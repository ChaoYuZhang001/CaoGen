import type { McpProbeOperationResult } from '../shared/mcp-probe-types'
import type { McpProbeResult } from '../shared/types'
import type { McpProbeInput } from './mcpProbe'
import { probeMcpServers } from './mcpProbe'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'
import { stableValueDigest } from './task/tool-idempotency'

type OperationGateway = typeof executeInteractiveOperationEffect
type ProbeRunner = typeof probeMcpServers

export interface McpProbeEffectContext {
  sourceSessionId: string
  projectId?: string
  cwd: string
}

export async function executeMcpProbeEffect(
  context: McpProbeEffectContext,
  inputs: McpProbeInput[],
  runOperation: OperationGateway,
  runProbe: ProbeRunner = probeMcpServers
): Promise<McpProbeOperationResult> {
  if (inputs.length === 0) return { ok: true, results: [] }
  const outcome = await runOperation({
    kind: 'mcp_probe',
    title: '探测 MCP 运行态',
    sourceSessionId: context.sourceSessionId,
    projectId: context.projectId,
    cwd: context.cwd,
    toolName: 'mcp_runtime_probe',
    toolInput: { targets: inputs.map(safeProbeTarget) },
    execute: (effect) => {
      if (effect.target.kind !== 'unsupported' || effect.target.toolName !== 'mcp_runtime_probe') {
        throw new Error('MCP 探测必须保持 opaque 并与工具名绑定')
      }
      return runProbe(inputs)
    },
    isSuccess: () => true,
    resultSummary: summarizeProbeResults
  })
  return mcpProbeEffectOutcome(outcome)
}

function safeProbeTarget(input: McpProbeInput): Record<string, string> {
  return {
    idDigest: stableValueDigest(input.id),
    configDigest: stableValueDigest(input.config),
    transport: typeof input.config.url === 'string'
      ? 'http'
      : typeof input.config.command === 'string'
        ? 'stdio'
        : 'unknown'
  }
}

function mcpProbeEffectOutcome(
  outcome: InteractiveOperationEffectOutcome<McpProbeResult[]>
): McpProbeOperationResult {
  if (outcome.status === 'completed' && outcome.value) {
    return {
      ok: true,
      results: outcome.value,
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  if (outcome.status === 'completed') {
    return {
      ok: false,
      error: 'MCP 探测效果已确认，但执行结果缺失',
      effectStatus: outcome.effectStatus,
      operationId: outcome.operationId
    }
  }
  return {
    ok: false,
    error: outcome.error,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId,
    ...(outcome.status === 'waiting_reconciliation' ? { snapshotId: outcome.snapshotId } : {})
  }
}

function summarizeProbeResults(results: McpProbeResult[]): string {
  const transports = { stdio: 0, http: 0, unknown: 0 }
  for (const result of results) transports[result.transport] += 1
  return JSON.stringify({
    count: results.length,
    reachable: results.filter((result) => result.ok).length,
    transports
  })
}
