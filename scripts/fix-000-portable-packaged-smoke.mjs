#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const artifactPath = path.resolve(argValue('--artifact') || path.join(scriptRoot, 'CaoGen-0.1.8-windows-x64-unsigned-preview.exe'))
const descriptorPath = path.resolve(argValue('--descriptor') || path.join(scriptRoot, 'FIX-000-D0.json'))
const evidenceArg = argValue('--evidence-dir')
const evidenceDir = evidenceArg ? path.resolve(evidenceArg) : null
const plannedInstallArg = argValue('--planned-install-dir')
const plannedInstallDir = plannedInstallArg ? path.resolve(plannedInstallArg) : null
const ownerAuthorized = process.argv.includes('--owner-authorized')
const preflightOnly = process.argv.includes('--preflight-only')
const assistedInstallOnly = process.argv.includes('--assisted-install-only')
const startedAt = new Date()
const runId = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const checks = []
const state = {
  installerInvoked: false,
  installation: {
    status: 'not_run',
    appExecutablePresent: false,
    uninstallerPresent: false,
    appAuthenticodeStatus: null,
    plannedInstallDirBound: false,
    registryCount: 0,
    registryUninstallerMatches: false,
    registryQuietUninstallerMatches: false
  },
  renderer: {
    status: 'not_run',
    title: null,
    readyState: null,
    rootChildCount: 0,
    bodyTextLength: 0,
    preloadReady: false,
    documentLanguage: null,
    timeToInteractiveMs: null
  },
  uninstall: {
    status: 'not_run',
    installRootAbsent: false,
    registryAbsent: false,
    userDataPreserved: false
  },
  cleanup: { status: 'not_run' }
}

let descriptor
let artifact
let host
let testRoot
let installRoot
let userDataDir
let child
let screenshot
let failure = null

try {
  if (preflightOnly && assistedInstallOnly) throw new Error('execution mode is ambiguous')
  check('private evidence directory was provided', Boolean(evidenceDir))
  if (evidenceDir) {
    check('private evidence directory is outside the portable kit', !isPathWithin(evidenceDir, scriptRoot))
    mkdirSync(evidenceDir, { recursive: true })
  }
  if (preflightOnly || assistedInstallOnly) {
    check('planned install directory was provided', Boolean(plannedInstallDir))
    if (plannedInstallDir) {
      check('planned install directory is a specific non-system path', isSpecificInstallTarget(plannedInstallDir))
      check('planned install directory does not exist', !existsSync(plannedInstallDir))
      check('private evidence directory and planned install directory do not overlap', Boolean(evidenceDir) &&
        !isPathWithin(evidenceDir, plannedInstallDir) && !isPathWithin(plannedInstallDir, evidenceDir))
    }
  }

  descriptor = readDescriptor(descriptorPath)
  check('D0 descriptor is valid', descriptor !== null)
  check('host platform is Windows', process.platform === 'win32', { actual: process.platform })
  check('host architecture is x64', process.arch === 'x64', { actual: process.arch })

  if (descriptor && existsSync(artifactPath) && lstatSync(artifactPath).isFile()) {
    artifact = {
      size: statSync(artifactPath).size,
      sha256: await sha256File(artifactPath)
    }
    check('D0 installer file name matches', path.basename(artifactPath) === descriptor.fileName)
    check('D0 installer size matches', artifact.size === descriptor.size, { expected: descriptor.size, actual: artifact.size })
    check('D0 installer SHA-256 matches', artifact.sha256 === descriptor.sha256, { expected: descriptor.sha256, actual: artifact.sha256 })
    const installerSignature = inspectAuthenticode(artifactPath)
    state.installation.installerAuthenticodeStatus = installerSignature.status
    check('D0 installer is intentionally unsigned', installerSignature.status === 'NotSigned' && installerSignature.hasCertificate === false, installerSignature)
  } else {
    check('D0 installer exists as a regular file', false)
  }

  if (process.platform === 'win32') {
    host = inspectWindowsHost()
    check('interactive desktop is available in this session', host.userInteractive && host.sameSessionExplorerCount > 0, {
      userInteractive: host.userInteractive,
      sameSessionExplorerCount: host.sameSessionExplorerCount
    })
    check('no CaoGen process is running', host.caogenProcessCount === 0, { count: host.caogenProcessCount })
    check('no CaoGen uninstall registration exists', host.existingInstallations.length === 0, {
      count: host.existingInstallations.length,
      installations: host.existingInstallations
    })
  }

  const preflightFailures = checks.filter((item) => item.status === 'failed')
  if (preflightFailures.length > 0) throw new Error('clean-host preflight failed')
  if (preflightOnly) {
    state.installation.status = 'not_run_preflight_only'
  } else if (assistedInstallOnly) {
    check('Owner explicitly authorized the assisted install', ownerAuthorized)
    if (!ownerAuthorized) throw new Error('Owner authorization is required')
    await runAssistedInstall()
  } else {
    check('Owner explicitly authorized the disposable installed smoke', ownerAuthorized)
    if (!ownerAuthorized) throw new Error('Owner authorization is required')
    await runInstalledSmoke()
  }
} catch (error) {
  failure = sanitizedError(error)
} finally {
  try {
    await stopChild(child)
  } catch (error) {
    if (!failure) failure = sanitizedError(error)
  }
}

