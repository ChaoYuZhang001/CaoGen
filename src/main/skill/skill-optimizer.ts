import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { SkillManager } from './skill-manager'
import { testSkillMarkdown, type SkillTestDiagnostic } from './skill-tester'
import type { SkillDefinition } from './skill-loader'

export type SkillFeedbackOutcome = 'failed' | 'corrected' | 'succeeded'

export interface SkillFeedbackInput {
  projectRoot: string
  skillIdOrName: string
  outcome: SkillFeedbackOutcome
  summary: string
  correctionSteps?: string[]
  verification?: string[]
  occurredAt?: number
  failureThreshold?: number
}

export type SkillOptimizationStatus =
  | 'recorded'
  | 'updated'
  | 'not_found'
  | 'not_project_skill'
  | 'validation_failed'

export interface SkillFeedbackRecord {
  id: string
  outcome: SkillFeedbackOutcome
  summary: string
  correctionSteps: string[]
  verification: string[]
  occurredAt: number
}

export interface SkillFeedbackStore {
  skillId: string
  skillName: string
  records: SkillFeedbackRecord[]
  appliedRecordIds: string[]
}

export interface SkillOptimizationResult {
  status: SkillOptimizationStatus
  skillId?: string
  skillName?: string
  skillPath?: string
  feedbackPath?: string
  applied?: boolean
  recordCount?: number
  diagnostics?: SkillTestDiagnostic[]
  reason?: string
}

const DEFAULT_FAILURE_THRESHOLD = 2
const MAX_RECORDS = 50
const MAX_TEXT_CHARS = 1_200

export async function recordSkillFeedback(input: SkillFeedbackInput): Promise<SkillOptimizationResult> {
  const projectRoot = resolve(input.projectRoot)
  const skillRoot = resolve(projectRoot, '.caogen', 'skills')
  const skill = findProjectSkill(projectRoot, input.skillIdOrName)
  if (!skill) return { status: 'not_found', reason: `未找到 Skill: ${input.skillIdOrName}` }
  if (skill.scope !== 'project' || !skill.sourcePath) {
    return { status: 'not_project_skill', skillId: skill.id, skillName: skill.name, reason: '仅项目本地 Skill 可自动优化。' }
  }

  const skillPath = resolve(skill.sourcePath)
  assertInside(skillRoot, skillPath)
  const feedbackPath = join(dirname(skillPath), 'skill-feedback.json')
  assertInside(skillRoot, feedbackPath)

  const store = readFeedbackStore(feedbackPath, skill)
  const record = normalizeRecord(input)
  const known = new Set(store.records.map((item) => item.id))
  if (!known.has(record.id)) {
    store.records.push(record)
    store.records = store.records.slice(-MAX_RECORDS)
  }

  const shouldApply = shouldApplyOptimization(store, record, normalizeThreshold(input.failureThreshold))
  if (!shouldApply) {
    await writeFeedbackStore(feedbackPath, store)
    return {
      status: 'recorded',
      skillId: skill.id,
      skillName: skill.name,
      skillPath,
      feedbackPath,
      applied: false,
      recordCount: store.records.length
    }
  }

  const markdown = readFileSync(skillPath, 'utf8')
  const nextMarkdown = appendOptimizationSection(markdown, skill, store, record)
  const validation = testSkillMarkdown(nextMarkdown, { sourcePath: skillPath, scope: 'project' })
  if (!validation.ok) {
    await writeFeedbackStore(feedbackPath, store)
    return {
      status: 'validation_failed',
      skillId: skill.id,
      skillName: skill.name,
      skillPath,
      feedbackPath,
      applied: false,
      recordCount: store.records.length,
      diagnostics: validation.diagnostics
    }
  }

  store.appliedRecordIds = unique([...store.appliedRecordIds, record.id])
  await writeTextAtomically(skillPath, nextMarkdown)
  await writeFeedbackStore(feedbackPath, store)
  return {
    status: 'updated',
    skillId: skill.id,
    skillName: skill.name,
    skillPath,
    feedbackPath,
    applied: true,
    recordCount: store.records.length,
    diagnostics: validation.diagnostics
  }
}

export async function applySkillCorrection(
  input: Omit<SkillFeedbackInput, 'outcome'> & { summary: string; correctionSteps: string[] }
): Promise<SkillOptimizationResult> {
  return recordSkillFeedback({ ...input, outcome: 'corrected', failureThreshold: 1 })
}

function findProjectSkill(projectRoot: string, idOrName: string): SkillDefinition | undefined {
  const manager = new SkillManager({ projectRoot })
  const needle = idOrName.trim().toLowerCase()
  return (
    manager.list().find((item) => item.id === idOrName || item.name.toLowerCase() === needle) ??
    manager.match(idOrName, 0.1).find((match) => match.skill.scope === 'project')?.skill
  )
}

