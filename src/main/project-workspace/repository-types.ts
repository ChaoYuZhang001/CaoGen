import type { MutationOptions } from '../../shared/project-workspace-types'

export interface ListOptions {
  includeArchived?: boolean
  includeDeleted?: boolean
  goalId?: string
}
export interface DeleteOptions extends MutationOptions {
  permanent?: boolean
}

export interface LeaseOptions extends MutationOptions {
  leaseId?: string
  ownerId?: string
  durationMs?: number
  fencingToken?: number
}
