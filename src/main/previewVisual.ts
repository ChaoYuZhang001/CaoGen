import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { OfficeVisualPreview } from '../shared/types'
import { resolvePreviewFileTarget } from './previewOps'

const QUICK_LOOK_BIN = '/usr/bin/qlmanage'
const PLUTIL_BIN = '/usr/bin/plutil'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DIMENSION = 1_200
const DEFAULT_MAX_OUTPUT_BYTES = 12_000_000
const PROCESS_OUTPUT_LIMIT = 4_000_000
const VISUAL_CACHE_LIMIT = 16
const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx'])
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline' data:",
  "script-src 'unsafe-inline'",
  'frame-src data: about:',
  'child-src data: about:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

export interface OfficeVisualPreviewOptions {
  timeoutMs?: number
  maxDimension?: number
  maxOutputBytes?: number
}

interface QuickLookAttachmentMetadata {
  contentId: string
  fileName: string
  mimeType?: string
}

interface QuickLookMetadata {
  width?: number
  height?: number
  attachments: QuickLookAttachmentMetadata[]
}

interface BundleAsset {
  relativePath: string
  fullPath: string
  mimeType: string
}

interface InlineContext {
  assetsByReference: Map<string, BundleAsset>
  buffers: Map<string, Buffer>
  cssCache: Map<string, string>
  dataUrlCache: Map<string, string>
  htmlCache: Map<string, string>
  maxOutputBytes: number
  totalReadBytes: number
}

interface InlinedQuickLookPreview {
  previewUrl: string
  width?: number
  height?: number
  bytes: number
  attachmentCount: number
}

interface ProcessResult {
  stdout: string
  stderr: string
}

const visualCache = new Map<string, OfficeVisualPreview>()
const inflight = new Map<string, Promise<OfficeVisualPreview>>()
const activeChildren = new Set<ChildProcess>()

/**
 * 优先生成 macOS Quick Look 完整文档预览。若系统生成器不能输出可安全内联的
 * HTML 包，则回退到首屏 PNG；结构化文本预览始终走独立链路。
 */
export async function prepareOfficeVisualPreview(
  projectRoot: string,
  relativePath: string,
  options: OfficeVisualPreviewOptions = {}
): Promise<OfficeVisualPreview> {
  let target: Awaited<ReturnType<typeof resolvePreviewFileTarget>>
  try {
    target = await resolvePreviewFileTarget(projectRoot, relativePath)
  } catch (error) {
    return visualFailure(errorMessage(error))
  }

  if (!OFFICE_EXTENSIONS.has(path.extname(target.relativePath).toLowerCase())) {
    return visualFailure('视觉预览仅支持 DOCX、XLSX 和 PPTX 文件', target.relativePath)
  }
  if (process.platform !== 'darwin') {
    return visualFailure('Office 视觉预览当前依赖 macOS Quick Look', target.relativePath)
  }

  const maxDimension = boundedInt(options.maxDimension, DEFAULT_MAX_DIMENSION, 256, 2_400)
  const timeoutMs = boundedInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 120_000)
  const maxOutputBytes = boundedInt(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    256_000,
    40_000_000
  )
  const cacheKey = `${target.fullPath}\0${target.mtimeMs}\0${maxDimension}\0${maxOutputBytes}`
  const cached = visualCache.get(cacheKey)
  if (cached) {
    visualCache.delete(cacheKey)
    visualCache.set(cacheKey, cached)
    return cached
  }

  const pending = inflight.get(cacheKey)
  if (pending) return pending

  const promise = generateQuickLookPreview(target, { maxDimension, timeoutMs, maxOutputBytes })
    .then((result) => {
      if (result.ok) cacheVisual(cacheKey, result)
      return result
    })
    .catch((error) => visualFailure(errorMessage(error), target.relativePath))
    .finally(() => inflight.delete(cacheKey))
  inflight.set(cacheKey, promise)
  return promise
}

export function disposeOfficeVisualPreviews(): void {
  for (const child of activeChildren) {
    if (!child.killed) child.kill('SIGKILL')
  }
  activeChildren.clear()
  inflight.clear()
  visualCache.clear()
}

