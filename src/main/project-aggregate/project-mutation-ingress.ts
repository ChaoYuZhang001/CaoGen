import type { ProjectAggregateSnapshot } from '../../shared/project-aggregate-types'
import { createProductionProjectAggregateService } from './project-aggregate-factory'
import { ProjectAggregateError, requiredProjectId } from './errors'

export interface ProjectMutationVerificationOptions {
  allowMissingProject?: boolean
}

/**
 * Production domain writers retain their own atomic transaction and reference
 * checks. This shared post-commit boundary rejects any successful write whose
 * combined Project-owned state can no longer form a valid aggregate.
 */
export async function verifyProductionProjectMutation(
  userDataRoot: string,
  projectId: string,
  options: ProjectMutationVerificationOptions = {}
): Promise<ProjectAggregateSnapshot | undefined> {
  try {
    return await createProductionProjectAggregateService(userDataRoot).verifyLiveProject(requiredProjectId(projectId))
  } catch (error) {
    if (options.allowMissingProject && isMissingProject(error)) return undefined
    throw error
  }
}

export function projectIdFromMutationResult(value: unknown): string | undefined {
  return projectIdsFromMutationResult(value)[0]
}

export function projectIdsFromMutationResult(value: unknown): string[] {
  const projectIds = new Set<string>()
  collectProjectIds(value, new Set(), projectIds)
  return [...projectIds].sort()
}

function collectProjectIds(value: unknown, active: Set<object>, projectIds: Set<string>): void {
  if (!value || typeof value !== 'object' || active.has(value)) return
  active.add(value)
  try {
    if (!Array.isArray(value)) {
      const record = value as Record<string, unknown>
      if (typeof record.projectId === 'string' && record.projectId.trim()) {
        projectIds.add(record.projectId.trim())
      }
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      collectProjectIds(child, active, projectIds)
    }
  } finally {
    active.delete(value)
  }
}

function isMissingProject(error: unknown): boolean {
  return error instanceof ProjectAggregateError && error.code === 'PROJECT_NOT_FOUND'
}
