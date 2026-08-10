import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, readdirSync, type Dirent } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Readable } from 'node:stream'
import WebSocket, { type RawData } from 'ws'
import type {
  ProjectDebugBreakpoint,
  ProjectDebugControlAction,
  ProjectDebugDiscoveryResult,
  ProjectDebugFrame,
  ProjectDebugScope,
  ProjectDebugState,
  ProjectDebugTarget,
  ProjectDebugTargetSource,
  ProjectDebugVariable
} from '../shared/types'

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const MAX_SCAN_ENTRIES = 2_000
const MAX_SCAN_DEPTH = 4
const MAX_TARGETS = 80
const CONNECT_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 5_000
const SUPPORTED_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'])
const ENTRY_BASENAMES = new Set(['app', 'cli', 'index', 'main', 'server'])

interface RunnableDebugTarget extends ProjectDebugTarget {
  absolutePath: string
}

interface InspectorCallFrame {
  callFrameId: string
  functionName?: string
  url?: string
  location?: { scriptId?: string; lineNumber?: number; columnNumber?: number }
  scopeChain?: Array<{ type?: string; name?: string; object?: InspectorRemoteObject }>
}

interface InspectorRemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  objectId?: string
}

interface InspectorProperty {
  name?: string
  value?: InspectorRemoteObject
  get?: InspectorRemoteObject
  set?: InspectorRemoteObject
}

interface InspectorMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

interface PendingCommand {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
}

type DebugChild = ChildProcessByStdio<null, Readable, Readable>

const runtimes = new Map<string, NodeInspectorRuntime>()
let smokeExecutable = ''
let smokeTsxLoader = ''

export function configureProjectDebuggerForSmoke(executable: string, tsxLoader?: string): void {
  if (process.env.CAOGEN_PROJECT_DEBUG_SMOKE !== '1') {
    throw new Error('Project debugger overrides are restricted to the smoke harness')
  }
  smokeExecutable = executable
  smokeTsxLoader = tsxLoader ?? ''
}

export function discoverProjectDebugTargets(cwd: string): ProjectDebugDiscoveryResult {
  try {
    return { ok: true, targets: discoverRunnableTargets(cwd).map(publicTarget) }
  } catch (error) {
    return { ok: false, targets: [], error: errorMessage(error) }
  }
}

export function getProjectDebugState(sessionId: string): ProjectDebugState {
  return runtimes.get(sessionId)?.snapshot() ?? emptyState()
}

export async function launchProjectDebug(
  cwd: string,
  sessionId: string,
  targetId: string,
  breakpoints: ProjectDebugBreakpoint[]
): Promise<ProjectDebugState> {
  const current = runtimes.get(sessionId)
  if (current?.isActive()) throw new Error('A debug session is already active for this project session')
  const target = discoverRunnableTargets(cwd).find((candidate) => candidate.id === targetId)
  if (!target) throw new Error('Debug target changed after discovery; refresh the target list')
  const normalizedBreakpoints = validateBreakpoints(cwd, breakpoints)
  const runtime = new NodeInspectorRuntime(cwd, target, normalizedBreakpoints)
  runtimes.set(sessionId, runtime)
  await runtime.start()
  return runtime.snapshot()
}

export async function controlProjectDebug(
  sessionId: string,
  action: ProjectDebugControlAction
): Promise<ProjectDebugState> {
  const runtime = requiredRuntime(sessionId)
  await runtime.control(action)
  return runtime.snapshot()
}

export async function selectProjectDebugFrame(sessionId: string, frameId: string): Promise<ProjectDebugState> {
  const runtime = requiredRuntime(sessionId)
  await runtime.selectFrame(frameId)
  return runtime.snapshot()
}

export async function expandProjectDebugVariable(
  sessionId: string,
  variableId: string
): Promise<ProjectDebugVariable[]> {
  return requiredRuntime(sessionId).expandVariable(variableId)
}

export function disposeProjectDebuggers(): void {
  for (const runtime of runtimes.values()) runtime.dispose()
}

class NodeInspectorRuntime {
  private child: DebugChild | null = null
  private socket: WebSocket | null = null
  private sequence = 0
  private pending = new Map<number, PendingCommand>()
  private callFrames = new Map<string, InspectorCallFrame>()
  private scriptUrls = new Map<string, string>()
  private variableObjects = new Map<string, string>()
  private state: ProjectDebugState
  private entryPauseResolve: (() => void) | null = null
  private entryPaused = false
  private waitingForEntry = true
  private stopping = false
  private detachingForExit = false
  private settled = false

