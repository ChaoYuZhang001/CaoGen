import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { markRun, updateRoutine, type Routine } from '../routineStore'

export type RoutineRunStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface RoutineRunRecord {
  id: string
  routineId: string
  routineName: string
  projectCwd: string
  startedAt: number
  finishedAt?: number
  status: RoutineRunStatus
  sessionId?: string
  nextRunAt?: number | null
  error?: string
}

export interface RoutineRunCallbackResult {
  sessionId?: string
}

export type RoutineRunCallback = (routine: Routine) => Promise<RoutineRunCallbackResult | void>

interface RoutineRunsFile {
  version: 1
  runs: RoutineRunRecord[]
}

const RUNS_FILE = 'routine-runs.json'
const MAX_RUNS = 500

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
    projectCwd: routine.projectCwd,
    startedAt,
    status: 'running',
    nextRunAt
  }
  await appendRun(rootDir, record)
  try {
    const result = await callback(routine)
    const sessionId = result && typeof result === 'object' ? result.sessionId : undefined
    const finishedAt = Date.now()
    record = {
      ...record,
      sessionId,
      finishedAt,
      status: 'succeeded'
    }
    await replaceRun(rootDir, record)
    await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt })
    await updateRoutine(rootDir, routine.id, { lastError: null, runState: 'succeeded' })
    return record
  } catch (error) {
    const finishedAt = Date.now()
    const message = error instanceof Error ? error.message : String(error)
    record = { ...record, finishedAt, status: 'failed', error: message }
    await replaceRun(rootDir, record)
    await markRun(rootDir, routine.id, { ranAt: startedAt, nextRunAt })
    await updateRoutine(rootDir, routine.id, { lastError: message, runState: 'failed' })
    return record
  }
}

async function appendRun(rootDir: string, record: RoutineRunRecord): Promise<void> {
  const file = await readRuns(rootDir)
  await writeRuns(rootDir, [record, ...file.runs].slice(0, MAX_RUNS))
}

async function replaceRun(rootDir: string, record: RoutineRunRecord): Promise<void> {
  const file = await readRuns(rootDir)
  const next = [record, ...file.runs.filter((run) => run.id !== record.id)].slice(0, MAX_RUNS)
  await writeRuns(rootDir, next)
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
      runs: (parsed as { runs: unknown[] }).runs.filter(isRunRecord)
    }
  } catch {
    return { version: 1, runs: [] }
  }
}

async function writeRuns(rootDir: string, runs: RoutineRunRecord[]): Promise<void> {
  const filePath = runsPath(rootDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`, 'utf8')
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

function runsPath(rootDir: string): string {
  if (!rootDir.trim()) throw new Error('rootDir 不能为空')
  return path.join(path.resolve(rootDir), RUNS_FILE)
}

function isRunRecord(value: unknown): value is RoutineRunRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.routineId === 'string' &&
    typeof record.routineName === 'string' &&
    typeof record.projectCwd === 'string' &&
    typeof record.startedAt === 'number' &&
    (record.status === 'queued' || record.status === 'running' || record.status === 'succeeded' || record.status === 'failed')
  )
}