function normalizeRecord(input: SkillFeedbackInput): SkillFeedbackRecord {
  const summary = cleanText(input.summary, MAX_TEXT_CHARS)
  const correctionSteps = cleanList(input.correctionSteps)
  const verification = cleanList(input.verification)
  const occurredAt = input.occurredAt ?? Date.now()
  const id = createHash('sha256')
    .update([input.skillIdOrName, input.outcome, summary, correctionSteps.join('\n'), verification.join('\n')].join('\0'))
    .digest('hex')
    .slice(0, 16)
  return { id, outcome: input.outcome, summary, correctionSteps, verification, occurredAt }
}

function readFeedbackStore(feedbackPath: string, skill: SkillDefinition): SkillFeedbackStore {
  if (!existsSync(feedbackPath)) {
    return { skillId: skill.id, skillName: skill.name, records: [], appliedRecordIds: [] }
  }
  try {
    const parsed = JSON.parse(readFileSync(feedbackPath, 'utf8')) as Partial<SkillFeedbackStore>
    return {
      skillId: typeof parsed.skillId === 'string' ? parsed.skillId : skill.id,
      skillName: typeof parsed.skillName === 'string' ? parsed.skillName : skill.name,
      records: Array.isArray(parsed.records) ? parsed.records.filter(isFeedbackRecord).slice(-MAX_RECORDS) : [],
      appliedRecordIds: Array.isArray(parsed.appliedRecordIds)
        ? parsed.appliedRecordIds.filter((item): item is string => typeof item === 'string')
        : []
    }
  } catch {
    return { skillId: skill.id, skillName: skill.name, records: [], appliedRecordIds: [] }
  }
}

function shouldApplyOptimization(store: SkillFeedbackStore, record: SkillFeedbackRecord, threshold: number): boolean {
  if (store.appliedRecordIds.includes(record.id)) return false
  if (record.outcome === 'corrected') return true
  if (record.outcome !== 'failed') return false
  const unappliedFailures = store.records.filter(
    (item) => item.outcome === 'failed' && !store.appliedRecordIds.includes(item.id)
  )
  return unappliedFailures.length >= threshold
}

function appendOptimizationSection(
  markdown: string,
  skill: SkillDefinition,
  store: SkillFeedbackStore,
  record: SkillFeedbackRecord
): string {
  const relatedRecords = relatedOptimizationRecords(store, record)
  const lines = [
    '',
    '## 自动优化记录',
    '',
    `- 更新时间: ${new Date(record.occurredAt).toISOString()}`,
    `- 触发原因: ${record.outcome === 'corrected' ? '用户修正' : '累计失败反馈'}`,
    `- Skill: ${skill.name}`,
    ...relatedRecords.map((item) => `- 反馈: ${item.summary}`)
  ]
  const correctionSteps = unique(relatedRecords.flatMap((item) => item.correctionSteps))
  if (correctionSteps.length > 0) {
    lines.push('', '### 修正步骤', ...correctionSteps.map((item, index) => `${index + 1}. ${item}`))
  }
  const verification = unique(relatedRecords.flatMap((item) => item.verification))
  if (verification.length > 0) {
    lines.push('', '### 新增验证', ...verification.map((item, index) => `${index + 1}. ${item}`))
  }
  return `${markdown.trimEnd()}\n${lines.join('\n')}\n`
}

function relatedOptimizationRecords(store: SkillFeedbackStore, record: SkillFeedbackRecord): SkillFeedbackRecord[] {
  if (record.outcome === 'corrected') return [record]
  return store.records
    .filter((item) => item.outcome === 'failed' && !store.appliedRecordIds.includes(item.id))
    .slice(-DEFAULT_FAILURE_THRESHOLD)
}

async function writeFeedbackStore(feedbackPath: string, store: SkillFeedbackStore): Promise<void> {
  await writeTextAtomically(feedbackPath, `${JSON.stringify(store, null, 2)}\n`)
}

async function writeTextAtomically(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function assertInside(root: string, target: string): void {
  const fromRoot = relative(resolve(root), resolve(target))
  if (fromRoot === '') return
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`路径不在受控 Skill 目录内: ${target}`)
  }
}

function cleanText(value: string, max: number): string {
  return value
    .replace(/\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function cleanList(value: string[] | undefined): string[] {
  return (value ?? [])
    .map((item) => cleanText(item, 360))
    .filter(Boolean)
    .slice(0, 12)
}

function normalizeThreshold(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value < 1) return DEFAULT_FAILURE_THRESHOLD
  return Math.min(5, value)
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))]
}

function isFeedbackRecord(value: unknown): value is SkillFeedbackRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    (record.outcome === 'failed' || record.outcome === 'corrected' || record.outcome === 'succeeded') &&
    typeof record.summary === 'string' &&
    Array.isArray(record.correctionSteps) &&
    Array.isArray(record.verification) &&
    typeof record.occurredAt === 'number'
  )
}
