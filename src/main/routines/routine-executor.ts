import { setTimeout as delay } from 'node:timers/promises'
import { computeNextRun } from '../routineScheduler'
import { showDesktopNotification } from '../desktopNotify'
import { listRoutines, type Routine } from '../routineStore'
import { sessionManager } from '../sessionManager'
import { runRoutineWithHistory, type RoutineRunRecord } from './routine-runner'

export interface RoutineExecutionOptions {
  nextRunAt?: number | null
  sendDelayMs?: number
}

interface RoutinePromptTarget {
  sessionId: string
  prompt: string
}

export async function executeRoutine(
  rootDir: string,
  routine: Routine,
  options: RoutineExecutionOptions = {}
): Promise<RoutineRunRecord> {
  const nextRunAt = options.nextRunAt === undefined ? computeNextRun(routine.schedule, Date.now()) : options.nextRunAt
  const sendDelayMs = options.sendDelayMs ?? 1200
  const promptTargets: RoutinePromptTarget[] = []

  const record = await runRoutineWithHistory(
    rootDir,
    routine,
    async (current) => {
      const meta = sessionManager.create({
        cwd: current.projectCwd,
        model: current.model || undefined,
        providerId: current.providerId || undefined,
        budgetUsd: current.budgetUsd,
        engine: current.engine,
        permissionMode: current.permissionMode,
        title: `Routine: ${current.name}`
      })
      // 先返回 sessionId，让 run history 写入 succeeded 后再投递 prompt，避免 UI 事件早于历史落盘。
      promptTargets.push({ sessionId: meta.id, prompt: current.prompt })
      return { sessionId: meta.id }
    },
    nextRunAt
  )

  for (const target of promptTargets) {
    if (sendDelayMs > 0) await delay(sendDelayMs)
    sessionManager.send(target.sessionId, target.prompt)
  }

  notifyRoutineResult(routine, record)
  return record
}

export async function runRoutineNow(rootDir: string, routineId: string): Promise<RoutineRunRecord | null> {
  const routines = await listRoutines(rootDir)
  const routine = routines.find((item) => item.id === routineId)
  if (!routine) return null
  return executeRoutine(rootDir, routine)
}

function notifyRoutineResult(routine: Routine, record: RoutineRunRecord): void {
  const notification = routine.notification
  if (!notification?.enabled) return
  if (record.status === 'succeeded' && !notification.onSuccess) return
  if (record.status === 'failed' && !notification.onFailure) return

  showDesktopNotification({
    title: record.status === 'succeeded' ? `Routine 已完成: ${routine.name}` : `Routine 失败: ${routine.name}`,
    body: record.status === 'succeeded'
      ? `已创建会话${record.sessionId ? ` ${record.sessionId}` : ''}，并投递定时任务内容。`
      : (record.error ?? '执行失败'),
    sessionId: record.sessionId ?? routine.id
  })
}
