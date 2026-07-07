import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentEvent, SessionMeta, TranscriptEntry } from '../../shared/types'
import { SkillLearner } from './skill-learner'
import { testSkillMarkdown, type SkillTestDiagnostic } from './skill-tester'

export interface AutoSkillReviewInput {
  meta: SessionMeta
  transcript: TranscriptEntry[]
  event: Extract<AgentEvent, { kind: 'turn-result' }>
}

export interface AutoSkillReviewOptions {
  enabled: boolean
  skillRoot?: string
  now?: () => number
}

export type AutoSkillReviewStatus = 'disabled' | 'skipped' | 'stored' | 'validation_failed'

export interface AutoSkillReviewResult {
  status: AutoSkillReviewStatus
  path?: string
  diagnostics?: SkillTestDiagnostic[]
  reason?: string
}

const DEFAULT_MAX_SUMMARY_CHARS = 5_000
const MIN_SUMMARY_CHARS = 80

type AssistantMessageEvent = Extract<AgentEvent, { kind: 'assistant-message' }>
type ToolResultEvent = Extract<AgentEvent, { kind: 'tool-result' }>
type TextAssistantBlock = Extract<AssistantMessageEvent['blocks'][number], { type: 'text' }>

export async function runAutoSkillReview(
  input: AutoSkillReviewInput,
  options: AutoSkillReviewOptions
): Promise<AutoSkillReviewResult> {
  if (!options.enabled) return { status: 'disabled', reason: 'auto skill review is disabled' }
  if (input.event.isError) return { status: 'skipped', reason: 'failed turns are not stored as skills' }

  const projectRoot = resolve(input.meta.sourceCwd ?? input.meta.repoRoot ?? input.meta.cwd)
  const skillRoot = resolve(options.skillRoot ?? join(projectRoot, '.caogen', 'skills'))
  const controlledRoot = resolve(projectRoot, '.caogen', 'skills')
  assertInside(controlledRoot, skillRoot)

  const summary = buildReviewSummary(input)
  if (summary.length < MIN_SUMMARY_CHARS) {
    return { status: 'skipped', reason: 'not enough durable task content to extract a skill' }
  }

  const learner = new SkillLearner({
    defaultTags: ['auto-skill', 'p2-002'],
    maxSummaryChars: DEFAULT_MAX_SUMMARY_CHARS
  })
  const draft = learner.draft({
    title: inferSkillTitle(input.meta, summary),
    description: `任务完成后自动复盘沉淀: ${input.meta.title}`,
    taskSummary: summary,
    trigger: inferTrigger(input.meta, summary),
    tags: ['review', 'verification'],
    verification: ['确认生成的 SKILL.md 通过结构和安全静态校验。'],
    notes: ['自动沉淀默认关闭；启用后仍建议人工复核再长期复用。']
  })

  const validation = testSkillMarkdown(draft.markdown, { sourcePath: 'auto-review/SKILL.md', scope: 'project' })
  const diagnostics = [...draft.diagnostics, ...validation.diagnostics]
  if (!draft.ok || !validation.ok) return { status: 'validation_failed', diagnostics }

  const dir = nextSkillDir(skillRoot, draft.name, summary)
  assertInside(skillRoot, dir)
  const target = join(dir, 'SKILL.md')
  assertInside(skillRoot, target)
  await writeSkillAtomically(dir, target, draft.markdown)
  return { status: 'stored', path: target, diagnostics }
}

export function scheduleAutoSkillReview(input: AutoSkillReviewInput, options: AutoSkillReviewOptions): void {
  void runAutoSkillReview(input, options).catch((err: unknown) => {
    // 自动沉淀不能影响原任务完成链路，只记录后台错误。
    console.error('[caogen] 自动 Skill 沉淀失败:', err)
  })
}

export function buildReviewSummary(input: AutoSkillReviewInput): string {
  const latestUser = latestEvent(input.transcript, 'user-message')
  const assistantTexts = input.transcript
    .filter((entry): entry is TranscriptEntry & { event: AssistantMessageEvent } => entry.event.kind === 'assistant-message')
    .flatMap((entry) =>
      entry.event.blocks
        .filter((block): block is TextAssistantBlock => block.type === 'text')
        .map((block) => redactSensitiveText(block.text))
    )
    .slice(-3)
  const toolEvidence = input.transcript
    .filter((entry): entry is TranscriptEntry & { event: ToolResultEvent } => entry.event.kind === 'tool-result')
    .map((entry) => `${entry.event.isError ? '失败' : '成功'}: ${redactSensitiveText(entry.event.content)}`)
    .slice(-6)

  const sections = [
    `会话标题: ${input.meta.title}`,
    `项目标识: ${basename(input.meta.cwd) || 'project'}`,
    latestUser ? `用户任务: ${redactSensitiveText(latestUser.text)}` : '',
    input.event.resultText ? `完成结果: ${redactSensitiveText(input.event.resultText)}` : '',
    assistantTexts.length > 0 ? `复盘材料:\n${assistantTexts.map((item) => `- ${compact(item, 800)}`).join('\n')}` : '',
    toolEvidence.length > 0 ? `验证证据:\n${toolEvidence.map((item) => `- ${compact(item, 500)}`).join('\n')}` : ''
  ].filter((item) => item.trim().length > 0)

  return compact(sections.join('\n\n'), DEFAULT_MAX_SUMMARY_CHARS)
}

function latestEvent<K extends AgentEvent['kind']>(
  transcript: TranscriptEntry[],
  kind: K
): Extract<AgentEvent, { kind: K }> | undefined {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const event = transcript[index]?.event
    if (event?.kind === kind) return event as Extract<AgentEvent, { kind: K }>
  }
  return undefined
}

function inferSkillTitle(meta: SessionMeta, summary: string): string {
  const title = cleanTitle(meta.title)
  if (title && title !== '新会话') return title
  const firstLine = summary.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
  return firstLine ? cleanTitle(firstLine) ?? '自动复盘 Skill' : '自动复盘 Skill'
}

function inferTrigger(meta: SessionMeta, summary: string): string {
  return [meta.title, ...(summary.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
    .map((item) => item.toLowerCase().trim())
    .filter((item, index, all) => item.length > 1 && all.indexOf(item) === index)
    .slice(0, 8)
    .join(' ')
}

function nextSkillDir(root: string, name: string, summary: string): string {
  const slug = slugify(name)
  const hash = createHash('sha256').update(`${name}\0${summary}`).digest('hex').slice(0, 8)
  const base = join(root, `${slug}-${hash}`)
  if (!existsSync(base)) return base
  return join(root, `${slug}-${hash}-${Date.now().toString(36)}`)
}

async function writeSkillAtomically(dir: string, target: string, markdown: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    await writeFile(temp, markdown, 'utf8')
    await rename(temp, target)
  } catch (err) {
    await unlink(temp).catch(() => undefined)
    throw err
  }
}

function assertInside(root: string, target: string): void {
  const fromRoot = relative(resolve(root), resolve(target))
  if (fromRoot === '') return
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`路径不在受控 Skill 目录内: ${target}`)
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'auto-skill'
}

function cleanTitle(value: string): string | undefined {
  const clean = value.replace(/\s+/g, ' ').trim().replace(/[<>:"/\\|?*]+/g, '-')
  return clean ? compact(clean, 48) : undefined
}

function compact(value: string, max: number): string {
  const clean = value.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trim()}…`
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_KEY]')
}
