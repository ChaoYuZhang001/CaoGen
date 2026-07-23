import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { ProjectWorkspaceState } from '../../shared/project-workspace-types'
import { digest } from './codec'
import { assertCanonicalAcceptanceBeforeTerminalWrite } from './ledger-shadow-acceptance'
import {
  listShadowJournals,
  projectWorkspaceLedgerShadowError,
  sealShadowJournal,
  shadowErrorRecord,
  updateShadowJournal,
  writeShadowJournal
} from './ledger-shadow-journal'
import { withProjectWorkspaceLedgerShadowLock } from './ledger-shadow-lock'
import {
  assertShadowCommittedSourceContinuity,
  classifyPreparedShadowJournal,
  findProjectWorkspaceLedgerShadowEntity,
  readProjectWorkspaceLedgerShadowSource,
  shadowProjectionCoversSource,
  shadowSourceAfter
} from './ledger-shadow-source'
import type {
  ProjectWorkspaceLedgerShadowCheckpoint,
  ProjectWorkspaceLedgerShadowEntity,
  ProjectWorkspaceLedgerShadowJournal,
  ProjectWorkspaceLedgerShadowMigration,
  ProjectWorkspaceLedgerShadowMutation,
  ProjectWorkspaceLedgerShadowOptions,
  ProjectWorkspaceLedgerShadowReadiness
} from './ledger-shadow-types'
import { PROJECT_WORKSPACE_LEDGER_SHADOW_JOURNAL_FORMAT } from './ledger-shadow-types'
import { resolveProjectWorkspaceRoot } from './persistence'
import type {
  ProjectWorkspaceLedgerMigrationOptions,
  ProjectWorkspaceLedgerMigrationResult
} from './ledger-migration'
import { ProjectWorkspaceError } from './errors'

const SHADOW_DIR = 'project-workspace-ledger-shadow'
const JOURNAL_DIR = 'journals'
const LOCK_FILE = 'command-write.lock'
const MAX_STABILITY_ATTEMPTS = 3

interface SourceCommit<T extends ProjectWorkspaceLedgerShadowEntity> {
  result: T
  journal: ProjectWorkspaceLedgerShadowJournal
  resultSuperseded: boolean
}

interface StableProjection {
  journal: ProjectWorkspaceLedgerShadowJournal
  state: ProjectWorkspaceState
  entity: ProjectWorkspaceLedgerShadowEntity
  resultSuperseded: boolean
}

export class ProjectWorkspaceLedgerShadowBoundary {
  readonly rootDir: string
  readonly shadowDir: string
  readonly journalDir: string
  readonly lockPath: string
  private readonly now: () => number
  private readonly migrate: ProjectWorkspaceLedgerShadowMigration

  constructor(rootDir?: string, private readonly options: ProjectWorkspaceLedgerShadowOptions = {}) {
    this.rootDir = resolve(resolveProjectWorkspaceRoot(rootDir))
    this.shadowDir = join(this.rootDir, SHADOW_DIR)
    this.journalDir = join(this.shadowDir, JOURNAL_DIR)
    this.lockPath = join(this.shadowDir, LOCK_FILE)
    this.now = options.now ?? Date.now
    this.migrate = options.migrate ?? defaultMigration
  }

  execute<T extends ProjectWorkspaceLedgerShadowEntity>(
    mutation: ProjectWorkspaceLedgerShadowMutation,
    writeSource: () => Promise<T>
  ): Promise<T> {
    return this.withLock(() => this.executeLocked(mutation, writeSource))
  }

  async reconcile(): Promise<ProjectWorkspaceLedgerShadowReadiness> {
    return this.withLock(async () => {
      await this.reconcilePendingLocked()
      return this.readinessLocked()
    })
  }

  readiness(): Promise<ProjectWorkspaceLedgerShadowReadiness> {
    return this.withLock(() => this.readinessLocked())
  }