if (!failure && !preflightOnly && !assistedInstallOnly) {
  try {
    await uninstallInstalledCandidate()
    await cleanupSuccessfulRun()
  } catch (error) {
    failure = sanitizedError(error)
  }
}

const finishedAt = new Date()
const evidenceClass = preflightOnly
  ? 'fix_000_portable_smoke_preflight'
  : assistedInstallOnly
    ? 'fix_000_assisted_install'
    : 'fix_000_portable_installed_smoke'
const diagnosticRoot = assistedInstallOnly ? plannedInstallDir : testRoot
const report = {
  schemaVersion: 1,
  evidenceClass,
  status: failure ? 'failed' : 'passed',
  required: !preflightOnly && !assistedInstallOnly,
  ownerAuthorized,
  preflightOnly,
  assistedInstallOnly,
  runId,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  artifact: {
    size: artifact?.size || null,
    sha256: artifact?.sha256 || null,
    artifactSetSha256: descriptor?.artifactSetSha256 || null
  },
  environment: host
    ? {
        platform: process.platform === 'win32' && process.arch === 'x64' ? 'windows-x64' : 'unsupported',
        interactiveDesktop: host.userInteractive && host.sameSessionExplorerCount > 0,
        existingInstallCountBefore: host.existingInstallations.length,
        caogenProcessCountBefore: host.caogenProcessCount
      }
    : { platform: process.platform },
  checks,
  installerInvoked: state.installerInvoked,
  installation: state.installation,
  renderer: state.renderer,
  uninstall: state.uninstall,
  cleanup: state.cleanup,
  installationPreserved: assistedInstallOnly && state.installation.status === 'passed',
  evidence: screenshot
    ? {
        rendererScreenshot: screenshot.fileName,
        rendererScreenshotSize: screenshot.size,
        rendererScreenshotSha256: screenshot.sha256
      }
    : null,
  diagnosticStatePreserved: Boolean(failure && state.installerInvoked && diagnosticRoot && existsSync(diagnosticRoot)),
  diagnostic: failure && state.installerInvoked && diagnosticRoot && existsSync(diagnosticRoot)
    ? { privateDiagnosticRoot: diagnosticRoot }
    : null,
  failure,
  privacy: 'No Provider, credential, project, Office, or user identity value is read or emitted. A failed private report may retain its disposable diagnostic root for Owner-led inspection.'
}

