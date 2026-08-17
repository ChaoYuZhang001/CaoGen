import type {
  CreateSessionOptions,
  SessionMeta,
  TaskDagDispatchInput,
  TaskDagTask
} from '../../shared/types'
import { requireDagPromptAccepted } from '../session-manager-support'
import {
  buildDagTaskPrompt,
  type DagTaskRunContext,
  type DagTaskRunResult
} from './dag-scheduler'

interface DagChildProvisioningDependencies {
  createManaged(
    options: CreateSessionOptions,
    lifecycle: { retainJournal: boolean }
  ): Promise<SessionMeta>
  send(sessionId: string, prompt: string): Promise<boolean>
}

export async function provisionDagChildSession(
  parent: SessionMeta,
  input: TaskDagDispatchInput,
  task: TaskDagTask,
  context: DagTaskRunContext,
  dependencies: DagChildProvisioningDependencies
): Promise<DagTaskRunResult> {
  const prompt = buildDagTaskPrompt(task, context)
  const meta = await dependencies.createManaged({
    cwd: input.cwd ?? parent.sourceCwd ?? parent.cwd,
    isolated: input.isolated ?? true,
    driveMode: input.driveMode ?? parent.driveMode,
    model: input.model ?? parent.model,
    providerId: input.providerId ?? parent.providerId,
    engine: input.engine ?? parent.engine,
    taskStrategy: parent.taskStrategy,
    title: `${task.title}${context.attempt > 1 ? ` · 重试 ${context.attempt - 1}` : ''}`,
    parentSessionId: parent.id,
    orchestrationId: input.dag.id,
    childTaskId: task.id,
    childRole: task.role,
    ...(task.workItemId ? { workItemId: task.workItemId } : {})
  }, { retainJournal: true })
  const dispatchItem = { taskId: task.id, prompt, meta }
  return {
    sessionId: meta.id,
    dispatchItem,
    start: async () => requireDagPromptAccepted(await dependencies.send(meta.id, prompt))
  }
}
