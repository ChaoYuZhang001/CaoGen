import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { nextAfter } from './cronParse'
import type { EngineKind, PermissionModeId, RoutineNotificationOptions } from '../shared/types'

export type RoutinePermissionMode = PermissionModeId

export interface Routine extends Record<string, unknown> {
  id: string
  name: string
  prompt: string
  content?: string
  projectCwd: string
  schedule: string
  frequency?: string
  providerId: string
  model: string
  engine?: EngineKind
  permissionMode: RoutinePermissionMode
  budgetUsd: number
  notification: RoutineNotificationOptions
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  nextRunAt?: number
}

export type CreateRoutineInput = {
  id?: string
  name: string
  prompt?: string
  content?: string
  projectCwd: string
  schedule?: string
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  createdAt?: number
  updatedAt?: number
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export type UpdateRoutineInput = {
  name?: string
  prompt?: string
  content?: string
  projectCwd?: string
  schedule?: string
  frequency?: string
  providerId?: string
  model?: string
  engine?: EngineKind
  permissionMode?: RoutinePermissionMode
  budgetUsd?: number
  notification?: RoutineNotificationOptions
  enabled?: boolean
  lastRunAt?: number | null
  nextRunAt?: number | null
} & Record<string, unknown>

export interface MarkRunOptions {
  ranAt?: number
  nextRunAt?: number | null
}

interface RoutineFile {
  version: 1
  routines: Routine[]
}

export class RoutineStoreValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoutineStoreValidationError'
  }
}

const ROUTINES_FILE = 'routines.json'
const STORE_VERSION = 1
const MINUTE_MS = 60_000
const PERMISSION_MODES = new Set<RoutinePermissionMode>([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
])
const ENGINE_KINDS = new Set<EngineKind>(['claude', 'openai', 'codex', 'gemini'])
const DEFAULT_NOTIFICATION: RoutineNotificationOptions = {
  enabled: false,
  onSuccess: true,
  onFailure: true
}
const SCHEMA_KEYS = new Set([
  'id',
  'name',
  'prompt',
  'content',
  'projectCwd',
  'schedule',
  'frequency',
  'providerId',
  'model',
  'engine',
  'permissionMode',
  'budgetUsd',
  'notification',
  'enabled',
  'createdAt',
  'updatedAt',
  'lastRunAt',
  'nextRunAt'
])

export function getRoutineStorePath(rootDir: string): string {
  return path.join(resolveRootDir(rootDir), ROUTINES_FILE)
}

export async function listRoutines(rootDir: string): Promise<Routine[]> {
  const file = await readStore(rootDir)
  return file.routines
}

export async function createRoutine(rootDir: string, input: CreateRoutineInput): Promise<Routine> {
  const file = await readStore(rootDir)
  const now = Date.now()
  const id = normalizeOptionalString(input.id, 'id') || randomUUID()

  if (file.routines.some((routine) => routine.id === id)) {
    throw new RoutineStoreValidationError(`Routine already exists: ${id}`)
  }

  const createdAt = normalizeOptionalTimestamp(input.createdAt, 'createdAt') ?? now
  const updatedAt = normalizeOptionalTimestamp(input.updatedAt, 'updatedAt') ?? createdAt
  const prompt = normalizeRequiredString(input.prompt ?? input.content, 'prompt')
  const schedule = normalizeRequiredString(input.schedule ?? input.frequency, 'schedule')
  const routine: Routine = {
    ...copyUnknownFields(input),
    id,
    name: normalizeRequiredString(input.name, 'name'),
    prompt,
    content: normalizeOptionalString(input.content, 'content') ?? prompt,
    projectCwd: normalizeRequiredString(input.projectCwd, 'projectCwd'),
    schedule,
    frequency: normalizeOptionalString(input.frequency, 'frequency') ?? schedule,
    providerId: normalizeOptionalString(input.providerId, 'providerId') ?? '',
    model: normalizeOptionalString(input.model, 'model') ?? '',
    engine: normalizeOptionalEngine(input.engine),
    permissionMode: normalizePermissionMode(input.permissionMode ?? 'default'),
    budgetUsd: normalizeBudget(input.budgetUsd ?? 0),
    notification: normalizeNotificationOptions(input.notification),
    enabled: normalizeOptionalBoolean(input.enabled, 'enabled') ?? true,
    createdAt,
    updatedAt,
    lastRunAt: normalizeNullableTimestamp(input.lastRunAt, 'lastRunAt') ?? null
  }
  const nextRunAt = normalizeNullableTimestamp(input.nextRunAt, 'nextRunAt')
  if (nextRunAt !== null) routine.nextRunAt = nextRunAt
  else if (routine.enabled && !hasOwn(input, 'nextRunAt')) {
    const seeded = computeInitialNextRun(routine.schedule, now)
    if (seeded !== null) routine.nextRunAt = seeded
  }

  file.routines.push(routine)
  await writeStore(rootDir, file.routines)
  return routine
}