if (evidenceDir) {
  try {
    const reportName = preflightOnly
      ? 'fix-000-portable-smoke-preflight.json'
      : assistedInstallOnly
        ? 'fix-000-assisted-install-result.json'
        : 'fix-000-portable-smoke-result.json'
    const reportPath = path.join(evidenceDir, reportName)
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch {
    report.status = 'failed'
    report.failure ||= 'private smoke report could not be written'
  }
}
console.log(JSON.stringify(publicConsoleSummary(report), null, 2))
if (report.status !== 'passed') process.exitCode = 1

async function runAssistedInstall() {
  installRoot = plannedInstallDir
  state.installerInvoked = true
  state.installation.status = 'running'
  const installResult = spawnSync(artifactPath, [`/D=${installRoot}`], {
    cwd: scriptRoot,
    stdio: 'inherit',
    windowsHide: false,
    timeout: 20 * 60_000
  })
  if (installResult.status !== 0) throw new Error(`NSIS installer failed: ${processFailure(installResult)}`)

  const binding = await waitForAssistedInstallBinding(installRoot, 30_000)
  state.installation.appExecutablePresent = binding.appExecutablePresent
  state.installation.uninstallerPresent = binding.uninstallerPresent
  state.installation.registryCount = binding.registryCount
  state.installation.registryUninstallerMatches = binding.registryUninstallerMatches
  state.installation.registryQuietUninstallerMatches = binding.registryQuietUninstallerMatches
  state.installation.plannedInstallDirBound = binding.plannedInstallDirBound
  check('assisted installer wrote application files to the planned directory',
    binding.appExecutablePresent && binding.uninstallerPresent)
  check('assisted installer registration is bound to the planned directory', binding.plannedInstallDirBound, {
    registrationCount: binding.registryCount,
    uninstallMatches: binding.registryUninstallerMatches,
    quietUninstallMatches: binding.registryQuietUninstallerMatches
  })
  if (!binding.plannedInstallDirBound) throw new Error('assisted installer target binding failed')

  const appSignature = inspectAuthenticode(path.join(installRoot, 'CaoGen.exe'))
  state.installation.appAuthenticodeStatus = appSignature.status
  if (appSignature.status !== 'NotSigned' || appSignature.hasCertificate !== false) {
    throw new Error('installed application has an unexpected Authenticode state')
  }
  state.installation.status = 'passed'
  state.cleanup.status = 'not_run_install_preserved'
}

async function runInstalledSmoke() {
  testRoot = mkdtempSync(path.join(tmpdir(), 'caogen-fix-000-portable-smoke-'))
  installRoot = path.join(testRoot, 'install')
  userDataDir = path.join(testRoot, 'user-data')

  state.installerInvoked = true
  state.installation.status = 'running'
  const installResult = spawnSync(artifactPath, ['/S', `/D=${installRoot}`], {
    cwd: scriptRoot,
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: false,
    timeout: 120_000
  })
  if (installResult.status !== 0) throw new Error(`NSIS installer failed: ${processFailure(installResult)}`)

  const appExecutable = path.join(installRoot, 'CaoGen.exe')
  const uninstaller = path.join(installRoot, 'Uninstall CaoGen.exe')
  state.installation.appExecutablePresent = existsSync(appExecutable)
  state.installation.uninstallerPresent = existsSync(uninstaller)
  if (!state.installation.appExecutablePresent) throw new Error('installed application executable is missing')
  if (!state.installation.uninstallerPresent) throw new Error('installed application uninstaller is missing')
  state.installation.plannedInstallDirBound = true
  const appSignature = inspectAuthenticode(appExecutable)
  state.installation.appAuthenticodeStatus = appSignature.status
  if (appSignature.status !== 'NotSigned' || appSignature.hasCertificate !== false) {
    throw new Error('installed application has an unexpected Authenticode state')
  }
  state.installation.status = 'passed'

  const port = await availablePort()
  const launchedAt = Date.now()
  let stderr = ''
  child = spawn(appExecutable, [`--remote-debugging-port=${port}`, '--enable-logging=stderr'], {
    cwd: scriptRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false
  })
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024)
  })

  state.renderer.status = 'running'
  const observed = await waitForRenderer(child, port, 30_000)
  Object.assign(state.renderer, observed.observation, {
    status: 'passed',
    timeToInteractiveMs: Date.now() - launchedAt
  })
  if (/Uncaught Exception|Cannot find module|NODE_MODULE_VERSION/i.test(stderr)) {
    throw new Error('packaged app emitted a main-process module loading error')
  }

  const screenshotPath = path.join(evidenceDir, 'fix-000-packaged-smoke-renderer.png')
  writeFileSync(screenshotPath, Buffer.from(observed.screenshotBase64, 'base64'))
  screenshot = {
    fileName: path.basename(screenshotPath),
    size: statSync(screenshotPath).size,
    sha256: await sha256File(screenshotPath)
  }
  await stopChild(child)
  child = undefined
}

