import { createHash } from 'node:crypto'
import { access, lstat, open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { TextDecoder } from 'node:util'
import type { EffectTarget, FileSystemIdentity } from '../../../shared/types'
import { createFileBackup } from '../../utils/backup'
import { resolveExistingProjectPath } from '../../utils/safe-project-path'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIFF_CHARS = 20_000
const SIMILAR_SNIPPET_COUNT = 3
const SIMILAR_SNIPPET_CONTEXT_LINES = 3
const MIN_CONTEXT_LINES = 3
const AUTO_APPLY_CONFIDENCE = 0.95
const PREVIEW_CONFIDENCE = 0.9
const FUZZY_LINE_WINDOW_DELTA = 2
const MAX_LEVENSHTEIN_CHARS = 4_000

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
  writeTextFile?: (filePath: string, content: string, guard: TextFileWriteGuard) => Promise<void>
  effectTarget?: Extract<EffectTarget, { kind: 'file_content' }>
  beforeWriteCommit?: () => Promise<void> | void
}

export interface TextFileWriteGuard {
  identity: FileSystemIdentity
  sha256: string
  bytes: number
}

export interface ExactFileEditInput {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
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
  matchType: MatchType
  confidence: number
  requiresPreview?: boolean
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

export interface SearchReplacePlan {
  ok: true
  rootPath: string
  rootIdentity: FileSystemIdentity
  filePath: string
  relativePath: string
  fileIdentity: FileSystemIdentity
  originalContent: string
  originalRawContent: Buffer
  originalSha256: string
  originalBytes: number
  nextContent: string
  writeContent: string
  replacements: ReplacementResult[]
  successCount: number
  diff: string
}

export type SearchReplacePlanResult = SearchReplacePlan | SearchReplaceFailure

type MatchType = 'exact' | 'whitespace' | 'fuzzy'

interface ResolvedMatch {
  offset: number
  length: number
  confidence: number
  type: MatchType
}

interface ResolvedMatchSet {
  matches: ResolvedMatch[]
  bestConfidence: number
}

export async function runSearchReplace(
  projectRoot: string,
  input: SearchReplaceInput,
  options: SearchReplaceRunOptions = {}
): Promise<SearchReplaceResult> {
  const plan = await planSearchReplace(projectRoot, input)
  if (plan.ok === false) return plan
  if (input.dry_run === true) {
    return publicResult(plan, true)
  }
  return applyTextPlan(plan, options)
}

export async function runExactFileEdit(
  projectRoot: string,
  input: ExactFileEditInput,
  options: SearchReplaceRunOptions = {}
): Promise<SearchReplaceResult> {
  const plan = await planExactFileEdit(projectRoot, input)
  if (plan.ok === false) return plan
  return applyTextPlan(plan, options)
}

async function applyTextPlan(
  plan: SearchReplacePlan,
  options: SearchReplaceRunOptions
): Promise<SearchReplaceResult> {
  const guardError = effectTargetError(plan, options.effectTarget)
  if (guardError) return { ok: false, filePath: plan.filePath, error: guardError }
  if (plan.originalContent === plan.nextContent) return publicResult(plan, false)
  const writable = await ensureWritable(plan.filePath)
  if (writable.ok === false) return { ok: false, filePath: plan.filePath, error: writable.error }

  const backup = await createFileBackup(plan.rootPath, plan.filePath, plan.originalRawContent)
  const driftError = await currentPlanError(plan)
  if (driftError) return { ok: false, filePath: plan.filePath, error: driftError }
  const writeGuard = {
    identity: plan.fileIdentity,
    sha256: plan.originalSha256,
    bytes: plan.originalBytes
  }
  try {
    if (options.writeTextFile) await options.writeTextFile(plan.filePath, plan.writeContent, writeGuard)
    else await writeGuardedTextFile(plan.filePath, plan.writeContent, writeGuard, options.beforeWriteCommit)
  } catch (error) {
    return {
      ok: false,
      filePath: plan.filePath,
      error: error instanceof Error ? error.message : String(error)
    }
  }

  return publicResult(plan, false, backup.backupPath)
}

export async function planSearchReplace(
  projectRoot: string,
  input: SearchReplaceInput
): Promise<SearchReplacePlanResult> {
  const prepared = await prepareTextPlan(projectRoot, input.file_path)
  if (prepared.ok === false) return prepared
  const replacements = validateReplacements(input.replacements)
  if (replacements.ok === false) return { ok: false, filePath: prepared.filePath, error: replacements.error }

  let nextContent = prepared.originalContent
  const applied: ReplacementResult[] = []
  for (const [index, replacement] of replacements.value.entries()) {
    const contextCheck = validateReplacementContext(replacement)
    if (contextCheck.ok === false) {
      return { ok: false, filePath: prepared.filePath, error: `第 ${index + 1} 个 old_str 上下文不足:${contextCheck.error}` }
    }
    const resolved = resolveMatches(nextContent, replacement.old_str, input.dry_run === true)
    if (resolved.matches.length === 0) {
      const confidenceText =
        resolved.bestConfidence > 0 ? `最佳候选匹配度 ${formatConfidence(resolved.bestConfidence)}。` : ''
      return {
        ok: false,
        filePath: prepared.filePath,
        error:
          `第 ${index + 1} 个 old_str 未在文件中找到。${confidenceText}` +
          '匹配度低于自动应用阈值,请先 dry_run 预览或根据相似片段修正缩进、空白、换行或上下文。',
        similarSnippets: findSimilarSnippets(nextContent, replacement.old_str)
      }
    }
    if (resolved.matches.length > 1 && replacement.replace_all !== true) {
      return {
        ok: false,
        filePath: prepared.filePath,
        error: `第 ${index + 1} 个 old_str 出现 ${resolved.matches.length} 次。请增加上下文保证唯一匹配,或显式设置 replace_all=true。`,
        similarSnippets: snippetsForMatches(nextContent, resolved.matches)
      }
    }
    const selected = replacement.replace_all === true ? resolved.matches : [resolved.matches[0]]
    applied.push(replacementResult(index, replacement.replace_all === true, nextContent, selected))
    nextContent = replaceResolvedMatches(nextContent, selected, replacement.new_str)
  }
  return completePlan(prepared, nextContent, applied)
}

export async function planExactFileEdit(
  projectRoot: string,
  input: ExactFileEditInput
): Promise<SearchReplacePlanResult> {
  const prepared = await prepareTextPlan(projectRoot, input.file_path)
  if (prepared.ok === false) return prepared
  if (!input.old_string) return { ok: false, filePath: prepared.filePath, error: 'old_string 不能为空' }
  if (input.old_string === input.new_string) {
    return { ok: false, filePath: prepared.filePath, error: 'new_string 必须与 old_string 不同' }
  }
  const matches = findExactMatches(prepared.originalContent, input.old_string)
  if (matches.length === 0) return { ok: false, filePath: prepared.filePath, error: 'old_string 未在文件中找到' }
  if (matches.length > 1 && input.replace_all !== true) {
    return { ok: false, filePath: prepared.filePath, error: `old_string 出现 ${matches.length} 次，必须唯一匹配或设置 replace_all=true` }
  }
  const selected = input.replace_all === true ? matches : [matches[0]]
  const applied = [replacementResult(0, input.replace_all === true, prepared.originalContent, selected)]
  const nextContent = replaceResolvedMatches(prepared.originalContent, selected, input.new_string)
  return completePlan(prepared, nextContent, applied)
}

export function searchReplacementArgs(value: unknown): SearchReplacementInput[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`replacement[${index}] 参数无效`)
    }
    const record = item as Record<string, unknown>
    if (typeof record.old_str !== 'string' || typeof record.new_str !== 'string') {
      throw new Error(`replacement[${index}] 的 old_str 与 new_str 必须是字符串`)
    }
    if (record.replace_all !== undefined && typeof record.replace_all !== 'boolean') {
      throw new Error(`replacement[${index}].replace_all 必须是布尔值`)
    }
    const replacement: SearchReplacementInput = {
      old_str: record.old_str,
      new_str: record.new_str
    }
    if (typeof record.replace_all === 'boolean') replacement.replace_all = record.replace_all
    return replacement
  })
}

