#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { detachDmg, readDmgMountState } from './lib/macos-dmg-detach.mjs'

const require = createRequire(import.meta.url)
const plist = require('plist')
const mountPoint = '/tmp/caogen-dmg-fixture'

const successCalls = []
const immediate = detachDmg(mountPoint, {
  runCommand(command, args) {
    successCalls.push([command, args])
    return commandResult({ ok: true })
  },
  wait: noWait
})
assert.equal(immediate.ok, true)
assert.equal(immediate.detachDisposition, 'command_succeeded')
assert.deepEqual(successCalls, [['hdiutil', ['detach', mountPoint]]])

const alreadyDetachedCalls = []
const alreadyDetached = detachDmg(mountPoint, {
  runCommand(command, args) {
    alreadyDetachedCalls.push([command, args])
    if (args[0] === 'detach') {
      return commandResult({ ok: false, exitCode: 1, stderr: 'hdiutil: detach failed - No such file or directory' })
    }
    return commandResult({ stdout: dmgInfo([]) })
  },
  wait: noWait
})
assert.equal(alreadyDetached.ok, true)
assert.equal(alreadyDetached.exitCode, 0)
assert.equal(alreadyDetached.originalExitCode, 1)
assert.equal(alreadyDetached.detachDisposition, 'verified_detached')
assert.equal(alreadyDetachedCalls.length, 2)

let detachAttempt = 0
const waits = []
const forced = detachDmg(mountPoint, {
  runCommand(command, args) {
    if (args[0] === 'info') return commandResult({ stdout: dmgInfo([mountPoint]) })
    detachAttempt += 1
    if (detachAttempt === 5) {
      assert.deepEqual(args, ['detach', '-force', mountPoint])
      return commandResult({ ok: true })
    }
    assert.deepEqual(args, ['detach', mountPoint])
    return commandResult({ ok: false, exitCode: 16, stderr: 'resource busy' })
  },
  wait(delayMs) {
    waits.push(delayMs)
  }
})
assert.equal(forced.ok, true)
assert.equal(forced.detachDisposition, 'command_succeeded')
assert.equal(detachAttempt, 5)
assert.deepEqual(waits, [500, 1000, 1500, 2000])

let failedAttempts = 0
const stillMounted = detachDmg(mountPoint, {
  runCommand(command, args) {
    if (args[0] === 'info') return commandResult({ stdout: dmgInfo([mountPoint]) })
    failedAttempts += 1
    return commandResult({ ok: false, exitCode: 16, stderr: 'resource busy' })
  },
  wait: noWait
})
assert.equal(stillMounted.ok, false)
assert.equal(stillMounted.detachDisposition, 'still_mounted_or_unknown')
assert.equal(failedAttempts, 5)

assert.equal(
  readDmgMountState(mountPoint, {
    runCommand: () => commandResult({ stdout: dmgInfo([mountPoint]) })
  }),
  'mounted'
)
assert.equal(
  readDmgMountState(mountPoint, {
    runCommand: () => commandResult({ stdout: 'not a plist' })
  }),
  'unknown'
)
assert.equal(
  readDmgMountState(mountPoint, {
    runCommand: () => commandResult({ ok: false, exitCode: 1 })
  }),
  'unknown'
)

console.log('macOS DMG detach smoke passed')

function dmgInfo(mountPoints) {
  return plist.build({
    images: mountPoints.map((value) => ({
      'system-entities': [{ 'mount-point': value }]
    }))
  })
}

function commandResult(overrides = {}) {
  const stdout = overrides.stdout ?? ''
  const stderr = overrides.stderr ?? ''
  return {
    ok: overrides.ok ?? true,
    exitCode: overrides.exitCode ?? 0,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`.trim(),
    error: null
  }
}

function noWait() {}