async function uninstallInstalledCandidate() {
  const uninstaller = path.join(installRoot, 'Uninstall CaoGen.exe')
  state.uninstall.status = 'running'
  const result = spawnSync(uninstaller, ['/S'], {
    cwd: installRoot,
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: false,
    timeout: 120_000
  })
  if (result.status !== 0) throw new Error(`NSIS uninstaller failed: ${processFailure(result)}`)
  await waitForPathAbsent(installRoot, 45_000)
  state.uninstall.installRootAbsent = true
  const after = inspectWindowsHost()
  state.uninstall.registryAbsent = after.existingInstallations.length === 0
  if (!state.uninstall.registryAbsent) throw new Error('silent uninstall left a CaoGen uninstall registration')
  state.uninstall.userDataPreserved = existsSync(userDataDir)
  if (!state.uninstall.userDataPreserved) throw new Error('silent uninstall unexpectedly deleted the isolated user-data directory')
  state.uninstall.status = 'passed'
}

async function cleanupSuccessfulRun() {
  if (!testRoot || !isSafeTestRoot(testRoot)) throw new Error('temporary smoke root failed its cleanup safety check')
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (existsSync(testRoot)) throw new Error('temporary smoke root remains after successful cleanup')
  state.cleanup.status = 'passed'
}

async function waitForRenderer(processHandle, port, timeoutMs) {
  let exited = null
  let lastObservation = null
  processHandle.once('exit', (code, signal) => { exited = { code, signal } })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) throw new Error(`packaged app exited before creating a renderer: ${JSON.stringify(exited)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) })
      if (!response.ok) throw new Error('DevTools target list was unavailable')
      const targets = await response.json()
      const target = Array.isArray(targets)
        ? targets.find((item) => item?.type === 'page' && /out\/renderer\/index\.html$/.test(String(item.url || '')))
        : null
      if (target?.webSocketDebuggerUrl) {
        const session = await openCdp(target.webSocketDebuggerUrl)
        try {
          const evaluated = await session.command('Runtime.evaluate', {
            expression: `(() => ({
              title: document.title,
              readyState: document.readyState,
              rootChildCount: document.querySelector('#root')?.children.length ?? 0,
              bodyTextLength: document.body?.innerText.trim().length ?? 0,
              preloadReady: typeof window.agentDesk === 'object',
              documentLanguage: document.documentElement.lang || null
            }))()`,
            returnByValue: true
          })
          lastObservation = evaluated?.result?.result?.value || null
          if (
            lastObservation?.title === 'CaoGen' &&
            lastObservation.rootChildCount > 0 &&
            lastObservation.bodyTextLength > 0 &&
            lastObservation.preloadReady === true
          ) {
            const captured = await session.command('Page.captureScreenshot', { format: 'png', fromSurface: true })
            if (!captured?.result?.data) throw new Error('renderer screenshot was empty')
            return { observation: lastObservation, screenshotBase64: captured.result.data }
          }
        } finally {
          session.close()
        }
      }
    } catch {
      // The renderer and its DevTools endpoint can appear at different times.
    }
    await delay(250)
  }
  throw new Error(`packaged app did not create an interactive CaoGen renderer; last observation=${JSON.stringify(lastObservation)}`)
}

function openCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1
    const openTimer = setTimeout(() => reject(new Error('CDP connection timed out')), 3_000)
    socket.addEventListener('open', () => {
      clearTimeout(openTimer)
      resolve({
        command(method, params = {}) {
          return new Promise((commandResolve, commandReject) => {
            const id = nextId++
            const timer = setTimeout(() => {
              pending.delete(id)
              commandReject(new Error(`CDP command timed out: ${method}`))
            }, 5_000)
            pending.set(id, { resolve: commandResolve, reject: commandReject, timer })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close() { socket.close() }
      })
    }, { once: true })
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
        if (!message.id || !pending.has(message.id)) return
        const entry = pending.get(message.id)
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if (message.error) entry.reject(new Error(message.error.message || 'CDP command failed'))
        else entry.resolve(message)
      } catch {
        // Ignore unrelated or malformed DevTools events.
      }
    })
    socket.addEventListener('error', () => {
      clearTimeout(openTimer)
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('CDP connection failed'))
      }
      pending.clear()
      reject(new Error('CDP connection failed'))
    }, { once: true })
  })
}

function inspectWindowsHost() {
  const script = `
$ErrorActionPreference = 'Stop'
$CurrentSessionId = (Get-Process -Id $PID).SessionId
$Locations = @(
  @{ Scope = 'current-user'; Path = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Scope = 'all-users'; Path = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Scope = 'all-users-wow64'; Path = 'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }
)
$Rows = foreach ($Location in $Locations) {
  Get-ItemProperty -Path $Location.Path -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.DisplayName -like 'CaoGen*' } |
    ForEach-Object {
      @{ Scope = $Location.Scope; DisplayName = [string]$_.DisplayName; DisplayVersion = [string]$_.DisplayVersion }
    }
}

@{
  UserInteractive = [Environment]::UserInteractive
  SameSessionExplorerCount = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $CurrentSessionId }).Count
  CaoGenProcessCount = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { [string]$_.ProcessName -like 'CaoGen*' }).Count
  ExistingInstallations = @($Rows)
} | ConvertTo-Json -Compress -Depth 5
`
  const result = runPowerShell(script)
  if (result.status !== 0) throw new Error('Windows clean-host inspection failed')
  const value = JSON.parse(String(result.stdout || '').trim())
  return {
    userInteractive: value.UserInteractive === true,
    sameSessionExplorerCount: Number(value.SameSessionExplorerCount || 0),
    caogenProcessCount: Number(value.CaoGenProcessCount || 0),
    existingInstallations: Array.isArray(value.ExistingInstallations)
      ? value.ExistingInstallations.map((item) => ({
          scope: String(item.Scope || ''),
          displayName: String(item.DisplayName || ''),
          displayVersion: String(item.DisplayVersion || '')
        }))
      : []
  }
}

async function waitForAssistedInstallBinding(expectedRoot, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = inspectInstalledBinding(expectedRoot)
    if (last.plannedInstallDirBound) return last
    await delay(250)
  }
  return last ?? inspectInstalledBinding(expectedRoot)
}

function inspectInstalledBinding(expectedRoot) {
  const script = `
