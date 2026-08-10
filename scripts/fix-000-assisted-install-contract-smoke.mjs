#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const portablePath = path.join(repoRoot, 'scripts', 'fix-000-portable-packaged-smoke.mjs')
const runnerPath = path.join(repoRoot, 'scripts', 'fix-000-run-assisted-install.cmd')
const kitBuilderPath = path.join(repoRoot, 'scripts', 'build-fix-000-owner-kit.mjs')
const guidePath = path.join(repoRoot, 'docs', 'OWNER-FIX-000-PORTABLE-KIT.md')

execFileSync(process.execPath, ['--check', portablePath], { cwd: repoRoot, stdio: 'inherit' })

const portable = readFileSync(portablePath, 'utf8')
const runner = readFileSync(runnerPath, 'utf8')
const kitBuilder = readFileSync(kitBuilderPath, 'utf8')
const guide = readFileSync(guidePath, 'utf8')
const assisted = between(portable, 'async function runAssistedInstall()', 'async function runInstalledSmoke()')

assert(portable.includes("const assistedInstallOnly = process.argv.includes('--assisted-install-only')"),
  'portable runner must expose an explicit assisted-install mode')
assert(portable.includes('if (preflightOnly || assistedInstallOnly)'),
  'assisted install must execute the planned-directory clean-host preflight')
assert(assisted.includes('spawnSync(artifactPath, [`/D=${installRoot}`]'),
  'assisted install must pass exactly one path-bound NSIS argument')
assert(!assisted.includes("'/S'") && !assisted.includes('"/S"'),
  'assisted install must remain interactive')
assert(assisted.includes('waitForAssistedInstallBinding(installRoot, 30_000)'),
  'assisted install must verify files and registry after NSIS exits')
assert(assisted.includes("state.cleanup.status = 'not_run_install_preserved'"),
  'successful assisted install must preserve the installation for Owner testing')
assert(portable.includes('if (!failure && !preflightOnly && !assistedInstallOnly)'),
  'assisted install must not enter the silent uninstall/cleanup path')
assert(portable.includes("? 'fix-000-assisted-install-result.json'"),
  'assisted install must emit a distinct private result')
assert(portable.includes('plannedInstallDir, testRoot, installRoot, userDataDir'),
  'planned install paths must be redacted from errors')

for (const required of [
  '--assisted-install-only',
  '--owner-authorized',
  '--planned-install-dir "%~2"'
]) assert(runner.includes(required), `assisted CMD runner is missing ${required}`)
assert(!runner.includes('--preflight-only') && !runner.includes(' /S'),
  'assisted CMD runner must not downgrade to preflight-only or silent install')
assert(kitBuilder.includes("'fix-000-run-assisted-install.cmd'), 'RUN-FIX-000-ASSISTED-INSTALL.cmd'"),
  'portable kit must include the assisted-install runner')
assert(guide.includes('RUN-FIX-000-ASSISTED-INSTALL.cmd'),
  'Owner guide must use the path-bound entry')
assert(guide.includes('a separately launched installer is not sufficient evidence for step 1'),
  'Owner guide must reject unbound preflight/install evidence')

console.log('FIX-000 assisted install contract smoke: PASS')

function between(source, start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(startIndex >= 0 && endIndex > startIndex, `missing source segment ${start}`)
  return source.slice(startIndex, endIndex)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
