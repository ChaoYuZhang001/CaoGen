import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type {
  ProjectTestCommand,
  ProjectTestCommandSource,
  ProjectTestDiscoveryResult,
  ProjectTestRunResult,
  ProjectTestRunStatus
} from '../shared/types'

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_MAX_RUN_MS = 10 * 60 * 1_000
const TEST_SCRIPT_NAME = /^(?:test|check|lint|typecheck)(?::[a-zA-Z0-9._-]+)?$/

interface RunnableCommand extends ProjectTestCommand {
  executable: string
  args: string[]
  shell: boolean
}

interface ActiveRun {
  child: TestChild
  cancel(reason: ProjectTestRunStatus): void
}

type TestChild = ChildProcessByStdio<null, Readable, Readable>

const activeRuns = new Map<string, ActiveRun>()
let runnerLimits = { maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, maxRunMs: DEFAULT_MAX_RUN_MS }

export function configureProjectTestRuntimeForSmoke(input?: {
  maxOutputBytes?: number
  maxRunMs?: number
}): void {
  if (process.env.CAOGEN_PROJECT_TEST_SMOKE !== '1') {
    throw new Error('Project test runtime overrides are restricted to the smoke harness')
  }
  runnerLimits = {
    maxOutputBytes: positiveLimit(input?.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    maxRunMs: positiveLimit(input?.maxRunMs, DEFAULT_MAX_RUN_MS)
  }
}

export function discoverProjectTests(cwd: string): ProjectTestDiscoveryResult {
  try {
    return { ok: true, commands: discoverRunnableCommands(cwd).map(publicCommand) }
  } catch (error) {
    return { ok: false, commands: [], error: errorMessage(error) }
  }
}

export async function runProjectTest(
  cwd: string,
  sessionId: string,
  commandId: string
): Promise<ProjectTestRunResult> {
  if (activeRuns.has(sessionId)) throw new Error('A test command is already running for this session')
  const command = discoverRunnableCommands(cwd).find((candidate) => candidate.id === commandId)
  if (!command) throw new Error('Test command changed after discovery; refresh the test list')
  return executeCommand(cwd, sessionId, command)
}

export function cancelProjectTest(sessionId: string): boolean {
  const active = activeRuns.get(sessionId)
  if (!active) return false
  active.cancel('cancelled')
  return true
}

export function disposeProjectTestRuns(): void {
  for (const active of activeRuns.values()) active.cancel('cancelled')
}

function discoverRunnableCommands(cwd: string): RunnableCommand[] {
  const root = resolve(cwd)
  const commands = [
    ...packageCommands(root),
    ...conventionCommands(root)
  ]
  const seen = new Set<string>()
  const unique = commands.filter((command) => !seen.has(command.id) && Boolean(seen.add(command.id))).slice(0, 40)
  const preferred = Math.max(0, unique.findIndex((command) => command.default))
  return unique.map((command, index) => ({ ...command, default: index === preferred }))
}

function packageCommands(cwd: string): RunnableCommand[] {
  const manifestPath = join(cwd, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifestText = readBoundedFile(manifestPath, 'package.json')
  let manifest: unknown
  try { manifest = JSON.parse(manifestText) } catch { throw new Error('package.json is invalid JSON') }
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {}
  const manager = packageManager(cwd, isRecord(manifest) && typeof manifest.packageManager === 'string' ? manifest.packageManager : '')
  return Object.entries(scripts)
    .filter((entry): entry is [string, string] => TEST_SCRIPT_NAME.test(entry[0]) && typeof entry[1] === 'string')
    .sort(([left], [right]) => Number(left !== 'test') - Number(right !== 'test') || left.localeCompare(right))
    .map(([name, body]) => runnable(
      'package-script',
      `${manager} run ${name}`,
      process.platform === 'win32' ? `${managerExecutable(manager)} run ${name}` : managerExecutable(manager),
      process.platform === 'win32' ? [] : ['run', name],
      process.platform === 'win32',
      `${manager}:${name}:${body}`,
      name === 'test'
    ))
}

function conventionCommands(cwd: string): RunnableCommand[] {
  const commands: RunnableCommand[] = []
  if (hasAny(cwd, ['pyproject.toml', 'pytest.ini', 'tox.ini']) || isDirectory(join(cwd, 'tests'))) {
    commands.push(runnable('pytest', 'Python: pytest', pythonExecutable(), ['-m', 'pytest'], false, 'pytest', commands.length === 0))
  }
  if (isRegularFile(join(cwd, 'Cargo.toml'))) {
    commands.push(runnable('cargo', 'Rust: cargo test', 'cargo', ['test'], false, readBoundedFile(join(cwd, 'Cargo.toml'), 'Cargo.toml'), commands.length === 0))
  }
  if (isRegularFile(join(cwd, 'go.mod'))) {
    commands.push(runnable('go', 'Go: go test ./...', 'go', ['test', './...'], false, readBoundedFile(join(cwd, 'go.mod'), 'go.mod'), commands.length === 0))
  }
  const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
  if (isRegularFile(join(cwd, wrapper))) {
    commands.push(runnable('gradle', 'Gradle: test', process.platform === 'win32' ? `${wrapper} test` : `./${wrapper}`, process.platform === 'win32' ? [] : ['test'], process.platform === 'win32', fileIdentity(join(cwd, wrapper)), commands.length === 0))
  }
  return commands
}

function runnable(
  source: ProjectTestCommandSource,
  label: string,
  executable: string,
  args: string[],
  shell: boolean,
  identity: string,
  isDefault: boolean
): RunnableCommand {
  const id = createHash('sha256').update(`${source}\0${label}\0${identity}`).digest('hex').slice(0, 24)
  return { id, label, source, default: isDefault, executable, args, shell }
}

function executeCommand(cwd: string, sessionId: string, command: RunnableCommand): Promise<ProjectTestRunResult> {
  const runId = randomUUID()
  const startedAt = new Date()
  let forcedStatus: ProjectTestRunStatus | undefined
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stdoutTruncated = false
  let stderrTruncated = false
  return new Promise((resolvePromise) => {
    let settled = false
    let child: TestChild
    try {
      child = spawn(command.executable, command.args, {
        cwd,
        env: testEnvironment(),
        shell: command.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolvePromise(finalResult(command, runId, startedAt, 'launch_failed', null, null, '', errorMessage(error), false, false, cwd))
      return
    }
    const cancel = (reason: ProjectTestRunStatus): void => {
      if (settled || forcedStatus) return
      forcedStatus = reason
      terminateChild(child)
    }
    activeRuns.set(sessionId, { child, cancel })
    const timeout = setTimeout(() => cancel('timed_out'), runnerLimits.maxRunMs)
    child.stdout.on('data', (chunk: Buffer) => {
      const captured = appendBounded(stdout, chunk, runnerLimits.maxOutputBytes)
      stdout = captured.value; stdoutTruncated ||= captured.truncated
      if (captured.truncated) cancel('output_limit')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const captured = appendBounded(stderr, chunk, runnerLimits.maxOutputBytes)
      stderr = captured.value; stderrTruncated ||= captured.truncated
      if (captured.truncated) cancel('output_limit')
    })
    child.on('error', (error) => finish('launch_failed', null, null, errorMessage(error)))
    child.on('close', (code, signal) => finish(forcedStatus ?? (code === 0 ? 'passed' : 'failed'), code, signal, ''))

    function finish(status: ProjectTestRunStatus, exitCode: number | null, signal: NodeJS.Signals | null, launchError: string): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      activeRuns.delete(sessionId)
      const normalizedStdout = normalizeOutput(stdout.toString('utf8'), cwd)
      const normalizedStderr = normalizeOutput(`${stderr.toString('utf8')}${launchError ? `\n${launchError}` : ''}`, cwd)
      resolvePromise(finalResult(
        command, runId, startedAt, status, exitCode, signal,
        normalizedStdout, normalizedStderr, stdoutTruncated, stderrTruncated, cwd
      ))
    }
  })
}

function finalResult(
  command: RunnableCommand,
  runId: string,
  startedAt: Date,
  status: ProjectTestRunStatus,
  exitCode: number | null,
  signal: string | null,
  stdout: string,
  stderr: string,
  stdoutTruncated: boolean,
  stderrTruncated: boolean,
  cwd: string
): ProjectTestRunResult {
  const finishedAt = new Date()
  const result: ProjectTestRunResult = {
    runId,
    commandId: command.id,
    label: command.label,
    source: command.source,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    exitCode,
    signal,
    stdout,
    stderr,
    stdoutTruncated,
    stderrTruncated,
    evidenceId: runId
  }
  try {
    writeEvidence(cwd, result)
  } catch (error) {
    result.evidenceId = ''
    result.evidenceError = `Failed to persist test evidence: ${errorMessage(error)}`
  }
  return result
}

function writeEvidence(cwd: string, result: ProjectTestRunResult): void {
  const workspaceDigest = createHash('sha256').update(resolve(cwd)).digest('hex')
  const directory = join(app.getPath('userData'), 'project-test-evidence', workspaceDigest.slice(0, 24))
  const filePath = join(directory, `${result.runId}.json`)
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  const output = `${result.stdout}\n${result.stderr}`
  const record = {
    kind: 'caogen-project-test-evidence',
    schemaVersion: 1,
    evidenceId: result.evidenceId,
    workspaceDigest,
    commandId: result.commandId,
    label: result.label,
    source: result.source,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    outputDigest: createHash('sha256').update(output).digest('hex'),
    stdoutLines: lineCount(result.stdout),
    stderrLines: lineCount(result.stderr),
    failureSummary: result.status === 'passed' ? undefined : failureSummary(result.stderr || result.stdout)
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    renameSync(temporary, filePath)
    syncDirectory(directory)
  } catch (error) {
    if (descriptor !== undefined) try { closeSync(descriptor) } catch { /* best effort */ }
    try { unlinkSync(temporary) } catch { /* best effort */ }
    throw error
  }
}

function appendBounded(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  maxBytes: number
): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  if (current.length >= maxBytes) return { value: current, truncated: true }
  const remaining = maxBytes - current.length
  return {
    value: Buffer.concat([current, chunk.subarray(0, remaining)]),
    truncated: chunk.length > remaining
  }
}

function terminateChild(child: TestChild): void {
  if (!child.pid || child.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

function publicCommand(command: RunnableCommand): ProjectTestCommand {
  return { id: command.id, label: command.label, source: command.source, default: command.default }
}

function packageManager(cwd: string, declared: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const name = declared.split('@')[0]
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name as 'npm' | 'pnpm' | 'yarn' | 'bun'
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))) return 'bun'
  return 'npm'
}

function managerExecutable(manager: string): string {
  return process.platform === 'win32' ? `${manager}.cmd` : manager
}

function pythonExecutable(): string {
  return process.platform === 'win32' ? 'python.exe' : 'python3'
}

function readBoundedFile(path: string, label: string): string {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error(`${label} is invalid or too large`)
  return readFileSync(path, 'utf8')
}

function isRegularFile(path: string): boolean {
  try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink() } catch { return false }
}