  withConsistentProjectionRead<T>(callback: (rootDir: string) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      await this.reconcilePendingLocked()
      const readiness = await this.readinessLocked()
      if (!readiness.ready) {
        throw new ProjectWorkspaceError(
          'ledger_reconciliation_required',
          'ProjectWorkspace canonical read is blocked by pending Ledger shadow reconciliation',
          { pendingJournals: readiness.pendingJournals }
        )
      }
      return callback(this.rootDir)
    })
  }

  private async executeLocked<T extends ProjectWorkspaceLedgerShadowEntity>(
    mutation: ProjectWorkspaceLedgerShadowMutation,
    writeSource: () => Promise<T>
  ): Promise<T> {
    await this.reconcilePendingLocked()
    const before = await this.readSource()
    await assertCanonicalAcceptanceBeforeTerminalWrite(this.rootDir, before, mutation)
    const { journalPath, journal } = await this.prepareJournal(mutation, before)
    await this.checkpoint('after_prepare', journal, journalPath)
    const sourceCommit = await this.commitSource(journalPath, journal, before, mutation, writeSource)
    await this.checkpoint('after_source_commit', sourceCommit.journal, journalPath)
    const stable = await this.synchronizeProjection(
      journalPath,
      sourceCommit.journal,
      sourceCommit.result,
      sourceCommit.resultSuperseded
    )
    await this.checkpoint('after_projection_before_journal_commit', stable.journal, journalPath)
    await writeShadowJournal(journalPath, stable.journal)
    this.assertReturnableResult(journalPath, stable, sourceCommit.result)
    return sourceCommit.result
  }

  private async prepareJournal(
    mutation: ProjectWorkspaceLedgerShadowMutation,
    before: ProjectWorkspaceState
  ): Promise<{ journalPath: string; journal: ProjectWorkspaceLedgerShadowJournal }> {
    const entityBefore = findProjectWorkspaceLedgerShadowEntity(before, mutation.entityType, mutation.entityId)
    const operationId = randomUUID()
    const journalPath = this.journalPath(operationId)
    const createdAt = this.now()
    const journal = sealShadowJournal({
      schemaVersion: 1,
      format: PROJECT_WORKSPACE_LEDGER_SHADOW_JOURNAL_FORMAT,
      operationId,
      command: mutation.command,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      workspaceId: mutation.workspaceId ?? entityBefore?.projectId,
      state: 'prepared',
      source: {
        storeRevisionBefore: before.revision,
        entityRevisionBefore: entityBefore?.revision,
        entityDigestBefore: entityBefore ? digest(entityBefore) : undefined
      },
      attempts: 0,
      createdAt,
      updatedAt: createdAt
    })
    await writeShadowJournal(journalPath, journal)
    return { journalPath, journal }
  }

  private async commitSource<T extends ProjectWorkspaceLedgerShadowEntity>(
    journalPath: string,
    journal: ProjectWorkspaceLedgerShadowJournal,
    before: ProjectWorkspaceState,
    mutation: ProjectWorkspaceLedgerShadowMutation,
    writeSource: () => Promise<T>
  ): Promise<SourceCommit<T>> {
    let result: T
    try {
      result = await writeSource()
    } catch (error) {
      await this.handleSourceWriteError(journalPath, journal, error)
      throw error
    }
    const after = await this.readSource()
    const persisted = findProjectWorkspaceLedgerShadowEntity(after, mutation.entityType, mutation.entityId)
    if (!persisted || after.revision <= before.revision) {
      throw this.failure('ledger_source_commit_unproven',
        'ProjectWorkspace command returned without a provable durable JSON mutation', journalPath, journal, false, true)
    }
    const committed = updateShadowJournal(journal, {
      workspaceId: persisted.projectId,
      state: 'source_committed',
      source: shadowSourceAfter(journal.source, after, persisted),
      updatedAt: this.now(),
      lastError: undefined
    })
    await writeShadowJournal(journalPath, committed)
    const resultSuperseded = mutation.workspaceId !== undefined && mutation.workspaceId !== persisted.projectId ||
      result.id !== persisted.id || result.projectId !== persisted.projectId || result.revision !== persisted.revision
    return { result, journal: committed, resultSuperseded }
  }

  private async handleSourceWriteError(
    journalPath: string,
    journal: ProjectWorkspaceLedgerShadowJournal,
    error: unknown
  ): Promise<void> {
    const current = await this.readSource()
    const disposition = classifyPreparedShadowJournal(journal, current)
    if (disposition.kind === 'not_committed') {
      await writeShadowJournal(journalPath, updateShadowJournal(journal, {
        state: 'aborted',
        updatedAt: this.now(),
        lastError: shadowErrorRecord(error, this.now())
      }))
      return
    }
    if (disposition.kind === 'ambiguous') {
      const pending = await this.persistAmbiguous(journalPath, journal, disposition.reason, error)
      throw this.failure('ledger_source_commit_ambiguous', disposition.reason, journalPath, pending, false, true, error)
    }
    const pending = await this.persistSourceCommitted(journalPath, journal, disposition.state, disposition.entity)
    const stable = await this.synchronizeProjection(journalPath, pending)
    await writeShadowJournal(journalPath, stable.journal)
    throw this.failure('ledger_source_commit_uncertain',
      'ProjectWorkspace JSON advanced even though its repository command rejected',
      journalPath, stable.journal, true, false, error)
  }

  private async synchronizeProjection(
    journalPath: string,
    initial: ProjectWorkspaceLedgerShadowJournal,
    result?: ProjectWorkspaceLedgerShadowEntity,
    superseded = false
  ): Promise<StableProjection> {
    let pending = initial
    let resultSuperseded = superseded
    for (let attempt = 0; attempt < MAX_STABILITY_ATTEMPTS; attempt += 1) {
      const committed = await this.projectJournal(journalPath, pending)
      const state = await this.readSource()
      const entity = findProjectWorkspaceLedgerShadowEntity(state, committed.entityType, committed.entityId)
      if (!entity || entity.projectId !== committed.workspaceId) {
        throw this.failure('ledger_reconciliation_required',
          'Projected entity disappeared or changed Workspace ownership', journalPath, pending, true, true)
      }
      if (shadowProjectionCoversSource(committed, state)) {
        resultSuperseded ||= Boolean(result && !sameEntityVersion(result, entity))
        return { journal: committed, state, entity, resultSuperseded }
      }
      resultSuperseded ||= Boolean(result && !sameEntityVersion(result, entity))
      pending = updateShadowJournal(committed, {
        state: 'source_committed',
        source: shadowSourceAfter(committed.source, state, entity),
        projection: undefined,
        updatedAt: this.now(),
        lastError: undefined
      })
    }
    await writeShadowJournal(journalPath, pending)
    throw this.failure('ledger_projection_source_unstable',
      'ProjectWorkspace JSON kept changing after Workflow Ledger projection', journalPath, pending, true, true)
  }

  private async projectJournal(
    journalPath: string,
    journal: ProjectWorkspaceLedgerShadowJournal
  ): Promise<ProjectWorkspaceLedgerShadowJournal> {
    if (!journal.workspaceId) {
      throw this.failure('ledger_reconciliation_required', 'Shadow journal has no provable Workspace ownership',
        journalPath, journal, journal.state === 'source_committed', true)
    }
    const attempting = updateShadowJournal(journal, {
      state: 'source_committed',
      attempts: journal.attempts + 1,
      updatedAt: this.now(),
      lastError: undefined
    })
    await writeShadowJournal(journalPath, attempting)
    try {
      const projection = await this.migrate(journal.workspaceId, this.rootDir, { now: this.now })
      return updateShadowJournal(attempting, {
        state: 'projection_committed',
        projection: migrationProjection(projection),
        updatedAt: this.now(),
        lastError: undefined
      })
    } catch (error) {
      const pending = updateShadowJournal(attempting, {
        updatedAt: this.now(),
        lastError: shadowErrorRecord(error, this.now())
      })
      await writeShadowJournal(journalPath, pending).catch(() => undefined)
      throw this.failure('ledger_projection_pending',
        'ProjectWorkspace JSON committed but Workflow Ledger projection did not complete',
        journalPath, pending, true, true, error)
    }
  }

  private async reconcilePendingLocked(): Promise<void> {
    for (const entry of await listShadowJournals(this.journalDir)) {
      let journal = entry.journal
      if (journal.state === 'projection_committed' || journal.state === 'aborted') continue
      const current = await this.readSource()
      if (journal.state === 'prepared') {
        const recovered = await this.recoverPreparedJournal(entry.path, journal, current)
        if (!recovered) continue
        journal = recovered
      } else {
        const continuityError = assertShadowCommittedSourceContinuity(journal, current)
        if (continuityError) {
          throw this.failure('ledger_reconciliation_required', continuityError, entry.path, journal, true, true)
        }
      }
      const stable = await this.synchronizeProjection(entry.path, journal)
      await writeShadowJournal(entry.path, stable.journal)
    }
  }

  private async recoverPreparedJournal(
    journalPath: string,
    journal: ProjectWorkspaceLedgerShadowJournal,
    current: ProjectWorkspaceState
  ): Promise<ProjectWorkspaceLedgerShadowJournal | undefined> {
    const disposition = classifyPreparedShadowJournal(journal, current)
    if (disposition.kind === 'not_committed') {
      await writeShadowJournal(journalPath, updateShadowJournal(journal, {
        state: 'aborted', updatedAt: this.now(), lastError: undefined
      }))
      return undefined
    }
    if (disposition.kind === 'ambiguous') {
      const pending = await this.persistAmbiguous(journalPath, journal, disposition.reason)
      throw this.failure('ledger_reconciliation_required', disposition.reason, journalPath, pending, false, true)
    }
    return this.persistSourceCommitted(journalPath, journal, disposition.state, disposition.entity)
  }

  private async persistSourceCommitted(
    journalPath: string,
    journal: ProjectWorkspaceLedgerShadowJournal,
    state: ProjectWorkspaceState,
    entity: ProjectWorkspaceLedgerShadowEntity
  ): Promise<ProjectWorkspaceLedgerShadowJournal> {
    const pending = updateShadowJournal(journal, {
      workspaceId: entity.projectId,
      state: 'source_committed',
      source: shadowSourceAfter(journal.source, state, entity),
      updatedAt: this.now(),
      lastError: undefined
    })
    await writeShadowJournal(journalPath, pending)
    return pending
  }

  private async persistAmbiguous(
    journalPath: string,
    journal: ProjectWorkspaceLedgerShadowJournal,
    reason: string,
    cause?: unknown
  ): Promise<ProjectWorkspaceLedgerShadowJournal> {
    const pending = updateShadowJournal(journal, {
      updatedAt: this.now(),
      lastError: shadowErrorRecord(cause ?? new Error(reason), this.now())
    })
    await writeShadowJournal(journalPath, pending)
    return pending
  }

  private async readinessLocked(): Promise<ProjectWorkspaceLedgerShadowReadiness> {
    const entries = await listShadowJournals(this.journalDir)
    const counts = countJournalStates(entries.map((entry) => entry.journal))
    const pending = entries.filter((entry) =>
      entry.journal.state === 'prepared' || entry.journal.state === 'source_committed'
    ).map((entry) => ({
      operationId: entry.journal.operationId,
      command: entry.journal.command,
      entityType: entry.journal.entityType,
      entityId: entry.journal.entityId,
      workspaceId: entry.journal.workspaceId,
      state: entry.journal.state as 'prepared' | 'source_committed',
      attempts: entry.journal.attempts,
      journalPath: entry.path,
      lastError: entry.journal.lastError
    }))
    return {
      enabled: true,
      ready: pending.length === 0,
      rootDir: this.rootDir,
      totalJournals: entries.length,
      pendingJournals: pending.length,
      prepared: counts.prepared,
      sourceCommitted: counts.source_committed,
      projectionCommitted: counts.projection_committed,
      aborted: counts.aborted,
      pending
    }
  }

  private assertReturnableResult(
    journalPath: string,
    stable: StableProjection,
    result: ProjectWorkspaceLedgerShadowEntity
  ): void {
    if (!stable.resultSuperseded && sameEntityVersion(result, stable.entity)) return
    throw this.failure('ledger_source_result_superseded',
      'ProjectWorkspace source advanced before the command result could be returned',
      journalPath, stable.journal, true, false)
  }

  private checkpoint(
    checkpoint: ProjectWorkspaceLedgerShadowCheckpoint,
    journal: ProjectWorkspaceLedgerShadowJournal,
    journalPath: string
  ): Promise<void> {
    if (this.options.faultAt !== checkpoint) return Promise.resolve()
    return this.invokeFault(checkpoint, journal, journalPath)
  }

  private async invokeFault(
    checkpoint: ProjectWorkspaceLedgerShadowCheckpoint,
    journal: ProjectWorkspaceLedgerShadowJournal,
    journalPath: string
  ): Promise<void> {
    await this.options.onFault?.(checkpoint, journal)
    throw this.failure('ledger_shadow_fault_injected', `Injected Ledger shadow fault at ${checkpoint}`,
      journalPath, journal, journal.state !== 'prepared', true)
  }

  private readSource(): Promise<ProjectWorkspaceState> {
    return readProjectWorkspaceLedgerShadowSource(this.rootDir)
  }

  private journalPath(operationId: string): string {
    return join(this.journalDir, `${operationId}.json`)
  }

  private failure(
    code: string,
    message: string,
    journalPath: string,
    journal: ProjectWorkspaceLedgerShadowJournal,
    sourceCommitted: boolean,
    reconciliationRequired: boolean,
    cause?: unknown
  ) {
    return projectWorkspaceLedgerShadowError({
      code, message, journalPath, journal, sourceCommitted, reconciliationRequired, cause
    })
  }

  private withLock<T>(callback: () => Promise<T>): Promise<T> {
    return withProjectWorkspaceLedgerShadowLock(this.lockPath, this.now, callback)
  }
}

