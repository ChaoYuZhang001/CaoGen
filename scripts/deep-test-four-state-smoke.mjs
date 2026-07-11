#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { commands, runDeepTest } from './deep-test.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scenarioFlag = process.argv.indexOf('--run-scenario')

if (scenarioFlag >= 0) {
  const scenario = process.argv[scenarioFlag + 1]
  const outRoot = process.argv[scenarioFlag + 2]
  const fixturePath = process.argv[scenarioFlag + 3]
  const report = await runDeepTest({
    repoRoot,
    outRoot,
    runId: scenario,
    commands: scenarioCommands(scenario, fixturePath),
    log: () => {}
  })
  console.log(JSON.stringify({ status: report.status, exitCode: report.exitCode }))
  process.exitCode = report.exitCode
} else {
  await runSmoke()
}

async function runSmoke() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-deep-four-state-'))
  const fixturePath = path.join(tempRoot, 'status-fixture.mjs')
  const helperUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'deep-test-status.cjs')).href
  writeFileSync(
    fixturePath,
    `import deepTestStatus from ${JSON.stringify(helperUrl)}\n` +
      `const { reportDeepTestStatus } = deepTestStatus\n` +
      `const status = process.argv[2]\n` +
      `const exitCode = Number(process.argv[3] || 0)\n` +
      `if (status === 'signal-crash') process.abort()\n` +
      `if (!status.startsWith('legacy-') && status !== 'signal-crash') reportDeepTestStatus(status, {\n` +
      `  ...(status === 'pass' ? {} : { reason: 'fixture ' + status }),\n` +
      `  details: { fixture: true }\n` +
      `})\n` +
      `console.log('fixture status=' + status)\n` +
      `process.exitCode = exitCode\n`,
    'utf8'
  )

  try {
    const optional = runScenario('optional-nonblocking', tempRoot, fixturePath)
    assert.equal(optional.process.status, 0, optional.process.output)
    assert.equal(optional.report.status, 'pass')
    assert.equal(optional.report.exitCode, 0)
    assert.deepEqual(optional.report.gatePolicy, {
      fail: 'always-blocking',
      required: 'must-pass',
      optional: 'skip-or-blocked-is-non-blocking; fail-is-blocking'
    })
    assert.deepEqual(optional.report.summary.counts, { pass: 2, skip: 1, blocked: 1, fail: 0 })
    assert.equal(optional.report.summary.required.blocking, 0)
    assert.equal(optional.report.summary.optional.blocking, 0)
    assert(optional.report.results.every((item) => item.executed === true))
    assert.equal(resultByName(optional.report, 'optional skip').protocolSource, 'structured')
    assert.equal(resultByName(optional.report, 'optional blocked').status, 'blocked')
    assert.equal(resultByName(optional.report, 'legacy pass').protocolSource, 'exit-code')
    assert(optional.markdown.includes('| Requirement | Status | Gate |'))
    assert(optional.markdown.includes('| optional | skip | non-blocking |'))
    assert(optional.markdown.includes('2 pass; 1 skip; 1 blocked; 0 fail'))
    assert(optional.markdown.includes('optional skip/blocked is retained but does not block'))

    const requiredSkip = runScenario('required-skip', tempRoot, fixturePath)
    assert.equal(requiredSkip.process.status, 1, requiredSkip.process.output)
    assert.equal(requiredSkip.report.status, 'fail')
    assert.equal(requiredSkip.report.exitCode, 1)
    assert.equal(resultByName(requiredSkip.report, 'required skip').status, 'skip')
    assert.equal(resultByName(requiredSkip.report, 'required skip').blocksGate, true)
    assert.equal(resultByName(requiredSkip.report, 'not executed after skip').status, 'blocked')
    assert.equal(resultByName(requiredSkip.report, 'not executed after skip').executed, false)
    assert(requiredSkip.markdown.includes('Blocked after gate failure: not executed after skip'))

    const requiredBlocked = runScenario('required-blocked', tempRoot, fixturePath)
    assert.equal(requiredBlocked.process.status, 1, requiredBlocked.process.output)
    assert.equal(requiredBlocked.report.status, 'fail')
    assert.equal(resultByName(requiredBlocked.report, 'required blocked').status, 'blocked')
    assert.equal(resultByName(requiredBlocked.report, 'required blocked').blocksGate, true)

    const runtimeEnvRequired = runScenario('runtime-env-required-skip', tempRoot, fixturePath)
    assert.equal(runtimeEnvRequired.process.status, 1, runtimeEnvRequired.process.output)
    assert.equal(runtimeEnvRequired.report.status, 'fail')
    assert.equal(resultByName(runtimeEnvRequired.report, 'runtime env required skip').status, 'skip')
    assert.equal(resultByName(runtimeEnvRequired.report, 'runtime env required skip').requirement, 'required')
    assert.equal(resultByName(runtimeEnvRequired.report, 'runtime env required skip').requirementSource, 'runtime')

    const runtimeArgRequired = runScenario('runtime-arg-required-skip', tempRoot, fixturePath)
    assert.equal(runtimeArgRequired.process.status, 1, runtimeArgRequired.process.output)
    assert.equal(runtimeArgRequired.report.status, 'fail')
    assert.equal(resultByName(runtimeArgRequired.report, 'runtime arg required skip').status, 'skip')
    assert.equal(resultByName(runtimeArgRequired.report, 'runtime arg required skip').requirement, 'required')
    assert.equal(resultByName(runtimeArgRequired.report, 'runtime arg required skip').requirementSource, 'runtime')

    const skipThenCrash = runScenario('skip-then-exit-one', tempRoot, fixturePath)
    assert.equal(skipThenCrash.process.status, 1, skipThenCrash.process.output)
    assert.equal(skipThenCrash.report.status, 'fail')
    assert.equal(resultByName(skipThenCrash.report, 'skip then exit one').status, 'fail')
    assert.match(resultByName(skipThenCrash.report, 'skip then exit one').reason, /reported skip but exited with code 1/)

    const signalCrash = runScenario('signal-crash', tempRoot, fixturePath)
    assert.equal(signalCrash.process.status, 1, signalCrash.process.output)
    assert.equal(signalCrash.report.status, 'fail')
    assert.equal(resultByName(signalCrash.report, 'signal crash').status, 'fail')
    assert.match(resultByName(signalCrash.report, 'signal crash').reason, /terminated by signal/)
    assert.equal(typeof resultByName(signalCrash.report, 'signal crash').signal, 'string')

    const optionalFail = runScenario('optional-fail', tempRoot, fixturePath)
    assert.equal(optionalFail.process.status, 1, optionalFail.process.output)
    assert.equal(optionalFail.report.status, 'fail')
    assert.equal(resultByName(optionalFail.report, 'optional fail').status, 'fail')
    assert.equal(resultByName(optionalFail.report, 'optional fail').blocksGate, true)

    const legacyFail = runScenario('legacy-fail', tempRoot, fixturePath)
    assert.equal(legacyFail.process.status, 1, legacyFail.process.output)
    assert.equal(resultByName(legacyFail.report, 'legacy fail').status, 'fail')
    assert.equal(resultByName(legacyFail.report, 'legacy fail').protocolSource, 'exit-code')

    assertExternalRequirements()
    assertExternalSkipProtocol('china real network', {
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts', 'china-real-network-smoke.mjs')],
      env: {
        CAOGEN_CHINA_REAL_NETWORK: '',
        CAOGEN_CHINA_REAL_NETWORK_REQUIRED: '',
        CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: ''
      }
    }, tempRoot)
    assertExternalSkipProtocol('china tool-call parity', {
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts', 'china-tool-call-parity.mjs')],
      env: {
        CAOGEN_CHINA_TOOL_CALL_PARITY: '',
        CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED: '',
        CAOGEN_CHINA_PARITY_PROVIDERS: ''
      }
    }, tempRoot)
    assertExternalSkipProtocol('claude real e2e', electronSpec(), tempRoot, {
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_HOST_CREDS_FILE: ''
    })
    assertRequiredExternalBlocked('china-real-required', tempRoot, fixturePath, 'chinaRealNetwork smoke')
    assertRequiredExternalBlocked('china-parity-required', tempRoot, fixturePath, 'chinaToolCallParity smoke')
    assertStandaloneRequiredFailure('china real network', {
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts', 'china-real-network-smoke.mjs'), '--required'],
      env: requiredExternalEnv('china-real-required')
    })
    assertStandaloneRequiredFailure('china tool-call parity', {
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts', 'china-tool-call-parity.mjs'), '--required'],
      env: requiredExternalEnv('china-parity-required')
    })

    console.log('deep-test four-state smoke: pass')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function runScenario(scenario, tempRoot, fixturePath) {
  const outRoot = path.join(tempRoot, scenario)
  const processResult = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--run-scenario', scenario, outRoot, fixturePath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        ...(scenario === 'runtime-env-required-skip' ? { CAOGEN_FIXTURE_REQUIRED: '1' } : {}),
        ...requiredExternalEnv(scenario)
      }
    }
  )
  const latestPath = path.join(outRoot, 'latest.json')
  assert(existsSync(latestPath), `${scenario} did not write latest.json\n${commandOutput(processResult)}`)
  const report = JSON.parse(readFileSync(latestPath, 'utf8'))
  const jsonPath = path.join(report.runDir, 'deep-test-report.json')
  const markdownPath = path.join(report.runDir, 'deep-test-report.md')
  assert(existsSync(jsonPath), `${scenario} did not write run JSON`)
  assert(existsSync(markdownPath), `${scenario} did not write run Markdown`)
  assert.deepEqual(JSON.parse(readFileSync(jsonPath, 'utf8')), report)
  assert.equal(report.schemaVersion, 2)
  return {
    process: { status: processResult.status, output: commandOutput(processResult) },
    report,
    markdown: readFileSync(markdownPath, 'utf8')
  }
}

