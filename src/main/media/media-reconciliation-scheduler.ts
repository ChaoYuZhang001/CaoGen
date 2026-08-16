import { resolve } from 'node:path'
import { getMediaRuntime } from './media-runtime'
import { getMediaStore } from './media-store'

const SWEEP_INTERVAL_MS = 15_000

interface SchedulerState {
  rootDir: string
  timer?: NodeJS.Timeout
  running?: Promise<void>
}

let scheduler: SchedulerState | undefined

export function startMediaReconciliationScheduler(rootDir: string): void {
  stopMediaReconciliationScheduler()
  scheduler = { rootDir: requiredRoot(rootDir) }
  schedule(scheduler, 5_000)
}

export function stopMediaReconciliationScheduler(): void {
  if (scheduler?.timer) clearTimeout(scheduler.timer)
  scheduler = undefined
}

function schedule(state: SchedulerState, delay: number): void {
  if (scheduler !== state) return
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    state.timer = undefined
    void sweep(state)
  }, delay)
  state.timer.unref?.()
}

async function sweep(state: SchedulerState): Promise<void> {
  if (scheduler !== state || state.running) return
  state.running = reconcileDueJobs(state.rootDir).finally(() => {
    state.running = undefined
  })
  await state.running
  if (scheduler === state) schedule(state, SWEEP_INTERVAL_MS)
}

async function reconcileDueJobs(rootDir: string): Promise<void> {
  const store = getMediaStore(rootDir)
  const runtime = getMediaRuntime(rootDir)
  const purgeTargets = await store.listMediaAssetPurgeTargets()
  for (const target of purgeTargets) {
    try {
      await runtime.purgeMediaAsset(target)
    } catch (error) {
      console.error('[caogen] Media retention purge deferred:', error)
    }
  }
  const downloadJobIds = await store.listRecoverableMediaDownloadJobIds()
  for (const jobId of downloadJobIds) {
    try {
      await runtime.advanceMediaJob(jobId)
    } catch (error) {
      console.error('[caogen] Media download resume failed:', error)
    }
  }
  const jobIds = await store.listDueMediaReconciliationJobIds()
  for (const jobId of jobIds) {
    try {
      await runtime.reconcileMediaJob(jobId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      try {
        await store.deferMediaJobReconciliation(jobId, reason)
      } catch (deferError) {
        console.error('[caogen] Media reconciliation deferral failed:', deferError)
      }
    }
  }
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error('Media reconciliation root is invalid')
  return resolve(value)
}
