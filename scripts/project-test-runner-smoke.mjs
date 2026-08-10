#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import Module, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-tests-'))
const workspace = path.join(tempRoot, 'workspace')
const userData = path.join(tempRoot, 'user-data')
const compiled = path.join(tempRoot, 'compiled')
const checks = []
const originalLoad = Module._load
const originalSmokeFlag = process.env.CAOGEN_PROJECT_TEST_SMOKE

try {
  mkdirSync(path.join(workspace, 'tests'), { recursive: true })
  mkdirSync(userData, { recursive: true })
  const manifest = fixtureManifest()
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify(manifest, null, 2))
  for (const name of ['Cargo.toml', 'go.mod', 'gradlew.bat']) writeFileSync(path.join(workspace, name), 'fixture\n')
  writeFileSync(path.join(workspace, 'pyproject.toml'), '[tool.pytest.ini_options]\n')
  compileRunner(compiled)

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => userData } }
    return originalLoad.call(this, request, parent, isMain)
  }
  process.env.CAOGEN_PROJECT_TEST_SMOKE = '1'
  const require = createRequire(import.meta.url)
  const runner = require(findCompiled(compiled, 'projectTestRunner.js'))
  Module._load = originalLoad

  const discovered = runner.discoverProjectTests(workspace)
  equal(discovered.ok, true, 'discovery succeeds')
  equal(discovered.commands.length, 11, 'supported package and convention commands are discovered')
  check('build scripts are excluded', !discovered.commands.some((item) => item.label.includes('build')))
  check('npm, pytest, cargo, go, and Gradle are represented',
    ['package-script', 'pytest', 'cargo', 'go', 'gradle'].every((source) => discovered.commands.some((item) => item.source === source)))
  equal(discovered.commands.filter((item) => item.default).length, 1, 'only the exact test script is the default')
  check('discovery never exposes executable or argument fields',
    discovered.commands.every((item) => !('executable' in item) && !('args' in item)))

  const stale = command(discovered, 'npm run check')
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
    ...manifest,
    scripts: { ...manifest.scripts, check: 'node -e "console.log(2)"' }
  }, null, 2))
  await assert.rejects(
    runner.runProjectTest(workspace, 'drift-session', stale.id),
    /changed after discovery/,
    'manifest drift invalidates the discovered command ID'
  )
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify(manifest, null, 2))

  runner.configureProjectTestRuntimeForSmoke({ maxRunMs: 10_000, maxOutputBytes: 8_192 })
  const fresh = runner.discoverProjectTests(workspace)
  const passed = await runner.runProjectTest(workspace, 'pass-session', command(fresh, 'npm run test').id)
  equal(passed.status, 'passed', 'passing command has a structured passed status')
  equal(passed.exitCode, 0, 'passing command preserves exit code zero')
  check('passing output is captured', passed.stdout.includes('fixture-pass'))

  const failed = await runner.runProjectTest(workspace, 'fail-session', command(fresh, 'npm run test:fail').id)
  equal(failed.status, 'failed', 'failing command has a structured failed status')
  equal(failed.exitCode, 3, 'failing command preserves its exit code')
  check('workspace paths are normalized in renderer output', !failed.stderr.includes(workspace) && failed.stderr.includes('<workspace>'))
  verifyEvidence(userData, workspace, failed)

  const slowCommand = command(fresh, 'npm run test:slow')
  const concurrentRun = runner.runProjectTest(workspace, 'concurrent-session', slowCommand.id)
  await assert.rejects(
    runner.runProjectTest(workspace, 'concurrent-session', slowCommand.id),
    /already running/,
    'a Session cannot start two test commands concurrently'
  )
  await delay(250)
  equal(runner.cancelProjectTest('concurrent-session'), true, 'active test can be cancelled')
  equal((await concurrentRun).status, 'cancelled', 'cancel returns a structured cancelled status')

  runner.configureProjectTestRuntimeForSmoke({ maxRunMs: 350, maxOutputBytes: 8_192 })
  const timedOut = await runner.runProjectTest(workspace, 'timeout-session', slowCommand.id)
  equal(timedOut.status, 'timed_out', 'timeout returns a structured timed_out status')

  runner.configureProjectTestRuntimeForSmoke({ maxRunMs: 10_000, maxOutputBytes: 1_024 })
  const loud = await runner.runProjectTest(workspace, 'loud-session', command(fresh, 'npm run test:loud').id)
  equal(loud.status, 'output_limit', 'excess output returns a structured output_limit status')
  equal(Buffer.byteLength(loud.stdout), 1_024, 'captured output stops at the configured byte limit')
  equal(loud.stdoutTruncated, true, 'output truncation is explicit')

  runner.disposeProjectTestRuns()
  console.log(`project test runner smoke ok: ${checks.length}/${checks.length}`)
} finally {
  Module._load = originalLoad
  if (originalSmokeFlag === undefined) delete process.env.CAOGEN_PROJECT_TEST_SMOKE
  else process.env.CAOGEN_PROJECT_TEST_SMOKE = originalSmokeFlag
  rmSync(tempRoot, { recursive: true, force: true })
}

function fixtureManifest() {
  return {
    name: 'caogen-project-test-fixture',
    private: true,
    scripts: {
      test: 'node -e "console.log(\'fixture-pass\')"',
      'test:fail': 'node -e "console.error(process.cwd() + \' password=sensitive-canary-value\'); process.exit(3)"',
      'test:slow': 'node -e "setInterval(() => {}, 1000)"',
      'test:loud': 'node -e "process.stdout.write(\'x\'.repeat(4096)); setInterval(() => {}, 1000)"',
      check: 'node -e "console.log(1)"',
      lint: 'node -e "console.log(1)"',
      typecheck: 'node -e "console.log(1)"',
      build: 'node -e "console.log(\'excluded\')"'
    }
  }
}

function compileRunner(outDir) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/projectTestRunner.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function command(discovery, label) {
  const found = discovery.commands.find((item) => item.label === label)
  assert(found, `missing discovered command: ${label}`)
  return found
}

function verifyEvidence(root, cwd, result) {
  assert(result.evidenceId, 'failed command must return an evidence ID')
  const digest = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 24)
  const evidencePath = path.join(root, 'project-test-evidence', digest, `${result.evidenceId}.json`)
  check('evidence file is durably published', existsSync(evidencePath))
  const serialized = readFileSync(evidencePath, 'utf8')
  const record = JSON.parse(serialized)
  equal(record.kind, 'caogen-project-test-evidence', 'evidence schema is explicit')
  equal(record.schemaVersion, 1, 'evidence schema version is explicit')
  equal(record.status, 'failed', 'evidence records the terminal status')
  check('evidence excludes absolute workspace paths', !serialized.includes(cwd))
  check('evidence redacts sensitive failure text', !serialized.includes('sensitive-canary-value'))
  check('evidence excludes full stdout and stderr', !('stdout' in record) && !('stderr' in record))
  check('evidence binds output by digest', /^[a-f0-9]{64}$/.test(record.outputDigest))
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* continue */ }
    } else if (entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function check(message, condition) {
  assert(condition, message)
  checks.push(message)
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  checks.push(message)
}
