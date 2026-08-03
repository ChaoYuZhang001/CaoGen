import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CreateSessionOptions } from '../../shared/types'
import { sessionManager } from '../sessionManager'

export function createUnassignedSession(options: CreateSessionOptions): ReturnType<typeof sessionManager.createManaged> {
  // Projectless sessions receive an app-owned root instead of broad access to the user's home directory.
  const cwd = join(app.getPath('userData'), 'personal-workspace')
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  return sessionManager.createManaged({ ...options, cwd, isolated: false, unassigned: true })
}
