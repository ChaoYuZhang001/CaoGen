import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeDurableFileSync } from './durable-file'
import { targetFingerprint } from './migration-safety'

export const MIGRATION_CONTRACT_FORMAT = 'caogen.migration-contract.v1' as const

export type MigrationContractState =
  | 'prepared'
  | 'backup_verified'
  | 'applying'
  | 'committed'
  | 'rollback_pending'
  | 'rolled_back'

export interface MigrationContractTarget {
  path: string
  beforeFingerprint: string
  afterFingerprint?: string
}

export interface MigrationContractJournal {
  schemaVersion: 1
  format: typeof MIGRATION_CONTRACT_FORMAT
  migrationId: string
  kind: string
  fromVersion: number
  toVersion: number
  backupId: string
  source: {
    path: string
    sha256: string
    sizeBytes: number
  }
  targets: MigrationContractTarget[]
  state: MigrationContractState
  writesCompleted: number
  createdAt: number
  updatedAt: number
  transitions: Array<{ state: MigrationContractState; at: number }>
}

export interface CreateMigrationContractInput {
  migrationId?: string
  kind: string
  fromVersion: number
  toVersion: number
  backupId: string
  source: { path: string; sha256: string; sizeBytes: number }
  targets: MigrationContractTarget[]
  now?: () => number
}

export function createMigrationContract(
  root: string,
  input: CreateMigrationContractInput
): MigrationContractJournal {
  if (!input.kind.trim() || !Number.isSafeInteger(input.fromVersion) || !Number.isSafeInteger(input.toVersion) ||
      input.fromVersion < 0 || input.toVersion < input.fromVersion || !input.backupId.trim()) {
    throw new Error('migration_contract_input_invalid')
  }
  const now = input.now ?? Date.now
  const timestamp = now()
  const migrationId = input.migrationId ?? `${input.kind.replace(/[^A-Za-z0-9._-]/g, '-')}-${timestamp}-${randomUUID()}`
  const journal: MigrationContractJournal = {
    schemaVersion: 1,
    format: MIGRATION_CONTRACT_FORMAT,
    migrationId,
    kind: input.kind,
    fromVersion: input.fromVersion,
    toVersion: input.toVersion,
    backupId: input.backupId,
    source: { ...input.source },
    targets: input.targets.map((target) => ({ ...target })),
    state: 'prepared',
    writesCompleted: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    transitions: [{ state: 'prepared', at: timestamp }]
  }
  writeContract(root, journal)
  return journal
}

export function transitionMigrationContract(
  root: string,
  journal: MigrationContractJournal,
  nextState: MigrationContractState,
  patch: Partial<Pick<MigrationContractJournal, 'writesCompleted' | 'targets'>> = {},
  now: () => number = Date.now
): MigrationContractJournal {
  if (!isAllowedTransition(journal.state, nextState)) {
    throw new Error(`migration_contract_invalid_transition:${journal.state}->${nextState}`)
  }
  const timestamp = now()
  const next: MigrationContractJournal = {
    ...journal,
    ...(patch.targets ? { targets: patch.targets.map((target) => ({ ...target })) } : {}),
    ...(patch.writesCompleted === undefined ? {} : { writesCompleted: patch.writesCompleted }),
    state: nextState,
    updatedAt: timestamp,
    transitions: [...journal.transitions, { state: nextState, at: timestamp }]
  }
  writeContract(root, next)
  return next
}

export function readMigrationContract(root: string, migrationId: string): MigrationContractJournal {
  const path = contractPath(root, migrationId)
  if (!existsSync(path)) throw new Error('migration_contract_missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    throw new Error('migration_contract_invalid')
  }
  assertContract(parsed)
  return parsed
}

export function listMigrationContracts(root: string): Array<{ path: string; journal: MigrationContractJournal }> {
  const directory = resolve(root)
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = contractPath(directory, entry.name)
      if (!existsSync(path)) return undefined
      try {
        const journal = readMigrationContract(directory, entry.name)
        return { path, journal }
      } catch {
        return undefined
      }
    })
    .filter((entry): entry is { path: string; journal: MigrationContractJournal } => entry !== undefined)
}