export async function updateRoutine(
  rootDir: string,
  id: string,
  patch: UpdateRoutineInput
): Promise<Routine | null> {
  const file = await readStore(rootDir)
  const index = file.routines.findIndex((routine) => routine.id === id)
  if (index === -1) return null

  const current = file.routines[index]
  const prompt = hasOwn(patch, 'prompt')
    ? normalizeRequiredString(patch.prompt, 'prompt')
    : hasOwn(patch, 'content')
      ? normalizeRequiredString(patch.content, 'content')
      : current.prompt
  const schedule = hasOwn(patch, 'schedule')
    ? normalizeRequiredString(patch.schedule, 'schedule')
    : hasOwn(patch, 'frequency')
      ? normalizeRequiredString(patch.frequency, 'frequency')
      : current.schedule
  const routine: Routine = {
    ...copyUnknownFields(current),
    ...copyUnknownFields(patch),
    id: current.id,
    name: hasOwn(patch, 'name') ? normalizeRequiredString(patch.name, 'name') : current.name,
    prompt,
    content: hasOwn(patch, 'content')
      ? normalizeOptionalString(patch.content, 'content')
      : hasOwn(patch, 'prompt')
        ? prompt
        : (current.content ?? current.prompt),
    projectCwd: hasOwn(patch, 'projectCwd')
      ? normalizeRequiredString(patch.projectCwd, 'projectCwd')
      : current.projectCwd,
    schedule,
    frequency: hasOwn(patch, 'frequency')
      ? normalizeOptionalString(patch.frequency, 'frequency')
      : hasOwn(patch, 'schedule')
        ? schedule
        : (current.frequency ?? current.schedule),
    providerId: hasOwn(patch, 'providerId')
      ? (normalizeOptionalString(patch.providerId, 'providerId') ?? '')
      : current.providerId,
    model: hasOwn(patch, 'model') ? (normalizeOptionalString(patch.model, 'model') ?? '') : current.model,
    engine: hasOwn(patch, 'engine') ? normalizeOptionalEngine(patch.engine) : current.engine,
    permissionMode: hasOwn(patch, 'permissionMode')
      ? normalizePermissionMode(patch.permissionMode)
      : current.permissionMode,
    budgetUsd: hasOwn(patch, 'budgetUsd') ? normalizeBudget(patch.budgetUsd) : current.budgetUsd,
    notification: hasOwn(patch, 'notification')
      ? normalizeNotificationOptions(patch.notification, current.notification)
      : (current.notification ?? DEFAULT_NOTIFICATION),
    enabled: hasOwn(patch, 'enabled') ? normalizeBoolean(patch.enabled, 'enabled') : current.enabled,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
    lastRunAt: hasOwn(patch, 'lastRunAt')
      ? normalizeNullableTimestamp(patch.lastRunAt, 'lastRunAt')
      : current.lastRunAt
  }

  if (hasOwn(patch, 'nextRunAt')) {
    const nextRunAt = normalizeNullableTimestamp(patch.nextRunAt, 'nextRunAt')
    if (nextRunAt !== null) routine.nextRunAt = nextRunAt
  } else if (current.nextRunAt !== undefined) {
    routine.nextRunAt = current.nextRunAt
  }

  file.routines[index] = routine
  await writeStore(rootDir, file.routines)
  return routine
}

export async function deleteRoutine(rootDir: string, id: string): Promise<boolean> {
  const file = await readStore(rootDir)
  const nextRoutines = file.routines.filter((routine) => routine.id !== id)
  if (nextRoutines.length === file.routines.length) return false
  await writeStore(rootDir, nextRoutines)
  return true
}

export async function markRun(
  rootDir: string,
  id: string,
  options: MarkRunOptions = {}
): Promise<Routine | null> {
  const patch: UpdateRoutineInput = {
    lastRunAt: normalizeOptionalTimestamp(options.ranAt, 'ranAt') ?? Date.now()
  }
  if (hasOwn(options, 'nextRunAt')) patch.nextRunAt = options.nextRunAt ?? undefined
  return updateRoutine(rootDir, id, patch)
}

export {
  createRoutine as create,
  deleteRoutine as delete,
  listRoutines as list,
  updateRoutine as update
}

async function readStore(rootDir: string): Promise<RoutineFile> {
  try {
    const raw = await readFile(getRoutineStorePath(rootDir), 'utf8')
    return normalizeStore(JSON.parse(raw))
  } catch (error) {
    if (error instanceof RoutineStoreValidationError) throw error
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { version: STORE_VERSION, routines: [] }
    }
    return { version: STORE_VERSION, routines: [] }
  }
}

async function writeStore(rootDir: string, routines: Routine[]): Promise<void> {
  const dir = resolveRootDir(rootDir)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, ROUTINES_FILE)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const payload: RoutineFile = { version: STORE_VERSION, routines }
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tempPath, filePath)
}

function normalizeStore(value: unknown): RoutineFile {
  const rawRoutines =
    Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.routines) ? value.routines : []
  return {
    version: STORE_VERSION,
    routines: rawRoutines.map(normalizeStoredRoutine).filter((routine): routine is Routine => routine !== null)
  }
}

