import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { markRun, updateRoutine, type Routine } from '../routineStore'
import { writeDurableFile } from '../durable-file'

export type RoutineRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type RoutineDispatchState = 'preparing' | 'session_created' | 'prompt_accepted'
export type RoutineReviewDecision = 'accepted' | 'rejected'

export interface RoutineRunRecord {
  id: string
  routineId: string
  routineName: string
  projectId?: string
  goalId?: string
  workItemId?: string
  projectCwd: string
  startedAt: number
  finishedAt?: number
  status: RoutineRunStatus
  inboxStatus: 'running' | 'waiting_approval' | 'needs_review' | 'accepted' | 'rejected' | 'failed'
  dispatchState: RoutineDispatchState
  sessionId?: string
  workflowRunId?: string
  artifactId?: string
  evidenceId?: string
  resultObservedAt?: number
  nextRunAt?: number | null
  resultText?: string
  error?: string
  reviewDecision?: RoutineReviewDecision
  reviewNote?: string
  reviewedAt?: number
}

export interface RoutineRunCallbackResult {
  sessionId?: string
  projectId?: string
  goalId?: string
  workItemId?: string
  projectCwd?: string
  workflowRunId?: string
  dispatchState?: RoutineDispatchState
  /** The callback dispatched durable work; completion will arrive through Session events. */
  pending?: boolean
}

export interface RoutineRunFinalizationInput {
  status: 'succeeded' | 'failed'
  workflowRunId?: string
  artifactId?: string
  evidenceId?: string
  resultObservedAt?: number
  resultText?: string
  error?: string
  finishedAt?: number
}

export interface RoutineRunResultDraft {
  workflowRunId?: string
  resultText?: string
  resultObservedAt: number
}

export interface RoutineRunExecutionBinding {
  projectId?: string
  goalId?: string
  workItemId?: string
  projectCwd: string
}

export type RoutineRunCallback = (
  routine: Routine,
  run: Readonly<RoutineRunRecord>
) => Promise<RoutineRunCallbackResult | void>

interface RoutineRunsFile {
  version: 1
  runs: RoutineRunRecord[]
}

const RUNS_FILE = 'routine-runs.json'
const MAX_RUNS = 500
const runStoreWriteQueues = new Map<string, Promise<void>>()

export async function listRoutineRuns(rootDir: string, routineId?: string): Promise<RoutineRunRecord[]> {
  const file = await readRuns(rootDir)
  return file.runs
    .filter((run) => !routineId || run.routineId === routineId)
    .sort((a, b) => b.startedAt - a.startedAt)
}

export async function runRoutineWithHistory(
  rootDir: string,
  routine: Routine,
  callback: RoutineRunCallback,
  nextRunAt: number | null
): Promise<RoutineRunRecord> {
  const startedAt = Date.now()
  let record: RoutineRunRecord = {
    id: randomUUID(),
    routineId: routine.id,
    routineName: routine.name,
    projectId: routine.projectId,
    projectCwd: routine.projectCwd ?? '',
    startedAt,
    status: 'running',
    inboxStatus: 'running',
    dispatchState: 'preparing',
    nextRunAt
  }
  await appendRun(rootDir, record)
  try {
    const result = await callback(routine, record)
    const metadata = result && typeof result === 'object'
      ? {
          sessionId: result.sessionId,
          projectId: result.projectId ?? record.projectId,
          goalId: result.goalId,
          workItemId: result.workItemId,
          projectCwd: result.projectCwd ?? record.projectCwd,
          workflowRunId: result.workflowRunId,
          dispatchState: result.dispatchState ?? record.dispatchState
        }
      : {}
    if (result && typeof result === 'object' && result.pending === true) {
      record = { ...record, ...metadata, status: 'running', inboxStatus: 'running' }
      await replaceRun(rootDir, record)
      await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt })
      await updateRoutine(rootDir, routine.id, { lastError: null, runState: 'running' })
      return record
    }
    const finishedAt = Date.now()
    record = {
      ...record,
      ...metadata,
      finishedAt,
      status: 'succeeded',
      inboxStatus: 'needs_review'
    }
    await replaceRun(rootDir, record)
    await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt })
    await updateRoutine(rootDir, routine.id, { lastError: null, runState: 'succeeded' })
    return record
  } catch (error) {
    const finishedAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    record = { ...record, finishedAt, status: 'failed', inboxStatus: 'failed', error: message }
    await replaceRun(rootDir, record)
    await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt })
    await updateRoutine(rootDir, routine.id, { lastError: message, runState: 'failed' })
    return record
  }
}

