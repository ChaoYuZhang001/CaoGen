import { ensureManagedPersonalWorkspace } from '../project-workspace/managed-personal-workspace'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import type { P2ToolExecutionContext, P2ToolResult } from '../agent/tools/p2-tools'
import { SearchBroker, type SearchBrokerEvidenceRecord, type SearchBrokerMode, type SearchBrokerResult } from './search-broker'
import { configuredSearchAdapter } from './search-adapter'
import { createDurableSearchStore } from './search-broker-store'
import {
  persistSearchArtifact,
  preparePersonalSearchArtifact,
  prepareSearchArtifact,
  searchEvidenceRecordsFromResult,
  type SearchArtifactContext
} from './search-artifact-binding'

export async function executeWebSearch(
  args: Record<string, unknown>,
  context: P2ToolExecutionContext,
  requiredString: (value: unknown, label: string) => string,
  optionalString: (value: unknown) => string | undefined,
  optionalNumber: (value: unknown) => number | undefined
): Promise<P2ToolResult> {
  const resolved = await resolveSearchExecution(args, context, requiredString, optionalString)
  if (typeof resolved === 'string') return { ok: false, output: resolved }
  const pendingEvidence: SearchBrokerEvidenceRecord[] = []
  const broker = context.searchBroker ?? createSearchBroker(resolved.root, resolved.projectId, pendingEvidence)
  const result = await broker.search(buildSearchRequest(args, resolved, optionalNumber))
  const automaticArtifact = await resolveAutomaticArtifact(result, resolved)
  await persistSearchOutcome(result, pendingEvidence, automaticArtifact, searchEvidenceBinding(resolved), resolved.root)
  const output = publicSearchResult(result, automaticArtifact, resolved)
  return { ok: result.ok, output: JSON.stringify(output, null, 2) }
}

interface SearchExecution {
  root: string
  meta: NonNullable<P2ToolExecutionContext['sessionMeta']>
  projectId: string
  workflowRunId?: string
  operationId: string
  requestedArtifactId?: string
  query: string
  mode: SearchBrokerMode
}

async function resolveSearchExecution(
  args: Record<string, unknown>,
  context: P2ToolExecutionContext,
  requiredString: (value: unknown, label: string) => string,
  optionalString: (value: unknown) => string | undefined
): Promise<SearchExecution | string> {
  const root = context.userDataRoot
  const meta = context.sessionMeta
  if (!root || !meta || !context.toolUseId) return 'web_search 缺少稳定 Session、用户数据目录或工具调用身份'
  const mode = searchMode(args.mode)
  if (!mode) return 'web_search mode 必须是 model_native 或 byok_search_adapter'
  const projectId = await resolveSearchProject(root, meta)
  const sessionRunId = context.runId ?? taskRuntimeRegistry.get(meta.id)?.id
  return {
    root,
    meta,
    projectId,
    // Assistant conversations live in a private durability partition, not a user-visible Project Run.
    ...(meta.unassigned === true || !meta.workspaceId ? {} : { workflowRunId: sessionRunId }),
    operationId: optionalString(args.operationId) ?? `search:${meta.id}:${context.toolUseId}`,
    ...(optionalString(args.artifactId) ? { requestedArtifactId: optionalString(args.artifactId) } : {}),
    query: requiredString(args.query, 'query'),
    mode
  }
}

function searchMode(value: unknown): SearchBrokerMode | undefined {
  return value === undefined || value === 'model_native' ? 'model_native' : value === 'byok_search_adapter' ? 'byok_search_adapter' : undefined
}

async function resolveSearchProject(root: string, meta: NonNullable<P2ToolExecutionContext['sessionMeta']>): Promise<string> {
  return meta.workspaceId ?? meta.personalWorkspaceId ?? (await ensureManagedPersonalWorkspace(root)).workspace.id
}

function createSearchBroker(root: string, projectId: string, evidence: SearchBrokerEvidenceRecord[]): SearchBroker {
  return new SearchBroker({
    modelNative: configuredSearchAdapter('CAOGEN_SEARCH_MODEL_NATIVE_URL', 'CAOGEN_SEARCH_MODEL_NATIVE_API_KEY'),
    byokSearchAdapter: configuredSearchAdapter('CAOGEN_SEARCH_BYOK_URL', 'CAOGEN_SEARCH_BYOK_API_KEY'),
    idempotencyStore: createDurableSearchStore(root, projectId),
    evidenceWriter: async (records) => { evidence.push(...records) }
  })
}

