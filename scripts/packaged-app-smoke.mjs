#!/usr/bin/env node
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { artifactSetEntryForPath } from './lib/release-matrix-evidence.mjs'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const { readPackagedReleaseProvenanceFromAsar, releaseProvenanceChecks } = require('./lib/release-provenance.cjs')
const puppeteer = require('puppeteer-core')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'packaged-app-smoke')
const reportDir = path.join(reportRoot, runId)
const requestedPlatform = argValue('--platform') || process.platform
const targetPlatform = requestedPlatform === 'macos' ? 'darwin' : requestedPlatform === 'windows' ? 'win32' : requestedPlatform
const targetArch = argValue('--arch') || process.arch
const unsignedBuild = process.argv.includes('--unsigned')
const previewMode = process.argv.includes('--preview')
const localUnsignedBuild = process.argv.includes('--local-unsigned')
const allowDirtyPreview = previewMode && process.argv.includes('--allow-dirty')
const interactiveInstaller = process.argv.includes('--interactive-installer')
const ciUnattendedInstaller = process.argv.includes('--ci-unattended-installer')
const distributionChannel = localUnsignedBuild
  ? 'local_unsigned_diagnostic'
  : previewMode || unsignedBuild
    ? 'unsigned_preview'
    : 'formal'
const sourceArtifact = argValue('--artifact')
  ? path.resolve(repoRoot, argValue('--artifact'))
  : releaseArtifactPath(targetPlatform, targetArch, packageJson.version, previewMode)
const releaseAudit = readReleaseAudit(targetPlatform, targetArch)
const userDataDir = mkdtempSync(path.join(tmpdir(), 'caogen-packaged-app-smoke-'))
const installRoot = mkdtempSync(path.join(tmpdir(), 'caogen-installed-app-smoke-'))
const git = readGitState()
let appRoot
let appExecutable
let buildProvenance = null
let signing = null
let mountedDmg
let child
let stderr = ''
let target
let failure
let cleanupFailure
const installation = {
  sourceArtifact: path.relative(repoRoot, sourceArtifact),
  method: targetPlatform === 'darwin' ? 'dmg-copy-to-isolated-directory' : 'nsis-silent-isolated-directory',
  interactiveInstaller,
  ciUnattendedInstaller,
  existingInstallations: [],
  status: 'failed',
  failure: null,
  uninstall: {
    status: targetPlatform === 'win32' ? 'not_run' : 'not_applicable',
    installRootRemoved: null,
    residualInstallations: [],
    failure: null
  }
}

