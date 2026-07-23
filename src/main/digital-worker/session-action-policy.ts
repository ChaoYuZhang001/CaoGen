import type { SessionMeta, TaskRunRecord } from '../../shared/types'
import { taskRuntimeRegistry } from '../task/task-runtime-registry'
import { preflightDigitalWorkerAction } from './action-policy'

interface SessionActionPolicyInput {
  rootDir: string
  meta: SessionMeta
  run?: TaskRunRecord
  activeSessions: readonly SessionMeta[]
}

export class DigitalWorkerProviderDispatchDeniedError extends Error {
  readonly name = 'DigitalWorkerProviderDispatchDeniedError'
}

/** Recheck the frozen worker/Assignment immediately before every Provider attempt. */
export function assertDigitalWorkerProviderDispatchAllowed(
  meta: SessionMeta,
  rootDir?: string
): void {
  const run = taskRuntimeRegistry.get(meta.id)
  if (!run) {
    throw new DigitalWorkerProviderDispatchDeniedError(
      'Provider dispatch 缺少 canonical TaskRun，已阻止请求'
    )
  }
  const decision = preflightDigitalWorkerAction({
    rootDir,
    meta,
    action: 'provider_send',
    runId: run.id,
    runStatus: run.status,
    runBinding: run.digitalWorkerBinding,
    failureCount: failedRunCount(run)
  })
  if ('message' in decision) {
    throw new DigitalWorkerProviderDispatchDeniedError(decision.message)
  }
}

export function isDigitalWorkerProviderDispatchDeniedError(
  error: unknown
): error is DigitalWorkerProviderDispatchDeniedError {
  return error instanceof DigitalWorkerProviderDispatchDeniedError
}

export function digitalWorkerSendPolicyError(
  input: SessionActionPolicyInput & { supervisorControlReplay?: boolean }
): string | null {
  const decision = preflightDigitalWorkerAction({
    rootDir: input.rootDir,
    meta: input.meta,
    action: input.supervisorControlReplay ? 'supervisor_resume' : 'provider_send',
    runId: input.run?.id,
    runStatus: input.run?.status,
    runBinding: input.run?.digitalWorkerBinding,
    failureCount: failedRunCount(input.run),
    escalationApproved: input.supervisorControlReplay === true,
    activeSessions: input.activeSessions
  })
  return 'message' in decision ? decision.message : null
}

export function digitalWorkerSupervisorPolicyError(
  input: SessionActionPolicyInput & { action: 'retry' | 'resume' }
): string | null {
  const decision = preflightDigitalWorkerAction({
    rootDir: input.rootDir,
    meta: input.meta,
    action: input.action === 'retry' ? 'supervisor_retry' : 'supervisor_resume',
    runId: input.run?.id,
    runStatus: input.run?.status,
    runBinding: input.run?.digitalWorkerBinding,
    failureCount: failedRunCount(input.run),
    escalationApproved: true,
    activeSessions: input.activeSessions
  })
  return 'message' in decision ? decision.message : null
}

function failedRunCount(run: TaskRunRecord | undefined): number | undefined {
  return run?.status === 'failed' || run?.status === 'waiting_reconciliation' ? run.attempt : undefined
}
