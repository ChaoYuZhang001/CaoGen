import { decideTaskStrategyTool } from '../task/task-strategy'

export type ClaudePermissionPreflightSource = 'policy' | 'permission-mode' | 'task-strategy'

interface ClaudePermissionPreflightInput {
  strategy: unknown
  toolName: string
  toolInput: unknown
  policyKind: 'allow' | 'deny' | 'ask' | 'neutral'
  policyReason: string
  sandboxDisabled: boolean
  readOnlyTool: boolean
  localExecutionDisabledMessage: string
  guiKind: 'allow' | 'deny' | 'ask' | 'not-gui'
  guiReason?: string
}

export interface ClaudePermissionPreflightDenial {
  source: ClaudePermissionPreflightSource
  message: string
}

export function claudePermissionPreflightDenial(
  input: ClaudePermissionPreflightInput
): ClaudePermissionPreflightDenial | undefined {
  if (input.policyKind === 'deny') return { source: 'policy', message: input.policyReason }
  const strategy = decideTaskStrategyTool(input.strategy, input.toolName, input.toolInput)
  if (!strategy.allow) {
    return { source: 'task-strategy', message: strategy.message ?? '任务策略拒绝执行' }
  }
  if (input.sandboxDisabled && !input.readOnlyTool) {
    return { source: 'policy', message: input.localExecutionDisabledMessage }
  }
  if (input.guiKind === 'deny') return { source: 'policy', message: input.guiReason ?? 'GUI 操作已被策略拒绝' }
  return undefined
}
