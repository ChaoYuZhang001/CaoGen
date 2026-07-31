#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.env.CAOGEN_JETBRAINS_RECORDER_E2E_REQUIRED === '1' || process.argv.includes('--required')
const enabled = required || process.env.CAOGEN_JETBRAINS_RECORDER_E2E_RUN === '1' || process.argv.includes('--enabled')
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const reportRoot = normalizePath(process.env.CAOGEN_JETBRAINS_RECORDER_E2E_REPORT_ROOT) ?? path.join(repoRoot, 'test-results', 'jetbrains-recorder-e2e')
const reportDir = path.join(reportRoot, runId)
const pluginDir = path.join(repoRoot, 'plugins', 'jetbrains')
const workspace = normalizePath(process.env.CAOGEN_JETBRAINS_WORKSPACE) ?? path.join(reportDir, 'workspace')
const recorderPath = normalizePath(process.env.CAOGEN_JETBRAINS_RECORDER_PATH) ?? path.join(reportDir, 'caogen-jetbrains-recorder.jsonl')
const markerPath = path.join(reportDir, 'caogen-jetbrains-recorder-marker.jsonl')
const recorderMode = normalizeMode(process.env.CAOGEN_JETBRAINS_RECORDER_E2E_MODE)
const ideScriptRelativePath = path.join('build', 'tmp', `caogen-recorder-e2e-${process.pid}.groovy`)
const ideScriptPath = path.join(pluginDir, ideScriptRelativePath)
const bridgeHost = '127.0.0.1'
const bridgePort = 17365
const timeoutMs = positiveInteger(process.env.CAOGEN_JETBRAINS_RECORDER_E2E_TIMEOUT_MS, 240_000)

mkdirSync(reportDir, { recursive: true })

let report
let bridge

try {
  if (!enabled) {
    report = {
      status: 'skipped',
      required,
      reportDir,
      reason: 'set CAOGEN_JETBRAINS_RECORDER_E2E_RUN=1 or pass --enabled/--required to launch a real JetBrains IDE'
    }
  } else {
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      path.join(workspace, 'RecorderE2E.kt'),
      'fun caogenSelection() = "before"\n',
      'utf8'
    )

    bridge = await startBridgeServer()
    const ideRun = await runIde()
    const validation = runValidator(ideRun)
    const failures = [
      ...ideRun.failures,
      ...validation.failures
    ]

    report = {
      status: failures.length > 0 ? 'failed' : 'passed',
      required,
      reportDir,
      workspace,
      recorderPath,
      markerPath,
      timeoutMs,
      bridge: {
        host: bridgeHost,
        port: bridgePort,
        receivedMessages: bridge.messages.length,
        messageTypes: bridge.messages.map((message) => message.type).filter(Boolean)
      },
      evidenceMode: recorderMode === 'ide-script'
        ? 'jetbrains-idescript-prototype'
        : 'jetbrains-lifecycle-autorun-prototype',
      prototypeLimitations: prototypeLimitations(),
      ideRun,
      validation,
      failures
    }
  }
} catch (error) {
  report = {
    status: 'failed',
    required,
    reportDir,
    workspace,
    recorderPath,
    markerPath,
    failures: [error instanceof Error ? error.message : String(error)]
  }
} finally {
  if (bridge) await closeBridge(bridge)
  writeReport(report)
}

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1
if (!required && report.status === 'failed') process.exitCode = 1

