import { createHash } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { openProjectWorkspaceStore } from './store'

export async function resolveWorkspaceSessionCwd(workspaceId: string, rootDir: string): Promise<string> {
  const id = requiredId(workspaceId)
  const workspace = await (await openProjectWorkspaceStore(rootDir)).getWorkspace(id)
  if (!workspace) throw new Error(`canonical Workspace does not exist:${id}`)
  if (workspace.status !== 'active') throw new Error(`canonical Workspace is not active:${id}:${workspace.status}`)

  for (const resource of workspace.resources) {
    if (resource.kind !== 'directory' && resource.kind !== 'repository') continue
    const path = resource.path?.trim()
    if (!path || !isAbsolute(path)) continue
    try {
      const candidate = resolve(path)
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // A stale optional resource must not block a directory-free Workspace.
    }
  }

  const digest = createHash('sha256').update(`caogen.workspace-cwd.v1\0${id}`).digest('hex').slice(0, 24)
  const fallback = join(rootDir, 'workspace-execution', digest)
  mkdirSync(fallback, { recursive: true, mode: 0o700 })
  return fallback
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error('workspaceId must be a non-empty string')
  }
  return value.trim()
}
