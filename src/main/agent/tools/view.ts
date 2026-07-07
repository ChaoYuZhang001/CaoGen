import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { TextDecoder } from 'node:util'
import { resolveExistingProjectPath } from '../../utils/safe-project-path'

const DEFAULT_LINE_WINDOW = 200
const MAX_VIEW_BYTES = 2 * 1024 * 1024
const GENERATED_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'poetry.lock'
])
const BLOCKED_EXTENSIONS = new Set([
  '.7z',
  '.avif',
  '.bmp',
  '.br',
  '.class',
  '.dll',
  '.dmg',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.map',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.webp',
  '.zip'
])

export interface ViewInput {
  file_path: string
  start_line?: number
  end_line?: number
}

export interface ViewSuccess {
  ok: true
  filePath: string
  startLine: number
  endLine: number
  totalLines: number
  truncated: boolean
  content: string
}

export interface ViewFailure {
  ok: false
  filePath?: string
  error: string
}

export type ViewResult = ViewSuccess | ViewFailure

export async function runView(projectRoot: string, input: ViewInput): Promise<ViewResult> {
  let filePath: string
  try {
    filePath = (await resolveExistingProjectPath(projectRoot, input.file_path)).fullPath
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const skipReason = skippedFileReason(filePath)
  if (skipReason) return { ok: false, filePath, error: skipReason }

  const info = await stat(filePath)
  if (!info.isFile()) return { ok: false, filePath, error: '目标路径不是文件' }
  if (info.size > MAX_VIEW_BYTES) return { ok: false, filePath, error: `文件过大:${info.size} bytes, 请指定更小文件或使用检索工具定位片段` }

  const buffer = await readFile(filePath)
  if (buffer.includes(0)) return { ok: false, filePath, error: '目标文件看起来是二进制内容,已跳过' }

  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return { ok: false, filePath, error: '目标文件不是有效 UTF-8 文本' }
  }

  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const startLine = normalizeLine(input.start_line, 1)
  const requestedEnd = typeof input.end_line === 'number' ? input.end_line : startLine + DEFAULT_LINE_WINDOW - 1
  const maxWindowEnd = startLine + DEFAULT_LINE_WINDOW - 1
  const endLine = Math.max(startLine, Math.min(normalizeLine(requestedEnd, maxWindowEnd), maxWindowEnd))
  const clampedStart = Math.min(startLine, Math.max(lines.length, 1))
  const clampedEnd = Math.min(endLine, lines.length)
  const selected = lines.slice(clampedStart - 1, clampedEnd)
  const width = String(clampedEnd).length
  const numbered = selected.map((line, index) => `${String(clampedStart + index).padStart(width, ' ')} | ${line}`)
  const truncated = clampedEnd < lines.length
  if (truncated) numbered.push(`... 文件还有 ${lines.length - clampedEnd} 行,继续 view start_line=${clampedEnd + 1}`)

  return {
    ok: true,
    filePath,
    startLine: clampedStart,
    endLine: clampedEnd,
    totalLines: lines.length,
    truncated,
    content: numbered.join('\n')
  }
}

export function formatViewResult(result: ViewResult): string {
  if (result.ok === false) return `view 失败: ${result.error}`
  return [
    `文件: ${result.filePath}`,
    `行号: ${result.startLine}-${result.endLine}/${result.totalLines}`,
    result.content
  ].join('\n')
}

function skippedFileReason(filePath: string): string | null {
  const name = basename(filePath)
  const lowerName = name.toLowerCase()
  if (GENERATED_FILENAMES.has(lowerName)) return '生成/锁定文件不适合直接读取,已跳过'
  if (lowerName.endsWith('.min.js') || lowerName.endsWith('.min.css')) return '压缩生成文件不适合直接读取,已跳过'
  if (BLOCKED_EXTENSIONS.has(extname(lowerName))) return '二进制、压缩或生成文件不适合直接读取,已跳过'
  return null
}

function normalizeLine(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}
