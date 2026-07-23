import type { MemoryLayer, MemoryWriteInput } from './memory-manager'
import {
  shouldExtractMemory,
  summarizeMemoryTitle
} from './memory-writer'
import {
  proposeMemoryDraft,
  type ProjectMemoryDraft,
  type ProjectMemoryDraftInput
} from '../memoryStore'

export type MemoryLoopOutcome = 'success' | 'partial' | 'failure'

export interface MemoryLoopReviewInput {
  title: string
  outcome: MemoryLoopOutcome
  summary?: string
  transcript?: string | string[]
  failures?: string | string[]
  rootCause?: string
  nextAction?: string
  verification?: string | string[]
  preferences?: string | string[]
  preferenceLayer?: Extract<MemoryLayer, 'project' | 'user'>
  projectRoot?: string
  source?: string
  maxDrafts?: number
}

export interface MemoryLoopSuggestion {
  kind: 'failure-review' | 'preference-review'
  title: string
  body: string
  priority: 'high' | 'medium'
}

export interface MemoryLoopReview {
  title: string
  outcome: MemoryLoopOutcome
  projectDrafts: ProjectMemoryDraftInput[]
  layeredMemories: MemoryWriteInput[]
  suggestions: MemoryLoopSuggestion[]
}

export interface PersistMemoryLoopInput {
  memoryRoot: string
  projectRoot: string
  review: MemoryLoopReviewInput
}

export interface PersistMemoryLoopResult {
  review: MemoryLoopReview
  drafts: ProjectMemoryDraft[]
  layered: []
}

const FAILURE_RE = /\b(failed|failure|error|exception|crash|blocked|timeout|timed out|cancelled)\b|失败|报错|异常|崩溃|阻塞|超时|取消|根因/i
const OUTCOME_LABEL: Record<MemoryLoopOutcome, string> = {
  success: '成功',
  partial: '部分完成',
  failure: '失败'
}

export function buildMemoryLoopReview(input: MemoryLoopReviewInput): MemoryLoopReview {
  const title = clip(requireText(input.title, 'title'), 90)
  const outcome = normalizeOutcome(input.outcome)
  const source = normalizeText(input.source) ?? 'memory-loop'
  const transcriptText = normalizeTranscript(input.transcript)
  const summary = normalizeText(input.summary)
  const failures = uniqueLines([...normalizeLines(input.failures), ...extractFailureSignals(transcriptText)])
  const preferences = uniqueLines([
    ...normalizeLines(input.preferences),
    ...extractPreferenceSignals(transcriptText)
  ])
  const verification = uniqueLines(normalizeLines(input.verification))
  const rootCause = normalizeText(input.rootCause)
  const nextAction = normalizeText(input.nextAction)
  const maxDrafts = clampMaxDrafts(input.maxDrafts)
  const projectDrafts: ProjectMemoryDraftInput[] = []
  const layeredMemories: MemoryWriteInput[] = []
  const suggestions: MemoryLoopSuggestion[] = []

  if (summary) {
    const body = renderTaskReviewBody({
      outcome,
      summary,
      failures,
      rootCause,
      nextAction,
      verification
    })
    projectDrafts.push({
      kind: 'task-retrospective',
      title: `任务复盘: ${title}`,
      body,
      source,
      reason: outcome === 'success' ? '任务完成后沉淀可复用上下文' : '任务结束后沉淀当前真实状态'
    })
    layeredMemories.push(memoryWriteInput({
      layer: 'working',
      projectRoot: input.projectRoot,
      title: `任务复盘: ${title}`,
      body,
      source,
      tags: ['任务复盘', OUTCOME_LABEL[outcome]]
    }))
  }

  if (outcome !== 'success' || failures.length > 0 || rootCause || nextAction) {
    const body = renderFailureBody({ failures, rootCause, nextAction, verification })
    projectDrafts.push({
      kind: 'failure-retrospective',
      title: `失败复盘: ${title}`,
      body,
      source,
      reason: '失败或未完成任务需要形成下次开工前可检索的复盘建议'
    })
    layeredMemories.push(memoryWriteInput({
      layer: 'project',
      projectRoot: input.projectRoot,
      title: `失败复盘: ${title}`,
      body,
      source,
      tags: ['失败复盘', '踩坑']
    }))
    suggestions.push({
      kind: 'failure-review',
      title: `复盘失败点: ${title}`,
      body: nextAction ?? rootCause ?? failures[0] ?? '先复现第一个可观察失败,再收敛到最小修复。',
      priority: 'high'
    })
  }

  for (const preference of preferences.slice(0, Math.max(0, maxDrafts - projectDrafts.length))) {
    const preferenceTitle = clip(summarizeMemoryTitle(preference), 90)
    const layer = input.preferenceLayer ?? 'project'
    projectDrafts.push({
      kind: 'preference',
      title: preferenceTitle,
      body: preference,
      source,
      reason: '用户偏好或长期约定,需要确认后进入项目记忆'
    })
    layeredMemories.push(memoryWriteInput({
      layer,
      projectRoot: layer === 'project' ? input.projectRoot : undefined,
      title: preferenceTitle,
      body: preference,
      source,
      tags: ['偏好学习']
    }))
    suggestions.push({
      kind: 'preference-review',
      title: `确认偏好: ${preferenceTitle}`,
      body: preference,
      priority: 'medium'
    })
  }

  return {
    title,
    outcome,
    projectDrafts: projectDrafts.slice(0, maxDrafts),
    layeredMemories,
    suggestions
  }
}

