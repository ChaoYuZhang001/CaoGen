import type { ProjectKnowledgePreview } from '../../shared/project-workspace-types'
import { connectorResourceAvailability } from './connector-resource'
import {
  buildProjectResourceContext,
  discoverProjectKnowledgeSources,
  projectResourcePolicyDigest
} from './resource-context'
import { openProjectWorkspaceStore } from './store'

export async function previewProjectKnowledge(
  rootDir: string,
  projectId: string
): Promise<ProjectKnowledgePreview> {
  const workspace = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(projectId)
  if (!workspace) throw new Error(`Project not found:${projectId}`)
  if (workspace.status !== 'active') throw new Error(`Project is not active:${projectId}`)
  const context = await buildProjectResourceContext({ workspaceId: workspace.id }, rootDir)
  const sources = discoverProjectKnowledgeSources(workspace)
  return {
    projectId: workspace.id,
    projectRevision: workspace.revision,
    policyDigest: context.projectPolicyDigest ?? projectResourcePolicyDigest(workspace),
    sources: sources.map(({ resourceId, resourceKind, path, digest, bytes, modifiedAt, truncated }) => ({
      resourceId, resourceKind, path, digest, bytes, modifiedAt, truncated
    })),
    connectors: workspace.resources
      .filter((resource) => resource.kind === 'connector')
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((resource) => {
        const contract = resource.connector
        const availability = connectorResourceAvailability(resource)
        return {
          resourceId: resource.id,
          label: resource.label?.trim() || resource.id,
          ...(contract?.connectorId === undefined ? {} : { connectorId: contract.connectorId }),
          available: availability.available,
          ...(availability.reason ? { reason: availability.reason } : {}),
          authorization: contract?.authorization.status ?? 'revoked',
          enabled: contract?.lifecycle?.enabled !== false,
          refresh: contract?.lifecycle?.refresh ?? { status: 'idle' as const },
          ...(contract?.lifecycle?.autoRefresh ? { autoRefresh: contract.lifecycle.autoRefresh } : {}),
          cache: contract?.lifecycle?.cache ?? { status: 'empty' as const },
          ...(contract?.lifecycle?.revocation ? { revocation: contract.lifecycle.revocation } : {})
        }
      })
  }
}