async function startBridgeServer() {
  const messages = []
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let handshakeBuffer = Buffer.alloc(0)
    let frameBuffer = Buffer.alloc(0)
    let handshaken = false

    socket.on('data', (chunk) => {
      if (!handshaken) {
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk])
        const text = handshakeBuffer.toString('utf8')
        const headerEnd = text.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const headers = parseHeaders(text.slice(0, headerEnd))
        const key = headers['sec-websocket-key']
        if (!key) {
          socket.destroy(new Error('missing Sec-WebSocket-Key'))
          return
        }
        socket.write(buildHandshakeResponse(key))
        handshaken = true
        const rest = handshakeBuffer.subarray(headerEnd + 4)
        handshakeBuffer = Buffer.alloc(0)
        if (rest.length > 0) frameBuffer = Buffer.concat([frameBuffer, rest])
      } else {
        frameBuffer = Buffer.concat([frameBuffer, chunk])
      }

      while (handshaken) {
        const parsed = readFrame(frameBuffer)
        if (!parsed) break
        frameBuffer = parsed.rest
        if (parsed.opcode === 0x8) {
          socket.end()
          break
        }
        if (parsed.opcode === 0x9) {
          socket.write(buildFrame(parsed.text, 0xA))
          continue
        }
        if (parsed.opcode !== 0x1) continue
        const message = parseMessage(parsed.text)
        messages.push(message)
        for (const response of responsesFor(message)) {
          socket.write(buildFrame(JSON.stringify(response), 0x1))
        }
      }
    })

    socket.on('error', (error) => {
      messages.push({
        type: 'socket.error',
        error: error instanceof Error ? error.message : String(error)
      })
    })

    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(bridgePort, bridgeHost, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return { server, messages, sockets }
}

async function runIde() {
  const gradle = resolveGradleCommand()
  if (!gradle) {
    return { status: 'failed', failures: ['missing Gradle command for JetBrains runIde'] }
  }
  const env = {
    ...process.env,
    ...gradle.env,
    CAOGEN_JETBRAINS_RECORDER_ENABLED: '1',
    CAOGEN_JETBRAINS_RECORDER_PATH: recorderPath,
    CAOGEN_JETBRAINS_RECORDER_MARKER_PATH: markerPath,
    CAOGEN_JETBRAINS_RECORDER_E2E: '1',
    CAOGEN_JETBRAINS_RECORDER_E2E_EXIT: '1',
    CAOGEN_JETBRAINS_WORKSPACE: workspace
  }
  if (recorderMode === 'ide-script') writeIdeScript()
  const invocation = runIdeInvocation(gradle)
  const child = spawn(invocation.command, invocation.args, {
    cwd: pluginDir,
    env,
    shell: invocation.shell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const output = []
  const started = Date.now()
  let exited = false
  let exitCode = null
  let exitSignal = null

  child.stdout?.on('data', (chunk) => appendOutput(output, chunk))
  child.stderr?.on('data', (chunk) => appendOutput(output, chunk))

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exited = true
      exitCode = code
      exitSignal = signal
      resolve({ type: 'exit' })
    })
    child.on('error', (error) => {
      exited = true
      exitCode = 1
      appendOutput(output, Buffer.from(error.message))
      resolve({ type: 'error' })
    })
  })
  const completionPromise = waitForRecorderStep('autorun.completed', timeoutMs)
  const timeoutPromise = sleep(timeoutMs).then(() => ({ type: 'timeout' }))
  const first = await Promise.race([exitPromise, completionPromise, timeoutPromise])

  if (first.type === 'completed' && !exited) {
    await Promise.race([exitPromise, sleep(20_000).then(() => ({ type: 'grace-timeout' }))])
  }
  if (!exited) killProcessTree(child.pid)
  if (!exited) await Promise.race([exitPromise, sleep(5_000)])

  const recorderEvents = readRecorderEvents()
  const markerEvents = readJsonLines(markerPath)
  const failures = []
  if (!existsSync(recorderPath)) failures.push(`recorder JSONL was not created: ${recorderPath}`)
  if (!recorderEvents.some((event) => event.step === 'autorun.completed')) failures.push('recorder JSONL missing autorun.completed')
  if (exitCode !== 0 && !recorderEvents.some((event) => event.step === 'autorun.completed')) {
    failures.push(`Gradle runIde exited with code ${exitCode}${exitSignal ? ` signal ${exitSignal}` : ''}`)
  }

  return {
    status: failures.length > 0 ? 'failed' : 'completed',
    command: invocation.display,
    mode: recorderMode,
    workspaceArg: recorderMode === 'project-startup' ? workspace : undefined,
    ideScript: recorderMode === 'ide-script' ? ideScriptPath : undefined,
    javaHome: gradle.javaHome,
    gradleHome: gradle.gradleHome,
    durationMs: Date.now() - started,
    exitCode,
    exitSignal,
    firstEvent: first.type,
    recorderEventCount: recorderEvents.length,
    markerEventCount: markerEvents.length,
    markerEvents,
    ideLogDiagnostics: collectIdeLogDiagnostics(),
    outputTail: output.slice(-80),
    failures
  }
}

