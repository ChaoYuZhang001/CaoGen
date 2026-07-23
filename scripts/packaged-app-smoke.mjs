#!/usr/bin/env node
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const { readPackagedReleaseProvenanceFromAsar, releaseProvenanceChecks } = require('./lib/release-provenance.cjs')
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'packaged-app-smoke')
const reportDir = path.join(reportRoot, runId)
const requestedPlatform = argValue('--platform') || process.platform
const targetPlatform = requestedPlatform === 'macos' ? 'darwin' : requestedPlatform === 'windows' ? 'win32' : requestedPlatform
const targetArch = argValue('--arch') || process.arch
const sourceArtifact = releaseArtifactPath(targetPlatform, targetArch, packageJson.version)
const releaseAudit = readReleaseAudit(targetPlatform, targetArch)
const userDataDir = mkdtempSync(path.join(tmpdir(), 'caogen-packaged-app-smoke-'))
const installRoot = mkdtempSync(path.join(tmpdir(), 'caogen-installed-app-smoke-'))
const git = readGitState()
let appRoot
let appExecutable
let buildProvenance = null
let mountedDmg
let child
let stderr = ''
let target
let failure
let cleanupFailure
const installation = {
  sourceArtifact: path.relative(repoRoot, sourceArtifact),
  method: targetPlatform === 'darwin' ? 'dmg-copy-to-isolated-directory' : 'nsis-silent-isolated-directory',
  status: 'failed',
  failure: null
}

try {
  if (targetPlatform !== 'darwin' && targetPlatform !== 'win32') {
    throw new Error(`unsupported packaged app platform: ${targetPlatform}`)
  }
  if (process.platform !== targetPlatform) {
    throw new Error(`packaged app smoke for ${targetPlatform} must run on ${targetPlatform}, got ${process.platform}`)
  }
  if (targetArch !== 'x64' && targetArch !== 'arm64') throw new Error(`unsupported packaged app architecture: ${targetArch}`)
  if (process.arch !== targetArch) {
    throw new Error(`native packaged app smoke for ${targetArch} must run on ${targetArch}, got ${process.arch}`)
  }
  assertReleaseAuditBinding(releaseAudit)
  if (!existsSync(sourceArtifact)) {
    throw new Error(`release installer is missing: ${path.relative(repoRoot, sourceArtifact)}`)
  }
  const installed = installCandidate()
  appRoot = installed.appRoot
  mountedDmg = installed.mountedDmg
  appExecutable = packagedExecutable(appRoot, targetPlatform)
  if (!existsSync(appExecutable)) throw new Error('installed application executable is missing')
  installation.status = 'passed'
  const inspectedProvenance = readPackagedReleaseProvenanceFromAsar(packagedAsarPath(appRoot, targetPlatform))
  buildProvenance = inspectedProvenance.value
  if (inspectedProvenance.error) throw new Error(`packaged release provenance is unreadable: ${inspectedProvenance.error}`)
  const provenanceFailures = Object.entries(releaseProvenanceChecks(buildProvenance, {
    gitCommit: git.commit,
    packageVersion: packageJson.version
  })).filter(([, passed]) => !passed)
  if (provenanceFailures.length > 0) {
    throw new Error(`packaged release provenance failed: ${provenanceFailures.map(([name]) => name).join(', ')}`)
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
  if (/Uncaught Exception|Cannot find module/i.test(stderr)) {
    throw new Error('packaged app emitted a main-process module loading error')
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
  if (installation.status !== 'passed') installation.failure = failure
} finally {
  await stopChild(child)
  const cleanupErrors = []
  try {
    cleanupInstalledCandidate()
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error))
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
  runId,
  reportDir,
  packageVersion: packageJson.version,
  platform: targetPlatform,
  targetArch,
  appExecutable: appExecutable ? 'isolated-install/CaoGen' : null,
  git,
  artifactSetSha256: releaseAudit.data?.artifactSetSha256 || null,
  releaseAudit: {
    path: releaseAudit.relativePath,
    status: releaseAudit.data?.status || (releaseAudit.error ? 'invalid_json' : 'missing')
  },
  buildProvenance,
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
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, `latest-${platformLabel(targetPlatform)}-${targetArch}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (failure) process.exitCode = 1

async function waitForRenderer(processHandle, port, timeoutMs) {
  let exit
  processHandle.once('exit', (code, signal) => {
    exit = { code, signal }
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exit) throw new Error(`packaged app exited before creating a renderer: ${JSON.stringify(exit)}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000)
      })
      if (response.ok) {
        const targets = await response.json()
        const page = Array.isArray(targets)
          ? targets.find((item) => item?.type === 'page' && item?.title === 'CaoGen' && /out\/renderer\/index\.html$/.test(item?.url || ''))
          : undefined
        if (page) return { type: page.type, title: page.title, url: page.url }
      }
    } catch {
      // The debugging endpoint is unavailable while Electron initializes.
    }
    await delay(250)
  }
  throw new Error('packaged app did not create the CaoGen renderer within 30 seconds')
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

