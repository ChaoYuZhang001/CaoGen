import type { EffectRecord } from '../shared/types'
import { getPersistedArtifactLifecycle } from './task/artifact-lifecycle-api'
import type { ArtifactLifecycleRecord } from './task/artifact-lifecycle-types'
import { settleCanonicalSystemOperation } from './task/system-operation-context'
import type { ProjectPortableExportEffectTarget } from './project-export-effect-target'

type ConfirmedProjectPortableExportEffect = EffectRecord & {
  status: 'confirmed'
  target: ProjectPortableExportEffectTarget
}

export function isConfirmedProjectPortableExportEffect(
  effect: EffectRecord
): effect is ConfirmedProjectPortableExportEffect {
  return effect.status === 'confirmed' && effect.target.kind === 'project_portable_export'
}

export async function recoverConfirmedProjectPortableExportArtifact(
  effect: ConfirmedProjectPortableExportEffect,
  rootDir?: string
): Promise<ArtifactLifecycleRecord> {
  const lifecycle = await getPersistedArtifactLifecycle(effect.target.artifactId, rootDir)
  if (!lifecycle || lifecycle.projectId !== effect.target.projectId || lifecycle.goalId !== effect.target.goalId ||
      lifecycle.workItemId !== effect.target.workItemId || lifecycle.runId !== effect.target.runId) {
    throw new Error(`confirmed Project export Artifact is missing or crosses ownership:${effect.id}`)
  }
  await settleCanonicalSystemOperation({
    rootDir,
    goalId: effect.target.goalId,
    workItemId: effect.target.workItemId
  }, {
    status: 'passed',
    evidenceRefs: [effect.target.evidenceId],
    verifiedBy: 'project-portable-export'
  })
  return lifecycle
}