function writeIdeScript() {
  mkdirSync(path.dirname(ideScriptPath), { recursive: true })
  writeFileSync(
    ideScriptPath,
    [
      'import com.caogen.idebridge.BridgeInteractionRecorder',
      'import com.caogen.idebridge.RecorderE2ERunner',
      'import com.intellij.openapi.application.ApplicationManager',
      '',
      'def cwd = System.getenv("CAOGEN_JETBRAINS_WORKSPACE") ?: System.getProperty("user.dir")',
      'BridgeInteractionRecorder.INSTANCE.recordActionStep("ideScript.triggered", ["cwd": cwd])',
      'try {',
      '  RecorderE2ERunner.INSTANCE.run(null, "JetBrains IdeScript", cwd)',
      '} finally {',
      '  ApplicationManager.getApplication().exit(false, true, false)',
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
}

function runIdeInvocation(gradle) {
  const workspaceArg = toPosixPath(workspace)
  const ideScriptArg = toPosixPath(ideScriptPath)
  if (recorderMode === 'project-startup') {
    if (process.platform === 'win32') {
      return {
        command: gradle.command,
        args: ['--no-daemon', 'runIde', `--args="${workspaceArg}"`],
        display: [gradle.command, '--no-daemon', 'runIde', `--args="${workspaceArg}"`].join(' '),
        shell: true
      }
    }
    return {
      command: gradle.command,
      args: ['--no-daemon', 'runIde', `--args=${workspaceArg}`],
      display: [gradle.command, '--no-daemon', 'runIde', `--args="${workspaceArg}"`].join(' '),
      shell: false
    }
  }
  if (process.platform === 'win32') {
    return {
      command: gradle.command,
      args: ['--no-daemon', 'runIde', `--args="ideScript ${ideScriptArg}"`],
      display: [gradle.command, '--no-daemon', 'runIde', `--args="ideScript ${ideScriptArg}"`].join(' '),
      shell: true
    }
  }
  return {
    command: gradle.command,
    args: ['--no-daemon', 'runIde', `--args=ideScript ${ideScriptArg}`],
    display: [gradle.command, '--no-daemon', 'runIde', `--args="ideScript ${ideScriptArg}"`].join(' '),
    shell: false
  }
}

function runValidator(ideRun) {
  if (!existsSync(recorderPath)) {
    return {
      status: 'failed',
      reportRoot: undefined,
      failures: ['cannot validate missing recorder JSONL']
    }
  }
  const reportRootForValidator = path.join(reportDir, 'jetbrains-ide-interaction')
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'jetbrains-ide-interaction-smoke.mjs'), '--required'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_JETBRAINS_IDE_INTERACTION_REPORT_ROOT: reportRootForValidator,
      CAOGEN_JETBRAINS_IDE_RECORDER_JSONL: recorderPath,
      CAOGEN_JETBRAINS_WORKSPACE: workspace,
      ...(ideRun.ideLogDiagnostics?.path ? { CAOGEN_JETBRAINS_RUNIDE_LOG_PATH: ideRun.ideLogDiagnostics.path } : {}),
      ...(ideRun.command ? { CAOGEN_JETBRAINS_RUNIDE_COMMAND: ideRun.command } : {}),
      ...(ideRun.workspaceArg ? { CAOGEN_JETBRAINS_RUNIDE_WORKSPACE: ideRun.workspaceArg } : {})
    },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true
  })
  const latestPath = path.join(reportRootForValidator, 'latest.json')
  const parsedReport = existsSync(latestPath) ? readJson(latestPath) : undefined
  const failures = []
  if (result.status !== 0) failures.push(`jetbrains-ide-interaction-smoke exited with ${result.status}`)
  if (parsedReport?.status !== 'passed') failures.push(...(Array.isArray(parsedReport?.failures) ? parsedReport.failures : ['JetBrains interaction validator did not pass']))
  return {
    status: failures.length > 0 ? 'failed' : 'passed',
    reportRoot: reportRootForValidator,
    reportPath: latestPath,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
    failures
  }
}