export function createProjectWorkspaceLedgerShadowBoundary(
  rootDir?: string,
  options?: ProjectWorkspaceLedgerShadowOptions
): ProjectWorkspaceLedgerShadowBoundary {
  return new ProjectWorkspaceLedgerShadowBoundary(rootDir, options)
}

export async function reconcileProjectWorkspaceLedgerShadow(
  rootDir?: string,
  options?: ProjectWorkspaceLedgerShadowOptions
): Promise<ProjectWorkspaceLedgerShadowReadiness> {
  return createProjectWorkspaceLedgerShadowBoundary(rootDir, options).reconcile()
}

export function inspectProjectWorkspaceLedgerShadowReadiness(
  rootDir?: string
): Promise<ProjectWorkspaceLedgerShadowReadiness> {
  return createProjectWorkspaceLedgerShadowBoundary(rootDir).readiness()
}

async function defaultMigration(
  workspaceId: string,
  rootDir?: string,
  options?: ProjectWorkspaceLedgerMigrationOptions
): Promise<ProjectWorkspaceLedgerMigrationResult> {
  const migration = await import('./ledger-migration.js')
  return migration.migrateProjectWorkspaceToWorkflowLedger(workspaceId, rootDir, options)
}

function migrationProjection(result: ProjectWorkspaceLedgerMigrationResult) {
  return {
    status: result.status,
    stateRevision: result.stateRevision,
    workspaceRevision: result.workspaceRevision,
    projectionDigest: result.projectionDigest,
    sourceSha256: result.sourceSha256,
    migrationId: result.migrationId,
    migrationJournalPath: result.journalPath
  }
}

function sameEntityVersion(
  left: ProjectWorkspaceLedgerShadowEntity,
  right: ProjectWorkspaceLedgerShadowEntity
): boolean {
  return left.id === right.id && left.projectId === right.projectId &&
    left.revision === right.revision && digest(left) === digest(right)
}

function countJournalStates(journals: readonly ProjectWorkspaceLedgerShadowJournal[]) {
  const counts = { prepared: 0, source_committed: 0, projection_committed: 0, aborted: 0 }
  for (const journal of journals) counts[journal.state] += 1
  return counts
}
