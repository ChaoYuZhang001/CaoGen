import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
} as const

type SupportedImageExtension = keyof typeof IMAGE_MIME_BY_EXTENSION

export interface CopyImageAttachmentOptions {
  maxBytes?: number
}

export interface SaveImageAttachmentBytesOptions extends CopyImageAttachmentOptions {
  mime?: string
}

export interface DurableImageAttachmentReference {
  hash?: string
  mime: string
  bytes: number
}

export interface ImageAttachmentSuccess {
  ok: true
  id: string
  hash: string
  path: string
  mime: string
  bytes: number
  createdAt: string
}

export interface AttachmentFailure {
  ok: false
  error: string
}

export type CopyImageAttachmentResult = ImageAttachmentSuccess | AttachmentFailure
export type SaveImageAttachmentBytesResult = ImageAttachmentSuccess | AttachmentFailure

export type ImageAttachmentBytesInput = Buffer | Uint8Array | ArrayBuffer | string

/**
 * Copies a user-selected image into the app attachment root using a content-hash filename.
 */
export async function copyImageAttachment(
  sourcePath: string,
  attachmentsRoot: string,
  options: CopyImageAttachmentOptions = {}
): Promise<CopyImageAttachmentResult> {
  try {
    const source = resolveSourcePath(sourcePath)
    const extension = supportedExtension(source)
    const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_IMAGE_BYTES)

    const sourceInfo = await lstat(source)
    if (sourceInfo.isDirectory()) return failure('附件源不能是目录')

    const fileInfo = await stat(source)
    if (!fileInfo.isFile()) return failure('附件源必须是图片文件')
    if (fileInfo.size > maxBytes) return failure(`图片过大: ${fileInfo.size} bytes, 上限 ${maxBytes} bytes`)

    const buffer = await readFile(source)
    if (buffer.byteLength > maxBytes) return failure(`图片过大: ${buffer.byteLength} bytes, 上限 ${maxBytes} bytes`)
    if (!matchesImageSignature(buffer, extension)) return failure('文件内容不是支持的图片格式')

    return await persistImageAttachment(buffer, extension, attachmentsRoot)
  } catch (err) {
    return failure(errorMessage(err))
  }
}

/**
 * Saves renderer-provided image bytes/base64 into the attachment root.
 * Base64 may be raw or a data:image/*;base64,... URL.
 */
export async function saveImageAttachmentBytes(
  input: ImageAttachmentBytesInput,
  attachmentsRoot: string,
  options: SaveImageAttachmentBytesOptions = {}
): Promise<SaveImageAttachmentBytesResult> {
  try {
    const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_IMAGE_BYTES)
    const payload = decodeImageBytesInput(input)
    if (payload.buffer.byteLength > maxBytes) {
      return failure(`图片过大: ${payload.buffer.byteLength} bytes, 上限 ${maxBytes} bytes`)
    }

    const requestedMime = normalizeMime(options.mime) ?? normalizeMime(payload.mime)
    const requestedExtension = requestedMime ? extensionFromMime(requestedMime) : null
    const detectedExtension = detectImageExtension(payload.buffer)
    if (!detectedExtension) return failure('文件内容不是支持的图片格式')
    if (requestedExtension && requestedExtension !== detectedExtension) return failure('图片 MIME 与内容不匹配')

    return await persistImageAttachment(payload.buffer, detectedExtension, attachmentsRoot)
  } catch (err) {
    return failure(errorMessage(err))
  }
}

export async function imageToContentBlock(imagePath: string): Promise<Record<string, unknown>> {
  const resolvedPath = resolveSourcePath(imagePath)
  const extension = supportedExtension(resolvedPath)
  const buffer = await readFile(resolvedPath)

  if (!matchesImageSignature(buffer, extension)) {
    throw new Error('文件内容不是支持的图片格式')
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: IMAGE_MIME_BY_EXTENSION[extension],
      data: buffer.toString('base64')
    }
  }
}

