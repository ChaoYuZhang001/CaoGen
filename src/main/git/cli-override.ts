import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export interface GitCliOverride {
  executable: string
  argsPrefix: string[]
}

export function gitCliOverride(command: 'gh' | 'glab'): GitCliOverride | undefined {
  const envName = command === 'gh' ? 'CAOGEN_GH_EXECUTABLE' : 'CAOGEN_GLAB_EXECUTABLE'
  const executable = process.env[envName]?.trim()
  if (!executable) return undefined
  const scriptEnv = command === 'gh' ? 'CAOGEN_GH_SCRIPT' : 'CAOGEN_GLAB_SCRIPT'
  const script = process.env[scriptEnv]?.trim()
  return { executable, argsPrefix: script ? [script] : [] }
}

export function gitCliOverrideExists(command: 'gh' | 'glab'): boolean {
  const override = gitCliOverride(command)
  return Boolean(override && existsSync(override.executable))
}

export function gitCliAvailable(command: 'gh' | 'glab', timeoutMs: number): boolean {
  if (gitCliOverrideExists(command)) return true
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(probe, [command], { stdio: 'ignore', timeout: timeoutMs }).status === 0
}

export function gitCliForProvider(provider: 'github' | 'gitlab'): 'gh' | 'glab' {
  return provider === 'github' ? 'gh' : 'glab'
}