/** @internal Exported for deterministic bundle-inlining smoke coverage. */
export async function inlineQuickLookPreviewBundle(
  previewDir: string,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<InlinedQuickLookPreview> {
  const metadata = await readQuickLookMetadata(previewDir, timeoutMs)
  const assets = await collectBundleAssets(previewDir, metadata)
  const previewAsset = assets.find((asset) => asset.relativePath === 'Preview.html')
  if (!previewAsset) throw new Error('Quick Look 完整预览缺少 Preview.html')

  const assetsByReference = new Map<string, BundleAsset>()
  for (const asset of assets) {
    registerAssetReference(assetsByReference, asset.relativePath, asset)
    registerAssetReference(assetsByReference, path.posix.basename(asset.relativePath), asset)
  }
  for (const attachment of metadata.attachments) {
    const asset = assetsByReference.get(normalizeReferenceKey(attachment.fileName))
    if (!asset) continue
    if (attachment.mimeType) asset.mimeType = attachment.mimeType
    registerAssetReference(assetsByReference, attachment.contentId, asset)
    registerAssetReference(assetsByReference, `cid:${attachment.contentId}`, asset)
  }

  const context: InlineContext = {
    assetsByReference,
    buffers: new Map(),
    cssCache: new Map(),
    dataUrlCache: new Map(),
    htmlCache: new Map(),
    maxOutputBytes,
    totalReadBytes: 0
  }
  const html = await inlineHtmlAsset(previewAsset, context, new Set())
  const bytes = Buffer.byteLength(html)
  if (bytes > maxOutputBytes) {
    throw new Error(`Quick Look 完整预览内联后过大: ${bytes} bytes`)
  }
  return {
    previewUrl: `data:text/html;base64,${Buffer.from(html).toString('base64')}`,
    width: metadata.width,
    height: metadata.height,
    bytes,
    attachmentCount: metadata.attachments.length
  }
}

async function generateQuickLookPreview(
  target: Awaited<ReturnType<typeof resolvePreviewFileTarget>>,
  options: Required<OfficeVisualPreviewOptions>
): Promise<OfficeVisualPreview> {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'caogen-office-visual-'))
  let fullPreviewError = ''
  try {
    const fullOutputDir = path.join(outputRoot, 'preview')
    await mkdir(fullOutputDir, { recursive: true })
    try {
      await runQuickLook(['-p', '-o', fullOutputDir, target.fullPath], options.timeoutMs)
      const previewDir = await findQuickLookPreviewBundle(fullOutputDir)
      const fullPreview = await inlineQuickLookPreviewBundle(
        previewDir,
        options.maxOutputBytes,
        options.timeoutMs
      )
      return {
        ok: true,
        path: target.relativePath,
        previewUrl: fullPreview.previewUrl,
        width: fullPreview.width,
        height: fullPreview.height,
        bytes: fullPreview.bytes,
        mtimeMs: target.mtimeMs,
        source: 'quick-look',
        fidelity: 'system-document-preview'
      }
    } catch (error) {
      fullPreviewError = errorMessage(error)
    }

    const thumbnailOutputDir = path.join(outputRoot, 'thumbnail')
    await mkdir(thumbnailOutputDir, { recursive: true })
    try {
      await runQuickLook(
        ['-t', '-s', String(options.maxDimension), '-o', thumbnailOutputDir, target.fullPath],
        options.timeoutMs
      )
      const outputPath = await findQuickLookPng(thumbnailOutputDir)
      const outputInfo = await stat(outputPath)
      if (!outputInfo.isFile()) throw new Error('Quick Look 没有生成可读取的缩略图')
      if (outputInfo.size > options.maxOutputBytes) {
        throw new Error(`Quick Look 缩略图过大: ${outputInfo.size} bytes`)
      }

      const image = await readFile(outputPath)
      const { width, height } = readPngDimensions(image)
      return {
        ok: true,
        path: target.relativePath,
        dataUrl: `data:image/png;base64,${image.toString('base64')}`,
        width,
        height,
        bytes: image.byteLength,
        mtimeMs: target.mtimeMs,
        source: 'quick-look',
        fidelity: 'first-page-thumbnail',
        warning: fullPreviewError ? `完整系统预览不可用，已回退首屏缩略图: ${fullPreviewError}` : undefined
      }
    } catch (thumbnailError) {
      throw new Error(
        `完整系统预览失败: ${fullPreviewError || '未知原因'}; 首屏缩略图降级失败: ${errorMessage(thumbnailError)}`
      )
    }
  } finally {
    await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readQuickLookMetadata(previewDir: string, timeoutMs: number): Promise<QuickLookMetadata> {
  const plistPath = path.join(previewDir, 'PreviewProperties.plist')
  const normalizedPath = path.join(previewDir, '.caogen-preview-properties.xml')
  const sanitizedPath = path.join(previewDir, '.caogen-preview-properties-sanitized.plist')
  try {
    await runProcess(
      PLUTIL_BIN,
      ['-convert', 'xml1', '-o', normalizedPath, plistPath],
      timeoutMs,
      'Quick Look 元数据转换'
    )
    const xml = await readFile(normalizedPath, 'utf8')
    const sanitized = xml.replace(/<key>AttachmentData<\/key>\s*<data>[\s\S]*?<\/data>/gi, '')
    await writeFile(sanitizedPath, sanitized, 'utf8')
    const { stdout } = await runProcess(
      PLUTIL_BIN,
      ['-convert', 'json', '-o', '-', sanitizedPath],
      timeoutMs,
      'Quick Look 元数据解析'
    )
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    const attachmentsObject = objectValue(parsed.Attachments)
    const attachments: QuickLookAttachmentMetadata[] = []
    for (const [contentId, rawValue] of Object.entries(attachmentsObject)) {
      const value = objectValue(rawValue)
      const fileName = stringValue(value.DumpedAttachmentFileName)
      if (!fileName) continue
      attachments.push({
        contentId,
        fileName,
        mimeType: stringValue(value.MimeType) || undefined
      })
    }
    return {
      width: positiveNumber(parsed.Width),
      height: positiveNumber(parsed.Height),
      attachments
    }
  } catch (error) {
    throw new Error(`Quick Look 元数据不可读: ${errorMessage(error)}`)
  } finally {
    await rm(normalizedPath, { force: true }).catch(() => undefined)
    await rm(sanitizedPath, { force: true }).catch(() => undefined)
  }
}

async function collectBundleAssets(
  previewDir: string,
  metadata: QuickLookMetadata
): Promise<BundleAsset[]> {
  const metadataMimeByFile = new Map(
    metadata.attachments.map((attachment) => [normalizeReferenceKey(attachment.fileName), attachment.mimeType])
  )
  const assets: BundleAsset[] = []
  await collectDirectory(previewDir, '')
  return assets

  async function collectDirectory(root: string, relativeDir: string): Promise<void> {
    const currentDir = path.join(root, relativeDir)
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.caogen-preview-properties')) continue
      const relativePath = path.posix.join(relativeDir, entry.name).replace(/^\.\//, '')
      if (entry.isDirectory()) {
        await collectDirectory(root, relativePath)
        continue
      }
      if (!entry.isFile() || entry.name === 'PreviewProperties.plist') continue
      assets.push({
        relativePath,
        fullPath: path.join(root, ...relativePath.split('/')),
        mimeType: metadataMimeByFile.get(normalizeReferenceKey(relativePath)) || mimeTypeForPath(relativePath)
      })
    }
  }
}

async function inlineHtmlAsset(
  asset: BundleAsset,
  context: InlineContext,
  ancestors: Set<string>
): Promise<string> {
  const cached = context.htmlCache.get(asset.relativePath)
  if (cached !== undefined) return cached
  if (ancestors.has(asset.relativePath)) {
    return secureHtmlDocument('<p>循环附件已被阻止</p>')
  }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(asset.relativePath)
  const source = (await readAssetBuffer(asset, context)).toString('utf8')
  const inlined = await inlineHtmlText(source, asset.relativePath, context, nextAncestors)
  const secured = secureHtmlDocument(inlined)
  context.htmlCache.set(asset.relativePath, secured)
  return secured
}

async function inlineHtmlText(
  source: string,
  fromPath: string,
  context: InlineContext,
  ancestors: Set<string>
): Promise<string> {
  let html = source
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(["'])?refresh\1?[^>]*>/gi, '')

  html = await replaceAsync(
    html,
    /<script\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>\s*<\/script\s*>/gi,
    async (match) => {
      const asset = resolveBundleReference(match[3], fromPath, context)
      if (!asset || !isJavaScriptMime(asset.mimeType, asset.relativePath)) return ''
      const script = (await readAssetBuffer(asset, context)).toString('utf8').replace(/<\/script/gi, '<\\/script')
      return `<script${match[1]}${match[4]} data-caogen-inline="${escapeHtmlAttribute(asset.relativePath)}">${script}</script>`
    }
  )

  html = await replaceAsync(
    html,
    /<link\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>/gi,
    async (match) => {
      const tag = match[0]
      if (!/\brel\s*=\s*(["'])?stylesheet\1?/i.test(tag)) return ''
      const asset = resolveBundleReference(match[3], fromPath, context)
      if (!asset || !isCssMime(asset.mimeType, asset.relativePath)) return ''
      const css = (await inlineCssAsset(asset, context)).replace(/<\/style/gi, '<\\/style')
      return `<style data-caogen-inline="${escapeHtmlAttribute(asset.relativePath)}">${css}</style>`
    }
  )

  html = await replaceAsync(html, /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi, async (match) => {
    const css = (await inlineCssText(match[2], fromPath, context)).replace(/<\/style/gi, '<\\/style')
    return `<style${match[1]}>${css}</style>`
  })

  html = await replaceAsync(html, /<(?:a|img|iframe|source|object|embed)\b[^>]*>/gi, async (match) =>
    inlineTagReferences(match[0], fromPath, context, ancestors)
  )

  return html
}

async function inlineTagReferences(
  tag: string,
  fromPath: string,
  context: InlineContext,
  ancestors: Set<string>
): Promise<string> {
  let output = await replaceAsync(
    tag,
    /\b(src|href|data)\s*=\s*(["'])(.*?)\2/gi,
    async (match) => {
      const attribute = match[1].toLowerCase()
      const reference = match[3].trim()
      if (!reference || reference.startsWith('#') || reference === 'about:blank') return match[0]
      const asset = resolveBundleReference(reference, fromPath, context)
      if (asset) {
        const dataUrl = await assetDataUrl(asset, context, ancestors)
        return `${attribute}="${dataUrl}"`
      }
      if (reference.startsWith('data:image/') || reference.startsWith('data:font/')) return match[0]
      return attribute === 'href' ? 'href="#"' : `${attribute}="about:blank"`
    }
  )
  output = await replaceAsync(output, /\bstyle\s*=\s*(["'])(.*?)\1/gi, async (match) => {
    const css = await inlineCssText(match[2], fromPath, context)
    return `style="${escapeHtmlAttribute(css)}"`
  })
  return output
}

async function inlineCssAsset(asset: BundleAsset, context: InlineContext): Promise<string> {
  const cached = context.cssCache.get(asset.relativePath)
  if (cached !== undefined) return cached
  const source = (await readAssetBuffer(asset, context)).toString('utf8')
  const inlined = await inlineCssText(source, asset.relativePath, context)
  context.cssCache.set(asset.relativePath, inlined)
  return inlined
}

async function inlineCssText(source: string, fromPath: string, context: InlineContext): Promise<string> {
  return replaceAsync(source, /url\(\s*(["']?)(.*?)\1\s*\)/gi, async (match) => {
    const reference = match[2].trim()
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return match[0]
    const asset = resolveBundleReference(reference, fromPath, context)
    if (!asset) return 'url("")'
    return `url("${await assetDataUrl(asset, context, new Set())}")`
  })
}

async function assetDataUrl(
  asset: BundleAsset,
  context: InlineContext,
  ancestors: Set<string>
): Promise<string> {
  const cached = context.dataUrlCache.get(asset.relativePath)
  if (cached !== undefined) return cached
  let dataUrl: string
  if (isHtmlMime(asset.mimeType, asset.relativePath)) {
    const html = await inlineHtmlAsset(asset, context, ancestors)
    dataUrl = `data:text/html;base64,${Buffer.from(html).toString('base64')}`
  } else if (isCssMime(asset.mimeType, asset.relativePath)) {
    const css = await inlineCssAsset(asset, context)
    dataUrl = `data:text/css;base64,${Buffer.from(css).toString('base64')}`
  } else {
    const buffer = await readAssetBuffer(asset, context)
    dataUrl = `data:${asset.mimeType};base64,${buffer.toString('base64')}`
  }
  context.dataUrlCache.set(asset.relativePath, dataUrl)
  return dataUrl
}

async function readAssetBuffer(asset: BundleAsset, context: InlineContext): Promise<Buffer> {
  const cached = context.buffers.get(asset.relativePath)
  if (cached) return cached
  const info = await stat(asset.fullPath)
  if (!info.isFile()) throw new Error(`Quick Look 附件不是文件: ${asset.relativePath}`)
  if (context.totalReadBytes + info.size > context.maxOutputBytes) {
    throw new Error(`Quick Look 附件总量过大: ${context.totalReadBytes + info.size} bytes`)
  }
  const buffer = await readFile(asset.fullPath)
  context.totalReadBytes += buffer.byteLength
  context.buffers.set(asset.relativePath, buffer)
  return buffer
}

function resolveBundleReference(
  rawReference: string,
  fromPath: string,
  context: InlineContext
): BundleAsset | undefined {
  let reference = rawReference.trim()
  if (!reference) return undefined
  if (reference.toLowerCase().startsWith('cid:')) {
    reference = safeDecodeURIComponent(reference.slice(4))
    return (
      context.assetsByReference.get(normalizeReferenceKey(reference)) ||
      context.assetsByReference.get(normalizeReferenceKey(`cid:${reference}`))
    )
  }
  if (/^(?:data:|https?:|file:|ftp:|javascript:|mailto:|tel:|about:)/i.test(reference)) return undefined
  reference = safeDecodeURIComponent(reference.split(/[?#]/, 1)[0]).replace(/^\.\//, '')
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), reference))
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) return undefined
  return (
    context.assetsByReference.get(normalizeReferenceKey(relative)) ||
    context.assetsByReference.get(normalizeReferenceKey(reference)) ||
    context.assetsByReference.get(normalizeReferenceKey(path.posix.basename(reference)))
  )
}

function secureHtmlDocument(html: string): string {
  const securityMeta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer"><meta name="caogen-preview" content="quick-look-inline">`
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => `${head}${securityMeta}`)
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (root) => `${root}<head>${securityMeta}</head>`)
  return `<html><head>${securityMeta}</head><body>${html}</body></html>`
}

async function runQuickLook(args: string[], timeoutMs: number): Promise<void> {
  await runProcess(QUICK_LOOK_BIN, args, timeoutMs, 'Quick Look 生成')
}

async function runProcess(
  executable: string,
  args: string[],
  timeoutMs: number,
  label: string
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    activeChildren.add(child)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let outputExceeded = false
    let forceTimer: NodeJS.Timeout | undefined

    const capture = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (outputExceeded) return
      const next = target === 'stdout' ? stdout + chunk.toString('utf8') : stderr + chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.byteLength > PROCESS_OUTPUT_LIMIT) {
        outputExceeded = true
        if (!child.killed) child.kill('SIGKILL')
        forceTimer = setTimeout(() => finish(new Error(`${label}输出过大`)), 2_000)
        return
      }
      if (target === 'stdout') stdout = next
      else stderr = next
    }
    child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk))

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      activeChildren.delete(child)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }

    const timer = setTimeout(() => {
      timedOut = true
      if (!child.killed) child.kill('SIGKILL')
      forceTimer = setTimeout(() => finish(new Error(`${label}超时(${timeoutMs}ms)`)), 2_000)
    }, timeoutMs)

    child.once('error', (error) => finish(new Error(`${label}启动失败: ${error.message}`)))
    child.once('close', (code, signal) => {
      if (timedOut) return finish(new Error(`${label}超时(${timeoutMs}ms)`))
      if (outputExceeded) return finish(new Error(`${label}输出过大`))
      if (code === 0) return finish()
      const detail = `${stdout}\n${stderr}`.replace(/\s+/g, ' ').trim().slice(0, 2_000)
      return finish(
        new Error(
          `${label}失败(code=${code ?? 'null'}, signal=${signal ?? 'none'})${detail ? `: ${detail}` : ''}`
        )
      )
    })
  })
}

async function findQuickLookPreviewBundle(outputDir: string): Promise<string> {
  const queue = [outputDir]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = path.join(current, entry.name)
      if (entry.name.toLowerCase().endsWith('.qlpreview')) return fullPath
      queue.push(fullPath)
    }
  }
  throw new Error('Quick Look 未输出完整 .qlpreview 文档包')
}