/** Resolve a durable transcript reference without trusting a persisted path or encoded payload. */
export function imageAttachmentRefToContentBlock(
  reference: DurableImageAttachmentReference,
  attachmentsRoot: string,
  options: CopyImageAttachmentOptions = {}
): Record<string, unknown> {
  const hash = durableAttachmentHash(reference.hash)
  const extension = extensionFromMime(reference.mime)
  const maxBytes = positiveLimit(options.maxBytes, DEFAULT_MAX_IMAGE_BYTES)
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes <= 0 || reference.bytes > maxBytes) {
    throw new Error(`图片引用大小无效或超过上限 ${maxBytes} bytes`)
  }

  const requestedRoot = path.resolve(attachmentsRoot)
  const rootInfo = lstatSync(requestedRoot)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('附件目录必须是普通目录')
  const root = realpathSync(requestedRoot)
  if (!statSync(root).isDirectory()) throw new Error('附件目录不存在或不是目录')
  const targetPath = path.join(root, `${hash}${canonicalExtension(extension)}`)
  ensureInsideRoot(root, targetPath)
  const targetInfo = lstatSync(targetPath)
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error('附件引用目标必须是普通文件')
  const resolvedTarget = realpathSync(targetPath)
  ensureInsideRoot(root, resolvedTarget)
  if (targetInfo.size !== reference.bytes || targetInfo.size > maxBytes) {
    throw new Error('附件引用大小与对象不匹配')
  }

  const buffer = readFileSync(resolvedTarget)
  if (buffer.byteLength !== reference.bytes || !matchesImageSignature(buffer, extension)) {
    throw new Error('附件引用 MIME 或内容签名不匹配')
  }
  if (sha256(buffer) !== hash) throw new Error('附件引用摘要与对象不匹配')
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: IMAGE_MIME_BY_EXTENSION[extension],
      data: buffer.toString('base64')
    }
  }
}

export function sessionImageAttachmentsRoot(userDataRoot: string, sessionId: string): string {
  const normalizedSessionId = sessionId.trim()
  if (
    normalizedSessionId === '.' ||
    normalizedSessionId === '..' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalizedSessionId)
  ) {
    throw new Error('会话附件目录标识无效')
  }
  const requestedBase = path.resolve(userDataRoot, 'attachments')
  let canonicalBase = requestedBase
  try {
    const baseInfo = lstatSync(requestedBase)
    if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
      throw new Error('附件基础目录必须是普通目录')
    }
    canonicalBase = realpathSync(requestedBase)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  const target = path.resolve(canonicalBase, normalizedSessionId)
  ensureInsideRoot(canonicalBase, target)
  return target
}

async function persistImageAttachment(
  buffer: Buffer,
  extension: SupportedImageExtension,
  attachmentsRoot: string
): Promise<ImageAttachmentSuccess> {
  let tmpPath: string | null = null
  try {
    const root = await normalizeAttachmentsRoot(attachmentsRoot)
    const hash = sha256(buffer)
    const targetPath = path.join(root, `${hash}${canonicalExtension(extension)}`)
    ensureInsideRoot(root, targetPath)

    const existing = await lstat(targetPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })

    if (existing) {
      if (!existing.isFile()) throw new Error('附件目标路径已存在且不是文件')
      await ensureExistingFileMatchesHash(targetPath, hash)
    } else {
      tmpPath = path.join(root, `.${hash}.${process.pid}.${randomUUID()}.tmp`)
      ensureInsideRoot(root, tmpPath)
      await writeFile(tmpPath, buffer, { flag: 'wx' })
      await rename(tmpPath, targetPath)
      tmpPath = null
    }

    const targetInfo = await stat(targetPath)
    return {
      ok: true,
      id: hash,
      hash,
      path: targetPath,
      mime: IMAGE_MIME_BY_EXTENSION[extension],
      bytes: targetInfo.size,
      createdAt: createdAtIso(targetInfo)
    }
  } catch (err) {
    if (tmpPath) {
      await rm(tmpPath, { force: true }).catch(() => undefined)
    }
    throw err
  }
}

function resolveSourcePath(sourcePath: string): string {
  if (!sourcePath.trim()) throw new Error('附件源路径不能为空')
  if (sourcePath.includes('\0')) throw new Error('附件源路径包含非法字符')
  return path.resolve(sourcePath)
}

async function normalizeAttachmentsRoot(attachmentsRoot: string): Promise<string> {
  if (!attachmentsRoot.trim()) throw new Error('附件目录不能为空')
  if (attachmentsRoot.includes('\0')) throw new Error('附件目录包含非法字符')

  const resolvedRoot = path.resolve(attachmentsRoot)
  await mkdir(resolvedRoot, { recursive: true })

  const root = await realpath(resolvedRoot)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('附件目录不存在或不是目录')
  return root
}

