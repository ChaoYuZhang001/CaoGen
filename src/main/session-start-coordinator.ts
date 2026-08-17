import type { SessionMeta } from '../shared/types'
import type { Engine } from './engine'

type SessionLookup = (sessionId: string) => Engine | undefined

/** Keeps restored idle sessions dormant until a user operation needs the runtime. */
export class SessionStartCoordinator {
  private readonly deferred = new Set<string>()
  private readonly starts = new Map<string, Promise<void>>()

  constructor(private readonly lookup: SessionLookup) {}

  restore(record: SessionMeta, engine: Engine): void | Promise<void> {
    if (record.status !== 'idle' && record.status !== 'error') return engine.start()
    engine.meta.status = record.status
    this.deferred.add(record.id)
  }

  ensure(id: string, session: Engine): Promise<void> {
    if (!this.deferred.has(id)) return Promise.resolve()
    const existing = this.starts.get(id)
    if (existing) return existing
    this.deferred.delete(id)
    const start = Promise.resolve()
      .then(() => {
        if (this.lookup(id) !== session) return
        return session.start()
      })
      .then(() => undefined)
      .catch((error) => {
        this.deferred.add(id)
        throw error
      })
      .finally(() => {
        if (this.starts.get(id) === start) this.starts.delete(id)
      })
    this.starts.set(id, start)
    return start
  }

  forget(id: string): void {
    this.deferred.delete(id)
    this.starts.delete(id)
  }

  clear(): void {
    this.deferred.clear()
    this.starts.clear()
  }
}