export async function settleRoutineRun(
  rootDir: string,
  runId: string,
  input: RoutineRunFinalizationInput
): Promise<RoutineRunRecord | null> {
  const result = await withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return { record: null, changed: false }
    if (current.status === 'succeeded' || current.status === 'failed') {
      return { record: current, changed: false }
    }
    const status = input.status
    const record: RoutineRunRecord = {
      ...current,
      status,
      inboxStatus: status === 'succeeded' ? 'needs_review' : 'failed',
      finishedAt: input.finishedAt ?? Date.now(),
      workflowRunId: input.workflowRunId ?? current.workflowRunId,
      artifactId: input.artifactId ?? current.artifactId,
      evidenceId: input.evidenceId ?? current.evidenceId,
      resultObservedAt: current.resultObservedAt ?? input.resultObservedAt,
      resultText: cleanOptionalText(input.resultText) ?? current.resultText,
      error: status === 'failed' ? cleanOptionalText(input.error) ?? 'Routine execution failed' : undefined
    }
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== runId)].slice(0, MAX_RUNS))
    return { record, changed: true }
  })
  if (result.record && result.changed) {
    await updateRoutine(rootDir, result.record.routineId, {
      lastError: result.record.error ?? null,
      runState: result.record.status
    })
  }
  return result.record
}

export async function stageRoutineRunResult(
  rootDir: string,
  runId: string,
  input: RoutineRunResultDraft
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running') return current
    const record: RoutineRunRecord = {
      ...current,
      workflowRunId: input.workflowRunId ?? current.workflowRunId,
      resultText: cleanOptionalText(input.resultText) ?? current.resultText,
      resultObservedAt: current.resultObservedAt ?? input.resultObservedAt
    }
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== runId)].slice(0, MAX_RUNS))
    return record
  })
}

export async function recordRoutineRunFinalizationError(
  rootDir: string,
  runId: string,
  error: string
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running') return current
    const record: RoutineRunRecord = {
      ...current,
      inboxStatus: 'failed',
      error: cleanOptionalText(error) ?? 'Routine result finalization failed'
    }
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== runId)].slice(0, MAX_RUNS))
    return record
  })
}

export async function setRoutineRunInboxStatus(
  rootDir: string,
  runId: string,
  inboxStatus: RoutineRunRecord['inboxStatus']
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running' || current.inboxStatus === inboxStatus) return current
    const record = { ...current, inboxStatus }
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== runId)].slice(0, MAX_RUNS))
    return record
  })
}

export async function setRoutineRunDispatchState(
  rootDir: string,
  runId: string,
  dispatchState: RoutineDispatchState,
  workflowRunId?: string,
  sessionId?: string
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (dispatchPhase(current.dispatchState) > dispatchPhase(dispatchState)) return current
    const record: RoutineRunRecord = {
      ...current,
      dispatchState,
      workflowRunId: workflowRunId ?? current.workflowRunId,
      sessionId: sessionId ?? current.sessionId
    }
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== runId)].slice(0, MAX_RUNS))
    return record
  })
}

export async function setRoutineRunExecutionBinding(
  rootDir: string,
  runId: string,
  binding: RoutineRunExecutionBinding
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.status !== 'running' || current.dispatchState !== 'preparing') {
      throw new Error(`Routine Run ${runId} cannot change its execution binding`)
    }
    const record: RoutineRunRecord = { ...current, ...binding }
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== runId)].slice(0, MAX_RUNS))
    return record
  })
}

export async function reviewRoutineRunRecord(
  rootDir: string,
  runId: string,
  decision: RoutineReviewDecision,
  note?: string,
  reviewedAt = Date.now()
): Promise<RoutineRunRecord | null> {
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === runId)
    if (!current) return null
    if (current.reviewDecision) {
      if (current.reviewDecision !== decision) throw new Error(`Routine Run ${runId} was already reviewed`)
      return current
    }
    if (current.status !== 'succeeded' || current.inboxStatus !== 'needs_review') {
      throw new Error(`Routine Run ${runId} is not ready for review`)
    }
    const reviewNote = cleanOptionalText(note)
    const record: RoutineRunRecord = {
      ...current,
      inboxStatus: decision,
      reviewDecision: decision,
      ...(reviewNote ? { reviewNote } : {}),
      reviewedAt
    }
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== runId)].slice(0, MAX_RUNS))
    return record
  })
}

export async function importProjectRoutineRuns(
  rootDir: string,
  projectId: string,
  values: readonly RoutineRunRecord[]
): Promise<number> {
  const expectedProjectId = requiredProjectId(projectId)
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const incoming = values.map((value) => normalizeRunRecord(structuredClone(value)))
    if (incoming.some((value) => value === null)) throw new Error('Project import contains an invalid Routine Run')
    let imported = 0
    for (const run of incoming as RoutineRunRecord[]) {
      if (run.projectId !== expectedProjectId) {
        throw new Error(`Routine Run ${run.id} is not owned by Project ${expectedProjectId}`)
      }
      const existing = file.runs.find((candidate) => candidate.id === run.id)
      if (existing) {
        if (!isDeepStrictEqual(existing, run)) throw new Error(`Routine Run import identity conflict: ${run.id}`)
        continue
      }
      file.runs.push(run)
      imported += 1
    }
    if (file.runs.length > MAX_RUNS) {
      throw new Error(`Routine Run import exceeds bounded history capacity (${MAX_RUNS})`)
    }
    if (imported > 0) {
      await writeRuns(rootDir, file.runs.sort((left, right) => right.startedAt - left.startedAt))
    }
    return imported
  })
}