function scenarioCommands(scenario, fixturePath) {
  const fixture = (name, status, requirement, exitCode = 0) => ({
    name,
    command: process.execPath,
    args: [fixturePath, status, String(exitCode)],
    category: 'fixture',
    requirement,
    statusReporter: fixturePath
  })
  if (scenario === 'optional-nonblocking') {
    return [
      fixture('legacy pass', 'legacy-pass', 'required'),
      fixture('optional skip', 'skip', 'optional'),
      fixture('optional blocked', 'blocked', 'optional'),
      fixture('structured pass', 'pass', 'required')
    ]
  }
  if (scenario === 'required-skip') {
    return [
      fixture('required skip', 'skip', 'required'),
      fixture('not executed after skip', 'pass', 'required')
    ]
  }
  if (scenario === 'required-blocked') return [fixture('required blocked', 'blocked', 'required')]
  if (scenario === 'runtime-env-required-skip') {
    return [{
      ...fixture('runtime env required skip', 'skip', 'optional'),
      requiredWhen: { env: ['CAOGEN_FIXTURE_REQUIRED'] }
    }]
  }
  if (scenario === 'runtime-arg-required-skip') {
    return [{
      ...fixture('runtime arg required skip', 'skip', 'optional'),
      args: [fixturePath, 'skip', '0', '--required'],
      requiredWhen: { args: ['--required'] }
    }]
  }
  if (scenario === 'skip-then-exit-one') return [fixture('skip then exit one', 'skip', 'optional', 1)]
  if (scenario === 'signal-crash') return [fixture('signal crash', 'signal-crash', 'optional')]
  if (scenario === 'china-real-required') {
    return [{
      name: 'chinaRealNetwork smoke',
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts', 'china-real-network-smoke.mjs'), '--required'],
      category: 'external',
      requirement: 'optional',
      requiredWhen: { env: ['CAOGEN_CHINA_REAL_NETWORK_REQUIRED'], args: ['--required'] },
      statusReporter: 'scripts/china-real-network-smoke.mjs'
    }]
  }
  if (scenario === 'china-parity-required') {
    return [{
      name: 'chinaToolCallParity smoke',
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts', 'china-tool-call-parity.mjs'), '--required'],
      category: 'external',
      requirement: 'optional',
      requiredWhen: { env: ['CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED'], args: ['--required'] },
      statusReporter: 'scripts/china-tool-call-parity.mjs'
    }]
  }
  if (scenario === 'optional-fail') return [fixture('optional fail', 'fail', 'optional')]
  if (scenario === 'legacy-fail') return [fixture('legacy fail', 'legacy-fail', 'required', 7)]
  throw new Error(`unknown deep-test scenario: ${scenario}`)
}