async function findQuickLookPng(outputDir: string): Promise<string> {
  const queue = [outputDir]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(fullPath)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) return fullPath
    }
  }
  throw new Error('Quick Look 未输出 PNG 缩略图')
}

function readPngDimensions(image: Buffer): { width: number; height: number } {
  if (image.byteLength < 24 || !image.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error('Quick Look 输出不是有效的 PNG 图片')
  }
  const width = image.readUInt32BE(16)
  const height = image.readUInt32BE(20)
  if (width <= 0 || height <= 0) throw new Error('Quick Look 输出的图片尺寸无效')
  return { width, height }
}

function registerAssetReference(map: Map<string, BundleAsset>, reference: string, asset: BundleAsset): void {
  const key = normalizeReferenceKey(reference)
  if (!key || map.has(key)) return
  map.set(key, asset)
}

function normalizeReferenceKey(reference: string): string {
  return reference.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase()
}

function mimeTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.html' || extension === '.htm') return 'text/html'
  if (extension === '.css') return 'text/css'
  if (extension === '.js') return 'application/javascript'
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.woff') return 'font/woff'
  if (extension === '.woff2') return 'font/woff2'
  return 'application/octet-stream'
}

function isHtmlMime(mimeType: string, filePath: string): boolean {
  return mimeType.toLowerCase().includes('text/html') || /\.html?$/i.test(filePath)
}

