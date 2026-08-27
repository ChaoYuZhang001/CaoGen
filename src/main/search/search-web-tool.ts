import { ensureManagedPersonalWorkspace } from '../project-workspace/managed-personal-workspace'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import type { P2ToolExecutionContext, P2ToolResult } from '../agent/tools/p2-tools'
import { SearchBroker, type SearchBrokerEvidenceRecord, type SearchBrokerMode, type SearchBrokerResult } from './search-broker'
import { configuredSearchAdapter } from './search-adapter'
import { createDurableSearchStore } from './search-broker-store'
import { assertSearchArtifactReplay, persistSearchArtifact, prepareSearchArtifact } from './search-artifact-binding'

export async function executeWebSearch(
  args: Record<string, unknown>,
  context: P2ToolExecutionContext,
  requiredString: (value: unknown, label: string) => string,
  optionalString: (value: unknown) => string | undefined,
  optionalNumber: (value: unknown) => number | undefined
): Promise<P2ToolResult> {
  const root = context.userDataRoot
  const meta = context.sessionMeta
  if (!root || !meta || !context.toolUseId) return { ok: false, output: 'web_search 缺少稳定 Session、用户数据目录或工具调用身份' }
  const mode = searchMode(args.mode)
  if (!mode) return { ok: false, output: 'web_search mode 必须是 model_native 或 byok_search_adapter' }
  const projectId = await resolveSearchProject(root, meta)
  const runId = context.runId ?? taskRuntimeRegistry.get(meta.id)?.id
  // Assistant conversations live in the managed personal Workspace, not a Project Run.
  // Keep their Evidence durable, but do not attach a TaskRun whose project ownership is absent.
  const workflowRunId = meta.unassigned === true || !meta.workspaceId ? undefined : runId
  const operationId = optionalString(args.operationId) ?? `search:${meta.id}:${context.toolUseId}`
  const requestedArtifactId = optionalString(args.artifactId)
  const automaticArtifact = requestedArtifactId ? undefined : await prepareSearchArtifact(root, meta, projectId, workflowRunId, operationId)
  const pendingEvidence: SearchBrokerEvidenceRecord[] = []
  const broker = context.searchBroker ?? createSearchBroker(root, projectId, pendingEvidence)
  // The personal Workspace is an internal durability partition, not a user-visible Project.
  const brokerProjectId = meta.unassigned === true ? undefined : projectId
  const result = await broker.search(buildSearchRequest(args, meta, brokerProjectId, workflowRunId, operationId, automaticArtifact, requestedArtifactId, mode, requiredString, optionalNumber))
  await persistSearchOutcome(result, pendingEvidence, automaticArtifact, { projectId, goalId: meta.goalId, workItemId: meta.workItemId, runId: workflowRunId, artifactId: requestedArtifactId }, root)
  // Keep the public Assistant result unassigned (`projectId: null`) while
  // exposing the app-owned durability partition used for replay and Evidence.
  const output = meta.unassigned === true
    ? { ...result, personalWorkspaceId: projectId }
    : result
  return { ok: result.ok, output: JSON.stringify(output, null, 2) }
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

function buildSearchRequest(args: Record<string, unknown>, meta: NonNullable<P2ToolExecutionContext['sessionMeta']>, projectId: string | undefined, runId: string | undefined, operationId: string, automaticArtifact: { artifactId: string } | undefined, requestedArtifactId: string | undefined, mode: SearchBrokerMode, requiredString: (value: unknown, label: string) => string, optionalNumber: (value: unknown) => number | undefined) {
  return {
    query: requiredString(args.query, 'query'), mode, operationId, projectId,
    ...(meta.goalId ? { goalId: meta.goalId } : {}), ...(meta.workItemId ? { workItemId: meta.workItemId } : {}),
    ...(runId ? { runId } : {}), ...((requestedArtifactId ?? automaticArtifact?.artifactId) ? { artifactId: requestedArtifactId ?? automaticArtifact?.artifactId } : {}),
    limit: optionalNumber(args.limit)
  }
}

async function persistSearchOutcome(result: SearchBrokerResult, pending: SearchBrokerEvidenceRecord[], automaticArtifact: { artifactId: string; } | undefined, binding: { projectId: string; goalId?: string; workItemId?: string; runId?: string; artifactId?: string }, root: string): Promise<void> {
  if (!result.ok) return
  if (pending.length > 0 && automaticArtifact) return persistSearchArtifact(automaticArtifact as Parameters<typeof persistSearchArtifact>[0], result, pending, root)
  if (pending.length > 0) for (const record of pending) await recordSearchEvidence(record, root, binding)
  if (pending.length === 0 && automaticArtifact) await assertSearchArtifactReplay(automaticArtifact as Parameters<typeof assertSearchArtifactReplay>[0], root)
}

async function recordSearchEvidence(record: SearchBrokerEvidenceRecord, rootDir: string, binding: { projectId: string; goalId?: string; workItemId?: string; runId?: string; artifactId?: string }): Promise<void> {
  const { createWorkflowEvidence } = await import('../task/workflow-ledger-api.js')
  await createWorkflowEvidence({ evidenceId: record.evidenceId, projectId: binding.projectId, ...(binding.goalId ? { goalId: binding.goalId } : {}), ...(binding.workItemId ? { workItemId: binding.workItemId } : {}), ...(binding.runId ? { runId: binding.runId } : {}), ...(binding.artifactId ? { artifactId: binding.artifactId } : {}), kind: record.kind, title: record.title, summary: record.summary, uri: record.uri, mediaType: record.mediaType, contentDigest: record.contentDigest, metadata: record.metadata }, rootDir, { source: 'runtime', verifier: record.verifier, observedAt: record.observedAt })
}
