import { setTimeout as delay } from 'node:timers/promises'
import { powerSaveBlocker } from 'electron'
import { computeNextRun } from '../routineScheduler'
import { showDesktopNotification } from '../desktopNotify'
import { listRoutines, type Routine } from '../routineStore'
import { sessionManager } from '../sessionManager'
import { getSettings } from '../settings'
import {
  buildRoutineRunNotification,
  runWithPersonalOsPowerBlocker,
  type PowerSaveBlockerAdapter
} from './personal-os'
import { runRoutineWithHistory, type RoutineRunRecord } from './routine-runner'

export interface RoutineExecutionOptions {
  nextRunAt?: number | null
  sendDelayMs?: number
}

const routinePowerAdapter: PowerSaveBlockerAdapter = {
  start: (type) => powerSaveBlocker.start(type),
  stop: (id) => powerSaveBlocker.stop(id),
  isStarted: (id) => powerSaveBlocker.isStarted(id)
}

export async function executeRoutine(
  rootDir: string,
  routine: Routine,
  options: RoutineExecutionOptions = {}
): Promise<RoutineRunRecord> {
  return runWithPersonalOsPowerBlocker(
    {
      adapter: routinePowerAdapter,
      enabled: getSettings().preventDisplaySleep,
      reason: `routine:${routine.id}`,
      onError: (error) => console.error('[caogen] routine prevent-display-sleep failed:', error)
    },
    async () => {
      const nextRunAt = options.nextRunAt === undefined ? computeNextRun(routine.schedule, Date.now()) : options.nextRunAt
      const sendDelayMs = options.sendDelayMs ?? 1200

      const record = await runRoutineWithHistory(
        rootDir,
        routine,
        async (current) => {
          const meta = await sessionManager.createManaged({
            cwd: current.projectCwd,
            isolated: false,
            model: current.model || undefined,
            providerId: current.providerId || undefined,
            budgetUsd: current.budgetUsd,
            engine: current.engine,
            permissionMode: current.permissionMode,
            title: `Routine: ${current.name}`
          })
          // History is persisted before prompt delivery so UI events do not outrun run records.
          if (sendDelayMs > 0) await delay(sendDelayMs)
          const accepted = sessionManager.send(meta.id, current.prompt)
          if (!accepted) {
            await sessionManager.close(meta.id).catch((error) => {
              console.error('[caogen] routine rejected-session cleanup failed:', error)
            })
            throw new Error(`Routine prompt was rejected before execution started: ${meta.id}`)
          }
          return { sessionId: meta.id }
        },
        nextRunAt
      )

      notifyRoutineResult(routine, record)
      return record
    }
  )
}

export async function runRoutineNow(rootDir: string, routineId: string): Promise<RoutineRunRecord | null> {
  const routines = await listRoutines(rootDir)
  const routine = routines.find((item) => item.id === routineId)
  if (!routine) return null
  return executeRoutine(rootDir, routine)
}

function notifyRoutineResult(routine: Routine, record: RoutineRunRecord): void {
  const payload = buildRoutineRunNotification(routine, record, getSettings())
  if (!payload) return
  showDesktopNotification(payload)
}
