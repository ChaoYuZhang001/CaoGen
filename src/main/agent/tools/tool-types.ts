import type { SandboxMode } from '../../../shared/types'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolExecResult {
  ok: boolean
  output: string
  sandboxMode?: SandboxMode
  modeUsed?: SandboxMode
  sandboxed?: boolean
  fallbackReason?: string
}