export async function persistMemoryLoopReview(input: PersistMemoryLoopInput): Promise<PersistMemoryLoopResult> {
  const memoryRoot = requireText(input.memoryRoot, 'memoryRoot')
  const projectRoot = requireText(input.projectRoot, 'projectRoot')
  const review = buildMemoryLoopReview({
    ...input.review,
    projectRoot: input.review.projectRoot ?? projectRoot
  })
  const drafts: ProjectMemoryDraft[] = []

  for (const draft of review.projectDrafts) {
    drafts.push(await proposeMemoryDraft(projectRoot, memoryRoot, draft))
  }

  return { review, drafts, layered: [] }
}

function renderTaskReviewBody(input: {
  outcome: MemoryLoopOutcome
  summary: string
  failures: string[]
  rootCause?: string
  nextAction?: string
  verification: string[]
}): string {
  const lines = [
    `结果: ${OUTCOME_LABEL[input.outcome]}`,
    `摘要: ${input.summary}`,
    renderList('验证', input.verification),
    input.failures.length > 0 ? renderList('失败信号', input.failures) : '',
    input.rootCause ? `根因: ${input.rootCause}` : '',
    input.nextAction ? `下次建议: ${input.nextAction}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

function renderFailureBody(input: {
  failures: string[]
  rootCause?: string
  nextAction?: string
  verification: string[]
}): string {
  const lines = [
    renderList('现象', input.failures.length > 0 ? input.failures : ['未提供具体失败文本']),
    input.rootCause ? `根因: ${input.rootCause}` : '根因: 未确认',
    input.nextAction ? `下次建议: ${input.nextAction}` : '下次建议: 先复现第一个可观察失败,再做最小修复。',
    renderList('验证', input.verification)
  ]
  return lines.filter(Boolean).join('\n')
}

function renderList(label: string, values: string[]): string {
  if (values.length === 0) return `${label}: 未提供`
  if (values.length === 1) return `${label}: ${values[0]}`
  return `${label}:\n${values.map((value) => `- ${value}`).join('\n')}`
}

function extractFailureSignals(text: string): string[] {
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8 && FAILURE_RE.test(line))
    .slice(-6)
}

function extractPreferenceSignals(text: string): string[] {
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => shouldExtractMemory(line))
    .slice(-6)
}

function memoryWriteInput(input: MemoryWriteInput): MemoryWriteInput {
  return {
    ...input,
    title: requireText(input.title, 'title'),
    body: requireText(input.body, 'body'),
    source: requireText(input.source, 'source'),
    tags: input.tags?.filter(Boolean)
  }
}

function normalizeOutcome(value: MemoryLoopOutcome): MemoryLoopOutcome {
  if (value === 'success' || value === 'partial' || value === 'failure') return value
  return 'partial'
}

function normalizeTranscript(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join('\n') : (normalizeText(value) ?? '')
}

function normalizeLines(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => normalizeText(item)).filter(isText)
  const text = normalizeText(value)
  if (!text) return []
  return text.split(/\r?\n/).map((line) => normalizeText(line)).filter(isText)
}

function uniqueLines(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim()
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function requireText(value: unknown, field: string): string {
  const normalized = normalizeText(value)
  if (!normalized) throw new Error(`${field} 不能为空`)
  if (normalized.includes('\0')) throw new Error(`${field} 包含非法字符`)
  return normalized
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

function isText(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

function clampMaxDrafts(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 8
  return Math.max(1, Math.min(20, Math.floor(value)))
}
