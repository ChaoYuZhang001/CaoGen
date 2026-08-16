import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkflowArtifactKind } from '../../shared/workflow-types'
import { ProjectWorkspaceStore } from '../project-workspace/store'
import { resolveProjectWorkspaceRoot } from '../project-workspace/persistence'
import {
  artifactBlobPath,
  assertRegularContent,
  isArtifactSourceProjectPath,
  materializeArtifactBlob,
  pathExists,
  prepareArtifactContent
} from './artifact-lifecycle-content'
import {
  assertLegacyArtifactLifecycleOwnership,
  assertArtifactLifecycleProjectOwnership,
  resolveArtifactProjectOwnership,
  resolveLegacyArtifactProjectOwnership
} from './artifact-lifecycle-ownership'
import {
  findArtifactLifecycle,
  appendArtifactRetentionRevision,
  planArtifactPurge,
  readArtifactLifecycles,
  recordArtifactPurge,
  registerArtifactLifecycle
} from './artifact-lifecycle-store'
import type {
  ArtifactLifecycleRecord,
  ArtifactLifecyclePurgeInput,
  ArtifactLifecyclePurgeResult,
  ArtifactLifecycleRegistrationInput,
  ArtifactLifecycleRegistrationResult,
  ArtifactLifecycleRootInput,
  ArtifactLifecycleVerification,
  ArtifactRetentionRevisionInput,
  ArtifactRetentionRevisionRecord,
  ArtifactProjectOwnership,
  PreparedArtifactContent
} from './artifact-lifecycle-types'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { verifyArtifactLifecycle } from './artifact-lifecycle-verification'
import {
  mutateTaskSnapshotDatabase,
  readTaskSnapshotDatabase,
  taskSnapshotsDbFile
} from './task-snapshot'
import { findWorkflowRun, findWorkflowWorkItem } from './workflow-ledger-store'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export async function registerPersistedArtifactLifecycle(
  input: ArtifactLifecycleRegistrationInput,
  rootInput?: ArtifactLifecycleRootInput
): Promise<ArtifactLifecycleRegistrationResult> {
  return registerPersistedArtifactLifecycleAtomically(
    input,
    (_db, registered) => registered,
    rootInput
  )
}

/**
 * Persist an Artifact lifecycle and its dependent Workflow records in one
 * snapshot-database commit. Blob materialization is rolled back when any
 * dependent projection fails before the database is published.
 */
export async function registerPersistedArtifactLifecycleAtomically<T>(
  input: ArtifactLifecycleRegistrationInput,
  transaction: (
    db: WorkflowLedgerDatabase,
    registered: ArtifactLifecycleRegistrationResult
  ) => T | Promise<T>,
  rootInput?: ArtifactLifecycleRootInput
): Promise<T> {
  const roots = resolveLifecycleRoots(rootInput)
  const ownership = await loadRegistrationOwnership(input, roots)
  const content = await prepareArtifactContent(input.content, roots.workflowRoot)
  let createdBlob = false
  try {
    return await mutateTaskSnapshotDatabase(roots.workflowRoot, async (db) => {
      createdBlob = await materializeArtifactBlob(content)
      const registered = registerArtifactLifecycle(db, input, content, ownership)
      return transaction(db, registered)
    })
  } catch (error) {
    if (createdBlob) await removeOrphanedBlob(roots.workflowRoot, content)
    throw error
  }
}

export async function purgePersistedArtifactContent(
  input: ArtifactLifecyclePurgeInput,
  rootInput?: ArtifactLifecycleRootInput
): Promise<ArtifactLifecyclePurgeResult> {
  const roots = resolveLifecycleRoots(rootInput)
  await assertPurgeProjectOwnership(input, roots)
  let quarantine: { source: string; temporary: string } | undefined
  try {
    const result = await mutateTaskSnapshotDatabase(roots.workflowRoot, async (db) => {
      const plan = planArtifactPurge(db, input)
      if (plan.deleteBlob) {
        const source = artifactBlobPath(roots.workflowRoot, plan.lifecycle.digest)
        await assertRegularContent(source, plan.lifecycle.digest, plan.lifecycle.sizeBytes)
        const temporary = `${source}.purge.${process.pid}.${randomUUID()}`
        await rename(source, temporary)
        quarantine = { source, temporary }
      } else if (plan.lifecycle.storageKind === 'source_ref' && plan.lifecycle.sourceRef &&
          isArtifactSourceProjectPath(roots.workflowRoot, plan.lifecycle.projectId, plan.lifecycle.sourceRef)) {
        await assertRegularContent(plan.lifecycle.sourceRef, plan.lifecycle.digest, plan.lifecycle.sizeBytes)
        const temporary = `${plan.lifecycle.sourceRef}.purge.${process.pid}.${randomUUID()}`
        await rename(plan.lifecycle.sourceRef, temporary)
        quarantine = { source: plan.lifecycle.sourceRef, temporary }
      }
      return recordArtifactPurge(db, input, plan)
    })
    if (quarantine) await rm(quarantine.temporary, { force: true })
    return result
  } catch (error) {
    await restoreQuarantine(quarantine)
    throw error
  }
}

export async function revisePersistedArtifactRetention(
  input: ArtifactRetentionRevisionInput,
  rootInput?: ArtifactLifecycleRootInput
): Promise<ArtifactRetentionRevisionRecord> {
  const roots = resolveLifecycleRoots(rootInput)
  await assertPurgeProjectOwnership(input, roots)
  return mutateTaskSnapshotDatabase(roots.workflowRoot, (db) => appendArtifactRetentionRevision(db, input))
}

