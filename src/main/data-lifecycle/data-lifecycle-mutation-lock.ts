import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { acquireFileLock, enqueueMutation, releaseFileLock } from '../digital-worker/persistence'

export const DATA_LIFECYCLE_MUTATION_LOCK_FILE = 'data-lifecycle-mutation.lock'

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()

/**
 * Serializes authority changes, destructive lifecycle work, and receipt compaction.
 * Nested journal writes reuse the caller's lock so one deletion can remain atomic.
 */
export async function withDataLifecycleMutation<T>(
  userDataRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = lifecycleLockPath(userDataRoot)
  if (heldLocks.getStore()?.has(lockPath)) return operation()
  return enqueueMutation(lockPath, async () => {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
    const descriptor = acquireFileLock(lockPath)
    const active = new Set(heldLocks.getStore() ?? [])
    active.add(lockPath)
    try {
      return await heldLocks.run(active, operation)
    } finally {
      releaseFileLock(lockPath, descriptor)
    }
  })
}

export function lifecycleLockPath(userDataRoot: string): string {
  return join(requiredRoot(userDataRoot), 'private', DATA_LIFECYCLE_MUTATION_LOCK_FILE)
}

function requiredRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('userDataRoot is required')
  }
  return resolve(value)
}