function assertExternalRequirements() {
  const byName = new Map(commands.map((item) => [item.name, item]))
  for (const name of ['chinaRealNetwork smoke', 'chinaToolCallParity smoke', 'claude real e2e']) {
    assert.equal(byName.get(name)?.requirement, 'optional', `${name} must be optional in the default deep gate`)
  }
  assert.deepEqual(byName.get('chinaRealNetwork smoke')?.requiredWhen, {
    env: ['CAOGEN_CHINA_REAL_NETWORK_REQUIRED'],
    args: ['--required']
  })
  assert.deepEqual(byName.get('chinaToolCallParity smoke')?.requiredWhen, {
    env: ['CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED'],
    args: ['--required']
  })
  assert.equal(byName.get('typecheck')?.requirement, 'required')
  assert.equal(byName.get('build')?.requirement, 'required')
  assert(commands.every((item) => item.requirement === 'required' || item.requirement === 'optional'))
}

function assertExternalSkipProtocol(name, spec, tempRoot, extraEnv = {}) {
  const statusPath = path.join(tempRoot, `${name.replace(/[^a-z0-9]+/gi, '-')}.status.json`)
  const result = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      ...spec.env,
      ...extraEnv,
      CAOGEN_DEEP_TEST_STATUS_FILE: statusPath,
      CAOGEN_DEEP_TEST_STATUS_REPORTER: spec.reporter ?? spec.args.at(-1)
    }
  })
  assert.equal(result.status, 0, `${name} should skip with exit 0\n${commandOutput(result)}`)
  assert(existsSync(statusPath), `${name} did not write structured status`)
  const status = JSON.parse(readFileSync(statusPath, 'utf8'))
  assert.equal(status.protocol, 'caogen.deep-test.status/v1')
  assert.equal(status.status, 'skip')
  assert.equal(typeof status.reason, 'string')
  assert(status.reason.length > 0)
}

