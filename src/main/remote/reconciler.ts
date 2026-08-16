import { executePendingRemoteCommands, reconcileRemoteExecutions } from './executor'

let timer: ReturnType<typeof setInterval> | undefined

export function startRemoteContinuationReconciler(rootDir: string, intervalMs = 15_000): void {
  stopRemoteContinuationReconciler()
  const tick = () => {
    void reconcileRemoteExecutions(rootDir)
      .then(() => executePendingRemoteCommands(rootDir))
      .catch((error) => console.error('[caogen] remote continuation background reconciliation failed:', error))
  }
  timer = setInterval(tick, Math.max(1_000, intervalMs))
  if (typeof timer.unref === 'function') timer.unref()
  tick()
}

export function stopRemoteContinuationReconciler(): void {
  if (!timer) return
  clearInterval(timer)
  timer = undefined
}
