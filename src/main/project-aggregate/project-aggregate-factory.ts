import { app } from 'electron'
import { join, resolve } from 'node:path'
import type { ProjectAggregateRoots } from '../../shared/project-aggregate-types'
import { ProjectAggregateError } from './errors'
import { ProjectAggregateService } from './project-aggregate-service'

/** Production stores share Electron userData; Learning keeps its existing subdirectory. */
export function projectAggregateRootsForUserData(
  userDataRoot: string,
  legacyLearningRoots?: ProjectAggregateRoots['legacyLearningRoots']
): ProjectAggregateRoots {
  if (typeof userDataRoot !== 'string' || !userDataRoot.trim() || userDataRoot.includes('\0')) {
    throw new ProjectAggregateError('INVALID_INPUT', 'userDataRoot is required')
  }
  const root = resolve(userDataRoot.trim())
  return {
    workspaceRoot: root,
    workflowRoot: root,
    digitalWorkerRoot: root,
    learningRoot: join(root, 'learning'),
    aggregateRoot: root,
    legacyLearningRoots
  }
}

export function createProductionProjectAggregateService(
  userDataRoot = app.getPath('userData'),
  legacyLearningRoots?: ProjectAggregateRoots['legacyLearningRoots']
): ProjectAggregateService {
  return new ProjectAggregateService(projectAggregateRootsForUserData(userDataRoot, legacyLearningRoots))
}