try {
  if (targetPlatform !== 'darwin' && targetPlatform !== 'win32') {
    throw new Error(`unsupported packaged app platform: ${targetPlatform}`)
  }
  if (process.platform !== targetPlatform) {
    throw new Error(`packaged app smoke for ${targetPlatform} must run on ${targetPlatform}, got ${process.platform}`)
  }
  if (targetArch !== 'x64' && targetArch !== 'arm64') throw new Error(`unsupported packaged app architecture: ${targetArch}`)
  if ([unsignedBuild, previewMode, localUnsignedBuild].filter(Boolean).length > 1) {
    throw new Error('use only one of --unsigned, --preview, or --local-unsigned')
  }
  if (unsignedBuild && targetPlatform !== 'win32') throw new Error('unsigned packaged app smoke is Windows-only')
  if (previewMode && targetPlatform !== 'win32') throw new Error('preview packaged app smoke is Windows-only')
  if (localUnsignedBuild && targetPlatform !== 'darwin') {
    throw new Error('local unsigned packaged app smoke is macOS-only')
  }
  if (interactiveInstaller && ciUnattendedInstaller) {
    throw new Error('use either --interactive-installer or --ci-unattended-installer, not both')
  }
  if (ciUnattendedInstaller && process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('--ci-unattended-installer is restricted to GitHub Actions')
  }
  if (process.arch !== targetArch) {
    throw new Error(`native packaged app smoke for ${targetArch} must run on ${targetArch}, got ${process.arch}`)
  }
  if (!existsSync(sourceArtifact)) {
    throw new Error(`release installer is missing: ${path.relative(repoRoot, sourceArtifact)}`)
  }
  if (!unsignedBuild && !localUnsignedBuild) {
    assertReleaseAuditBinding(releaseAudit, sourceArtifact, allowDirtyPreview)
  }
  if (targetPlatform === 'win32') {
    installation.existingInstallations = inspectExistingWindowsInstallations()
    if (installation.existingInstallations.length > 0) {
      installation.status = 'blocked'
      throw new Error(
        'existing CaoGen installation detected; NSIS upgrade handling can invoke the old uninstaller even when /D ' +
        'points at an isolated directory; run packaged smoke on a clean disposable Windows environment'
      )
    }
  }
  if (
    targetPlatform === 'win32' &&
    (previewMode || unsignedBuild) &&
    !interactiveInstaller &&
    !ciUnattendedInstaller
  ) {
    installation.status = 'blocked'
    throw new Error(
      'unsigned Windows installer smoke requires an interactive desktop for SmartScreen/elevation confirmation; ' +
      'rerun with --interactive-installer under Owner supervision, or use the GitHub-Actions-only unattended path'
    )
  }
  if (unsignedBuild) {
    signing = { installer: inspectAuthenticode(sourceArtifact), app: null }
    if (signing.installer.status !== 'NotSigned') {
      throw new Error(`unsigned installer has unexpected Authenticode status: ${signing.installer.status}`)
    }
  }
  const installed = installCandidate()
  appRoot = installed.appRoot
  mountedDmg = installed.mountedDmg
  appExecutable = packagedExecutable(appRoot, targetPlatform)
  if (!existsSync(appExecutable)) throw new Error('installed application executable is missing')
  installation.status = 'passed'
  if (unsignedBuild) {
    signing.app = inspectAuthenticode(appExecutable)
    if (signing.app.status !== 'NotSigned') {
      throw new Error(`unsigned application has unexpected Authenticode status: ${signing.app.status}`)
    }
  } else if (!localUnsignedBuild) {
    const inspectedProvenance = readPackagedReleaseProvenanceFromAsar(packagedAsarPath(appRoot, targetPlatform))
    buildProvenance = inspectedProvenance.value
    if (inspectedProvenance.error) throw new Error(`packaged release provenance is unreadable: ${inspectedProvenance.error}`)
    const provenanceFailures = Object.entries(releaseProvenanceChecks(buildProvenance, {
      gitCommit: git.commit,
      packageVersion: packageJson.version
    })).filter(([name, passed]) => !(allowDirtyPreview && name === 'worktreeWasClean') && !passed)
    if (provenanceFailures.length > 0) {
      throw new Error(`packaged release provenance failed: ${provenanceFailures.map(([name]) => name).join(', ')}`)
    }
  }
  const port = await availablePort()
  child = spawn(appExecutable, [`--remote-debugging-port=${port}`, '--enable-logging=stderr'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_USER_DATA_DIR: userDataDir,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024)
  })

  target = await waitForRenderer(child, port, 30_000)
  if (/Uncaught Exception|Cannot find module|NODE_MODULE_VERSION/i.test(stderr)) {
    throw new Error('packaged app emitted a main-process module loading error')
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  if (installation.status !== 'passed') installation.failure = failure
} finally {
  await stopChild(child)
  const cleanupErrors = []
  try {
    await cleanupInstalledCandidate()
  } catch (error) {
    const cleanupError = error instanceof Error ? error.message : String(error)
    if (targetPlatform === 'win32') {
      installation.uninstall.status = 'failed'
      installation.uninstall.failure = cleanupError
    }
    cleanupErrors.push(cleanupError)
  }
  try {
    await removeDirectoryWhenQuiescent(installRoot, 15_000)
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    await removeDirectoryWhenQuiescent(userDataDir, 15_000)
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error))
  }
  cleanupFailure = cleanupErrors.length > 0 ? cleanupErrors.join(' | ') : undefined
}