function normalizeStoredRoutine(value: unknown): Routine | null {
  if (!isRecord(value)) return null

  try {
    const id = normalizeRequiredString(value.id, 'id')
    const routine: Routine = {
      ...copyUnknownFields(value),
      id,
      name: normalizeRequiredString(value.name, 'name'),
      prompt: normalizeRequiredString(value.prompt ?? value.content, 'prompt'),
      content: normalizeOptionalString(value.content, 'content') ?? normalizeRequiredString(value.prompt ?? value.content, 'prompt'),
      projectCwd: normalizeRequiredString(value.projectCwd, 'projectCwd'),
      schedule: normalizeRequiredString(value.schedule ?? value.frequency, 'schedule'),
      frequency: normalizeOptionalString(value.frequency, 'frequency') ?? normalizeRequiredString(value.schedule ?? value.frequency, 'schedule'),
      providerId: normalizeOptionalString(value.providerId, 'providerId') ?? '',
      model: normalizeOptionalString(value.model, 'model') ?? '',
      engine: normalizeOptionalEngine(value.engine),
      permissionMode: isPermissionMode(value.permissionMode) ? value.permissionMode : 'default',
      budgetUsd: isNonNegativeNumber(value.budgetUsd) ? value.budgetUsd : 0,
      notification: normalizeNotificationOptions(value.notification),
      enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
      createdAt: normalizeOptionalTimestamp(value.createdAt, 'createdAt') ?? 0,
      updatedAt: normalizeOptionalTimestamp(value.updatedAt, 'updatedAt') ?? 0,
      lastRunAt: normalizeNullableTimestamp(value.lastRunAt, 'lastRunAt') ?? null
    }
    const nextRunAt = normalizeNullableTimestamp(value.nextRunAt, 'nextRunAt')
    if (nextRunAt !== null) routine.nextRunAt = nextRunAt
    return routine
  } catch {
    return null
  }
}

function resolveRootDir(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new RoutineStoreValidationError('rootDir is required')
  }
  return path.resolve(rootDir)
}

function copyUnknownFields(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!SCHEMA_KEYS.has(key) && fieldValue !== undefined) fields[key] = fieldValue
  }
  return fields
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RoutineStoreValidationError(`${field} is required`)
  }
  return value
}

function normalizeOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new RoutineStoreValidationError(`${field} must be a string`)
  }
  return value
}

function normalizePermissionMode(value: unknown): RoutinePermissionMode {
  if (!isPermissionMode(value)) {
    throw new RoutineStoreValidationError('permissionMode must be one of: default, acceptEdits, plan, bypassPermissions')
  }
  return value
}

function normalizeOptionalEngine(value: unknown): EngineKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!isEngineKind(value)) {
    throw new RoutineStoreValidationError('engine must be one of: claude, openai, codex, gemini')
  }
  return value
}

function normalizeBudget(value: unknown): number {
  if (!isNonNegativeNumber(value)) {
    throw new RoutineStoreValidationError('budgetUsd must be a non-negative number')
  }
  return value
}

function normalizeNotificationOptions(
  value: unknown,
  fallback: RoutineNotificationOptions = DEFAULT_NOTIFICATION
): RoutineNotificationOptions {
  if (value === undefined || value === null) return { ...fallback }
  if (!isRecord(value)) {
    throw new RoutineStoreValidationError('notification must be an object')
  }
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
    onSuccess: typeof value.onSuccess === 'boolean' ? value.onSuccess : fallback.onSuccess,
    onFailure: typeof value.onFailure === 'boolean' ? value.onFailure : fallback.onFailure
  }
}

function computeInitialNextRun(schedule: string, from: number): number | null {
  const trimmed = schedule.trim()
  const interval = parseIntervalSchedule(trimmed)
  if (interval !== null) return interval > 0 ? from + interval : null
  return nextAfter(trimmed, from)
}

function parseIntervalSchedule(input: string): number | null {
  const match = /^(?:every\s+)?(\d+)\s*([smhd])$/i.exec(input)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return 0
  const unit = match[2].toLowerCase()
  const unitMs = unit === 's' ? 1_000 : unit === 'm' ? MINUTE_MS : unit === 'h' ? 3_600_000 : 86_400_000
  return value * unitMs
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RoutineStoreValidationError(`${field} must be a boolean`)
  }
  return value
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  return normalizeBoolean(value, field)
}

function normalizeOptionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!isNonNegativeNumber(value)) {
    throw new RoutineStoreValidationError(`${field} must be a non-negative timestamp`)
  }
  return value
}

function normalizeNullableTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (!isNonNegativeNumber(value)) {
    throw new RoutineStoreValidationError(`${field} must be a non-negative timestamp or null`)
  }
  return value
}

function isPermissionMode(value: unknown): value is RoutinePermissionMode {
  return typeof value === 'string' && PERMISSION_MODES.has(value as RoutinePermissionMode)
}

function isEngineKind(value: unknown): value is EngineKind {
  return typeof value === 'string' && ENGINE_KINDS.has(value as EngineKind)
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
