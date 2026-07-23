import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  createLearningDraft,
  getLearningRecord,
  importSkillLearningBaseline
} from '../learning/learning-lifecycle'
import { resolveDefaultLearningRoot } from '../learning/learning-store'
import { SkillManager } from './skill-manager'
import { testSkillMarkdown, type SkillTestDiagnostic } from './skill-tester'
import type { SkillDefinition } from './skill-loader'
import type { LearningStatus } from '../../shared/learning-types'

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
  | 'drafted'
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
  /** Legacy ids from releases that directly materialized optimization output. */
  appliedRecordIds: string[]
  draftedRecordIds: string[]
  learningDraftIds: Record<string, string>
}

export interface SkillOptimizationResult {
  status: SkillOptimizationStatus
  skillId?: string
  skillName?: string
  skillPath?: string
  feedbackPath?: string
  applied?: false
  draftId?: string
  draftStatus?: LearningStatus
  recordCount?: number
  diagnostics?: SkillTestDiagnostic[]
  reason?: string
}

interface SkillOptimizationContext {
  projectRoot: string
  skillRoot: string
  learningRoot: string
  skill: SkillDefinition
  skillPath: string
  feedbackPath: string
  store: SkillFeedbackStore
  record: SkillFeedbackRecord
}

const DEFAULT_FAILURE_THRESHOLD = 2
const MAX_RECORDS = 50
const MAX_TEXT_CHARS = 1_200

export async function proposeSkillOptimization(input: SkillFeedbackInput): Promise<SkillOptimizationResult> {
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
  const normalizedRecord = normalizeRecord(input)
  const existingRecord = store.records.find((item) => item.id === normalizedRecord.id)
  const record = existingRecord ?? normalizedRecord
  if (!existingRecord) {
    store.records.push(normalizedRecord)
    store.records = store.records.slice(-MAX_RECORDS)
  }

  // Unbound ids came from the pre-Learning sidecar schema and cannot prove a live proposal.
  store.draftedRecordIds = store.draftedRecordIds.filter((id) => Boolean(store.learningDraftIds[id]))
  const learningRoot = await resolveDefaultLearningRoot(projectRoot)
  const context = { projectRoot, skillRoot, learningRoot, skill, skillPath, feedbackPath, store, record }
  const boundResult = await resolveBoundProposal(context)
  if (boundResult) return boundResult
  if (!shouldDraftOptimization(store, record, normalizeThreshold(input.failureThreshold))) {
    return recordFeedbackOnly(context)
  }
  return createSkillOptimizationProposal(context)
}

async function resolveBoundProposal(context: SkillOptimizationContext): Promise<SkillOptimizationResult | undefined> {
  const boundDraftId = context.store.learningDraftIds[context.record.id]
  if (!boundDraftId) return undefined
  const boundRecord = await getLearningRecord(context.projectRoot, context.learningRoot, boundDraftId)
  if (!boundRecord || isRetryableProposalStatus(boundRecord.status)) {
    releaseBoundFeedback(context.store, boundDraftId)
    return undefined
  }
  return {
    status: boundRecord.status === 'draft' ? 'drafted' : 'recorded',
    skillId: context.skill.id,
    skillName: context.skill.name,
    skillPath: context.skillPath,
    feedbackPath: context.feedbackPath,
    ...(boundRecord.status === 'draft' ? { applied: false as const } : {}),
    draftId: boundRecord.id,
    draftStatus: boundRecord.status,
    recordCount: context.store.records.length
  }
}

async function recordFeedbackOnly(context: SkillOptimizationContext): Promise<SkillOptimizationResult> {
  await writeFeedbackSidecar(context.feedbackPath, context.store)
  return {
    status: 'recorded',
    skillId: context.skill.id,
    skillName: context.skill.name,
    skillPath: context.skillPath,
    feedbackPath: context.feedbackPath,
    applied: false,
    recordCount: context.store.records.length
  }
}

async function createSkillOptimizationProposal(context: SkillOptimizationContext): Promise<SkillOptimizationResult> {
  const markdown = readFileSync(context.skillPath, 'utf8')
  const nextMarkdown = appendOptimizationSection(markdown, context.skill, context.store, context.record)
  const validation = testSkillMarkdown(nextMarkdown, { sourcePath: context.skillPath, scope: 'project' })
  if (!validation.ok) return persistValidationFailure(context, validation.diagnostics)

  // Persist the feedback first so a crash/retry rebuilds the exact same proposal.
  await writeFeedbackSidecar(context.feedbackPath, context.store)
  const relativePath = relative(context.skillRoot, context.skillPath).split('\\').join('/')
  const baseline = await importSkillLearningBaseline(context.projectRoot, context.learningRoot, {
    type: 'skill',
    name: context.skill.name,
    description: context.skill.description,
    markdown,
    relativePath
  })
  const proposal = baseline.status === 'draft' && baseline.payload.type === 'skill' && baseline.payload.markdown === nextMarkdown.trim()
    ? baseline
    : await createLearningDraft(context.projectRoot, context.learningRoot, {
      kind: 'skill',
      source: `optimize_skill:${context.record.outcome}`,
      confidence: optimizationConfidence(context.record),
      supersedes: baseline.id,
      payload: {
        type: 'skill',
        name: context.skill.name,
        description: context.skill.description,
        markdown: nextMarkdown,
        relativePath
      }
    }, {
      actor: { type: 'agent', id: 'skill-optimizer', source: 'optimize_skill' }
    })
  return persistDraftProposal(context, proposal.id, validation.diagnostics)
}