if (!failure && cleanupFailure) failure = `temporary user-data cleanup failed: ${cleanupFailure}`

const report = {
  status: failure ? 'failed' : 'passed',
  evidenceClass: localUnsignedBuild ? 'development_diagnostic' : 'distribution_validation',
  closesFormalReleaseGate: distributionChannel === 'formal',
  mode: localUnsignedBuild
    ? 'local-unsigned'
    : unsignedBuild
      ? 'unsigned'
      : previewMode
        ? 'unsigned-preview'
        : 'signed-release',
  distributionChannel,
  runId,
  reportDir,
  packageVersion: packageJson.version,
  platform: targetPlatform,
  targetArch,
  allowDirtyPreview,
  appExecutable: appExecutable ? 'isolated-install/CaoGen' : null,
  git,
  artifactSetSha256: unsignedBuild || localUnsignedBuild ? null : releaseAudit.data?.artifactSetSha256 || null,
  releaseAudit: {
    path: releaseAudit.relativePath,
    status: unsignedBuild || localUnsignedBuild
      ? 'not-required'
      : releaseAudit.data?.status || (releaseAudit.error ? 'invalid_json' : 'missing')
  },
  buildProvenance,
  signing,
  installation,
  target,
  failure,
  cleanup: {
    status: cleanupFailure ? 'failed' : 'passed',
    failure: cleanupFailure
  }
}
mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
const latestReportName = localUnsignedBuild
  ? 'latest-local-unsigned.json'
  : previewMode
    ? 'latest-preview.json'
    : 'latest.json'
writeFileSync(path.join(reportRoot, latestReportName), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
const latestPlatformName = previewMode
  ? `latest-${platformLabel(targetPlatform)}-${targetArch}-preview.json`
  : localUnsignedBuild
    ? `latest-${platformLabel(targetPlatform)}-local-unsigned-${targetArch}.json`
  : unsignedBuild
    ? `latest-${platformLabel(targetPlatform)}-unsigned-${targetArch}.json`
    : `latest-${platformLabel(targetPlatform)}-${targetArch}.json`
writeFileSync(path.join(reportRoot, latestPlatformName), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (failure) process.exitCode = 1

async function waitForRenderer(processHandle, port, timeoutMs) {
  let exit
  let browser
  let lastObservation
  let lastError
  processHandle.once('exit', (code, signal) => {
    exit = { code, signal }
  })
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (exit) throw new Error(`packaged app exited before creating a renderer: ${JSON.stringify(exit)}`)
      try {
        browser ??= await puppeteer.connect({
          browserURL: `http://127.0.0.1:${port}`,
          defaultViewport: null
        })
        const page = (await browser.pages()).find((candidate) => /out\/renderer\/index\.html$/.test(candidate.url()))
        if (page) {
          lastObservation = await page.evaluate(() => ({
            documentTitle: document.title,
            readyState: document.readyState,
            rootChildCount: document.querySelector('#root')?.children.length ?? 0,
            bodyTextLength: document.body?.innerText.trim().length ?? 0,
            preloadReady: typeof window.agentDesk === 'object'
          }))
          if (
            lastObservation.documentTitle === 'CaoGen' &&
            lastObservation.rootChildCount > 0 &&
            lastObservation.bodyTextLength > 0 &&
            lastObservation.preloadReady
          ) {
            return {
              type: 'page',
              title: lastObservation.documentTitle,
              url: page.url(),
              readyState: lastObservation.readyState,
              rootChildCount: lastObservation.rootChildCount,
              bodyTextLength: lastObservation.bodyTextLength,
              preloadReady: lastObservation.preloadReady
            }
          }
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (browser) {
          await browser.disconnect().catch(() => undefined)
          browser = undefined
        }
      }
      await delay(250)
    }
  } finally {
    if (browser) await browser.disconnect().catch(() => undefined)
  }
  throw new Error(
    `packaged app did not create an interactive CaoGen renderer within ${timeoutMs}ms` +
    `; last observation=${JSON.stringify(lastObservation || null)}` +
    (lastError ? `; last error=${lastError}` : '')
  )
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error('unable to reserve a local debugging port')
  return port
}

async function stopChild(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return
  if (process.platform === 'win32' && processHandle.pid) {
    spawnSync('taskkill', ['/pid', String(processHandle.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    return
  }
  processHandle.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolve) => processHandle.once('exit', () => resolve(true))),
    delay(5_000).then(() => false)
  ])
  if (!exited) processHandle.kill('SIGKILL')
}

