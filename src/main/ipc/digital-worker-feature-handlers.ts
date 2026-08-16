import { app } from 'electron'
import {
  buildDigitalWorkerHistory,
  decideDigitalWorkerMemory,
  exportDigitalWorkerHistory,
  listDigitalWorkerMemory,
  proposeDigitalWorkerMemory,
  recommendDigitalWorkerTeam,
  refreshDigitalWorkerPerformance,
  type DigitalWorkerStore
} from '../digital-worker'
import { openProjectWorkspaceStore } from '../project-workspace'
import { applyProjectWorkspaceTemplate } from '../project-workspace/template-service'
import type {
  DigitalWorkerMemoryDraftInput,
  DigitalWorkerTeamRecommendationInput
} from '../../shared/digital-worker-types'

type DigitalWorkerFeatureActionHandler = (
  store: DigitalWorkerStore,
  payload: Record<string, unknown>
) => unknown

export const DIGITAL_WORKER_FEATURE_HANDLERS = {
  recommendDigitalWorkerTeam: async (_store, payload) => {
    assertGatewayPayload(payload, ['input'], 'recommendDigitalWorkerTeam')
    const input = normalizeTeamRecommendationInput(payload.input)
    const workspace = await openProjectWorkspaceStore(app.getPath('userData'))
    const [project, initialGoals] = await Promise.all([
      workspace.getWorkspace(input.projectId),
      workspace.listGoals(input.projectId)
    ])
    if (!project || project.status !== 'active') {
      throw new Error(`DigitalWorker project is not active: ${input.projectId}`)
    }
    if (initialGoals.length === 0 && input.goalId === undefined) {
      await applyProjectWorkspaceTemplate(app.getPath('userData'), {
        requestId: `digital-worker-bootstrap:${project.id}`,
        projectId: project.id,
        templateId: project.kind
      })
    }
    const [goals, workItems] = await Promise.all([
      workspace.listGoals(input.projectId),
      workspace.listWorkItems(input.projectId)
    ])
    return recommendDigitalWorkerTeam({ project, goals, workItems, goalId: input.goalId })
  },
  refreshDigitalWorkerPerformance: (store, payload) => {
    assertGatewayPayload(payload, ['id'], 'refreshDigitalWorkerPerformance')
    return refreshDigitalWorkerPerformance(store, app.getPath('userData'), requiredId(payload.id, 'DigitalWorker id'))
  },
  getDigitalWorkerHistory: (_store, payload) => {
    assertGatewayPayload(payload, ['workerId'], 'getDigitalWorkerHistory')
    return buildDigitalWorkerHistory(app.getPath('userData'), requiredId(payload.workerId, 'DigitalWorker id'))
  },
  exportDigitalWorkerHistory: (_store, payload) => {
    assertGatewayPayload(payload, ['workerId'], 'exportDigitalWorkerHistory')
    return exportDigitalWorkerHistory(app.getPath('userData'), requiredId(payload.workerId, 'DigitalWorker id'))
  },
  listDigitalWorkerMemory: (store, payload) => {
    assertGatewayPayload(payload, ['workerId'], 'listDigitalWorkerMemory')
    return listDigitalWorkerMemory(store, app.getPath('userData'), requiredId(payload.workerId, 'DigitalWorker id'))
  },
  proposeDigitalWorkerMemory: (store, payload) => {
    assertGatewayPayload(payload, ['workerId', 'input'], 'proposeDigitalWorkerMemory')
    return proposeDigitalWorkerMemory(
      store,
      app.getPath('userData'),
      requiredId(payload.workerId, 'DigitalWorker id'),
      normalizeWorkerMemoryDraftInput(payload.input)
    )
  },
  approveDigitalWorkerMemory: (store, payload) => workerMemoryDecision(store, payload, 'approve'),
  rejectDigitalWorkerMemory: (store, payload) => workerMemoryDecision(store, payload, 'reject'),
  revokeDigitalWorkerMemory: (store, payload) => workerMemoryDecision(store, payload, 'revoke'),
  deleteDigitalWorkerMemory: (store, payload) => workerMemoryDecision(store, payload, 'delete')
} satisfies Record<string, DigitalWorkerFeatureActionHandler>

function workerMemoryDecision(
  store: DigitalWorkerStore,
  payload: Record<string, unknown>,
  action: 'approve' | 'reject' | 'revoke' | 'delete'
) {
  assertGatewayPayload(payload, ['workerId', 'recordId'], `${action}DigitalWorkerMemory`)
  return decideDigitalWorkerMemory(
    store,
    app.getPath('userData'),
    requiredId(payload.workerId, 'DigitalWorker id'),
    requiredId(payload.recordId, 'Worker Memory record id'),
    action
  )
}

function normalizeTeamRecommendationInput(value: unknown): DigitalWorkerTeamRecommendationInput {
  const record = requiredRecord(value, 'Team recommendation input')
  assertAllowedKeys(record, ['projectId', 'goalId'], 'Team recommendation input')
  return {
    projectId: requiredId(record.projectId, 'projectId'),
    ...(record.goalId === undefined ? {} : { goalId: requiredId(record.goalId, 'goalId') })
  }
}

function normalizeWorkerMemoryDraftInput(value: unknown): DigitalWorkerMemoryDraftInput {
  const record = requiredRecord(value, 'Worker Memory draft input')
  assertAllowedKeys(record, ['memoryKind', 'title', 'body', 'reason', 'confidence'], 'Worker Memory draft input')
  const confidence = record.confidence === undefined ? undefined : nonNegativeNumber(record.confidence, 'confidence')
  if (confidence !== undefined && confidence > 1) throw new Error('confidence must be between 0 and 1')
  return {
    memoryKind: requiredText(record.memoryKind, 'memoryKind', 128),
    title: requiredContent(record.title, 'title', 512),
    body: requiredContent(record.body, 'body', 100_000),
    reason: requiredContent(record.reason, 'reason', 2_000),
    ...(confidence === undefined ? {} : { confidence })
  }
}

function assertGatewayPayload(payload: Record<string, unknown>, allowed: readonly string[], action: string): void {
  assertAllowedKeys(payload, allowed, `${action} payload`)
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains an unknown field: ${key}`)
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredId(value: unknown, label: string): string {
  return requiredText(value, label, 256)
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0-\x1F\x7F]/.test(normalized)) {
    throw new Error(`${label} has an invalid format`)
  }
  return normalized
}

function requiredContent(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a non-empty string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength || /[\0\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) {
    throw new Error(`${label} has an invalid format`)
  }
  return normalized
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`)
  }
  return value
}
