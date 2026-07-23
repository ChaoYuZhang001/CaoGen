#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const outDir = mkdtempSync(path.join(tmpdir(), 'caogen-session-model-switch-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/session-model-switch-policy.ts',
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const policy = await import(pathToFileURL(path.join(outDir, 'main', 'session-model-switch-policy.js')).href)
  const state = (status, currentModel = 'model-a', pendingPermissionCount = 0) => ({
    status,
    currentModel,
    pendingPermissionCount
  })

  const sameRunning = policy.evaluateSessionModelSwitch(state('running'), 'model-a')
  assert.deepEqual(sameRunning, { allowed: true, changed: false, model: 'model-a' })

  for (const status of ['starting', 'running']) {
    const decision = policy.evaluateSessionModelSwitch(state(status), 'model-b')
    assert.equal(decision.allowed, false)
    assert.equal(decision.changed, false)
    assert.equal(decision.reason, 'active-run')
    assert.throws(
      () => policy.assertSessionModelSwitchAllowed(state(status), 'model-b'),
      (error) => error?.code === 'SESSION_MODEL_SWITCH_BLOCKED' && error?.decision?.reason === 'active-run'
    )
  }

  const pending = policy.evaluateSessionModelSwitch(state('idle', 'model-a', 1), 'model-b')
  assert.equal(pending.allowed, false)
  assert.equal(pending.reason, 'pending-permission')

  const closed = policy.evaluateSessionModelSwitch(state('closed'), 'model-b')
  assert.equal(closed.allowed, false)
  assert.equal(closed.reason, 'closed-session')

  const idle = policy.assertSessionModelSwitchAllowed(state('idle'), '  model-b  ')
  assert.deepEqual(idle, { allowed: true, changed: true, model: 'model-b' })

  const errorRecovery = policy.assertSessionModelSwitchAllowed(state('error'), 'model-b')
  assert.equal(errorRecovery.allowed, true)
  assert.equal(errorRecovery.changed, true)

  assert.throws(
    () => policy.evaluateSessionModelSwitch(state('idle'), null),
    (error) => error instanceof TypeError && /字符串/.test(error.message)
  )

  console.log('session model switch policy smoke: PASS')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