async function removeDirectoryWhenQuiescent(targetPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      rmSync(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (!existsSync(targetPath)) return
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  if (lastError) throw lastError
  throw new Error(`temporary directory still exists after ${timeoutMs}ms: ${targetPath}`)
}

function readGitState() {
  const commit = gitOutput(['rev-parse', 'HEAD'])
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

function releaseArtifactPath(platform, arch, version, preview) {
  if (platform === 'darwin') {
    const suffix = arch === 'arm64' ? '-arm64' : ''
    return path.join(repoRoot, 'dist', `CaoGen-${version}${suffix}.dmg`)
  }
  if (platform === 'win32') {
    const name = preview
      ? `CaoGen-${version}-windows-x64-unsigned-preview.exe`
      : `CaoGen Setup ${version}.exe`
    return path.join(repoRoot, 'dist', name)
  }
  return path.join(repoRoot, 'dist', 'unsupported')
}

function installCandidate() {
  if (targetPlatform === 'darwin') {
    const attachOutput = runChecked('hdiutil', ['attach', '-readonly', '-nobrowse', '-plist', sourceArtifact])
    const plist = require('plist').parse(attachOutput)
    mountedDmg = Array.isArray(plist?.['system-entities'])
      ? plist['system-entities'].map((item) => item?.['mount-point']).find((item) => typeof item === 'string')
      : undefined
    if (!mountedDmg) throw new Error('hdiutil did not report a mounted volume')
    const sourceApp = path.join(mountedDmg, 'CaoGen.app')
    if (!existsSync(sourceApp)) throw new Error('mounted DMG does not contain CaoGen.app')
    const installedApp = path.join(installRoot, 'CaoGen.app')
    runChecked('ditto', [sourceApp, installedApp])
    return { appRoot: installedApp, mountedDmg }
  }

  const result = spawnSync(sourceArtifact, ['/S', `/D=${installRoot}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    // NSIS elevation/security children can inherit pipes and keep spawnSync
    // blocked after the launcher has already exited. Silent installers do not
    // have useful stdout/stderr, so avoid those inherited handles entirely.
    stdio: 'ignore',
    windowsHide: true,
    timeout: 120_000
  })
  if (result.status !== 0) {
    throw new Error(`NSIS installer failed: ${nsisCommandFailure(result)}`)
  }
  return { appRoot: installRoot, mountedDmg: null }
}

async function cleanupInstalledCandidate() {
  if (targetPlatform === 'darwin' && mountedDmg) {
    detachMountedDmg(mountedDmg)
    mountedDmg = undefined
    return
  }
  if (targetPlatform !== 'win32') return
  const uninstallers = ['Uninstall CaoGen.exe', 'Uninstall.exe']
    .map((name) => path.join(installRoot, name))
    .filter(existsSync)
  if (!uninstallers[0]) {
    if (installation.status === 'passed') throw new Error('installed NSIS uninstaller is missing')
    return
  }
  installation.uninstall.status = 'running'
  const result = spawnSync(uninstallers[0], ['/S'], {
    cwd: installRoot,
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true,
    timeout: 120_000
  })
  if (result.status !== 0) throw new Error(`NSIS uninstaller failed: ${nsisCommandFailure(result)}`)

  await waitForPathAbsent(installRoot, 45_000)
  installation.uninstall.installRootRemoved = true
  installation.uninstall.residualInstallations = await waitForWindowsInstallationsAbsent(30_000)
  if (installation.uninstall.residualInstallations.length > 0) {
    throw new Error('NSIS uninstaller left a CaoGen uninstall registry entry')
  }
  installation.uninstall.status = 'passed'
}

async function waitForPathAbsent(targetPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(targetPath)) return
    await delay(250)
  }
  throw new Error(`NSIS uninstaller left the isolated installation directory after ${timeoutMs}ms`)
}

async function waitForWindowsInstallationsAbsent(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let installations = inspectExistingWindowsInstallations()
  while (installations.length > 0 && Date.now() < deadline) {
    await delay(250)
    installations = inspectExistingWindowsInstallations()
  }
  return installations
}

function detachMountedDmg(mountPoint) {
  let failure
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const args = attempt === 5 ? ['detach', '-force', mountPoint] : ['detach', mountPoint]
    const result = spawnSync('hdiutil', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (result.status === 0) return
    failure = commandFailure(result)
    if (attempt < 5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 500)
  }
  throw new Error(`hdiutil detach failed: ${failure}`)
}

function runChecked(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`${command} failed: ${commandFailure(result)}`)
  return String(result.stdout || '')
}

function commandFailure(result) {
  const fallback = result.error?.code === 'ETIMEDOUT'
    ? `timed out; signal ${result.signal || 'unknown'}`
    : result.status !== null && result.status !== undefined
      ? `exit ${result.status}`
      : result.signal
        ? `signal ${result.signal}`
        : 'unknown process failure'
  return String(result.stderr || result.stdout || fallback)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ')
}

function nsisCommandFailure(result) {
  if (result.status === 1223) {
    return 'Windows security/elevation confirmation was cancelled or unavailable (exit 1223)'
  }
  return commandFailure(result)
}

function packagedExecutable(appRootPath, platform) {
  return platform === 'darwin'
    ? path.join(appRootPath, 'Contents', 'MacOS', 'CaoGen')
    : path.join(appRootPath, 'CaoGen.exe')
}

function packagedAsarPath(appRootPath, platform) {
  return platform === 'darwin'
    ? path.join(appRootPath, 'Contents', 'Resources', 'app.asar')
    : path.join(appRootPath, 'resources', 'app.asar')
}

function readReleaseAudit(platform, arch) {
  const relativePath = platform === 'darwin'
    ? `test-results/macos-release-audit/latest-${arch}.json`
    : previewMode
      ? `test-results/windows-preview-audit/latest-${arch}.json`
      : `test-results/windows-release-audit/latest-${arch}.json`
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) return { relativePath, data: null, error: null }
  try {
    return { relativePath, data: JSON.parse(readFileSync(absolutePath, 'utf8')), error: null }
  } catch (error) {
    return { relativePath, data: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function assertReleaseAuditBinding(audit, artifactPath, allowDirty = false) {
  if (audit.error) throw new Error(`release audit is invalid JSON: ${audit.error}`)
  if (!audit.data) throw new Error(`release audit is missing: ${audit.relativePath}`)
  const failures = []
  if (audit.data.status !== 'passed') failures.push('status')
  if (!allowDirty && audit.data.required !== true) failures.push('required')
  if (audit.data.mode !== 'post_build') failures.push('mode')
  if (audit.data.packageVersion !== packageJson.version) failures.push('packageVersion')
  if (audit.data.targetArch !== targetArch) failures.push('targetArch')
  if (!auditPlatformMatches(audit.data)) failures.push('platformChannel')
  if (audit.data.git?.commit !== git.commit) failures.push('gitCommit')
  if (!allowDirty && (audit.data.git?.worktreeClean !== true || !git.worktreeClean)) failures.push('cleanGit')
  if (allowDirty && audit.data.allowDirtyPreview !== true) failures.push('allowDirtyPreview')
  if (!/^[0-9a-f]{64}$/i.test(audit.data.artifactSetSha256 || '')) failures.push('artifactSetSha256')
  const auditedArtifact = artifactSetEntryForPath(audit.data.artifactSet?.files, {
    repoRoot,
    distDir: path.join(repoRoot, 'dist'),
    artifactPath
  })
  if (!auditedArtifact) {
    failures.push('sourceArtifactPath')
  } else {
    const bytes = readFileSync(artifactPath)
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (auditedArtifact.size !== bytes.length) failures.push('sourceArtifactSize')
    if (auditedArtifact.sha256 !== digest) failures.push('sourceArtifactSha256')
  }
  if (failures.length > 0) throw new Error(`release audit binding failed: ${failures.join(', ')}`)
}

function inspectAuthenticode(filePath) {
  const script = `
$ErrorActionPreference = 'Stop'
$Signature = Get-AuthenticodeSignature -LiteralPath ${powerShellLiteral(filePath)}
@{
  Status = [string]$Signature.Status
  HasCertificate = $null -ne $Signature.SignerCertificate
  Timestamped = $null -ne $Signature.TimeStamperCertificate
} | ConvertTo-Json -Compress
`
  const result = spawnSync(powerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`Authenticode inspection failed: ${commandFailure(result)}`)
  }
  try {
    const data = JSON.parse(String(result.stdout || '').trim())
    return {
      status: typeof data.Status === 'string' ? data.Status : 'Unknown',
      hasCertificate: data.HasCertificate === true,
      timestamped: data.Timestamped === true
    }
  } catch (error) {
    throw new Error(`Authenticode inspection returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function inspectExistingWindowsInstallations() {
  const script = `
$ErrorActionPreference = 'Stop'
$Locations = @(
  @{ Scope = 'current-user'; Path = 'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Scope = 'all-users'; Path = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },
  @{ Scope = 'all-users-wow64'; Path = 'Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }
)
$Rows = foreach ($Location in $Locations) {
  Get-ItemProperty -Path $Location.Path -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.DisplayName -like 'CaoGen*' } |
    ForEach-Object {
      @{
        Scope = $Location.Scope
        RegistryKey = [string]$_.PSChildName
        DisplayName = [string]$_.DisplayName
        DisplayVersion = [string]$_.DisplayVersion
        HasUninstallCommand = -not [string]::IsNullOrWhiteSpace([string]$_.UninstallString)
      }
    }
}
@($Rows) | ConvertTo-Json -Compress
`
  const result = spawnSync(powerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(`existing CaoGen installation inspection failed: ${commandFailure(result)}`)
  }
  try {
    const data = JSON.parse(String(result.stdout || '[]').trim() || '[]')
    return (Array.isArray(data) ? data : [data]).map((item) => ({
      scope: String(item.Scope || ''),
      registryKey: String(item.RegistryKey || ''),
      displayName: String(item.DisplayName || ''),
      displayVersion: String(item.DisplayVersion || ''),
      hasUninstallCommand: item.HasUninstallCommand === true
    }))
  } catch (error) {
    throw new Error(
      `existing CaoGen installation inspection returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function powerShellExecutable() {
  const probe = spawnSync('where.exe', ['pwsh.exe'], {
    stdio: 'ignore',
    windowsHide: true
  })
  return probe.status === 0 ? 'pwsh.exe' : 'powershell.exe'
}

function auditPlatformMatches(data) {
  return data.platform === targetPlatform && (data.distributionChannel || 'formal') === distributionChannel
}

function platformLabel(platform) {
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  const prefix = `${name}=`
  const inline = process.argv.find((item) => item.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
