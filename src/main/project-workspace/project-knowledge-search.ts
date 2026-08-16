import { createHash } from 'node:crypto'
import type {
  ProjectKnowledgePreviewConnector,
  ProjectKnowledgeSearchConnectorError,
  ProjectKnowledgeSearchInput,
  ProjectKnowledgeSearchResult,
  ProjectKnowledgeSearchCitation,
  ProjectWorkspace
} from '../../shared/project-workspace-types'
import { connectorAuthorizationDigest, connectorResourceAvailability, connectorSupportsRead } from './connector-resource'
import {
  discoverProjectKnowledgeSources,
  projectResourceEgressPolicy,
  projectResourceIsEnabled
} from './resource-context'
import { openProjectWorkspaceStore } from './store'
import { createWorkflowEvidence } from '../task/workflow-ledger-api'
import { readProjectConnector } from './project-connector-read-adapter'
import {
  readProjectConnectorCache,
  writeProjectConnectorCache,
  type ProjectConnectorCachedRead
} from './project-connector-cache'
import { completeProjectConnectorRefresh } from './project-connector-lifecycle'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const MAX_QUERY_CHARS = 512
const MAX_SNIPPET_CHARS = 320

export interface ProjectKnowledgeSearchEvidenceScope {
  goalId?: string
  workItemId?: string
  runId?: string
}

/**
 * Search only the bounded local sources registered to a Project. The returned
 * matches are transient snippets; each source version is also recorded in the
 * canonical Evidence ledger so later Result/Acceptance views can cite it.
 */