function releaseArtifactPath(platform, arch, version) {
  if (platform === 'darwin') {
    const suffix = arch === 'arm64' ? '-arm64' : ''
    return path.join(repoRoot, 'dist', `CaoGen-${version}${suffix}.dmg`)
  }
  if (platform === 'win32') return path.join(repoRoot, 'dist', `CaoGen Setup ${version}.exe`)
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
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 120_000
  })
  if (result.status !== 0) {
    throw new Error(`NSIS installer failed: ${commandFailure(result)}`)
  }
  return { appRoot: installRoot, mountedDmg: null }
}

function cleanupInstalledCandidate() {
  if (targetPlatform === 'darwin' && mountedDmg) {
    detachMountedDmg(mountedDmg)
    mountedDmg = undefined
    return
  }
  if (targetPlatform !== 'win32') return
  const uninstallers = ['Uninstall CaoGen.exe', 'Uninstall.exe']
    .map((name) => path.join(installRoot, name))
    .filter(existsSync)
  if (uninstallers[0]) {
    const result = spawnSync(uninstallers[0], ['/S'], {
      cwd: installRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 120_000
    })
    if (result.status !== 0) throw new Error(`NSIS uninstaller failed: ${commandFailure(result)}`)
  }
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
  return String(result.stderr || result.stdout || `exit ${result.status}`)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ')
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
    : `test-results/windows-release-audit/latest-${arch}.json`
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) return { relativePath, data: null, error: null }
  try {
    return { relativePath, data: JSON.parse(readFileSync(absolutePath, 'utf8')), error: null }
  } catch (error) {
    return { relativePath, data: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function assertReleaseAuditBinding(audit) {
  if (audit.error) throw new Error(`release audit is invalid JSON: ${audit.error}`)
  if (!audit.data) throw new Error(`release audit is missing: ${audit.relativePath}`)
  const failures = []
  if (audit.data.status !== 'passed') failures.push('status')
  if (audit.data.required !== true) failures.push('required')
  if (audit.data.mode !== 'post_build') failures.push('mode')
  if (audit.data.packageVersion !== packageJson.version) failures.push('packageVersion')
  if (audit.data.targetArch !== targetArch) failures.push('targetArch')
  if (audit.data.platform !== targetPlatform) failures.push('platform')
  if (audit.data.git?.commit !== git.commit) failures.push('gitCommit')
  if (audit.data.git?.worktreeClean !== true || !git.worktreeClean) failures.push('cleanGit')
  if (!/^[0-9a-f]{64}$/i.test(audit.data.artifactSetSha256 || '')) failures.push('artifactSetSha256')
  if (failures.length > 0) throw new Error(`release audit binding failed: ${failures.join(', ')}`)
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
