import {
  selectTaskEvidence,
  selectTaskRunsForEvidence,
  verifyTaskEvidence
} from './task-evidence-store'
import type {
  TaskEvidenceRecord,
  TaskEvidenceScope,
  TaskEvidenceVerification
} from './task-evidence-store'
import {
  readTaskSnapshotDatabase
} from './task-snapshot'

export async function listPersistedTaskEvidence(
  scope: TaskEvidenceScope = {},
  rootDir?: string
): Promise<TaskEvidenceRecord[]> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    selectTaskRunsForEvidence(db)
    return selectTaskEvidence(db, scope)
  })
}

export async function verifyPersistedTaskEvidence(
  rootDir?: string
): Promise<TaskEvidenceVerification> {
  return readTaskSnapshotDatabase(rootDir, (db) => {
    selectTaskRunsForEvidence(db)
    return verifyTaskEvidence(db)
  })
}