function responsesFor(message) {
  if (message.type === 'hello') {
    return [{ id: message.id ?? 'jb-hello', type: 'hello.result', payload: { ok: true } }]
  }
  if (message.type === 'sessions.list') {
    return [{ id: message.id ?? 'jb-list', type: 'sessions.list.result', payload: { sessions: [] } }]
  }
  if (message.type === 'sessions.create') {
    return [{
      id: message.id ?? 'jb-create',
      type: 'sessions.create.result',
      payload: { id: 'jetbrains-recorder-e2e-session' }
    }]
  }
  if (message.type === 'sessions.send') {
    return [{
      id: `event-${Date.now()}`,
      type: 'session.event',
      payload: {
        sessionId: message.payload?.sessionId ?? 'jetbrains-recorder-e2e-session',
        role: 'assistant',
        text: 'fun caogenSelection() = "after"'
      }
    }]
  }
  if (message.type === 'documents.sync') {
    return [{ id: message.id ?? 'jb-doc-sync', type: 'documents.sync.result', payload: { ok: true } }]
  }
  return []
}

function parseHeaders(headerText) {
  const headers = {}
  for (const line of headerText.split('\r\n').slice(1)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return headers
}

function buildHandshakeResponse(key) {
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64')
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n')
}

function readFrame(buffer) {
  if (buffer.length < 2) return undefined
  const first = buffer[0]
  const second = buffer[1]
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < offset + 2) return undefined
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined
    const high = buffer.readUInt32BE(offset)
    const low = buffer.readUInt32BE(offset + 4)
    if (high !== 0) throw new Error('WebSocket frame too large')
    length = low
    offset += 8
  }
  const maskOffset = offset
  if (masked) offset += 4
  if (buffer.length < offset + length) return undefined
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4)
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4]
    }
  }
  return {
    opcode,
    text: payload.toString('utf8'),
    rest: buffer.subarray(offset + length)
  }
}

function buildFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x80 | opcode
  header[1] = 127
  header.writeUInt32BE(0, 2)
  header.writeUInt32BE(payload.length, 6)
  return Buffer.concat([header, payload])
}

function parseMessage(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { type: 'invalid-json', raw: text }
  }
}

function waitForRecorderStep(step, deadlineMs) {
  const started = Date.now()
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (readRecorderEvents().some((event) => event.step === step)) {
        clearInterval(timer)
        resolve({ type: 'completed' })
      } else if (Date.now() - started >= deadlineMs) {
        clearInterval(timer)
        resolve({ type: 'recorder-timeout' })
      }
    }, 500)
  })
}

function readRecorderEvents() {
  return readJsonLines(recorderPath)
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return []
  const events = []
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') events.push(parsed)
    } catch {
    }
  }
  return events
}

function collectIdeLogDiagnostics() {
  const logPath = findLatestIdeaLog()
  if (!logPath) return { status: 'missing', path: undefined, keywordLines: [] }
  const text = readFileSync(logPath, 'utf8')
  const keywords = [
    'CaoGen Bridge',
    'args:',
    'caogenRecorderE2E',
    'ideScript',
    'applicationInitialized',
    'startupActivity',
    'appStarter',
    'autorun',
    'recorder',
    'Project'
  ]
  const keywordLines = text
    .split(/\r?\n/)
    .filter((line) => keywords.some((keyword) => line.includes(keyword)))
    .slice(-120)
  return {
    status: 'present',
    path: logPath,
    keywordLines
  }
}

