import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkPromise: Promise<SdkModule> | undefined

/** SDK is ESM-only while the main process is built as CJS, so load it lazily. */
export function loadClaudeSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

let cachedExecPath: string | null | undefined

/** Resolve the unpacked native Claude executable in packaged builds. */
export function claudeExecutablePath(): string | undefined {
  if (cachedExecPath !== undefined) return cachedExecPath ?? undefined
  if (!app.isPackaged) {
    cachedExecPath = null
    return undefined
  }
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const executable = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    pkg,
    bin
  )
  cachedExecPath = existsSync(executable) ? executable : null
  if (!cachedExecPath) console.error('[caogen] 未找到打包后的 claude 二进制:', executable)
  return cachedExecPath ?? undefined
}
