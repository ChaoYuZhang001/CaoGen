import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkflowArtifactKind } from '../../shared/workflow-types'
import { ProjectWorkspaceStore } from '../project-workspace/store'
import { resolveProjectWorkspaceRoot } from '../project-workspace/persistence'
import {
  artifactBlobPath,
  assertRegularContent,
  materializeArtifactBlob,
  pathExists,
  prepareArtifactContent
} from './artifact-lifecycle-content'
import {
  assertArtifactLifecycleProjectOwnership,
  resolveArtifactProjectOwnership
} from './artifact-lifecycle-ownership'
import {
  findArtifactLifecycle,
  planArtifactPurge,
  readArtifactLifecycles,
  recordArtifactPurge,
  registerArtifactLifecycle
} from './artifact-lifecycle-store'
import type {
  ArtifactLifecyclePurgeInput,
  ArtifactLifecyclePurgeResult,
  ArtifactLifecycleRegistrationInput,
  ArtifactLifecycleRegistrationResult,
  ArtifactLifecycleRootInput,
  ArtifactLifecycleVerification,
  ArtifactProjectOwnership,
  PreparedArtifactContent
} from './artifact-lifecycle-types'
import { verifyArtifactLifecycle } from './artifact-lifecycle-verification'
import {
  mutateTaskSnapshotDatabase,
  readTaskSnapshotDatabase,
  taskSnapshotsDbFile
} from './task-snapshot'
import { findWorkflowRun } from './workflow-ledger-store'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export async function registerPersistedArtifactLifecycle(
  input: ArtifactLifecycleRegistrationInput,
  rootInput?: ArtifactLifecycleRootInput
): Promise<ArtifactLifecycleRegistrationResult> {
  const roots = resolveLifecycleRoots(rootInput)
  const ownership = await loadRegistrationOwnership(input, roots)
  const content = await prepareArtifactContent(input.content, roots.workflowRoot)
  let createdBlob = false
  try {
    return await mutateTaskSnapshotDatabase(roots.workflowRoot, async (db) => {
      createdBlob = await materializeArtifactBlob(content)
      return registerArtifactLifecycle(db, input, content, ownership)
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
    assertArtifactLifecycleProjectOwnership(state, records)
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

async function loadRegistrationOwnership(
  input: ArtifactLifecycleRegistrationInput,
  roots: ResolvedArtifactLifecycleRoots
): Promise<ArtifactProjectOwnership> {
  const run = await readTaskSnapshotDatabase(roots.workflowRoot, (db) => findWorkflowRun(db, input.runId))
  if (!run) throw new WorkflowLedgerCorruptionError(`creating Run not found: ${input.runId}`)
  const workspace = new ProjectWorkspaceStore(roots.workspaceRoot)
  await workspace.open()
  return resolveArtifactProjectOwnership(await workspace.getState(), run, input.projectId, true)
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
  assertArtifactLifecycleProjectOwnership(await workspace.getState(), [lifecycle])
}

interface ResolvedArtifactLifecycleRoots {
  workflowRoot: string
  workspaceRoot: string
}

function resolveLifecycleRoots(input?: ArtifactLifecycleRootInput): ResolvedArtifactLifecycleRoots {
  if (typeof input === 'string') {
    const root = resolveProjectWorkspaceRoot(input)
    return { workflowRoot: root, workspaceRoot: root }
  }
  return {
    workflowRoot: input?.workflowRoot ?? dirname(taskSnapshotsDbFile()),
    workspaceRoot: resolveProjectWorkspaceRoot(input?.workspaceRoot)
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
