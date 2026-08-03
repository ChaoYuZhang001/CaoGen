import type { WelcomeDraftState } from './welcome-draft'

export const WELCOME_DRAFT_STORAGE_KEY = 'caogen.welcome-draft.v1'

const SCHEMA_VERSION = 1
const MAX_TEXT_LENGTH = 200_000
const MAX_PATH_LENGTH = 32_768
const MAX_ID_LENGTH = 2_048
const DRIVE_MODES = new Set(['spark', 'core', 'forge', 'command', 'genesis'])
const ROUTING_MODES = new Set(['fixed', 'provider', 'global'])
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
const TASK_STRATEGIES = new Set(['view', 'plan', 'execute'])

export function loadWelcomeDraft(
  fallback: WelcomeDraftState,
  storage: Storage | null = resolveStorage()
): WelcomeDraftState {
  if (!storage) return fallback
  try {
    const raw = storage.getItem(WELCOME_DRAFT_STORAGE_KEY)
    if (!raw) return fallback
    const payload = JSON.parse(raw) as { schemaVersion?: unknown; draft?: unknown }
    const draft = payload.schemaVersion === SCHEMA_VERSION ? parseDraft(payload.draft) : null
    if (draft) return draft
    storage.removeItem(WELCOME_DRAFT_STORAGE_KEY)
  } catch {
    try { storage.removeItem(WELCOME_DRAFT_STORAGE_KEY) } catch { /* best-effort recovery */ }
  }
  return fallback
}

export function persistWelcomeDraft(
  draft: WelcomeDraftState,
  storage: Storage | null = resolveStorage()
): void {
  if (!storage) return
  try {
    if (isEmptyDraft(draft)) storage.removeItem(WELCOME_DRAFT_STORAGE_KEY)
    else storage.setItem(WELCOME_DRAFT_STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, draft }))
  } catch {
    // The in-memory draft remains usable when storage is unavailable or full.
  }
}

function resolveStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

function parseDraft(value: unknown): WelcomeDraftState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const draft = value as Record<string, unknown>
  if (!validString(draft.text, MAX_TEXT_LENGTH)) return null
  if (!validNullableString(draft.projectChoice, MAX_ID_LENGTH)) return null
  if (!validNullableString(draft.cwd, MAX_PATH_LENGTH)) return null
  if (draft.driveMode !== null && !DRIVE_MODES.has(String(draft.driveMode))) return null
  if (!ROUTING_MODES.has(String(draft.routingMode))) return null
  if (!validNullableString(draft.providerId, MAX_ID_LENGTH)) return null
  if (!validNullableString(draft.model, MAX_ID_LENGTH)) return null
  if (draft.permissionMode !== null && !PERMISSION_MODES.has(String(draft.permissionMode))) return null
  if (draft.taskStrategy !== undefined && !TASK_STRATEGIES.has(String(draft.taskStrategy))) return null
  if (!validOptionalString(draft.forkFromSdkSessionId, MAX_ID_LENGTH)) return null
  if (!validOptionalString(draft.forkSourceTitle, MAX_ID_LENGTH)) return null
  return draft as unknown as WelcomeDraftState
}

function validString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function validNullableString(value: unknown, maxLength: number): value is string | null {
  return value === null || validString(value, maxLength)
}

function validOptionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || validString(value, maxLength)
}

function isEmptyDraft(draft: WelcomeDraftState): boolean {
  return draft.text === '' && draft.projectChoice === null && draft.cwd === null && draft.driveMode === null
    && draft.routingMode === 'global' && draft.providerId === null && draft.model === null
    && draft.permissionMode === null && draft.taskStrategy === undefined
    && draft.forkFromSdkSessionId === undefined && draft.forkSourceTitle === undefined
}
