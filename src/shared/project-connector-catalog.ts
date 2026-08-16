import type { ProjectConnectorCatalogEntry } from './project-workspace-types'

/**
 * The catalog describes stable Project Resource contracts. It does not imply
 * that a live remote adapter or OAuth flow is installed on this machine.
 */
export const PROJECT_CONNECTOR_CATALOG: readonly ProjectConnectorCatalogEntry[] = [
  {
    id: 'notion', label: 'Notion', defaultUri: 'notion://workspace',
    usage: ['knowledge_source'], capabilities: ['pages:read', 'databases:read'],
    dataDirection: 'read', scopes: ['pages:read', 'databases:read'], version: 'v1', reconciliation: 'manual_only'
  },
  {
    id: 'feishu', label: '飞书', defaultUri: 'feishu://tenant',
    usage: ['knowledge_source', 'resource'], capabilities: ['docs:read', 'wiki:read'],
    dataDirection: 'read', scopes: ['docs:read', 'wiki:read'], version: 'v1', reconciliation: 'manual_only'
  },
  {
    id: 'slack', label: 'Slack', defaultUri: 'slack://workspace',
    usage: ['knowledge_source'], capabilities: ['messages:read', 'files:read'],
    dataDirection: 'read', scopes: ['messages:read', 'files:read'], version: 'v1', reconciliation: 'manual_only'
  },
  {
    id: 'linear', label: 'Linear', defaultUri: 'linear://workspace',
    usage: ['resource', 'knowledge_source', 'tool'], capabilities: ['issues:read', 'issues:write'],
    dataDirection: 'bidirectional', scopes: ['issues:read', 'issues:write'], version: 'v1', reconciliation: 'queryable'
  },
  {
    id: 'jira', label: 'Jira', defaultUri: 'jira://site',
    usage: ['resource', 'knowledge_source', 'tool'], capabilities: ['issues:read', 'issues:write'],
    dataDirection: 'bidirectional', scopes: ['issues:read', 'issues:write'], version: 'v1', reconciliation: 'queryable'
  },
  {
    id: 'github', label: 'GitHub', defaultUri: 'github://repository',
    usage: ['resource', 'knowledge_source', 'tool'], capabilities: ['repo:read', 'issues:write'],
    dataDirection: 'bidirectional', scopes: ['repo:read', 'issues:write'], version: 'v1', reconciliation: 'queryable'
  },
  {
    id: 'figma', label: 'Figma', defaultUri: 'figma://file',
    usage: ['knowledge_source', 'resource'], capabilities: ['file:read', 'comments:read'],
    dataDirection: 'read', scopes: ['file:read', 'comments:read'], version: 'v1', reconciliation: 'manual_only'
  },
  {
    id: 'generic', label: '通用连接器', defaultUri: 'connector://resource',
    usage: ['resource'], capabilities: ['resource:read'],
    dataDirection: 'read', scopes: ['read'], version: 'v1', reconciliation: 'manual_only'
  }
] as const