function assertRequiredExternalBlocked(scenario, tempRoot, fixturePath, resultName) {
  const result = runScenario(scenario, tempRoot, fixturePath)
  assert.equal(result.process.status, 1, result.process.output)
  assert.equal(result.report.status, 'fail')
  const check = resultByName(result.report, resultName)
  assert.equal(check.status, 'blocked')
  assert.equal(check.requirement, 'required')
  assert.equal(check.requirementSource, 'runtime')
  assert.equal(check.blocksGate, true)
  assert.equal(check.exitCode, 0)
  assert.equal(check.protocolSource, 'structured')
}

function assertStandaloneRequiredFailure(name, spec) {
  const env = { ...process.env, ...spec.env }
  delete env.CAOGEN_DEEP_TEST_STATUS_FILE
  delete env.CAOGEN_DEEP_TEST_STATUS_REPORTER
  const result = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env
  })
  assert.equal(result.status, 1, `${name} standalone required must exit 1\n${commandOutput(result)}`)
}

function requiredExternalEnv(scenario) {
  if (scenario === 'china-real-required') {
    return {
      CAOGEN_CHINA_REAL_NETWORK: '',
      CAOGEN_CHINA_REAL_NETWORK_REQUIRED: '',
      CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: ''
    }
  }
  if (scenario === 'china-parity-required') {
    return {
      CAOGEN_CHINA_TOOL_CALL_PARITY: '',
      CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED: '',
      CAOGEN_CHINA_PARITY_PROVIDERS: ''
    }
  }
  return {}
}

function electronSpec() {
  const electron = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  assert(existsSync(electron), `Electron binary missing: ${electron}`)
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', electron, path.join(repoRoot, 'scripts', 'claude-real-e2e.cjs')] }
  }
  return { command: electron, args: [path.join(repoRoot, 'scripts', 'claude-real-e2e.cjs')] }
}

function resultByName(report, name) {
  const result = report.results.find((item) => item.name === name)
  assert(result, `missing result: ${name}`)
  return result
}

function commandOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim()
}