interface PreparedTextPlan {
  ok: true
  rootPath: string
  rootIdentity: FileSystemIdentity
  filePath: string
  relativePath: string
  fileIdentity: FileSystemIdentity
  originalContent: string
  originalRawContent: Buffer
  originalSha256: string
  originalBytes: number
  hasUtf8Bom: boolean
}

async function prepareTextPlan(
  projectRoot: string,
  rawPath: string
): Promise<PreparedTextPlan | SearchReplaceFailure> {
  let resolved: Awaited<ReturnType<typeof resolveExistingProjectPath>>
  try {
    resolved = await resolveExistingProjectPath(projectRoot, rawPath)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const readable = await readUtf8TextFile(resolved.fullPath)
  if (readable.ok === false) return { ok: false, filePath: resolved.fullPath, error: readable.error }
  const rootInfo = await stat(resolved.root, { bigint: true })
  return {
    ok: true,
    rootPath: resolved.root,
    rootIdentity: fileIdentity(rootInfo),
    filePath: resolved.fullPath,
    relativePath: resolved.relativePath,
    fileIdentity: readable.identity,
    originalContent: readable.content,
    originalRawContent: readable.rawContent,
    originalSha256: readable.sha256,
    originalBytes: readable.bytes,
    hasUtf8Bom: readable.hasUtf8Bom
  }
}

function completePlan(
  prepared: PreparedTextPlan,
  nextContent: string,
  replacements: ReplacementResult[]
): SearchReplacePlan {
  const writeContent = prepared.hasUtf8Bom ? `\uFEFF${nextContent}` : nextContent
  return {
    ...prepared,
    nextContent,
    writeContent,
    replacements,
    successCount: totalMatches(replacements),
    diff: formatUnifiedDiff(prepared.filePath, prepared.originalContent, nextContent)
  }
}

function replacementResult(
  index: number,
  replaceAll: boolean,
  content: string,
  selected: ResolvedMatch[]
): ReplacementResult {
  const minConfidence = Math.min(...selected.map((match) => match.confidence))
  return {
    index,
    replaceAll,
    matches: selected.length,
    ranges: selected.map((match) => lineRangeForOffset(content, match.offset, match.length)),
    matchType: selected.some((match) => match.type === 'fuzzy')
      ? 'fuzzy'
      : selected.some((match) => match.type === 'whitespace')
        ? 'whitespace'
        : 'exact',
    confidence: minConfidence,
    ...(minConfidence < AUTO_APPLY_CONFIDENCE ? { requiresPreview: true } : {})
  }
}

function publicResult(plan: SearchReplacePlan, dryRun: boolean, backupPath?: string): SearchReplaceSuccess {
  return {
    ok: true,
    filePath: plan.filePath,
    dryRun,
    replacements: plan.replacements,
    successCount: plan.successCount,
    ...(backupPath ? { backupPath } : {}),
    diff: plan.diff
  }
}

function effectTargetError(
  plan: SearchReplacePlan,
  target: Extract<EffectTarget, { kind: 'file_content' }> | undefined
): string | undefined {
  if (!target) return undefined
  const expected = Buffer.from(plan.writeContent, 'utf8')
  if (
    target.rootPath !== plan.rootPath ||
    target.relativePath !== plan.relativePath ||
    target.preState !== 'file' ||
    target.preBytes !== plan.originalBytes ||
    target.preSha256 !== plan.originalSha256 ||
    target.expectedBytes !== expected.byteLength ||
    target.expectedSha256 !== sha256(expected) ||
    (target.rootIdentity && !sameIdentity(target.rootIdentity, plan.rootIdentity)) ||
    (target.preFileIdentity && !sameIdentity(target.preFileIdentity, plan.fileIdentity))
  ) {
    return '文件编辑目标与审批时冻结的 Effect 不一致，已阻止执行'
  }
  return undefined
}

async function currentPlanError(plan: SearchReplacePlan): Promise<string | undefined> {
  const current = await readUtf8TextFile(plan.filePath)
  if (current.ok === false) return `备份后无法重新验证目标文件:${current.error}`
  if (
    current.bytes !== plan.originalBytes ||
    current.sha256 !== plan.originalSha256 ||
    !sameIdentity(current.identity, plan.fileIdentity)
  ) {
    return '目标文件在备份后、写入前发生变化，已阻止覆盖'
  }
  return undefined
}

async function writeGuardedTextFile(
  filePath: string,
  content: string,
  guard: TextFileWriteGuard,
  beforeWriteCommit?: () => Promise<void> | void
): Promise<void> {
  const handle = await open(filePath, safeOpenFlags(constants.O_RDWR))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('目标路径不是文件')
    if (!sameIdentity(fileIdentity(before), guard.identity)) {
      throw new Error('目标文件身份在写入前发生变化，已阻止覆盖')
    }
    const current = await handle.readFile()
    if (current.byteLength !== guard.bytes || sha256(current) !== guard.sha256) {
      throw new Error('目标文件内容在写入前发生变化，已阻止覆盖')
    }
    await beforeWriteCommit?.()
    const commitTarget = await readUtf8TextFile(filePath)
    if (
      commitTarget.ok === false ||
      !sameIdentity(commitTarget.identity, guard.identity) ||
      commitTarget.bytes !== guard.bytes ||
      commitTarget.sha256 !== guard.sha256
    ) {
      throw new Error('目标路径在提交写入前发生变化，已阻止覆盖')
    }

    const output = Buffer.from(content, 'utf8')
    await handle.truncate(0)
    let offset = 0
    while (offset < output.length) {
      const written = await handle.write(output, offset, output.length - offset, offset)
      if (written.bytesWritten <= 0) throw new Error('目标文件写入未取得进展')
      offset += written.bytesWritten
    }
    await handle.truncate(output.length)
    await handle.sync()

    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('目标文件身份在写入期间发生变化')
    }
    const observed = Buffer.alloc(output.length)
    const bytesRead = output.length > 0
      ? (await handle.read(observed, 0, observed.length, 0)).bytesRead
      : 0
    const verified = await handle.stat({ bigint: true })
    if (
      verified.size !== BigInt(output.length) ||
      bytesRead !== output.length ||
      !observed.equals(output)
    ) {
      throw new Error('目标文件写入后置条件不匹配')
    }
    const currentPath = await readUtf8TextFile(filePath)
    if (
      currentPath.ok === false ||
      !sameIdentity(currentPath.identity, guard.identity) ||
      currentPath.bytes !== output.byteLength ||
      !currentPath.rawContent.equals(output)
    ) {
      throw new Error('目标路径在写入期间发生变化，写入结果未落在已批准路径')
    }
  } finally {
    await handle.close()
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileIdentity(info: { dev: number | bigint; ino: number | bigint }): FileSystemIdentity {
  return { device: String(info.dev), inode: String(info.ino) }
}

function sameIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
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
    const confidence = item.matchType === 'exact' ? '' : `, 匹配度=${formatConfidence(item.confidence)}`
    const preview = item.requiresPreview ? ', 已强制预览确认' : ''
    lines.push(
      `- replacement[${item.index}]: ${item.matches} 处, 行号 ${ranges}, replace_all=${item.replaceAll}, match=${item.matchType}${confidence}${preview}`
    )
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

async function readUtf8TextFile(
  filePath: string
): Promise<{
  ok: true
  content: string
  rawContent: Buffer
  identity: FileSystemIdentity
  sha256: string
  bytes: number
  hasUtf8Bom: boolean
} | { ok: false; error: string }> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, safeOpenFlags(constants.O_RDONLY))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) return { ok: false, error: '目标路径不是文件' }
    if (before.size > BigInt(MAX_FILE_BYTES)) {
      return { ok: false, error: `文件过大:${before.size} bytes, 上限 ${MAX_FILE_BYTES} bytes` }
    }
    const buffer = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const current = await lstat(filePath, { bigint: true })
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs
    ) {
      return { ok: false, error: '读取期间目标文件发生变化，请重新预览后再编辑' }
    }
    if (buffer.includes(0)) return { ok: false, error: '目标文件看起来是二进制内容,已跳过' }
    try {
      return {
        ok: true,
        content: new TextDecoder('utf-8', { fatal: true }).decode(buffer),
        rawContent: buffer,
        identity: fileIdentity(before),
        sha256: sha256(buffer),
        bytes: buffer.byteLength,
        hasUtf8Bom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      }
    } catch {
      return { ok: false, error: '目标文件不是有效 UTF-8 文本' }
    }
  } finally {
    await handle.close()
  }
}