export async function verifyPersistedArtifactLifecycle(
  rootInput?: ArtifactLifecycleRootInput,
  requiredKinds: readonly WorkflowArtifactKind[] = []
): Promise<ArtifactLifecycleVerification> {
  const roots = resolveLifecycleRoots(rootInput)
  const workspace = new ProjectWorkspaceStore(roots.workspaceRoot)
  await workspace.open()
  const state = await workspace.getState()
  return readTaskSnapshotDatabase(roots.workflowRoot, async (db) => {
    const records = readArtifactLifecycles(db)
    const legacyRecords = records.filter((record) => record.provenance === 'legacy-derived')
    assertArtifactLifecycleProjectOwnership(
      state,
      records.filter((record) => record.provenance !== 'legacy-derived')
    )
    for (const record of legacyRecords) {
      const run = findWorkflowRun(db, record.runId)
      const workItem = run ? findWorkflowWorkItem(db, run.workItemId) : null
      assertLegacyArtifactLifecycleOwnership(record, run, workItem)
    }
    return verifyArtifactLifecycle(db, roots.workflowRoot, requiredKinds)
  })
}

export async function getPersistedArtifactLifecycle(
  artifactId: string,
  rootInput?: ArtifactLifecycleRootInput
) {
  const roots = resolveLifecycleRoots(rootInput)
  return readTaskSnapshotDatabase(roots.workflowRoot, (db) => findArtifactLifecycle(db, artifactId))
}

export async function getLatestPersistedArtifactLifecycleByLineage(
  input: {
    projectId: string
    workItemId?: string
    lineageId: string
    kind: WorkflowArtifactKind
  },
  rootInput?: ArtifactLifecycleRootInput
): Promise<ArtifactLifecycleRecord | null> {
  const roots = resolveLifecycleRoots(rootInput)
  return readTaskSnapshotDatabase(roots.workflowRoot, (db) => {
    const matches = readArtifactLifecycles(db).filter((record) =>
      record.projectId === input.projectId &&
      (input.workItemId === undefined || record.workItemId === input.workItemId) &&
      record.lineageId === input.lineageId &&
      record.kind === input.kind
    )
    return matches.sort((left, right) => right.version - left.version ||
      right.createdAt - left.createdAt || right.artifactId.localeCompare(left.artifactId))[0] ?? null
  })
}

async function loadRegistrationOwnership(
  input: ArtifactLifecycleRegistrationInput,
  roots: ResolvedArtifactLifecycleRoots
): Promise<ArtifactProjectOwnership> {
  const { run, workItem } = await readTaskSnapshotDatabase(roots.workflowRoot, (db) => {
    const run = findWorkflowRun(db, input.runId)
    return { run, workItem: run ? findWorkflowWorkItem(db, run.workItemId) : null }
  })
  if (!run) throw new WorkflowLedgerCorruptionError(`creating Run not found: ${input.runId}`)
  const workspace = new ProjectWorkspaceStore(roots.workspaceRoot)
  await workspace.open()
  const state = await workspace.getState()
  if (state.workspaces.some((candidate) => candidate.id === input.projectId) ||
      input.provenance !== 'legacy-derived') {
    return resolveArtifactProjectOwnership(state, run, input.projectId, true)
  }
  return resolveLegacyArtifactProjectOwnership(run, workItem, input.projectId)
}

async function assertPurgeProjectOwnership(
  input: ArtifactLifecyclePurgeInput,
  roots: ResolvedArtifactLifecycleRoots
): Promise<void> {
  const lifecycle = await readTaskSnapshotDatabase(
    roots.workflowRoot,
    (db) => findArtifactLifecycle(db, input.artifactId)
  )
  if (!lifecycle || lifecycle.projectId !== input.projectId) {
    throw new WorkflowLedgerCorruptionError(`artifact purge crosses Project ownership boundary: ${input.artifactId}`)
  }
  const workspace = new ProjectWorkspaceStore(roots.workspaceRoot)
  await workspace.open()
  if (lifecycle.provenance === 'legacy-derived') {
    await readTaskSnapshotDatabase(roots.workflowRoot, (db) => {
      const run = findWorkflowRun(db, lifecycle.runId)
      const workItem = run ? findWorkflowWorkItem(db, run.workItemId) : null
      assertLegacyArtifactLifecycleOwnership(lifecycle, run, workItem)
    })
    return
  }
  assertArtifactLifecycleProjectOwnership(await workspace.getState(), [lifecycle])
}

interface ResolvedArtifactLifecycleRoots {
  workflowRoot: string
  workspaceRoot: string
}

export function resolveLifecycleRoots(input?: ArtifactLifecycleRootInput): ResolvedArtifactLifecycleRoots {
  if (typeof input === 'string') {
    const root = resolveProjectWorkspaceRoot(input)
    return { workflowRoot: root, workspaceRoot: root }
  }
  const workflowRoot = input?.workflowRoot ?? dirname(taskSnapshotsDbFile())
  return {
    workflowRoot,
    workspaceRoot: resolveProjectWorkspaceRoot(input?.workspaceRoot ?? workflowRoot)
  }
}

async function removeOrphanedBlob(root: string, content: PreparedArtifactContent): Promise<void> {
  if (content.storageKind !== 'blob') return
  const referenced = await readTaskSnapshotDatabase(root, (db) =>
    readArtifactLifecycles(db).some((record) => record.blobRef === content.blobRef))
  if (!referenced) await rm(content.locationPath, { force: true })
}

async function restoreQuarantine(
  quarantine: { source: string; temporary: string } | undefined
): Promise<void> {
  if (!quarantine || !(await pathExists(quarantine.temporary))) return
  if (await pathExists(quarantine.source)) {
    await rm(quarantine.temporary, { force: true })
    return
  }
  await rename(quarantine.temporary, quarantine.source)
}