  constructor(
    private readonly cwd: string,
    private readonly target: RunnableDebugTarget,
    private readonly breakpoints: ProjectDebugBreakpoint[]
  ) {
    this.state = {
      ...emptyState(),
      status: 'starting',
      targetId: target.id,
      targetLabel: target.label,
      startedAt: new Date().toISOString()
    }
  }

  isActive(): boolean {
    return this.state.status === 'starting' || this.state.status === 'running' || this.state.status === 'paused'
  }

  snapshot(): ProjectDebugState {
    return structuredClone(this.state)
  }

  async start(): Promise<void> {
    try {
      const args = ['--inspect-brk=127.0.0.1:0', '--enable-source-maps']
      if (this.target.runtime === 'tsx') args.push('--import', pathToFileURL(resolveTsxLoader()).href)
      args.push(this.target.absolutePath)
      const child = spawn(debugExecutable(), args, {
        cwd: this.cwd,
        env: debugEnvironment(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child
      child.stdout.on('data', (chunk: Buffer) => this.captureOutput('stdout', chunk))
      let inspectorBuffer = ''
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        this.captureOutput('stderr', chunk)
        inspectorBuffer = `${inspectorBuffer}${text}`.slice(-32_768)
        const match = inspectorBuffer.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9-]+)/)
        if (match && !this.socket) void this.connect(match[1])
        if (text.includes('Waiting for the debugger to disconnect...')) this.detachForNaturalExit()
      })
      child.on('error', (error) => this.fail(errorMessage(error)))
      child.on('close', (code) => this.handleProcessClose(code))
      await this.waitUntilConnected()
      await this.send('Runtime.enable')
      await this.send('Debugger.enable')
      for (const breakpoint of this.breakpoints) {
        await this.send('Debugger.setBreakpointByUrl', {
          url: pathToFileURL(resolve(this.cwd, breakpoint.path)).href,
          lineNumber: breakpoint.line - 1
        })
      }
      await this.send('Runtime.runIfWaitingForDebugger')
      await this.waitForEntryPause()
      this.waitingForEntry = false
      await this.send('Debugger.resume')
      if (!this.settled && this.state.status !== 'paused') this.state.status = 'running'
    } catch (error) {
      this.fail(errorMessage(error))
      this.terminateProcess()
    }
  }

  async control(action: ProjectDebugControlAction): Promise<void> {
    if (action === 'stop') {
      await this.stop()
      return
    }
    if (!this.isActive()) throw new Error('The debug session is not active')
    if (action === 'pause') {
      if (this.state.status !== 'running') throw new Error('The debug session is not running')
      await this.send('Debugger.pause')
      return
    }
    if (this.state.status !== 'paused') throw new Error('The debug session is not paused')
    this.clearPauseProjection()
    this.state.status = 'running'
    const method = {
      continue: 'Debugger.resume',
      'step-over': 'Debugger.stepOver',
      'step-into': 'Debugger.stepInto',
      'step-out': 'Debugger.stepOut'
    }[action]
    await this.send(method)
  }

  async selectFrame(frameId: string): Promise<void> {
    if (this.state.status !== 'paused') throw new Error('The debug session is not paused')
    const frame = this.callFrames.get(frameId)
    if (!frame) throw new Error('The stack frame is no longer available')
    this.state.selectedFrameId = frameId
    this.state.scopes = await this.loadScopes(frame)
  }

  async expandVariable(variableId: string): Promise<ProjectDebugVariable[]> {
    if (this.state.status !== 'paused') throw new Error('The debug session is not paused')
    const objectId = this.variableObjects.get(variableId)
    if (!objectId) throw new Error('The variable is no longer available')
    return this.loadProperties(objectId)
  }

  dispose(): void {
    if (!this.isActive()) return
    this.stopping = true
    this.terminateProcess()
    this.finish('stopped', null)
  }

  private async connect(url: string): Promise<void> {
    if (this.socket) return
    const socket = new WebSocket(url)
    this.socket = socket
    socket.on('message', (data) => this.handleMessage(data))
    socket.on('error', (error) => {
      if (!this.settled) this.fail(errorMessage(error))
    })
    socket.on('close', () => {
      if (!this.stopping && !this.detachingForExit && this.isActive() && !this.settled) this.fail('Debugger connection closed unexpectedly')
    })
  }

  private waitUntilConnected(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const started = Date.now()
      const timer = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          clearInterval(timer)
          resolvePromise()
        } else if (this.settled || Date.now() - started >= CONNECT_TIMEOUT_MS) {
          clearInterval(timer)
          reject(new Error(this.state.error || 'Timed out connecting to the Node debugger'))
        }
      }, 25)
    })
  }

  private waitForEntryPause(): Promise<void> {
    if (this.entryPaused) return Promise.resolve()
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.entryPauseResolve = null
        reject(new Error('Timed out waiting for the debug target to pause on entry'))
      }, COMMAND_TIMEOUT_MS)
      this.entryPauseResolve = () => {
        clearTimeout(timeout)
        resolvePromise()
      }
    })
  }

  private handleMessage(raw: RawData): void {
    let message: InspectorMessage
    try { message = JSON.parse(raw.toString()) as InspectorMessage } catch { return }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'Node inspector command failed'))
      else pending.resolve(message.result ?? {})
      return
    }
    if (message.method === 'Debugger.paused') {
      void this.handlePaused(message.params ?? {}).catch((error) => {
        if (!this.settled) this.fail(errorMessage(error))
      })
    }
    if (message.method === 'Debugger.scriptParsed') {
      const scriptId = message.params?.scriptId
      const url = message.params?.url
      if (typeof scriptId === 'string' && typeof url === 'string') this.scriptUrls.set(scriptId, url)
    }
    if (message.method === 'Debugger.resumed' && !this.waitingForEntry) {
      this.clearPauseProjection()
      this.state.status = 'running'
    }
  }

  private async handlePaused(params: Record<string, unknown>): Promise<void> {
    if (this.waitingForEntry) {
      this.entryPaused = true
      this.entryPauseResolve?.()
      this.entryPauseResolve = null
      return
    }
    const frames = Array.isArray(params.callFrames) ? params.callFrames as InspectorCallFrame[] : []
    this.callFrames.clear()
    for (const frame of frames.slice(0, 50)) this.callFrames.set(frame.callFrameId, frame)
    const publicFrames = frames.slice(0, 50).map((frame) => this.publicFrame(frame))
    this.state.pauseReason = typeof params.reason === 'string' ? params.reason : 'paused'
    this.state.frames = publicFrames
    this.state.selectedFrameId = publicFrames[0]?.id ?? ''
    this.variableObjects.clear()
    this.state.scopes = frames[0] ? await this.loadScopes(frames[0]) : []
    if (!this.settled) this.state.status = 'paused'
  }

  private publicFrame(frame: InspectorCallFrame): ProjectDebugFrame {
    const line = (frame.location?.lineNumber ?? -1) + 1
    const column = (frame.location?.columnNumber ?? -1) + 1
    return {
      id: frame.callFrameId,
      name: frame.functionName || '(anonymous)',
      location: line > 0 ? {
        path: this.publicScriptPath(frame.url || this.scriptUrls.get(frame.location?.scriptId ?? '') || ''),
        line,
        column: Math.max(1, column)
      } : null
    }
  }

  private publicScriptPath(url: string): string {
    try {
      const absolute = url.startsWith('file:') ? fileURLToPath(url) : resolve(url)
      const rel = relative(resolve(this.cwd), resolve(absolute))
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? rel.replace(/\\/g, '/') : `<runtime>/${basename(absolute)}`
    } catch {
      return '<runtime>'
    }
  }

  private async loadScopes(frame: InspectorCallFrame): Promise<ProjectDebugScope[]> {
    const scopes: ProjectDebugScope[] = []
    for (const scope of (frame.scopeChain ?? []).slice(0, 12)) {
      if (!scope.object?.objectId) continue
      scopes.push({
        name: scope.name || scope.type || 'scope',
        variables: await this.loadProperties(scope.object.objectId)
      })
    }
    return scopes
  }

  private async loadProperties(objectId: string): Promise<ProjectDebugVariable[]> {
    const result = await this.send('Runtime.getProperties', { objectId, ownProperties: true, generatePreview: true })
    const properties = Array.isArray(result.result) ? result.result as InspectorProperty[] : []
    return properties.slice(0, 200).flatMap((property) => {
      const value = property.value ?? property.get ?? property.set
      if (!property.name || !value) return []
      const expandable = Boolean(value.objectId) && value.subtype !== 'null'
      const id = expandable ? randomUUID() : undefined
      if (id && value.objectId) this.variableObjects.set(id, value.objectId)
      return [{
        ...(id ? { id } : {}),
        name: property.name,
        value: displayValue(value),
        type: value.subtype || value.type || 'unknown',
        expandable
      }]
    })
  }

  private send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Debugger is not connected'))
    const id = ++this.sequence
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Node inspector command timed out: ${method}`))
      }, COMMAND_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolvePromise, reject, timeout })
      socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }))
    })
  }

  private captureOutput(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const normalized = sanitizeDebuggerOutput(normalizeOutput(chunk.toString('utf8'), this.cwd))
    const current = this.state[stream]
    if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) {
      this.state.outputTruncated = true
      return
    }
    const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current)
    const next = Buffer.from(normalized).subarray(0, remaining).toString('utf8')
    this.state[stream] = `${current}${next}`
    if (Buffer.byteLength(normalized) > remaining) this.state.outputTruncated = true
  }

  private clearPauseProjection(): void {
    this.callFrames.clear()
    this.variableObjects.clear()
    this.state.pauseReason = ''
    this.state.frames = []
    this.state.selectedFrameId = ''
    this.state.scopes = []
  }

  private async stop(): Promise<void> {
    if (!this.isActive()) return
    this.stopping = true
    try { await this.send('Runtime.terminateExecution') } catch { /* process termination is authoritative */ }
    this.terminateProcess()
    this.finish('stopped', null)
  }

  private terminateProcess(): void {
    const child = this.child
    if (!child?.pid || child.killed) return
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  }

  private detachForNaturalExit(): void {
    if (this.detachingForExit || this.stopping || this.settled) return
    this.detachingForExit = true
    try { this.socket?.close() } catch { /* process close will settle the state */ }
  }

  private handleProcessClose(code: number | null): void {
    if (this.settled) return
    if (this.stopping) this.finish('stopped', code)
    else if (code === 0) this.finish('stopped', code)
    else this.fail(`Debug target exited with code ${code ?? 'unknown'}`, code)
  }

  private fail(message: string, exitCode: number | null = null): void {
    this.finish('failed', exitCode, message)
  }

  private finish(status: 'stopped' | 'failed', exitCode: number | null, message = ''): void {
    if (this.settled) return
    this.settled = true
    this.state.status = status
    this.state.exitCode = exitCode
    this.state.error = message
    this.state.finishedAt = new Date().toISOString()
    this.clearPauseProjection()
    for (const command of this.pending.values()) {
      clearTimeout(command.timeout)
      command.reject(new Error(message || 'Debug session ended'))
    }
    this.pending.clear()
    try { this.socket?.close() } catch { /* best effort */ }
  }
}

function discoverRunnableTargets(cwd: string): RunnableDebugTarget[] {
  const root = resolve(cwd)
  const manifestPath = join(root, 'package.json')
  let manifestText = ''
  let manifest: Record<string, unknown> = {}
  if (existsSync(manifestPath)) {
    manifestText = readBoundedFile(manifestPath, 'package.json')
    try {
      const parsed = JSON.parse(manifestText) as unknown
      if (isRecord(parsed)) manifest = parsed
    } catch {
      throw new Error('package.json is invalid JSON')
    }
  }
  const candidates: Array<{ path: string; source: ProjectDebugTargetSource; label: string }> = []
  if (typeof manifest.main === 'string') candidates.push({ path: manifest.main, source: 'package-main', label: 'Package main' })
  if (typeof manifest.bin === 'string') candidates.push({ path: manifest.bin, source: 'package-bin', label: 'Package CLI' })
  if (isRecord(manifest.bin)) {
    for (const [name, value] of Object.entries(manifest.bin)) {
      if (typeof value === 'string') candidates.push({ path: value, source: 'package-bin', label: `CLI: ${name}` })
    }
  }
  if (isRecord(manifest.scripts)) {
    for (const [name, value] of Object.entries(manifest.scripts)) {
      const parsed = typeof value === 'string' ? directScriptEntry(value) : null
      if (parsed) candidates.push({ path: parsed, source: 'package-script', label: `Script: ${name}` })
    }
  }
  for (const entry of scanWorkspaceEntries(root)) {
    candidates.push({ path: entry, source: 'workspace-entry', label: entry.replace(/\\/g, '/') })
  }
  const seen = new Set<string>()
  const runnable: RunnableDebugTarget[] = []
  for (const candidate of candidates) {
    const absolutePath = resolve(root, candidate.path)
    const rel = relative(root, absolutePath)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || seen.has(rel.toLowerCase())) continue
    if (!isSupportedFile(absolutePath)) continue
    seen.add(rel.toLowerCase())
    const runtime = isTypeScript(absolutePath) ? 'tsx' : 'node'
    const identity = `${manifestText}\0${fileIdentity(absolutePath)}\0${runtime}`
    const id = createHash('sha256').update(identity).digest('hex').slice(0, 24)
    runnable.push({
      id,
      label: candidate.label,
      source: candidate.source,
      relativePath: rel.replace(/\\/g, '/'),
      runtime,
      default: runnable.length === 0,
      absolutePath
    })
    if (runnable.length >= MAX_TARGETS) break
  }
  return runnable
}

function scanWorkspaceEntries(root: string): string[] {
  const results: string[] = []
  let visited = 0
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_SCAN_ENTRIES || results.length >= MAX_TARGETS) return
    let entries: Dirent[]
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (++visited > MAX_SCAN_ENTRIES) return
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'build', 'out', 'coverage'].includes(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      const name = basename(entry.name, extension).toLowerCase()
      if (SUPPORTED_EXTENSIONS.has(extension) && ENTRY_BASENAMES.has(name)) results.push(relative(root, full))
    }
  }
  walk(root, 0)
  return results
}

function directScriptEntry(command: string): string | null {
  const match = command.trim().match(/^(?:node|tsx)(?:\s+--enable-source-maps)?\s+([a-zA-Z0-9_./\\-]+\.(?:[cm]?[jt]s))$/)
  return match?.[1] ?? null
}

function validateBreakpoints(cwd: string, breakpoints: ProjectDebugBreakpoint[]): ProjectDebugBreakpoint[] {
  if (!Array.isArray(breakpoints) || breakpoints.length > 200) throw new Error('Debug breakpoints are invalid')
  const root = resolve(cwd)
  const seen = new Set<string>()
  return breakpoints.map((breakpoint) => {
    if (!breakpoint || typeof breakpoint.path !== 'string' || !Number.isSafeInteger(breakpoint.line) || breakpoint.line < 1 || breakpoint.line > 1_000_000) {
      throw new Error('Debug breakpoint is invalid')
    }
    const absolute = resolve(root, breakpoint.path)
    const rel = relative(root, absolute)
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !isSupportedFile(absolute)) throw new Error('Debug breakpoint path is invalid')
    const normalized = rel.replace(/\\/g, '/')
    const key = `${normalized.toLowerCase()}:${breakpoint.line}`
    if (seen.has(key)) throw new Error('Duplicate debug breakpoint')
    seen.add(key)
    return { path: normalized, line: breakpoint.line }
  })
}

function requiredRuntime(sessionId: string): NodeInspectorRuntime {
  const runtime = runtimes.get(sessionId)
  if (!runtime) throw new Error('Debug session was not found')
  return runtime
}

function publicTarget(target: RunnableDebugTarget): ProjectDebugTarget {
  const { absolutePath: _absolutePath, ...view } = target
  return view
}

function emptyState(): ProjectDebugState {
  return {
    status: 'idle', targetId: '', targetLabel: '', pauseReason: '', frames: [], selectedFrameId: '', scopes: [],
    stdout: '', stderr: '', outputTruncated: false, startedAt: '', finishedAt: '', exitCode: null, error: ''
  }
}

function debugExecutable(): string {
  return smokeExecutable || process.execPath
}

function debugEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function resolveTsxLoader(): string {
  return smokeTsxLoader || createRequire(__filename).resolve('tsx')
}

function isSupportedFile(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink() && SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())
  } catch {
    return false
  }
}

function isTypeScript(path: string): boolean {
  return ['.ts', '.cts', '.mts'].includes(extname(path).toLowerCase())
}

function fileIdentity(path: string): string {
  const info = lstatSync(path)
  return `${info.size}:${info.mtimeMs}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function readBoundedFile(path: string, label: string): string {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error(`${label} is invalid or too large`)
  return readFileSync(path, 'utf8')
}

function displayValue(value: InspectorRemoteObject): string {
  if (value.unserializableValue) return value.unserializableValue
  if (value.type === 'string') return JSON.stringify(value.value)
  if (value.value !== undefined) return String(value.value)
  if (value.subtype === 'null') return 'null'
  return value.description || value.type || 'undefined'
}

function normalizeOutput(value: string, cwd: string): string {
  const absolute = resolve(cwd)
  return value
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .split(absolute).join('<workspace>')
    .split(absolute.replace(/\\/g, '/')).join('<workspace>')
}

function sanitizeDebuggerOutput(value: string): string {
  return value
    .replace(/Debugger listening on ws:\/\/[^\s]+\n?/g, '[debugger attached]\n')
    .replace(/For help, see: https:\/\/[^\s]+\n?/g, '')
    .replace(/Debugger attached\.\n?/g, '')
    .replace(/Waiting for the debugger to disconnect\.\.\.\n?/g, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
