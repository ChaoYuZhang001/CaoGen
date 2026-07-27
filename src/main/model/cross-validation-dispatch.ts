import type { AgentEvent, SessionMeta } from '../../shared/types'

export type CrossValidationDispatchStage = 'review' | 'arbitration'

interface CrossValidationDispatchDependencies {
  send(sessionId: string, prompt: string): boolean
  getMeta(sessionId: string): SessionMeta | undefined
  dispatch(sessionId: string, event: AgentEvent): void
}

interface CrossValidationDispatchInput {
  parentSessionId: string
  childSessionId: string
  prompt: string
  stage: CrossValidationDispatchStage
}

/** Converts a rejected validation prompt into an observable parent event. */
export function dispatchCrossValidationPrompt(
  dependencies: CrossValidationDispatchDependencies,
  input: CrossValidationDispatchInput
): boolean {
  let accepted = false
  let thrown: unknown
  try {
    accepted = dependencies.send(input.childSessionId, input.prompt)
  } catch (error) {
    thrown = error
  }
  if (accepted) return true

  const reason = thrown
    ? errorText(thrown)
    : dependencies.getMeta(input.childSessionId)?.lastError ?? 'SessionManager rejected the validation prompt'
  const arbitration = input.stage === 'arbitration'
  dependencies.dispatch(input.parentSessionId, {
    kind: 'hook-event',
    event: arbitration
      ? 'model-cross-validation-arbitration-rejected'
      : 'model-cross-validation-review-rejected',
    detail: `${arbitration ? '模型仲裁' : '第二模型复核'}指令未被接受,本轮自动${arbitration ? '仲裁' : '复核'}已停止。原因:${cleanOneLine(reason)}`
  })
  return false
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cleanOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}