function buildSearchRequest(
  args: Record<string, unknown>,
  execution: SearchExecution,
  optionalNumber: (value: unknown) => number | undefined
) {
  const { meta } = execution
  return {
    query: execution.query,
    mode: execution.mode,
    operationId: execution.operationId,
    projectId: meta.unassigned === true ? undefined : execution.projectId,
    ...(meta.goalId ? { goalId: meta.goalId } : {}), ...(meta.workItemId ? { workItemId: meta.workItemId } : {}),
    ...(execution.workflowRunId ? { runId: execution.workflowRunId } : {}),
    ...(execution.requestedArtifactId ? { artifactId: execution.requestedArtifactId } : {}),
    limit: optionalNumber(args.limit)
  }
}

async function resolveAutomaticArtifact(
  result: SearchBrokerResult,
  execution: SearchExecution
): Promise<SearchArtifactContext | undefined> {
  if (!result.ok || execution.requestedArtifactId) return undefined
  if (execution.meta.unassigned === true) {
    return preparePersonalSearchArtifact(
      execution.root,
      execution.meta,
      execution.operationId,
      execution.query
    )
  }
  return prepareSearchArtifact(
    execution.root,
    execution.meta,
    execution.projectId,
    execution.workflowRunId,
    execution.operationId
  )
}

function searchEvidenceBinding(execution: SearchExecution): {
  projectId: string
  goalId?: string
  workItemId?: string
  runId?: string
  artifactId?: string
} {
  return {
    projectId: execution.projectId,
    ...(execution.meta.goalId ? { goalId: execution.meta.goalId } : {}),
    ...(execution.meta.workItemId ? { workItemId: execution.meta.workItemId } : {}),
    ...(execution.workflowRunId ? { runId: execution.workflowRunId } : {}),
    ...(execution.requestedArtifactId ? { artifactId: execution.requestedArtifactId } : {})
  }
}

function publicSearchResult(
  result: SearchBrokerResult,
  automaticArtifact: SearchArtifactContext | undefined,
  execution: SearchExecution
): SearchBrokerResult & Record<string, unknown> {
  const bound = result.ok && automaticArtifact
    ? { ...result, artifactId: automaticArtifact.artifactId }
    : result
  if (execution.meta.unassigned !== true) return bound
  return {
    ...bound,
    personalWorkspaceId: execution.projectId,
    ...(automaticArtifact ? {
      canonicalRunId: automaticArtifact.runId,
      acceptanceId: automaticArtifact.acceptanceId,
      goalId: null,
      workItemId: null,
      runId: null
    } : {})
  }
}

async function persistSearchOutcome(result: SearchBrokerResult, pending: SearchBrokerEvidenceRecord[], automaticArtifact: SearchArtifactContext | undefined, binding: { projectId: string; goalId?: string; workItemId?: string; runId?: string; artifactId?: string }, root: string): Promise<void> {
  if (!result.ok) return
  if (automaticArtifact) {
    const evidence = pending.length > 0 ? pending : searchEvidenceRecordsFromResult(result)
    return persistSearchArtifact(automaticArtifact, result, evidence, root)
  }
  if (pending.length > 0) for (const record of pending) await recordSearchEvidence(record, root, binding)
}

async function recordSearchEvidence(record: SearchBrokerEvidenceRecord, rootDir: string, binding: { projectId: string; goalId?: string; workItemId?: string; runId?: string; artifactId?: string }): Promise<void> {
  const { createWorkflowEvidence } = await import('../task/workflow-ledger-api.js')
  await createWorkflowEvidence({ evidenceId: record.evidenceId, projectId: binding.projectId, ...(binding.goalId ? { goalId: binding.goalId } : {}), ...(binding.workItemId ? { workItemId: binding.workItemId } : {}), ...(binding.runId ? { runId: binding.runId } : {}), ...(binding.artifactId ? { artifactId: binding.artifactId } : {}), kind: record.kind, title: record.title, summary: record.summary, uri: record.uri, mediaType: record.mediaType, contentDigest: record.contentDigest, metadata: record.metadata }, rootDir, { source: 'runtime', verifier: record.verifier, observedAt: record.observedAt })
}
