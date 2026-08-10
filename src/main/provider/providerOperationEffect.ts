import { app } from 'electron'
import { executeInteractiveOperationEffect } from '../task/operation-effect-gateway'
import { stableValueDigest } from '../task/tool-idempotency'

export async function executeProviderOperationEffect<T>(
  toolName: string,
  title: string,
  selectors: Record<string, unknown>,
  execute: () => T | Promise<T>
): Promise<T> {
  let executionError: unknown
  const outcome = await executeInteractiveOperationEffect({
    kind: 'provider_operation',
    title,
    sourceSessionId: 'provider-management:settings',
    cwd: app.getPath('userData'),
    toolName,
    toolInput: providerOperationEffectInput(selectors),
    execute: async () => {
      try {
        return { ok: true as const, value: await execute() }
      } catch (error) {
        executionError = error
        return { ok: false as const }
      }
    },
    isSuccess: (result) => result.ok,
    resultSummary: (result) => result.ok ? 'provider_operation_completed' : 'provider_operation_failed'
  })
  if (outcome.status === 'completed' && outcome.value?.ok) return outcome.value.value
  if (executionError instanceof Error) throw executionError
  throw new Error('Provider 操作结果无法确认，已停止自动重试并等待人工对账')
}

function providerOperationEffectInput(selectors: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(selectors).map(([key, value]) => {
    if (key === 'service') return [key, value]
    return [`${key}Digest`, stableValueDigest(value)]
  }))
}