function findLatestIdeaLog() {
  const sandboxRoot = path.join(pluginDir, 'build', 'idea-sandbox')
  if (!existsSync(sandboxRoot)) return undefined
  const candidates = []
  for (const entry of readdirSync(sandboxRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(sandboxRoot, entry.name, 'log', 'idea.log')
    if (!existsSync(candidate)) continue
    candidates.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.path
}

function resolveGradleCommand() {
  const env = jetbrainsBuildEnv()
  const gradlewBat = path.join(pluginDir, 'gradlew.bat')
  if (process.platform === 'win32' && existsSync(gradlewBat)) {
    return { command: gradlewBat, env, javaHome: env.JAVA_HOME, gradleHome: undefined }
  }
  const gradlew = path.join(pluginDir, 'gradlew')
  if (existsSync(gradlew)) return { command: gradlew, env, javaHome: env.JAVA_HOME, gradleHome: undefined }
  const gradleHome = resolveGradleHome()
  const gradleCommand = gradleHome ? path.join(gradleHome, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle') : undefined
  if (gradleCommand && existsSync(gradleCommand)) {
    return { command: gradleCommand, env, javaHome: env.JAVA_HOME, gradleHome }
  }
  if (hasCommand('gradle', env)) {
    return { command: 'gradle', env, javaHome: env.JAVA_HOME, gradleHome: undefined }
  }
  return undefined
}

function hasCommand(command, env = process.env) {
  const probe = process.platform === 'win32'
    ? spawnSync('where.exe', [command], { stdio: 'ignore', env })
    : spawnSync('which', [command], { stdio: 'ignore', env })
  return probe.status === 0
}

function jetbrainsBuildEnv() {
  const javaHome = resolveJavaHome()
  const gradleHome = resolveGradleHome()
  const pathParts = []
  if (javaHome) pathParts.push(path.join(javaHome, 'bin'))
  if (gradleHome) pathParts.push(path.join(gradleHome, 'bin'))
  pathParts.push(process.env.PATH ?? '')
  return {
    ...process.env,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
    PATH: pathParts.filter(Boolean).join(path.delimiter)
  }
}

function resolveJavaHome() {
  const explicit = process.env.CAOGEN_JAVA_HOME || process.env.JAVA_HOME
  if (explicit && existsSync(explicit)) return explicit
  const marker = path.join(portableToolchainRoot(), 'jdk-home.txt')
  if (existsSync(marker)) {
    const value = readFileSync(marker, 'utf8').trim()
    if (value && existsSync(value)) return value
  }
  return undefined
}

function resolveGradleHome() {
  const explicit = process.env.CAOGEN_GRADLE_HOME || process.env.GRADLE_HOME
  if (explicit && existsSync(explicit)) return explicit
  const home = path.join(portableToolchainRoot(), 'gradle-8.10.2')
  return existsSync(home) ? home : undefined
}

function portableToolchainRoot() {
  return path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), 'caogen-p2-toolchain')
}

function killProcessTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
    }
  }
}

function appendOutput(output, chunk) {
  const lines = chunk.toString('utf8').split(/\r?\n/)
  for (const line of lines) {
    if (!line) continue
    output.push(line)
    if (output.length > 200) output.shift()
  }
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function closeBridge(bridge) {
  for (const socket of bridge.sockets) socket.destroy()
  await Promise.race([closeServer(bridge.server), sleep(5_000)])
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function trimOutput(value) {
  const text = value ?? ''
  return text.length > 4000 ? text.slice(-4000) : text
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  return path.isAbsolute(text) ? text : path.join(repoRoot, text)
}

function normalizeMode(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return text === 'ide-script' ? 'ide-script' : 'project-startup'
}

function prototypeLimitations() {
  const common = [
    'runs inside a real JetBrains IDE process and plugin sandbox',
    'does not prove full user-visible menu/diff UI interaction'
  ]
  if (recorderMode === 'ide-script') {
    return [
      ...common,
      'uses the built-in ideScript starter and an IDE document write action when no project is opened'
    ]
  }
  return [
    ...common,
    'uses a temporary runIde sandbox and a gated lifecycle autorun hook; this is not a full manual user workflow'
  ]
}

function toPosixPath(value) {
  return value.split(path.sep).join('/')
}

function writeReport(value) {
  mkdirSync(reportDir, { recursive: true })
  const json = `${JSON.stringify(value, null, 2)}\n`
  writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
  writeFileSync(path.join(reportRoot, 'latest.json'), json, 'utf8')
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
