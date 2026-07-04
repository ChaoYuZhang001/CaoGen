import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'

const DEFAULT_MAX_TEXT_PREVIEW_BYTES = 1_000_000
const DEFAULT_MAX_ASSET_PREVIEW_BYTES = 20_000_000

export type PreviewType =
  | 'html'
  | 'markdown'
  | 'text'
  | 'csv'
  | 'json'
  | 'image'
  | 'pdf'
  | 'unknown'

export type PreviewMode = 'text' | 'asset' | 'unsupported'

export interface PreviewOpsFailure {
  ok: false
  error: string
}

export interface PreviewDetection {
  ok: true
  path: string
  type: PreviewType
  mode: PreviewMode
  mime: string
  bytes: number
  mtimeMs: number
}

export interface TextPreview extends PreviewDetection {
  mode: 'text'
  type: 'html' | 'markdown' | 'text' | 'csv' | 'json'
  content: string
}

export interface AssetPreview extends PreviewDetection {
  mode: 'asset'
  type: 'image' | 'pdf'
  dataUrl: string
}

export interface UnknownPreview extends PreviewDetection {
  mode: 'unsupported'
  type: 'unknown'
}

export interface PreparePreviewOptions {
  maxTextBytes?: number
  maxAssetBytes?: number
}

export type DetectPreviewResult = PreviewDetection | PreviewOpsFailure
export type PreparePreviewResult = TextPreview | AssetPreview | UnknownPreview | PreviewOpsFailure

interface PreviewTarget {
  fullPath: string
  relativePath: string
  bytes: number
  mtimeMs: number
}

interface PreviewKind {
  type: PreviewType
  mode: PreviewMode
  mime: string
}

const PREVIEW_BY_EXTENSION: Record<string, PreviewKind> = {
  '.csv': { type: 'csv', mode: 'text', mime: 'text/csv' },
  '.gif': { type: 'image', mode: 'asset', mime: 'image/gif' },
  '.htm': { type: 'html', mode: 'text', mime: 'text/html' },
  '.html': { type: 'html', mode: 'text', mime: 'text/html' },
  '.odp': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.oasis.opendocument.presentation' },
  '.ods': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  '.jpeg': { type: 'image', mode: 'asset', mime: 'image/jpeg' },
  '.jpg': { type: 'image', mode: 'asset', mime: 'image/jpeg' },
  '.json': { type: 'json', mode: 'text', mime: 'application/json' },
  '.log': { type: 'text', mode: 'text', mime: 'text/plain' },
  '.markdown': { type: 'markdown', mode: 'text', mime: 'text/markdown' },
  '.md': { type: 'markdown', mode: 'text', mime: 'text/markdown' },
  '.pdf': { type: 'pdf', mode: 'asset', mime: 'application/pdf' },
  '.png': { type: 'image', mode: 'asset', mime: 'image/png' },
  '.ppt': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.ms-powerpoint' },
  '.pptx': {
    type: 'unknown',
    mode: 'unsupported',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  },
  '.svg': { type: 'image', mode: 'asset', mime: 'image/svg+xml' },
  '.text': { type: 'text', mode: 'text', mime: 'text/plain' },
  '.tsv': { type: 'csv', mode: 'text', mime: 'text/tab-separated-values' },
  '.txt': { type: 'text', mode: 'text', mime: 'text/plain' },
  '.webp': { type: 'image', mode: 'asset', mime: 'image/webp' },
  '.xls': { type: 'unknown', mode: 'unsupported', mime: 'application/vnd.ms-excel' },
  '.xlsx': {
    type: 'unknown',
    mode: 'unsupported',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
}

const UNKNOWN_PREVIEW: PreviewKind = {
  type: 'unknown',
  mode: 'unsupported',
  mime: 'application/octet-stream'
}

/**
 * 检测项目内文件可用的预览类型。只返回元数据,不读取文件内容。
 */
export async function detectPreview(projectRoot: string, relativePath: string): Promise<DetectPreviewResult> {
  try {
    const target = await resolvePreviewTarget(projectRoot, relativePath)
    return {
      ok: true,
      path: target.relativePath,
      ...detectPreviewKind(target.relativePath),
      bytes: target.bytes,
      mtimeMs: target.mtimeMs
    }
  } catch (err) {
    return failure(errorMessage(err))
  }
}

/**
 * 准备项目内文件预览。文本类返回 UTF-8 content; 图片/PDF/unknown 只返回稳定元数据。
 */
export async function preparePreview(
  projectRoot: string,
  relativePath: string,
  options: PreparePreviewOptions = {}
): Promise<PreparePreviewResult> {
  try {
    const target = await resolvePreviewTarget(projectRoot, relativePath)
    const kind = detectPreviewKind(target.relativePath)
    const base = {
      ok: true as const,
      path: target.relativePath,
      ...kind,
      bytes: target.bytes,
      mtimeMs: target.mtimeMs
    }

    if (kind.mode !== 'text') {
      if (kind.type === 'unknown') return base as UnknownPreview
      const maxAssetBytes = positiveLimit(options.maxAssetBytes, DEFAULT_MAX_ASSET_PREVIEW_BYTES)
      if (target.bytes > maxAssetBytes) {
        return failure(`预览资产过大: ${target.bytes} bytes, 上限 ${maxAssetBytes} bytes`)
      }
      const buffer = await readFile(target.fullPath)
      return {
        ...base,
        bytes: buffer.byteLength,
        dataUrl: `data:${kind.mime};base64,${buffer.toString('base64')}`
      } as AssetPreview
    }

    const maxTextBytes = positiveLimit(options.maxTextBytes, DEFAULT_MAX_TEXT_PREVIEW_BYTES)
    if (target.bytes > maxTextBytes) {
      return failure(`预览文本过大: ${target.bytes} bytes, 上限 ${maxTextBytes} bytes`)
    }

    const buffer = await readFile(target.fullPath)
    if (buffer.includes(0)) return failure('文件看起来是二进制内容')

    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return failure('文件不是有效的 UTF-8 文本')
    }

    return {
      ...base,
      bytes: buffer.byteLength,
      content
    } as TextPreview
  } catch (err) {
    return failure(errorMessage(err))
  }
}

