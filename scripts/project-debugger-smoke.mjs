#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-debugger-'))
const workspace = path.join(tempRoot, 'workspace')
const compiled = path.join(tempRoot, 'compiled')
const checks = []
const originalSmokeFlag = process.env.CAOGEN_PROJECT_DEBUG_SMOKE
let debuggerRuntime

try {
  mkdirSync(path.join(workspace, 'src'), { recursive: true })
  const manifest = fixtureManifest()
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(path.join(workspace, 'src', 'index.js'), [
    'function compute(input) {',
    '  const doubled = input * 2',
    '  const payload = { doubled, nested: { ready: true } }',
    "  console.log('value', payload.doubled)",
    '  return payload',
    '}',
    'compute(21)',
    ''
  ].join('\n'))
  writeFileSync(path.join(workspace, 'src', 'main.ts'), [
    'const input: number = 7',
    'const label: string = `typed-${input}`',
    "console.log('typescript', label)",
    ''
  ].join('\n'))
  writeFileSync(path.join(workspace, 'server.js'), "setInterval(() => {}, 1000)\n")
  compileRunner(compiled)

  process.env.CAOGEN_PROJECT_DEBUG_SMOKE = '1'
  const require = createRequire(import.meta.url)
  debuggerRuntime = require(findCompiled(compiled, 'projectDebugger.js'))
  debuggerRuntime.configureProjectDebuggerForSmoke(process.execPath, require.resolve('tsx'))

  const discovery = debuggerRuntime.discoverProjectDebugTargets(workspace)
  equal(discovery.ok, true, 'debug target discovery succeeds')
  check('JavaScript, TypeScript, and long-running targets are discovered',
    ['src/index.js', 'src/main.ts', 'server.js'].every((entry) => discovery.targets.some((target) => target.relativePath === entry)))
  check('discovery exposes no executable, arguments, cwd, or absolute paths', discovery.targets.every((target) =>
    !('executable' in target) && !('args' in target) && !('cwd' in target) && !path.isAbsolute(target.relativePath)))
  check('only one discovered target is the default', discovery.targets.filter((target) => target.default).length === 1)

  const staleTarget = target(discovery, 'src/index.js')
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ ...manifest, description: 'changed' }, null, 2))
  await assert.rejects(
    debuggerRuntime.launchProjectDebug(workspace, 'stale-session', staleTarget.id, []),
    /changed after discovery/,
    'manifest drift invalidates a discovered debug target ID'
  )
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify(manifest, null, 2))

  const fresh = debuggerRuntime.discoverProjectDebugTargets(workspace)
  const jsTarget = target(fresh, 'src/index.js')
  await assert.rejects(
    debuggerRuntime.launchProjectDebug(workspace, 'escape-session', jsTarget.id, [{ path: '../outside.js', line: 1 }]),
    /breakpoint path is invalid/,
    'breakpoints cannot escape the Session workspace'
  )

  let state = await debuggerRuntime.launchProjectDebug(
    workspace,
    'javascript-session',
    jsTarget.id,
    [{ path: 'src/index.js', line: 4 }]
  )
  state = await waitForState(debuggerRuntime, 'javascript-session', (candidate) => candidate.status === 'paused')
  equal(state.status, 'paused', 'a real JavaScript breakpoint pauses execution')
  check('the paused location is projected as a project-relative path',
    state.frames.some((frame) => frame.location?.path === 'src/index.js' && frame.location.line === 4))
  const visibleVariables = state.scopes.flatMap((scope) => scope.variables)
  check('local primitive variables are available', visibleVariables.some((variable) => variable.name === 'doubled' && variable.value === '42'))
  const payload = visibleVariables.find((variable) => variable.name === 'payload')
  check('object variables are expandable without exposing inspector object IDs', Boolean(payload?.expandable && payload.id && !payload.id.includes(':')))
  const payloadChildren = await debuggerRuntime.expandProjectDebugVariable('javascript-session', payload.id)
  check('expanded object properties are returned', payloadChildren.some((variable) => variable.name === 'doubled' && variable.value === '42'))
  state = await debuggerRuntime.controlProjectDebug('javascript-session', 'step-over')
  state = await waitForState(debuggerRuntime, 'javascript-session', (candidate) => candidate.status === 'paused' || candidate.status === 'stopped')
  check('step-over advances or completes the target', state.status === 'paused' || state.status === 'stopped')
  if (state.status === 'paused') await debuggerRuntime.controlProjectDebug('javascript-session', 'continue')
  state = await waitForState(debuggerRuntime, 'javascript-session', (candidate) => candidate.status === 'stopped')
  equal(state.exitCode, 0, 'continued JavaScript target exits cleanly')
  check('workspace absolute paths are removed from captured output', !`${state.stdout}\n${state.stderr}`.includes(workspace))

  const tsTarget = target(fresh, 'src/main.ts')
  await debuggerRuntime.launchProjectDebug(
    workspace,
    'typescript-session',
    tsTarget.id,
    [{ path: 'src/main.ts', line: 3 }]
  )
  state = await waitForState(debuggerRuntime, 'typescript-session', (candidate) => candidate.status === 'paused')
  check('TypeScript runs through the bundled tsx runtime and hits a source breakpoint',
    state.frames.some((frame) => frame.location?.path === 'src/main.ts' && frame.location.line === 3))
  check('TypeScript source variables are inspectable', state.scopes.flatMap((scope) => scope.variables)
    .some((variable) => variable.name === 'label' && variable.value.includes('typed-7')))
  await debuggerRuntime.controlProjectDebug('typescript-session', 'continue')
  await waitForState(debuggerRuntime, 'typescript-session', (candidate) => candidate.status === 'stopped')

  const serverTarget = target(fresh, 'server.js')
  await debuggerRuntime.launchProjectDebug(workspace, 'control-session', serverTarget.id, [])
  await waitForState(debuggerRuntime, 'control-session', (candidate) => candidate.status === 'running')
  await debuggerRuntime.controlProjectDebug('control-session', 'pause')
  state = await waitForState(debuggerRuntime, 'control-session', (candidate) => candidate.status === 'paused')
  equal(state.status, 'paused', 'a running target can be paused explicitly')
  await debuggerRuntime.controlProjectDebug('control-session', 'stop')
  equal(debuggerRuntime.getProjectDebugState('control-session').status, 'stopped', 'stop terminates the debug process tree')

  debuggerRuntime.disposeProjectDebuggers()
  console.log(`project debugger smoke ok: ${checks.length}/${checks.length}`)
} finally {
  debuggerRuntime?.disposeProjectDebuggers()
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (originalSmokeFlag === undefined) delete process.env.CAOGEN_PROJECT_DEBUG_SMOKE
  else process.env.CAOGEN_PROJECT_DEBUG_SMOKE = originalSmokeFlag
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function fixtureManifest() {
  return {
    name: 'caogen-project-debug-fixture',
    private: true,
    main: 'src/index.js',
    scripts: {
      'debug:typescript': 'tsx src/main.ts',
      'debug:server': 'node server.js'
    }
  }
}

function compileRunner(outDir) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/projectDebugger.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function target(discovery, relativePath) {
  const found = discovery.targets.find((item) => item.relativePath === relativePath)
  assert(found, `missing debug target: ${relativePath}`)
  return found
}

async function waitForState(runtime, sessionId, predicate, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = runtime.getProjectDebugState(sessionId)
    if (predicate(state)) return state
    if (state.status === 'failed') assert.fail(`debug session failed: ${state.error}\n${state.stderr}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for debug state; last state: ${JSON.stringify(runtime.getProjectDebugState(sessionId))}`)
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

function check(message, condition) {
  assert(condition, message)
  checks.push(message)
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  checks.push(message)
}
