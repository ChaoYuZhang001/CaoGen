import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { TextDecoder } from 'node:util'
import { createFileBackup } from '../../utils/backup'
import { resolveExistingProjectPath } from '../../utils/safe-project-path'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIFF_CHARS = 20_000
const SIMILAR_SNIPPET_COUNT = 3
const SIMILAR_SNIPPET_CONTEXT_LINES = 3
const MIN_CONTEXT_LINES = 3

export interface SearchReplacementInput {
  old_str: string
  new_str: string
  replace_all?: boolean
}

export interface SearchReplaceInput {
  file_path: string
  replacements: SearchReplacementInput[]
  dry_run?: boolean
}

export interface SearchReplaceRunOptions {
  writeTextFile?: (filePath: string, content: string) => Promise<void>
}

export interface ReplacementLineRange {
  startLine: number
  endLine: number
}

export interface ReplacementResult {
  index: number
  replaceAll: boolean
  matches: number
  ranges: ReplacementLineRange[]
}

export interface SearchReplaceSuccess {
  ok: true
  filePath: string
  dryRun: boolean
  replacements: ReplacementResult[]
  successCount: number
  backupPath?: string
  diff: string
}

export interface SearchReplaceFailure {
  ok: false
  filePath?: string
  error: string
  similarSnippets?: string[]
}

export type SearchReplaceResult = SearchReplaceSuccess | SearchReplaceFailure

export async function runSearchReplace(
  projectRoot: string,
  input: SearchReplaceInput,
  options: SearchReplaceRunOptions = {}
): Promise<SearchReplaceResult> {
  let filePath: string
  try {
    filePath = (await resolveExistingProjectPath(projectRoot, input.file_path)).fullPath
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const replacements = validateReplacements(input.replacements)
  if (replacements.ok === false) return { ok: false, filePath, error: replacements.error }

  const readable = await readUtf8TextFile(filePath)
  if (readable.ok === false) return { ok: false, filePath, error: readable.error }

  let nextContent = readable.content
  const applied: ReplacementResult[] = []

  for (const [index, replacement] of replacements.value.entries()) {
    const contextCheck = validateReplacementContext(replacement)
    if (contextCheck.ok === false) {
      return { ok: false, filePath, error: `第 ${index + 1} 个 old_str 上下文不足:${contextCheck.error}` }
    }
    const matches = findMatches(nextContent, replacement.old_str)
    if (matches.length === 0) {
      return {
        ok: false,
        filePath,
        error: `第 ${index + 1} 个 old_str 未在文件中找到。请根据相似片段修正缩进、空白或上下文。`,
        similarSnippets: findSimilarSnippets(nextContent, replacement.old_str)
      }
    }
    if (matches.length > 1 && replacement.replace_all !== true) {
      return {
        ok: false,
        filePath,
        error: `第 ${index + 1} 个 old_str 出现 ${matches.length} 次。请增加上下文保证唯一匹配,或显式设置 replace_all=true。`,
        similarSnippets: snippetsForMatches(nextContent, matches, replacement.old_str.length)
      }
    }

    const selected = replacement.replace_all === true ? matches : [matches[0]]
    const ranges = selected.map((offset) => lineRangeForOffset(nextContent, offset, replacement.old_str.length))
    nextContent = replaceAtOffsets(nextContent, selected, replacement.old_str, replacement.new_str)
    applied.push({
      index,
      replaceAll: replacement.replace_all === true,
      matches: selected.length,
      ranges
    })
  }

  const diff = formatUnifiedDiff(filePath, readable.content, nextContent)
  if (input.dry_run === true) {
    return {
      ok: true,
      filePath,
      dryRun: true,
      replacements: applied,
      successCount: totalMatches(applied),
      diff
    }
  }

  const writable = await ensureWritable(filePath)
  if (writable.ok === false) return { ok: false, filePath, error: writable.error }

  const backup = await createFileBackup(projectRoot, filePath)
  if (options.writeTextFile) await options.writeTextFile(filePath, nextContent)
  else await writeFile(filePath, nextContent, 'utf8')

  return {
    ok: true,
    filePath,
    dryRun: false,
    replacements: applied,
    successCount: totalMatches(applied),
    backupPath: backup.backupPath,
    diff
  }
}

async function ensureWritable(filePath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await access(filePath, constants.W_OK)
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `目标文件不可写,无法执行非 dry_run 替换:${message}` }
  }
}

export function formatSearchReplaceResult(result: SearchReplaceResult): string {
  if (result.ok === false) {
    const snippets = result.similarSnippets?.length
      ? `\n\n相似内容片段:\n${result.similarSnippets.join('\n\n')}`
      : ''
    return `search_replace 失败: ${result.error}${snippets}`
  }

  const lines = [
    result.dryRun ? 'search_replace dry_run 预览成功,未写入文件。' : 'search_replace 修改成功。',
    `文件: ${result.filePath}`,
    `成功替换: ${result.successCount} 处`
  ]
  if (result.backupPath) lines.push(`备份: ${result.backupPath}`)
  for (const item of result.replacements) {
    const ranges = item.ranges.map((range) => `${range.startLine}-${range.endLine}`).join(', ')
    lines.push(`- replacement[${item.index}]: ${item.matches} 处, 行号 ${ranges}, replace_all=${item.replaceAll}`)
  }
  lines.push('', 'Diff:', result.diff || '(无差异)')
  return lines.join('\n')
}

