import type { SessionMeta } from '../../shared/types'
import { writeAuditLog } from '../permission/audit-log'
import type { ToolPermissionDecision } from '../permission/tool-permission'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import {
  preflightDigitalWorkerAction,
  type DigitalWorkerActionPolicyDecision
} from './action-policy'

export function digitalWorkerToolPolicyError(
  meta: SessionMeta,
  toolName: string,
  toolInput: Record<string, unknown>,
  rootDir?: string
): string | null {
  const decision = digitalWorkerToolActionDecision(meta, toolName, toolInput, rootDir)
  if (!('message' in decision)) return null
  writeAuditLog(meta.cwd, {
    action: 'deny',
    source: 'policy',
    toolName,
    input: toolInput,
    message: decision.message
  })
  return decision.message
}

export function digitalWorkerToolPermissionDecision(
  meta: SessionMeta,
  toolName: string,
  toolInput: Record<string, unknown>,
  rootDir: string | undefined,
  fallback: () => ToolPermissionDecision
): ToolPermissionDecision {
  const decision = digitalWorkerToolActionDecision(meta, toolName, toolInput, rootDir)
  if (!('message' in decision)) return fallback()
  return {
    kind: 'deny',
    reason: decision.message,
    risk: { level: 'high', reasons: ['DigitalWorker action policy denied the tool'] },
    matchedRule: 'digital-worker-action-policy'
  }
}

function digitalWorkerToolActionDecision(
  meta: SessionMeta,
  toolName: string,
  toolInput: Record<string, unknown>,
  rootDir?: string
): DigitalWorkerActionPolicyDecision {
  const run = taskRuntimeRegistry.get(meta.id)
  return preflightDigitalWorkerAction({
    rootDir,
    meta,
    action: 'tool_call',
    toolName,
    toolInput,
    runId: run?.id,
    runStatus: run?.status,
    runBinding: run?.digitalWorkerBinding,
    failureCount: run?.status === 'failed' || run?.status === 'waiting_reconciliation'
      ? run.attempt
      : undefined
  })
}