$ErrorActionPreference = 'Stop'
$ExpectedRoot = [IO.Path]::GetFullPath(${powerShellLiteral(expectedRoot)}).TrimEnd('\\')
$ExpectedUninstaller = [IO.Path]::GetFullPath((Join-Path $ExpectedRoot 'Uninstall CaoGen.exe'))
function Get-CommandExecutable([string]$Command) {
  if ([string]::IsNullOrWhiteSpace($Command)) { return '' }
  if ($Command -match '^\\s*"([^"]+)"') { return $Matches[1] }
  if ($Command -match '^\\s*([^\\s]+\\.exe)') { return $Matches[1] }
  return ''
}
function Same-Path([string]$Left, [string]$Right) {
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
  try { return [IO.Path]::GetFullPath($Left).TrimEnd('\\') -ieq [IO.Path]::GetFullPath($Right).TrimEnd('\\') } catch { return $false }
}
$Locations = @(
  'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$Rows = @($Locations | ForEach-Object {
  Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.DisplayName -like 'CaoGen*' }
})
$UninstallMatches = @($Rows | Where-Object { Same-Path (Get-CommandExecutable ([string]$_.UninstallString)) $ExpectedUninstaller }).Count -eq 1
$QuietMatches = @($Rows | Where-Object { Same-Path (Get-CommandExecutable ([string]$_.QuietUninstallString)) $ExpectedUninstaller }).Count -eq 1
$AppPresent = Test-Path -LiteralPath (Join-Path $ExpectedRoot 'CaoGen.exe') -PathType Leaf
$UninstallerPresent = Test-Path -LiteralPath $ExpectedUninstaller -PathType Leaf
@{
  AppExecutablePresent = $AppPresent
  UninstallerPresent = $UninstallerPresent
  RegistryCount = $Rows.Count
  RegistryUninstallerMatches = $UninstallMatches
  RegistryQuietUninstallerMatches = $QuietMatches
  PlannedInstallDirBound = $AppPresent -and $UninstallerPresent -and $Rows.Count -eq 1 -and $UninstallMatches -and $QuietMatches
} | ConvertTo-Json -Compress
`
  const result = runPowerShell(script)
  if (result.status !== 0) throw new Error('Windows install-target binding inspection failed')
  const value = JSON.parse(String(result.stdout || '').trim())
  return {
    appExecutablePresent: value.AppExecutablePresent === true,
    uninstallerPresent: value.UninstallerPresent === true,
    registryCount: Number(value.RegistryCount || 0),
    registryUninstallerMatches: value.RegistryUninstallerMatches === true,
    registryQuietUninstallerMatches: value.RegistryQuietUninstallerMatches === true,
    plannedInstallDirBound: value.PlannedInstallDirBound === true
  }
}

function inspectAuthenticode(filePath) {
  const script = `
