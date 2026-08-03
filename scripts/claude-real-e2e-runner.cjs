#!/usr/bin/env node
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { reportDeepTestStatus } = require('./deep-test-status.cjs')

const scriptPath = path.join(__dirname, 'claude-real-e2e.cjs')

if (process.env.CAOGEN_CLAUDE_REAL_E2E !== '1') {
  const reason = 'real Provider call is not explicitly enabled'
  reportDeepTestStatus('skip', { reason })
  console.log(`[SKIP] Claude real E2E: ${reason}`)
  process.exit(0)
}

const electron = require('electron')
const result = spawnSync(electron, [scriptPath], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    CAOGEN_DEEP_TEST_STATUS_REPORTER: scriptPath
  },
  stdio: 'inherit'
})

if (result.error) {
  console.error(`Claude real E2E could not start: ${result.error.message}`)
  process.exit(1)
}
if (result.signal) {
  console.error(`Claude real E2E terminated by signal ${result.signal}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