function isCssMime(mimeType: string, filePath: string): boolean {
  return mimeType.toLowerCase().includes('text/css') || /\.css$/i.test(filePath)
}

function isJavaScriptMime(mimeType: string, filePath: string): boolean {
  return /(?:javascript|ecmascript)/i.test(mimeType) || /\.js$/i.test(filePath)
}

function cacheVisual(cacheKey: string, result: OfficeVisualPreview): void {
  visualCache.set(cacheKey, result)
  while (visualCache.size > VISUAL_CACHE_LIMIT) {
    const oldest = visualCache.keys().next().value
    if (typeof oldest !== 'string') break
    visualCache.delete(oldest)
  }
}

function visualFailure(error: string, relativePath?: string): OfficeVisualPreview {
  return {
    ok: false,
    path: relativePath,
    source: 'quick-look',
    fidelity: 'first-page-thumbnail',
    error
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>
): Promise<string> {
  const matches = [...input.matchAll(pattern)]
  if (matches.length === 0) return input
  const replacements = await Promise.all(matches.map((match) => replacer(match)))
  let output = ''
  let cursor = 0
  matches.forEach((match, index) => {
    const matchIndex = match.index ?? 0
    output += input.slice(cursor, matchIndex)
    output += replacements[index]
    cursor = matchIndex + match[0].length
  })
  return output + input.slice(cursor)
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value as number)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