async function persistValidationFailure(
  context: SkillOptimizationContext,
  diagnostics: SkillTestDiagnostic[]
): Promise<SkillOptimizationResult> {
  await writeFeedbackSidecar(context.feedbackPath, context.store)
  return {
    status: 'validation_failed',
    skillId: context.skill.id,
    skillName: context.skill.name,
    skillPath: context.skillPath,
    feedbackPath: context.feedbackPath,
    applied: false,
    recordCount: context.store.records.length,
    diagnostics
  }
}

async function persistDraftProposal(
  context: SkillOptimizationContext,
  draftId: string,
  diagnostics: SkillTestDiagnostic[]
): Promise<SkillOptimizationResult> {
  const draftedFeedbackIds = relatedOptimizationRecords(context.store, context.record).map((item) => item.id)
  context.store.draftedRecordIds = unique([...context.store.draftedRecordIds, ...draftedFeedbackIds])
  for (const feedbackId of draftedFeedbackIds) context.store.learningDraftIds[feedbackId] = draftId
  await writeFeedbackSidecar(context.feedbackPath, context.store)
  return {
    status: 'drafted',
    skillId: context.skill.id,
    skillName: context.skill.name,
    skillPath: context.skillPath,
    feedbackPath: context.feedbackPath,
    applied: false,
    draftId,
    draftStatus: 'draft',
    recordCount: context.store.records.length,
    diagnostics
  }
}

/** @deprecated Use proposeSkillOptimization so production call sites make draft-only intent explicit. */
export async function recordSkillFeedback(input: SkillFeedbackInput): Promise<SkillOptimizationResult> {
  return proposeSkillOptimization(input)
}

export async function applySkillCorrection(
  input: Omit<SkillFeedbackInput, 'outcome'> & { summary: string; correctionSteps: string[] }
): Promise<SkillOptimizationResult> {
  return proposeSkillOptimization({ ...input, outcome: 'corrected', failureThreshold: 1 })
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

function optimizationConfidence(record: SkillFeedbackRecord): number {
  return record.outcome === 'corrected' ? 0.95 : 0.8
}

function readFeedbackStore(feedbackPath: string, skill: SkillDefinition): SkillFeedbackStore {
  if (!existsSync(feedbackPath)) {
    return {
      skillId: skill.id,
      skillName: skill.name,
      records: [],
      appliedRecordIds: [],
      draftedRecordIds: [],
      learningDraftIds: {}
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(feedbackPath, 'utf8')) as Partial<SkillFeedbackStore>
    return {
      skillId: typeof parsed.skillId === 'string' ? parsed.skillId : skill.id,
      skillName: typeof parsed.skillName === 'string' ? parsed.skillName : skill.name,
      records: Array.isArray(parsed.records) ? parsed.records.filter(isFeedbackRecord).slice(-MAX_RECORDS) : [],
      appliedRecordIds: Array.isArray(parsed.appliedRecordIds)
        ? parsed.appliedRecordIds.filter((item): item is string => typeof item === 'string')
        : [],
      draftedRecordIds: Array.isArray(parsed.draftedRecordIds)
        ? parsed.draftedRecordIds.filter((item): item is string => typeof item === 'string')
        : [],
      learningDraftIds: isStringRecord(parsed.learningDraftIds) ? parsed.learningDraftIds : {}
    }
  } catch {
    return {
      skillId: skill.id,
      skillName: skill.name,
      records: [],
      appliedRecordIds: [],
      draftedRecordIds: [],
      learningDraftIds: {}
    }
  }
}

function isRetryableProposalStatus(status: LearningStatus): boolean {
  return status === 'rejected' || status === 'deleted'
}

function releaseBoundFeedback(store: SkillFeedbackStore, draftId: string): string[] {
  const releasedIds = new Set(
    Object.entries(store.learningDraftIds)
      .filter(([, value]) => value === draftId)
      .map(([feedbackId]) => feedbackId)
  )
  for (const feedbackId of releasedIds) delete store.learningDraftIds[feedbackId]
  store.draftedRecordIds = store.draftedRecordIds.filter((feedbackId) => !releasedIds.has(feedbackId))
  return [...releasedIds]
}

function shouldDraftOptimization(store: SkillFeedbackStore, record: SkillFeedbackRecord, threshold: number): boolean {
  if (store.appliedRecordIds.includes(record.id) || store.draftedRecordIds.includes(record.id)) return false
  if (record.outcome === 'corrected') return true
  if (record.outcome !== 'failed') return false
  const unappliedFailures = store.records.filter(
    (item) => item.outcome === 'failed' &&
      !store.appliedRecordIds.includes(item.id) &&
      !store.draftedRecordIds.includes(item.id)
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
    .filter((item) => item.outcome === 'failed' &&
      !store.appliedRecordIds.includes(item.id) &&
      !store.draftedRecordIds.includes(item.id))
    .slice(-DEFAULT_FAILURE_THRESHOLD)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
}

async function writeFeedbackSidecar(feedbackPath: string, store: SkillFeedbackStore): Promise<void> {
  if (join(dirname(feedbackPath), 'skill-feedback.json') !== feedbackPath) {
    throw new Error(`反馈存储必须是非活动 Skill sidecar: ${feedbackPath}`)
  }
  // SkillManager only loads SKILL.md; this sidecar never becomes active Skill content.
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