function isDirectory(path: string): boolean {
  try { const info = lstatSync(path); return info.isDirectory() && !info.isSymbolicLink() } catch { return false }
}

function hasAny(cwd: string, names: string[]): boolean {
  return names.some((name) => isRegularFile(join(cwd, name)))
}

function fileIdentity(path: string): string {
  const info = lstatSync(path)
  return `${basename(path)}:${info.size}:${info.mtimeMs}`
}

function testEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, CI: process.env.CI ?? '1', NO_COLOR: '1', FORCE_COLOR: '0' }
}

function normalizeOutput(value: string, cwd: string): string {
  const candidates = [resolve(cwd), resolve(cwd).replace(/\\/g, '/')]
  let normalized = value.replace(/\u0000/g, '').replace(/\r\n/g, '\n')
  for (const candidate of candidates) normalized = normalized.split(candidate).join('<workspace>')
  return normalized
}

function failureSummary(value: string): string {
  const line = value.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? 'Test command failed'
  return redactSecrets(line).slice(0, 500)
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '<redacted>')
    .replace(/\b(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '$1=<redacted>')
}

function lineCount(value: string): number {
  return value ? value.split(/\r?\n/).length : 0
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined
  try { descriptor = openSync(directory, 'r'); fsyncSync(descriptor) } catch { /* unsupported on some platforms */ }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}