$ErrorActionPreference = 'Stop'
$Signature = Get-AuthenticodeSignature -LiteralPath ${powerShellLiteral(filePath)}
@{ Status = [string]$Signature.Status; HasCertificate = $null -ne $Signature.SignerCertificate } | ConvertTo-Json -Compress
`
  const result = runPowerShell(script)
  if (result.status !== 0) throw new Error('Authenticode inspection failed')
  const value = JSON.parse(String(result.stdout || '').trim())
  return { status: String(value.Status || 'Unknown'), hasCertificate: value.HasCertificate === true }
}

function runPowerShell(script) {
  return spawnSync(powerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], {
    cwd: scriptRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
}

function readDescriptor(filePath) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'))
    if (
      value?.schemaVersion !== 1 ||
      value?.gateId !== 'fix_000_d0' ||
      value?.platform !== 'windows-x64' ||
      value?.distributionChannel !== 'unsigned_preview' ||
      !Number.isInteger(value?.size) ||
      !/^[a-f0-9]{64}$/.test(value?.sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(value?.artifactSetSha256 || '')
    ) return null
    return value
  } catch {
    return null
  }
}

async function availablePort() {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error('unable to reserve a local DevTools port')
  return port
}

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return
  if (process.platform === 'win32' && processHandle.pid) {
    spawnSync('taskkill', ['/pid', String(processHandle.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await Promise.race([
      new Promise((resolve) => processHandle.once('exit', resolve)),
      delay(5_000)
    ])
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      throw new Error('packaged app process did not stop before uninstall')
    }
    return
  }
  processHandle.kill('SIGTERM')
  await delay(1_000)
}

async function waitForPathAbsent(targetPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(targetPath)) return
    await delay(250)
  }
  throw new Error('NSIS uninstaller left the isolated installation directory')
}

function check(name, passed, detail) {
  checks.push({ name, status: passed ? 'passed' : 'failed', ...(detail !== undefined ? { detail } : {}) })
}

function isPathWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isSafeTestRoot(candidate) {
  const resolved = path.resolve(candidate)
  const relative = path.relative(path.resolve(tmpdir()), resolved)
  return relative.startsWith('caogen-fix-000-portable-smoke-') && !relative.includes(path.sep + '..') && !path.isAbsolute(relative)
}

function isSpecificInstallTarget(candidate) {
  const resolved = path.resolve(candidate)
  const unsafe = [
    path.parse(resolved).root,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.USERPROFILE,
    tmpdir()
  ].filter(Boolean).map((item) => path.resolve(item))
  return !unsafe.some((item) => resolved.toLowerCase() === item.toLowerCase()) &&
    !isPathWithin(resolved, process.env.SystemRoot || 'C:\\Windows') &&
    !isPathWithin(resolved, scriptRoot)
}

function processFailure(result) {
  if (result.status === 1223) return 'Windows security/elevation confirmation was cancelled or unavailable'
  if (result.error?.code === 'ETIMEDOUT') return 'process timed out'
  return result.status === null || result.status === undefined ? 'unknown process failure' : `exit ${result.status}`
}

function sanitizedError(error) {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of [artifactPath, evidenceDir, plannedInstallDir, testRoot, installRoot, userDataDir].filter(Boolean)) {
    message = message.replaceAll(String(value), '<private-path>')
  }
  return message.slice(0, 2_000)
}

function publicConsoleSummary(report) {
  return {
    status: report.status,
    evidenceClass: report.evidenceClass,
    artifact: report.artifact,
    environment: report.environment,
    installerInvoked: report.installerInvoked,
    installation: report.installation,
    renderer: report.renderer,
    uninstall: report.uninstall,
    cleanup: report.cleanup,
    diagnosticStatePreserved: report.diagnosticStatePreserved,
    failure: report.failure
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function powerShellExecutable() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