function safeOpenFlags(baseFlags: number): number {
  let flags = baseFlags
  if (process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number') flags |= constants.O_NOFOLLOW
  if (process.platform !== 'win32' && typeof constants.O_NONBLOCK === 'number') flags |= constants.O_NONBLOCK
  return flags
}

function resolveMatches(content: string, needle: string, allowPreviewMatch: boolean): ResolvedMatchSet {
  const exact = findExactMatches(content, needle)
  if (exact.length > 0) return { matches: exact, bestConfidence: 1 }

  const approximate = findApproximateMatches(content, needle)
  const best = approximate[0]
  const bestConfidence = best?.confidence ?? 0
  const threshold = allowPreviewMatch ? PREVIEW_CONFIDENCE : AUTO_APPLY_CONFIDENCE
  return {
    matches: approximate.filter((match) => match.confidence >= threshold),
    bestConfidence
  }
}

function findExactMatches(content: string, needle: string): ResolvedMatch[] {
  const matches: ResolvedMatch[] = []
  let start = 0
  while (start <= content.length) {
    const index = content.indexOf(needle, start)
    if (index === -1) break
    matches.push({ offset: index, length: needle.length, confidence: 1, type: 'exact' })
    start = index + Math.max(needle.length, 1)
  }
  return matches
}

function findApproximateMatches(content: string, needle: string): ResolvedMatch[] {
  const compactNeedle = compactForMatch(needle)
  if (compactNeedle.length === 0) return []

  const whitespaceMatches = findWhitespaceInsensitiveMatches(content, needle, compactNeedle)
  if (whitespaceMatches.length > 0) return whitespaceMatches

  return findFuzzyLineWindowMatches(content, needle, compactNeedle)
}

function findWhitespaceInsensitiveMatches(
  content: string,
  needle: string,
  compactNeedle: string
): ResolvedMatch[] {
  const compact = compactWithMap(content)
  const matches: ResolvedMatch[] = []
  let cursor = 0
  while (cursor <= compact.text.length) {
    const index = compact.text.indexOf(compactNeedle, cursor)
    if (index === -1) break
    const first = compact.map[index]
    const last = compact.map[index + compactNeedle.length - 1]
    const range = expandApproximateRange(content, needle, first, last + 1)
    matches.push({
      offset: range.start,
      length: range.end - range.start,
      confidence: 1,
      type: 'whitespace'
    })
    cursor = index + Math.max(compactNeedle.length, 1)
  }
  return dedupeMatches(matches)
}

function findFuzzyLineWindowMatches(content: string, needle: string, compactNeedle: string): ResolvedMatch[] {
  if (compactNeedle.length > MAX_LEVENSHTEIN_CHARS) return []
  const lines = splitLineRecords(content)
  if (lines.length === 0) return []

  const needleLineCount = Math.max(1, splitLines(needle).filter((line) => line.trim()).length)
  const minLines = Math.max(1, needleLineCount - FUZZY_LINE_WINDOW_DELTA)
  const maxLines = Math.max(minLines, needleLineCount + FUZZY_LINE_WINDOW_DELTA)
  const candidates: ResolvedMatch[] = []

  for (let start = 0; start < lines.length; start++) {
    for (let count = minLines; count <= maxLines && start + count <= lines.length; count++) {
      const endLine = lines[start + count - 1]
      const startOffset = lines[start].start
      const endOffset = endLine.end
      if (endOffset <= startOffset) continue
      const candidate = content.slice(startOffset, endOffset)
      const compactCandidate = compactForMatch(candidate)
      if (!compactCandidate) continue
      const lengthRatio = Math.min(compactCandidate.length, compactNeedle.length) / Math.max(compactCandidate.length, compactNeedle.length)
      if (lengthRatio < PREVIEW_CONFIDENCE) continue
      const confidence = normalizedLevenshteinSimilarity(compactNeedle, compactCandidate)
      if (confidence < PREVIEW_CONFIDENCE) continue
      candidates.push({
        offset: startOffset,
        length: endOffset - startOffset,
        confidence,
        type: 'fuzzy'
      })
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.offset - b.offset || a.length - b.length)
  return dedupeMatches(candidates).slice(0, SIMILAR_SNIPPET_COUNT)
}

function dedupeMatches(matches: ResolvedMatch[]): ResolvedMatch[] {
  const out: ResolvedMatch[] = []
  const seen = new Set<string>()
  for (const match of matches) {
    const key = `${match.offset}:${match.length}`
    if (seen.has(key)) continue
    if (out.some((existing) => rangesOverlap(existing, match))) continue
    seen.add(key)
    out.push(match)
  }
  return out
}

function rangesOverlap(a: ResolvedMatch, b: ResolvedMatch): boolean {
  return a.offset < b.offset + b.length && b.offset < a.offset + a.length
}

function replaceResolvedMatches(content: string, matches: ResolvedMatch[], newStr: string): string {
  let next = ''
  let cursor = 0
  for (const match of [...matches].sort((a, b) => a.offset - b.offset)) {
    next += content.slice(cursor, match.offset)
    next += newStr
    cursor = match.offset + match.length
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

function snippetsForMatches(content: string, matches: ResolvedMatch[]): string[] {
  const contentLines = splitLines(content)
  return matches.slice(0, SIMILAR_SNIPPET_COUNT).map((match) => {
    const lineIndex = Math.max(0, lineNumberAt(content, match.offset) - 1)
    const endLine = Math.max(lineIndex, lineNumberAt(content, match.offset + match.length) - 1)
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

function compactForMatch(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase()
}

function compactWithMap(text: string): { text: string; map: number[] } {
  let compact = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue
    compact += text[i].toLowerCase()
    map.push(i)
  }
  return { text: compact, map }
}

function expandApproximateRange(
  content: string,
  needle: string,
  start: number,
  end: number
): { start: number; end: number } {
  const spansMultipleLines = splitLines(needle).filter((line) => line.trim()).length > 1
  if (!spansMultipleLines) return { start, end }
  return {
    start: lineStartAt(content, start),
    end: lineEndAt(content, end)
  }
}

function lineStartAt(content: string, offset: number): number {
  return content.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
}

function lineEndAt(content: string, offset: number): number {
  const next = content.indexOf('\n', offset)
  return next === -1 ? content.length : next
}

interface LineRecord {
  start: number
  end: number
}

function splitLineRecords(text: string): LineRecord[] {
  const lines: LineRecord[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') continue
    const rawEnd = i > start && text[i - 1] === '\r' ? i - 1 : i
    lines.push({ start, end: rawEnd })
    start = i + 1
  }
  return lines.length ? lines : [{ start: 0, end: text.length }]
}

function normalizedLevenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  if (a.length > MAX_LEVENSHTEIN_CHARS || b.length > MAX_LEVENSHTEIN_CHARS) return 0
  const distance = levenshteinDistance(a, b)
  return 1 - distance / Math.max(a.length, b.length)
}

function levenshteinDistance(a: string, b: string): number {
  const previous = new Array<number>(b.length + 1)
  const current = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) previous[j] = j
  for (let i = 1; i <= a.length; i++) {
    current[0] = i
    const left = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = left === b.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]
  }
  return previous[b.length]
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`
}