export async function purgeProjectRoutineRuns(
  rootDir: string,
  projectId: string,
  routineIds: ReadonlySet<string> = new Set()
): Promise<number> {
  const expectedProjectId = requiredProjectId(projectId)
  return withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const next = file.runs.filter((run) =>
      run.projectId !== expectedProjectId && !(run.projectId === undefined && routineIds.has(run.routineId)))
    const removed = file.runs.length - next.length
    if (removed > 0) await writeRuns(rootDir, next)
    return removed
  })
}

export async function countProjectRoutineRuns(rootDir: string, projectId: string): Promise<number> {
  const expectedProjectId = requiredProjectId(projectId)
  return (await listRoutineRuns(rootDir)).filter((run) => run.projectId === expectedProjectId).length
}

async function appendRun(rootDir: string, record: RoutineRunRecord): Promise<void> {
  await withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    await writeRuns(rootDir, [record, ...file.runs.filter((run) => run.id !== record.id)].slice(0, MAX_RUNS))
  })
}

async function replaceRun(rootDir: string, record: RoutineRunRecord): Promise<void> {
  await withRunStoreWriteLock(rootDir, async () => {
    const file = await readRuns(rootDir)
    const current = file.runs.find((run) => run.id === record.id)
    const replacement = current && isTerminalRun(current) && !isTerminalRun(record)
      ? current
      : { ...current, ...record }
    const next = [replacement, ...file.runs.filter((run) => run.id !== record.id)].slice(0, MAX_RUNS)
    await writeRuns(rootDir, next)
  })
}

async function withRunStoreWriteLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const key = runsPath(rootDir)
  const previous = runStoreWriteQueues.get(key) ?? Promise.resolve()
  let value!: T
  const operationPromise = previous
    .catch(() => undefined)
    .then(async () => {
      value = await operation()
    })
  const queueTail = operationPromise.then(() => undefined, () => undefined)
  runStoreWriteQueues.set(key, queueTail)
  try {
    await operationPromise
    return value
  } finally {
    if (runStoreWriteQueues.get(key) === queueTail) runStoreWriteQueues.delete(key)
  }
}

async function readRuns(rootDir: string): Promise<RoutineRunsFile> {
  try {
    const raw = await readFile(runsPath(rootDir), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { runs?: unknown }).runs)) {
      return { version: 1, runs: [] }
    }
    return {
      version: 1,
      runs: (parsed as { runs: unknown[] }).runs
        .map(normalizeRunRecord)
        .filter((run): run is RoutineRunRecord => run !== null)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, runs: [] }
    throw new Error(`Routine run store is unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeRuns(rootDir: string, runs: RoutineRunRecord[]): Promise<void> {
  const filePath = runsPath(rootDir)
  await writeDurableFile(filePath, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`)
}

function runsPath(rootDir: string): string {
  if (!rootDir.trim()) throw new Error('rootDir 不能为空')
  return path.join(path.resolve(rootDir), RUNS_FILE)
}

function normalizeRunRecord(value: unknown): RoutineRunRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!(
    typeof record.id === 'string' &&
    typeof record.routineId === 'string' &&
    typeof record.routineName === 'string' &&
    typeof record.projectCwd === 'string' &&
    typeof record.startedAt === 'number' &&
    (record.status === 'queued' || record.status === 'running' || record.status === 'succeeded' || record.status === 'failed')
  )) return null
  const status = record.status
  const inboxStatus = record.inboxStatus === 'running' || record.inboxStatus === 'waiting_approval' ||
    record.inboxStatus === 'needs_review' || record.inboxStatus === 'accepted' ||
    record.inboxStatus === 'rejected' || record.inboxStatus === 'failed'
    ? record.inboxStatus
    : status === 'failed'
      ? 'failed'
      : status === 'succeeded'
        ? 'needs_review'
        : 'running'
  const dispatchState = record.dispatchState === 'preparing' || record.dispatchState === 'session_created' ||
    record.dispatchState === 'prompt_accepted'
    ? record.dispatchState
    : record.sessionId
      ? 'prompt_accepted'
      : 'preparing'
  return { ...record, status, inboxStatus, dispatchState } as unknown as RoutineRunRecord
}

function cleanOptionalText(value: string | undefined): string | undefined {
  const clean = value?.trim()
  return clean ? clean.slice(0, 20_000) : undefined
}

function isTerminalRun(record: Pick<RoutineRunRecord, 'status'>): boolean {
  return record.status === 'succeeded' || record.status === 'failed'
}

function dispatchPhase(state: RoutineDispatchState): number {
  if (state === 'prompt_accepted') return 3
  if (state === 'session_created') return 2
  return 1
}

function requiredProjectId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('projectId is required')
  }
  return value.trim()
}