export async function searchProjectKnowledge(
  rootDir: string,
  input: ProjectKnowledgeSearchInput,
  evidenceScope: ProjectKnowledgeSearchEvidenceScope = {}
): Promise<ProjectKnowledgeSearchResult> {
  const projectId = requiredText(input.projectId, 'projectId')
  const query = normalizeQuery(input.query)
  const store = await openProjectWorkspaceStore(rootDir)
  const workspace = await store.getWorkspace(projectId)
  if (!workspace) throw new Error(`Project not found:${projectId}`)
  if (workspace.status !== 'active') throw new Error(`Project is not active:${projectId}`)

  const queryDigest = digestText(query)
  const evidenceScopeDigest = digestText(
    `${evidenceScope.goalId ?? ''}\0${evidenceScope.workItemId ?? ''}\0${evidenceScope.runId ?? ''}`
  )
  const searchedAt = Date.now()
  const terms = searchTerms(query)
  const limit = normalizeLimit(input.limit)
  const sources = discoverProjectKnowledgeSources(workspace)
    .filter((source) => readableSource(workspace, source.resourceId))
    .map((source) => ({ source, score: scoreSource(source.path, source.content, terms) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.source.path.localeCompare(right.source.path))

  const localResults: ProjectKnowledgeSearchCitation[] = []
  for (const { source, score } of sources) {
    const evidenceId = `project-knowledge:${projectId}:${queryDigest.slice(7)}:${evidenceScopeDigest.slice(7)}:${source.resourceId}:${source.digest}`
    // Evidence intentionally stores only stable source identity and version,
    // never the matched text or a user-provided query.
    await createWorkflowEvidence({
      evidenceId,
      projectId,
      ...(evidenceScope.goalId ? { goalId: evidenceScope.goalId } : {}),
      ...(evidenceScope.workItemId ? { workItemId: evidenceScope.workItemId } : {}),
      ...(evidenceScope.runId ? { runId: evidenceScope.runId } : {}),
      kind: 'research_source',
      title: `Project knowledge source: ${source.resourceId}`,
      summary: 'A Project-owned local knowledge source matched a bounded query.',
      contentDigest: `sha256:${source.digest}`,
      mediaType: 'text/plain',
      metadata: {
        resourceId: source.resourceId,
        resourceKind: source.resourceKind,
        sourceVersion: `sha256:${source.digest}`,
        queryDigest
      }
    }, rootDir, {
      source: 'runtime',
      verifier: 'project-knowledge-search',
      observedAt: Math.max(0, Math.floor(source.modifiedAt))
    })
    localResults.push({
      resourceId: source.resourceId,
      resourceKind: source.resourceKind,
      path: source.path,
      source: source.path,
      version: `sha256:${source.digest}`,
      retrievedAt: searchedAt,
      contentDigest: `sha256:${source.digest}`,
      snippet: snippetFor(source.path, source.content, terms),
      score,
      evidenceId
    })
  }

  const connectorResults: ProjectKnowledgeSearchCitation[] = []
  const connectorErrors: ProjectKnowledgeSearchConnectorError[] = []
  let connectorWorkspace = workspace
  for (const connectorResourceId of workspace.resources
    .filter((candidate) => candidate.kind === 'connector' && candidate.connector?.usage.includes('knowledge_source'))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((resource) => resource.id)) {
    const resource = connectorWorkspace.resources.find((candidate) => candidate.id === connectorResourceId)
    if (!resource) continue
    if (!connectorSupportsRead(resource) || projectResourceEgressPolicy(resource) === 'deny') continue
    let liveCacheWritten = false
    try {
      let read = await validProjectConnectorCache(rootDir, connectorWorkspace, resource.id)
      if (!read) {
        const liveRead = await readProjectConnector(connectorWorkspace, resource.id, {
          operationId: `connector-search:${connectorWorkspace.id}:${resource.id}:${queryDigest}`
        })
        const current = await store.getWorkspace(connectorWorkspace.id)
        if (!current || current.revision !== connectorWorkspace.revision) {
          throw new Error('Project connector changed during read; result was discarded')
        }
        const currentResource = current.resources.find((candidate) => candidate.id === resource.id)
        if (!currentResource) throw new Error('Project connector was removed during read; result was discarded')
        const cached = await writeProjectConnectorCache(rootDir, current.id, resource.id, liveRead, {
          authorizationDigest: connectorAuthorizationDigest(currentResource)
        })
        liveCacheWritten = true
        if (!cached.citation.contentDigest) throw new Error('Connector cache citation is missing its content digest')
        connectorWorkspace = await completeProjectConnectorRefresh(rootDir, current.id, resource.id, {
          status: 'succeeded',
          citation: cached.citation,
          cache: {
            authorizationDigest: cached.authorizationDigest,
            contentDigest: cached.citation.contentDigest,
            bytes: cached.bytes,
            cachedAt: cached.cachedAt
          }
        }, { expectedRevision: current.revision })
        read = cached
        liveCacheWritten = false
      }
      const current = await store.getWorkspace(connectorWorkspace.id)
      if (!current) {
        throw new Error('Project connector changed during read; result was discarded')
      }
      const currentResource = current.resources.find((candidate) => candidate.id === resource.id)
      if (!currentResource || !connectorSupportsRead(currentResource) || projectResourceEgressPolicy(currentResource) === 'deny') {
        throw new Error('Project connector authorization changed during read; result was discarded')
      }
      const currentDigest = currentResource.connector?.lifecycle?.cache?.contentDigest
      if (currentDigest !== read.citation.contentDigest) {
        throw new Error('Project connector cache changed during read; result was discarded')
      }
      connectorWorkspace = current
      const score = scoreSource(read.citation.source, read.data, terms)
      if (score <= 0 || !read.citation.contentDigest) continue
      const evidenceId = `connector-search:${workspace.id}:${resource.id}:${queryDigest.slice(7)}:${evidenceScopeDigest.slice(7)}:${read.citation.contentDigest.slice(7)}:${read.citation.retrievedAt}`
      await createWorkflowEvidence({
        evidenceId,
        projectId: workspace.id,
        ...(evidenceScope.goalId ? { goalId: evidenceScope.goalId } : {}),
        ...(evidenceScope.workItemId ? { workItemId: evidenceScope.workItemId } : {}),
        ...(evidenceScope.runId ? { runId: evidenceScope.runId } : {}),
        kind: 'research_source',
        title: 'Project connector search source',
        summary: 'An authorized Project connector source matched a bounded query.',
        contentDigest: read.citation.contentDigest,
        mediaType: 'text/plain',
        metadata: {
          resourceId: resource.id,
          connectorId: resource.connector?.connectorId ?? 'generic',
          sourceVersion: read.citation.version,
          queryDigest
        }
      }, rootDir, {
        source: 'runtime',
        verifier: 'project-knowledge-search',
        observedAt: read.citation.retrievedAt
      })
      connectorResults.push({
        resourceId: resource.id,
        resourceKind: 'connector',
        path: read.citation.source,
        source: read.citation.source,
        version: read.citation.version,
        retrievedAt: read.citation.retrievedAt,
        contentDigest: read.citation.contentDigest,
        snippet: snippetFor(read.citation.source, read.data, terms),
        score,
        evidenceId
      })
    } catch (error) {
      if (liveCacheWritten) {
        await import('./project-connector-cache.js').then(({ purgeProjectConnectorCache }) =>
          purgeProjectConnectorCache(rootDir, connectorWorkspace.id, resource.id)
        ).catch(() => undefined)
      }
      connectorErrors.push({
        resourceId: resource.id,
        reason: connectorErrorReason(error)
      })
    }
  }

  return {
    projectId: workspace.id,
    projectRevision: connectorWorkspace.revision,
    query,
    queryDigest,
    searchedAt,
    results: [...localResults, ...connectorResults]
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit),
    connectors: connectorViews(connectorWorkspace),
    connectorErrors
  }
}

function readableSource(workspace: ProjectWorkspace, resourceId: string): boolean {
  const resource = workspace.resources.find((candidate) => candidate.id === resourceId)
  return Boolean(resource && projectResourceIsEnabled(resource) && projectResourceEgressPolicy(resource) !== 'deny')
}

function connectorViews(workspace: ProjectWorkspace): ProjectKnowledgePreviewConnector[] {
  return workspace.resources
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

async function validProjectConnectorCache(
  rootDir: string,
  workspace: ProjectWorkspace,
  resourceId: string
): Promise<ProjectConnectorCachedRead | undefined> {
  const resource = workspace.resources.find((candidate) => candidate.id === resourceId)
  const lifecycle = resource?.connector?.lifecycle
  if (!resource || !connectorSupportsRead(resource) || lifecycle?.cache?.status !== 'ready') return undefined
  const cached = await readProjectConnectorCache(rootDir, workspace.id, resourceId)
  if (!cached || !cachedReadMatchesLifecycle(cached, lifecycle, resource)) {
    throw new Error('Project connector cache metadata does not match its lifecycle state')
  }
  return cached
}

function cachedReadMatchesLifecycle(
  cached: ProjectConnectorCachedRead,
  lifecycle: NonNullable<ProjectWorkspace['resources'][number]['connector']>['lifecycle'],
  resource: ProjectWorkspace['resources'][number]
): boolean {
  const citation = lifecycle?.refresh.latestCitation
  const cache = lifecycle?.cache
  return Boolean(
    citation && cache?.status === 'ready' &&
    cache.authorizationDigest === connectorAuthorizationDigest(resource) &&
    cached.authorizationDigest === cache.authorizationDigest &&
    cached.citation.contentDigest === cache.contentDigest &&
    cached.bytes === cache.bytes && cached.cachedAt === cache.cachedAt &&
    cached.citation.source === citation.source &&
    cached.citation.version === citation.version &&
    cached.citation.retrievedAt === citation.retrievedAt &&
    cached.citation.contentDigest === citation.contentDigest
  )
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('knowledge query is required')
  const query = value.trim().replace(/\s+/g, ' ')
  if (!query) throw new Error('knowledge query is required')
  if (query.length > MAX_QUERY_CHARS) throw new Error(`knowledge query exceeds ${MAX_QUERY_CHARS} characters`)
  return query
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('knowledge search limit must be a positive integer')
  }
  return Math.min(MAX_LIMIT, value)
}

function searchTerms(query: string): string[] {
  return [...new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter((term) => term.length > 1 || /\p{Script=Han}/u.test(term)))]
}

function scoreSource(path: string, content: string, terms: readonly string[]): number {
  const haystack = `${path}\n${content}`.toLocaleLowerCase()
  return terms.reduce((score, term) => {
    const occurrences = countOccurrences(haystack, term)
    const pathBonus = path.toLocaleLowerCase().includes(term) ? 4 : 0
    return score + Math.min(occurrences, 8) + pathBonus
  }, 0)
}

function snippetFor(path: string, content: string, terms: readonly string[]): string {
  const lower = content.toLocaleLowerCase()
  const firstIndex = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0
  const start = Math.max(0, firstIndex - 96)
  const end = Math.min(content.length, start + MAX_SNIPPET_CHARS)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < content.length ? '...' : ''
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}` || path
}

function countOccurrences(value: string, term: string): number {
  let count = 0
  let offset = 0
  while (offset < value.length) {
    const index = value.indexOf(term, offset)
    if (index < 0) break
    count += 1
    offset = index + term.length
  }
  return count
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function connectorErrorReason(error: unknown): string {
  if (!(error instanceof Error)) return 'Connector read failed'
  const message = error.message.trim()
  return message && message.length <= 160 ? message : 'Connector read failed'
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}