async function resolvePreviewTarget(projectRoot: string, relativePath: string): Promise<PreviewTarget> {
  const root = await normalizeProjectRoot(projectRoot)
  const target = resolveProjectPath(root, relativePath)
  const realTarget = await realpath(target.fullPath)
  ensureInsideRoot(root, realTarget)

  const info = await stat(realTarget)
  if (!info.isFile()) throw new Error('只能预览文件')

  return {
    fullPath: realTarget,
    relativePath: toProjectRelative(root, realTarget),
    bytes: info.size,
    mtimeMs: info.mtimeMs
  }
}

async function normalizeProjectRoot(projectRoot: string): Promise<string> {
  if (!projectRoot.trim()) throw new Error('项目目录不能为空')
  const root = await realpath(projectRoot)
  const info = await stat(root)
  if (!info.isDirectory()) throw new Error('项目目录不存在或不是目录')
  return root
}

function resolveProjectPath(root: string, relativePath: string): { fullPath: string; relativePath: string } {
  if (!relativePath.trim()) throw new Error('文件路径不能为空')
  if (relativePath.includes('\0')) throw new Error('文件路径包含非法字符')
  if (path.isAbsolute(relativePath)) throw new Error('只允许项目内相对路径')

  const fullPath = path.resolve(root, relativePath)
  ensureInsideRoot(root, fullPath)
  return { fullPath, relativePath: toProjectRelative(root, fullPath) }
}

function detectPreviewKind(relativePath: string): PreviewKind {
  const extension = path.extname(relativePath).toLowerCase()
  return PREVIEW_BY_EXTENSION[extension] ?? UNKNOWN_PREVIEW
}

function ensureInsideRoot(root: string, fullPath: string): void {
  const rel = path.relative(root, fullPath)
  if (rel === '') return
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return
  throw new Error('路径越过了项目目录边界')
}

function toProjectRelative(root: string, fullPath: string): string {
  return path.relative(root, fullPath).split(path.sep).join('/')
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function failure(error: string): PreviewOpsFailure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