/** Reconcile only contracts that provably performed no target write before a crash. */
export function reconcileMigrationContracts(root: string): Array<{ migrationId: string; state: MigrationContractState; recoverable: boolean }> {
  const result: Array<{ migrationId: string; state: MigrationContractState; recoverable: boolean }> = []
  for (const { journal } of listMigrationContracts(root)) {
    if (journal.state === 'committed' || journal.state === 'rolled_back') continue
    const unchanged = journal.targets.every((target) => targetFingerprint(target.path) === target.beforeFingerprint)
    result.push({ migrationId: journal.migrationId, state: journal.state, recoverable: unchanged })
  }
  return result
}

export function assertMigrationContractPreflight(journal: MigrationContractJournal): void {
  if (journal.state !== 'prepared' && journal.state !== 'backup_verified') {
    throw new Error('migration_contract_not_preflight')
  }
  for (const target of journal.targets) {
    if (targetFingerprint(target.path) !== target.beforeFingerprint) throw new Error('migration_contract_target_changed')
  }
}

function writeContract(root: string, journal: MigrationContractJournal): void {
  writeDurableFileSync(contractPath(root, journal.migrationId), `${JSON.stringify(journal, null, 2)}\n`)
}

function contractPath(root: string, migrationId: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(migrationId)) throw new Error('migration_contract_id_invalid')
  return join(resolve(root), migrationId, 'contract.json')
}

function assertContract(value: unknown): asserts value is MigrationContractJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('migration_contract_invalid')
  const item = value as Partial<MigrationContractJournal>
  if (item.schemaVersion !== 1 || item.format !== MIGRATION_CONTRACT_FORMAT || typeof item.migrationId !== 'string' ||
      typeof item.kind !== 'string' || !Number.isSafeInteger(item.fromVersion) || !Number.isSafeInteger(item.toVersion) ||
      typeof item.backupId !== 'string' || !item.source || !Array.isArray(item.targets) ||
      !isState(item.state) || !Number.isSafeInteger(item.writesCompleted) || !Array.isArray(item.transitions)) {
    throw new Error('migration_contract_invalid')
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(item.migrationId) || !item.kind.trim() || (item.fromVersion ?? -1) < 0 ||
      (item.toVersion ?? -1) < (item.fromVersion ?? 0) || (item.writesCompleted ?? -1) < 0 || !item.backupId.trim()) {
    throw new Error('migration_contract_invalid')
  }
  if (!item.source.path || !/^[a-f0-9]{64}$/.test(item.source.sha256) || !Number.isSafeInteger(item.source.sizeBytes) || item.source.sizeBytes < 0) {
    throw new Error('migration_contract_invalid')
  }
  if (item.targets.some((target) => !target || typeof target.path !== 'string' || !target.path ||
      typeof target.beforeFingerprint !== 'string' || (target.afterFingerprint !== undefined && typeof target.afterFingerprint !== 'string'))) {
    throw new Error('migration_contract_invalid')
  }
}

function isState(value: unknown): value is MigrationContractState {
  return value === 'prepared' || value === 'backup_verified' || value === 'applying' || value === 'committed' ||
    value === 'rollback_pending' || value === 'rolled_back'
}

function isAllowedTransition(current: MigrationContractState, next: MigrationContractState): boolean {
  if (current === next && current === 'applying') return true
  if (current === 'prepared') return next === 'backup_verified' || next === 'rollback_pending'
  if (current === 'backup_verified') return next === 'applying' || next === 'rollback_pending'
  if (current === 'applying') return next === 'committed' || next === 'rollback_pending'
  if (current === 'committed') return next === 'rollback_pending'
  if (current === 'rollback_pending') return next === 'rolled_back'
  return false
}
