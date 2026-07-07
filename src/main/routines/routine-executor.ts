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

interface RoutinePromptTarget {
  sessionId: string
  prompt: string
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
          // History is persisted before prompt delivery so UI events do not outrun run records.
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
