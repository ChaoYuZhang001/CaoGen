import type {
  ProjectAggregateExportBundle,
  ProjectAggregateExportResult,
  ProjectAggregateObjectCounts
} from './project-aggregate-types'

export interface ProjectImportResult {
  operationId: string
  projectId: string
  phase: 'completed'
  sourcePath: string
  sourceDigest: string
  exportDigest: string
  sourceAggregateDigest: string
  importedAggregateDigest: string
  semanticDigest: string
  aggregateRevision: number
  sourceEquivalent: true
  objectCounts: ProjectAggregateObjectCounts
}

export interface ProjectDataLifecycleApi {
  /** Export the complete sanitized Project aggregate, not only Workspace metadata. */
  exportProjectWorkspaceData(projectId: string): Promise<ProjectAggregateExportResult>
  /** Import one verified export directly; no empty Project needs to be created first. */
  importProjectWorkspaceData(source: string | ProjectAggregateExportBundle): Promise<ProjectImportResult>
}