function supportedExtension(filePath: string): SupportedImageExtension {
  const extension = path.extname(filePath).toLowerCase()
  if (extension in IMAGE_MIME_BY_EXTENSION) return extension as SupportedImageExtension
  throw new Error('仅支持 png、jpg、jpeg、gif、webp 图片')
}

function extensionFromMime(mime: string): SupportedImageExtension {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg'
  if (mime === 'image/gif') return '.gif'
  if (mime === 'image/webp') return '.webp'
  throw new Error('仅支持 image/png、image/jpeg、image/gif、image/webp 图片')
}

function canonicalExtension(extension: SupportedImageExtension): string {
  return extension === '.jpeg' ? '.jpg' : extension
}

function detectImageExtension(buffer: Buffer): SupportedImageExtension | null {
  const extensions = Object.keys(IMAGE_MIME_BY_EXTENSION) as SupportedImageExtension[]
  for (const extension of extensions) {
    if (matchesImageSignature(buffer, extension)) return canonicalExtension(extension) as SupportedImageExtension
  }
  return null
}

function matchesImageSignature(buffer: Buffer, extension: SupportedImageExtension): boolean {
  if (extension === '.png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }

  if (extension === '.jpg' || extension === '.jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }

  if (extension === '.gif') {
    if (buffer.length < 6) return false
    const header = buffer.subarray(0, 6).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }

  if (extension === '.webp') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }

  return false
}

async function ensureExistingFileMatchesHash(filePath: string, expectedHash: string): Promise<void> {
  const buffer = await readFile(filePath)
  const actualHash = sha256(buffer)
  if (actualHash !== expectedHash) {
    throw new Error('附件目标文件与内容 hash 不匹配')
  }
}

function ensureInsideRoot(root: string, fullPath: string): void {
  const relativePath = path.relative(root, fullPath)
  if (relativePath === '') return
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) return
  throw new Error('附件目标路径越过了附件目录边界')
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function decodeImageBytesInput(input: ImageAttachmentBytesInput): { buffer: Buffer; mime?: string } {
  if (typeof input === 'string') return decodeBase64ImageInput(input)
  if (input instanceof ArrayBuffer) return ensureNonEmptyBuffer(Buffer.from(input))
  if (input instanceof Uint8Array) return ensureNonEmptyBuffer(Buffer.from(input))
  throw new Error('图片内容必须是 bytes 或 base64 字符串')
}

function decodeBase64ImageInput(input: string): { buffer: Buffer; mime?: string } {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('图片内容不能为空')
  if (trimmed.includes('\0')) throw new Error('图片内容包含非法字符')

  const dataUrlMatch = /^data:([^;,]+);base64,(.*)$/is.exec(trimmed)
  const mime = dataUrlMatch ? dataUrlMatch[1] : undefined
  const base64 = dataUrlMatch ? dataUrlMatch[2] : trimmed
  return ensureNonEmptyBuffer(Buffer.from(strictBase64(base64), 'base64'), mime)
}

function strictBase64(value: string): string {
  const normalized = value.replace(/\s+/g, '')
  if (!normalized) throw new Error('图片 base64 内容不能为空')
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('图片 base64 内容无效')
  }
  return normalized
}

function ensureNonEmptyBuffer(buffer: Buffer, mime?: string): { buffer: Buffer; mime?: string } {
  if (buffer.byteLength === 0) throw new Error('图片内容不能为空')
  return { buffer, mime }
}

function normalizeMime(mime: string | undefined): string | undefined {
  if (mime === undefined) return undefined
  const normalized = mime.split(';', 1)[0]?.trim().toLowerCase()
  if (!normalized) return undefined
  return normalized
}

function durableAttachmentHash(value: string | undefined): string {
  const hash = value?.trim() ?? ''
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('附件引用缺少有效 SHA-256 摘要')
  return hash
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

function createdAtIso(info: { birthtimeMs: number; ctimeMs: number }): string {
  const timestamp = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs
  return new Date(timestamp).toISOString()
}

function failure(error: string): AttachmentFailure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