function validateReplacements(value: SearchReplacementInput[]): { ok: true; value: SearchReplacementInput[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'replacements 至少需要 1 项' }
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: `replacement[${index}] 参数无效` }
    if (typeof item.old_str !== 'string' || item.old_str.length === 0) {
      return { ok: false, error: `replacement[${index}].old_str 不能为空` }
    }
    if (typeof item.new_str !== 'string') return { ok: false, error: `replacement[${index}].new_str 必须是字符串` }
  }
  return { ok: true, value }
}

function validateReplacementContext(item: SearchReplacementInput): { ok: true } | { ok: false; error: string } {
  if (item.replace_all === true) return { ok: true }
  const lines = item.old_str
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length >= MIN_CONTEXT_LINES) return { ok: true }
  return {
    ok: false,
    error: `非 replace_all 替换至少需要 ${MIN_CONTEXT_LINES} 行有效上下文;请先用 view 读取目标区域,把待改行及其相邻上下文一起放入 old_str。`
  }
}

async function readUtf8TextFile(filePath: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const info = await stat(filePath)
  if (!info.isFile()) return { ok: false, error: '目标路径不是文件' }
  if (info.size > MAX_FILE_BYTES) return { ok: false, error: `文件过大:${info.size} bytes, 上限 ${MAX_FILE_BYTES} bytes` }

  const buffer = await readFile(filePath)
  if (buffer.includes(0)) return { ok: false, error: '目标文件看起来是二进制内容,已跳过' }
  try {
    return { ok: true, content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  } catch {
    return { ok: false, error: '目标文件不是有效 UTF-8 文本' }
  }
}

function findMatches(content: string, needle: string): number[] {
  const matches: number[] = []
  let start = 0
  while (start <= content.length) {
    const index = content.indexOf(needle, start)
    if (index === -1) break
    matches.push(index)
    start = index + Math.max(needle.length, 1)
  }
  return matches
}

function replaceAtOffsets(content: string, offsets: number[], oldStr: string, newStr: string): string {
  let next = ''
  let cursor = 0
  for (const offset of offsets) {
    next += content.slice(cursor, offset)
    next += newStr
    cursor = offset + oldStr.length
  }
  return next + content.slice(cursor)
}

function lineRangeForOffset(content: string, offset: number, length: number): ReplacementLineRange {
  const startLine = lineNumberAt(content, offset)
  const endLine = lineNumberAt(content, Math.max(offset, offset + length - 1))
  return { startLine, endLine }
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1
  const capped = Math.min(Math.max(offset, 0), content.length)
  for (let i = 0; i < capped; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

function totalMatches(results: ReplacementResult[]): number {
  return results.reduce((sum, item) => sum + item.matches, 0)
}

function findSimilarSnippets(content: string, oldStr: string): string[] {
  const contentLines = splitLines(content)
  const needleLines = splitLines(oldStr).map((line) => line.trim()).filter(Boolean)
  const candidates: Array<{ index: number; score: number }> = []

  for (const [index, line] of contentLines.entries()) {
    const normalized = line.trim()
    if (!normalized) continue
    let score = 0
    for (const needle of needleLines) {
      if (needle === normalized) score += 4
      else if (needle.includes(normalized) || normalized.includes(needle)) score += 2
      else if (sharedTokenScore(needle, normalized) >= 2) score += 1
    }
    if (score > 0) candidates.push({ index, score })
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index)
  return candidates.slice(0, SIMILAR_SNIPPET_COUNT).map((candidate) => formatNumberedSnippet(contentLines, candidate.index))
}

function snippetsForMatches(content: string, matches: number[], length: number): string[] {
  const contentLines = splitLines(content)
  return matches.slice(0, SIMILAR_SNIPPET_COUNT).map((offset) => {
    const lineIndex = Math.max(0, lineNumberAt(content, offset) - 1)
    const endLine = Math.max(lineIndex, lineNumberAt(content, offset + length) - 1)
    return formatNumberedSnippet(contentLines, Math.floor((lineIndex + endLine) / 2))
  })
}

function formatNumberedSnippet(lines: string[], centerIndex: number): string {
  const start = Math.max(0, centerIndex - SIMILAR_SNIPPET_CONTEXT_LINES)
  const end = Math.min(lines.length, centerIndex + SIMILAR_SNIPPET_CONTEXT_LINES + 1)
  return lines
    .slice(start, end)
    .map((line, offset) => `${String(start + offset + 1).padStart(4, ' ')} | ${line}`)
    .join('\n')
}

function sharedTokenScore(a: string, b: string): number {
  const left = new Set(a.split(/\W+/).filter((token) => token.length >= 3))
  let score = 0
  for (const token of b.split(/\W+/)) {
    if (token.length >= 3 && left.has(token)) score++
  }
  return score
}

function formatUnifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) return ''
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) {
    suffix++
  }

  const context = 3
  const beforeStart = Math.max(0, prefix - context)
  const afterStart = Math.max(0, prefix - context)
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + context)
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + context)
  const beforeChangedStart = prefix
  const beforeChangedEnd = beforeLines.length - suffix
  const afterChangedStart = prefix
  const afterChangedEnd = afterLines.length - suffix

  const lines = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${beforeStart + 1},${beforeEnd - beforeStart} +${afterStart + 1},${afterEnd - afterStart} @@`
  ]

  for (let i = beforeStart; i < beforeChangedStart; i++) lines.push(` ${beforeLines[i]}`)
  for (let i = beforeChangedStart; i < beforeChangedEnd; i++) lines.push(`-${beforeLines[i]}`)
  for (let i = afterChangedStart; i < afterChangedEnd; i++) lines.push(`+${afterLines[i]}`)
  for (let i = beforeChangedEnd; i < beforeEnd; i++) lines.push(` ${beforeLines[i]}`)

  const diff = lines.join('\n')
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… [diff 已截断,共 ${diff.length} 字符]` : diff
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}
