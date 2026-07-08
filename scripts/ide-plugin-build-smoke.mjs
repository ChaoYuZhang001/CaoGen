#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const required = process.env.CAOGEN_IDE_PLUGINS_REQUIRED === '1' || process.argv.includes('--required')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'ide-plugins', runId)
const results = []
const JETBRAINS_REQUIRED_TASKS = ['buildPlugin', 'verifyPluginProjectConfiguration', 'verifyPluginStructure', 'prepareSandbox']

mkdirSync(reportDir, { recursive: true })

runCheck('vscode_compile', true, () => {
  const pluginDir = path.join(repoRoot, 'plugins', 'vscode')
  const dependencyStatus = ensureVscodeDependencies(pluginDir)
  execFileSync(npmCommand(), ['run', 'compile'], {
    cwd: pluginDir,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    env: process.env
  })
  return {
    ok: existsSync(path.join(repoRoot, 'plugins', 'vscode', 'out', 'extension.js')),
    artifact: path.join('plugins', 'vscode', 'out', 'extension.js'),
    dependencyStatus
  }
})

const jetbrainsCommand = resolveJetBrainsBuildCommand()
runCheck('jetbrains_build_plugin', Boolean(jetbrainsCommand), () => {
  if (!jetbrainsCommand) return { ok: false, error: 'missing Gradle command' }
  execFileSync(jetbrainsCommand.command, jetbrainsCommand.args, {
    cwd: path.join(repoRoot, 'plugins', 'jetbrains'),
    stdio: 'pipe',
    shell: process.platform === 'win32',
    env: jetbrainsCommand.env
  })
  return {
    ok: true,
    command: [jetbrainsCommand.command, ...jetbrainsCommand.args].join(' '),
    tasks: jetbrainsCommand.tasks,
    gradleHome: jetbrainsCommand.gradleHome,
    javaHome: jetbrainsCommand.javaHome
  }
})

const failures = []
for (const result of results) {
  if (result.status === 'fail') failures.push(`${result.name} failed`)
  if (required && result.status === 'skipped') failures.push(`${result.name} skipped in required mode: ${result.reason}`)
}

const report = {
  status: failures.length > 0 ? 'failed' : 'completed',
  required,
  reportDir,
  results,
  failures
}
writeReport(report)
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1

function runCheck(name, shouldRun, fn) {
  if (!shouldRun) {
    results.push({ name, status: 'skipped', reason: 'missing required local build tool' })
    return
  }
  const started = Date.now()
  try {
    const evidence = fn()
    results.push({
      name,
      status: evidence.ok ? 'pass' : 'fail',
      durationMs: Date.now() - started,
      ...evidence
    })
  } catch (error) {
    results.push({
      name,
      status: 'fail',
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function resolveJetBrainsBuildCommand() {
  const pluginDir = path.join(repoRoot, 'plugins', 'jetbrains')
  const gradlewBat = path.join(pluginDir, 'gradlew.bat')
  const env = jetbrainsBuildEnv()
  if (process.platform === 'win32' && existsSync(gradlewBat)) {
    return { command: gradlewBat, args: JETBRAINS_REQUIRED_TASKS, tasks: JETBRAINS_REQUIRED_TASKS, env, gradleHome: undefined, javaHome: env.JAVA_HOME }
  }
  const gradlew = path.join(pluginDir, 'gradlew')
  if (existsSync(gradlew)) return { command: gradlew, args: JETBRAINS_REQUIRED_TASKS, tasks: JETBRAINS_REQUIRED_TASKS, env, gradleHome: undefined, javaHome: env.JAVA_HOME }
  const gradleHome = resolveGradleHome()
  const gradleCommand = gradleHome ? gradleExecutable(gradleHome) : undefined
  if (gradleCommand && existsSync(gradleCommand)) {
    return { command: gradleCommand, args: ['--no-daemon', ...JETBRAINS_REQUIRED_TASKS], tasks: JETBRAINS_REQUIRED_TASKS, env, gradleHome, javaHome: env.JAVA_HOME }
  }
  if (hasCommand('gradle', env)) return { command: 'gradle', args: ['--no-daemon', ...JETBRAINS_REQUIRED_TASKS], tasks: JETBRAINS_REQUIRED_TASKS, env, gradleHome, javaHome: env.JAVA_HOME }
  return null
}

function hasCommand(command, env = process.env) {
  const probe =
    process.platform === 'win32'
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
  const macJdk17 = resolveMacJavaHome('17')
  if (macJdk17) return macJdk17
  const marker = path.join(portableToolchainRoot(), 'jdk-home.txt')
  if (existsSync(marker)) {
    const value = readFileSync(marker, 'utf8').trim()
    if (value && existsSync(value)) return value
  }
  return undefined
}

function resolveMacJavaHome(version) {
  if (process.platform !== 'darwin') return undefined
  const probe = spawnSync('/usr/libexec/java_home', ['-v', version], { encoding: 'utf8' })
  const value = probe.status === 0 ? probe.stdout.trim() : ''
  return value && existsSync(value) ? value : undefined
}

function resolveGradleHome() {
  const explicit = process.env.CAOGEN_GRADLE_HOME || process.env.GRADLE_HOME
  if (explicit && existsSync(explicit)) return explicit
  const home = path.join(portableToolchainRoot(), 'gradle-8.10.2')
  return existsSync(home) ? home : undefined
}

function gradleExecutable(gradleHome) {
  return path.join(gradleHome, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle')
}

function portableToolchainRoot() {
  return path.join(process.env.TEMP || process.env.TMPDIR || process.cwd(), 'caogen-p2-toolchain')
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function ensureVscodeDependencies(pluginDir) {
  const typeFile = path.join(pluginDir, 'node_modules', '@types', 'vscode', 'index.d.ts')
  const tscBin = path.join(pluginDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  if (existsSync(typeFile) && existsSync(tscBin)) return 'already-present'
  const lockFile = path.join(pluginDir, 'package-lock.json')
  const args = existsSync(lockFile) ? ['ci'] : ['install']
  execFileSync(npmCommand(), args, {
    cwd: pluginDir,
    stdio: 'pipe',
    shell: process.platform === 'win32',
    env: process.env
  })
  return existsSync(lockFile) ? 'npm-ci' : 'npm-install'
}

function writeReport(report) {
  mkdirSync(reportDir, { recursive: true })
  const json = JSON.stringify(report, null, 2)
  writeFileSync(path.join(reportDir, 'report.json'), json, 'utf8')
  writeFileSync(path.join(repoRoot, 'test-results', 'ide-plugins', 'latest.json'), json, 'utf8')
}
