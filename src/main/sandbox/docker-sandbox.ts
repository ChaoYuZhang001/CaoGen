import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { resolveWritableProjectPath } from '../utils/safe-project-path'

export type SandboxMode = 'strictDocker' | 'standardSystem' | 'loose'

export interface SandboxCommandOptions {
  command: string
  cwd: string
  mode: SandboxMode
  timeoutMs: number
  maxBufferBytes: number
  dockerImage?: string
  dockerBinary?: string
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  dockerRegistryMirror?: string
  allowStrictDockerFallback?: boolean
}

export interface SandboxCommandResult {
  ok: boolean
  output: string
  exitCode: number
  modeUsed: SandboxMode
  sandboxed: boolean
  fallbackReason?: string
}

export interface SandboxFileWriteOptions {
  cwd: string
  targetPath: string
  content: string
  mode: SandboxMode
  timeoutMs: number
  dockerImage?: string
  dockerBinary?: string
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
  dockerRegistryMirror?: string
  allowStrictDockerFallback?: boolean
}

interface ExecFileResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
  errorMessage?: string
}

export const DEFAULT_DOCKER_IMAGE = 'caogen-sandbox:latest'
const DEFAULT_DOCKER_CPUS = '2'
const DEFAULT_DOCKER_MEMORY = '2g'
const DEFAULT_DOCKER_PIDS = '256'
const DOCKER_WORKSPACE = '/workspace'
const SANDBOX_WRITE_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const payload = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const root = path.resolve('${DOCKER_WORKSPACE}');
const target = path.resolve(root, payload.targetRelPath);
if (target !== root && !target.startsWith(root + path.sep)) {
  throw new Error('target path escapes workspace');
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, payload.content, 'utf8');
`

export async function runSandboxedCommand(options: SandboxCommandOptions): Promise<SandboxCommandResult> {
  const command = options.command.trim()
  if (!command) {
    return {
      ok: false,
      output: '命令不能为空',
      exitCode: 1,
      modeUsed: options.mode,
      sandboxed: options.mode === 'strictDocker'
    }
  }

  if (options.mode === 'strictDocker') {
    const dockerBinary = options.dockerBinary ?? 'docker'
    const dockerAvailable = await isDockerAvailable(dockerBinary)
    if (dockerAvailable) {
      const image = resolveDockerImage(options.dockerImage?.trim() || DEFAULT_DOCKER_IMAGE, options)
      const imageAvailable = await isDockerImageAvailable(dockerBinary, image)
      if (!imageAvailable) return handleStrictDockerUnavailable(options, command, `Docker image unavailable:${image}`)
      return runDockerCommand({ ...options, command, dockerBinary })
    }

    const fallbackReason = `Docker 不可用,已降级为 standardSystem:${dockerBinary}`
    return handleStrictDockerUnavailable(options, command, fallbackReason)
  }

  return runSystemCommand({ ...options, command })
}

export async function writeTextFileWithSandbox(options: SandboxFileWriteOptions): Promise<SandboxCommandResult> {
  const safePath = await resolveWritableProjectPath(options.cwd, options.targetPath).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error)
  }))
  if ('error' in safePath) {
    return {
      ok: false,
      output: `target path escapes workspace:${options.targetPath}; ${safePath.error}`,
      exitCode: 1,
      modeUsed: options.mode,
      sandboxed: false
    }
  }
  const cwd = safePath.root
  const targetPath = safePath.fullPath
  const relPath = safePath.relativePath
  const safeOptions = { ...options, cwd, targetPath }

  if (options.mode !== 'strictDocker') {
    return writeTextFileOnHost(safeOptions, options.mode)
  }

  const dockerBinary = options.dockerBinary ?? 'docker'
  const dockerAvailable = await isDockerAvailable(dockerBinary)
  if (!dockerAvailable) {
    return writeTextFileWithFallback(safeOptions, `Docker 不可用,已降级为 standardSystem:${dockerBinary}`)
  }

  const image = resolveDockerImage(options.dockerImage?.trim() || DEFAULT_DOCKER_IMAGE, options)
  const imageAvailable = await isDockerImageAvailable(dockerBinary, image)
  if (!imageAvailable) {
    return writeTextFileWithFallback(safeOptions, `Docker image unavailable:${image}`)
  }

  const payloadRelPath = `.caogen/tmp/sandbox-write/${randomUUID()}.json`
  const payloadPath = join(cwd, payloadRelPath)
  await mkdir(dirname(payloadPath), { recursive: true })
  await writeFile(
    payloadPath,
    JSON.stringify({ targetRelPath: relPath.split(sep).join('/'), content: options.content }),
    'utf8'
  )
  try {
    const mirrorEnv = buildChinaMirrorEnv(options)
    const result = await execFilePromise(
      dockerBinary,
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=512m',
        '--cpus',
        DEFAULT_DOCKER_CPUS,
        '--memory',
        DEFAULT_DOCKER_MEMORY,
        '--pids-limit',
        DEFAULT_DOCKER_PIDS,
        '--user',
        'node',
        ...dockerEnvArgs(mirrorEnv),
        '-v',
        `${cwd}:${DOCKER_WORKSPACE}`,
        '-w',
        DOCKER_WORKSPACE,
        image,
        'node',
        '-e',
        SANDBOX_WRITE_SCRIPT,
        payloadRelPath
      ],
      {
        cwd,
        timeoutMs: options.timeoutMs,
        maxBufferBytes: 512 * 1024,
        env: mergeProcessEnv(mirrorEnv)
      }
    )
    const formatted = formatResult(result, 'strictDocker', true)
    return {
      ...formatted,
      output: result.ok ? `已通过 Docker 沙箱写入 ${relPath}` : formatted.output
    }
  } finally {
    await rm(payloadPath, { force: true }).catch(() => undefined)
  }
}

async function isDockerAvailable(dockerBinary: string): Promise<boolean> {
  const result = await execFilePromise(dockerBinary, ['version', '--format', '{{.Server.Version}}'], {
    cwd: process.cwd(),
    timeoutMs: 3_000,
    maxBufferBytes: 256 * 1024
  })
  return result.ok
}

async function isDockerImageAvailable(dockerBinary: string, image: string): Promise<boolean> {
  const result = await execFilePromise(dockerBinary, ['image', 'inspect', image], {
    cwd: process.cwd(),
    timeoutMs: 3_000,
    maxBufferBytes: 256 * 1024
  })
  return result.ok
}

async function handleStrictDockerUnavailable(
  options: SandboxCommandOptions,
  command: string,
  fallbackReason: string
): Promise<SandboxCommandResult> {
  if (options.allowStrictDockerFallback !== true) {
    return {
      ok: false,
      output: `[sandbox strictDocker blocked] ${fallbackReason}\n严格 Docker 沙箱未运行;为避免误以为处于隔离环境,默认不自动降级。`,
      exitCode: 1,
      modeUsed: 'strictDocker',
      sandboxed: false,
      fallbackReason
    }
  }
  const fallback = await runSystemCommand({ ...options, command, mode: 'standardSystem' })
  return {
    ...fallback,
    output: `[sandbox fallback] ${fallbackReason}\n${fallback.output}`,
    fallbackReason
  }
}

async function runDockerCommand(
  options: SandboxCommandOptions & { command: string; dockerBinary: string }
): Promise<SandboxCommandResult> {
  const image = resolveDockerImage(options.dockerImage?.trim() || DEFAULT_DOCKER_IMAGE, options)
  const mirrorEnv = buildChinaMirrorEnv(options)
  const result = await execFilePromise(
    options.dockerBinary,
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=512m',
      '--cpus',
      DEFAULT_DOCKER_CPUS,
      '--memory',
      DEFAULT_DOCKER_MEMORY,
      '--pids-limit',
      DEFAULT_DOCKER_PIDS,
      '--user',
      'node',
      ...dockerEnvArgs(mirrorEnv),
      '-v',
      `${options.cwd}:/workspace`,
      '-w',
      '/workspace',
      image,
      '/bin/sh',
      '-lc',
      options.command
    ],
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
      env: mergeProcessEnv(mirrorEnv)
    }
  )
  return formatResult(result, 'strictDocker', true)
}

async function writeTextFileWithFallback(
  options: SandboxFileWriteOptions,
  fallbackReason: string
): Promise<SandboxCommandResult> {
  if (options.allowStrictDockerFallback !== true) {
    return {
      ok: false,
      output: `[sandbox strictDocker blocked] ${fallbackReason}\n严格 Docker 沙箱未运行;为避免误以为处于隔离环境,默认不自动降级。`,
      exitCode: 1,
      modeUsed: 'strictDocker',
      sandboxed: false,
      fallbackReason
    }
  }
  const fallback = await writeTextFileOnHost(options, 'standardSystem')
  return {
    ...fallback,
    output: `[sandbox fallback] ${fallbackReason}\n${fallback.output}`,
    fallbackReason
  }
}

async function writeTextFileOnHost(
  options: SandboxFileWriteOptions,
  modeUsed: SandboxMode
): Promise<SandboxCommandResult> {
  try {
    await mkdir(dirname(options.targetPath), { recursive: true })
    await writeFile(options.targetPath, options.content, 'utf8')
    return {
      ok: true,
      output: `已写入 ${relative(resolve(options.cwd), resolve(options.targetPath))}`,
      exitCode: 0,
      modeUsed,
      sandboxed: false
    }
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      modeUsed,
      sandboxed: false
    }
  }
}

async function runSystemCommand(
  options: SandboxCommandOptions & { command: string }
): Promise<SandboxCommandResult> {
  const shell = process.platform === 'win32' ? 'cmd' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/c', options.command] : ['-c', options.command]
  const result = await execFilePromise(shell, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    env: mergeProcessEnv(buildChinaMirrorEnv(options))
  })
  return formatResult(result, options.mode, false)
}

function formatResult(result: ExecFileResult, modeUsed: SandboxMode, sandboxed: boolean): SandboxCommandResult {
  const output = [
    result.stdout,
    result.stderr ? `[stderr]\n${result.stderr}` : '',
    result.errorMessage && result.exitCode !== 0 ? `[exit ${result.exitCode}] ${result.errorMessage}` : ''
  ]
    .filter(Boolean)
    .join('\n')
    .trim()
  return {
    ok: result.ok,
    output: output || '(无输出)',
    exitCode: result.exitCode,
    modeUsed,
    sandboxed
  }
}

export function buildChinaMirrorEnv(options: {
  chinaMirrorEnabled?: boolean
  npmRegistry?: string
  pipIndexUrl?: string
}): Record<string, string> {
  if (options.chinaMirrorEnabled !== true) return {}
  const env: Record<string, string> = {}
  const npmRegistry = options.npmRegistry?.trim()
  const pipIndexUrl = options.pipIndexUrl?.trim()
  if (npmRegistry) env.NPM_CONFIG_REGISTRY = npmRegistry
  if (pipIndexUrl) env.PIP_INDEX_URL = pipIndexUrl
  return env
}

function dockerEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`])
}

function mergeProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv | undefined {
  return Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined
}

export function resolveDockerImage(
  image: string,
  options: { chinaMirrorEnabled?: boolean; dockerRegistryMirror?: string }
): string {
  const mirror = options.dockerRegistryMirror?.trim().replace(/\/+$/, '')
  if (options.chinaMirrorEnabled !== true || !mirror || hasRegistryHost(image)) return image
  return `${mirror}/${image}`
}

function hasRegistryHost(image: string): boolean {
  const parts = image.split('/')
  if (parts.length < 2) return false
  const first = parts[0] ?? ''
  return first.includes('.') || first.includes(':') || first === 'localhost'
}

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxBufferBytes: number; env?: NodeJS.ProcessEnv }
): Promise<ExecFileResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxBufferBytes, env: options.env },
      (err, stdout, stderr) => {
        const exitCode = exitCodeFromError(err)
        resolvePromise({
          ok: !err,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode,
          errorMessage: err instanceof Error ? err.message : undefined
        })
      }
    )
  })
}

function exitCodeFromError(err: Error | null): number {
  if (!err) return 0
  const withCode = err as NodeJS.ErrnoException & { code?: unknown }
  return typeof withCode.code === 'number' ? withCode.code : 1
}
