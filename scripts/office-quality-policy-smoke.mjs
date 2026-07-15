#!/usr/bin/env node

import assert from 'node:assert/strict'
import {
  initialOfficeAutoQuality,
  nextOfficeAutoQuality,
  OFFICE_QUALITY_PROFILES
} from '../src/renderer/src/components/office/quality.ts'

assert.deepEqual(Object.keys(OFFICE_QUALITY_PROFILES), ['high', 'balanced', 'low'])
assert.equal(OFFICE_QUALITY_PROFILES.high.contactShadows, 'dynamic')
assert.equal(OFFICE_QUALITY_PROFILES.balanced.contactShadows, 'static')
assert.equal(OFFICE_QUALITY_PROFILES.low.contactShadows, 'off')
assert.equal(OFFICE_QUALITY_PROFILES.low.shadows, false)

const overloadedBalanced = { medianFrameMs: 50, p95FrameMs: 70 }
const overloadedHigh = { medianFrameMs: 30, p95FrameMs: 40 }
const healthyLow = { medianFrameMs: 20, p95FrameMs: 28 }
const healthyBalanced = { medianFrameMs: 12, p95FrameMs: 18 }
const middleBand = { medianFrameMs: 30, p95FrameMs: 40 }

let state = initialOfficeAutoQuality(0)
state = nextOfficeAutoQuality(state, overloadedBalanced, 5_000)
assert.equal(state.tier, 'balanced', 'one slow window must not downgrade during cold-start pressure')
state = nextOfficeAutoQuality(state, overloadedBalanced, 10_000)
assert.equal(state.tier, 'low', 'sustained slow Balanced frames must downgrade to Low')
assert.equal(state.upgradeBlockedUntil, 70_000, 'a downgrade must block an immediate retry')

for (const now of [20_000, 30_000, 40_000, 50_000, 60_000]) {
  state = nextOfficeAutoQuality(state, healthyLow, now)
  assert.equal(state.tier, 'low', 'Low must remain locked during downgrade backoff')
}
state = nextOfficeAutoQuality(state, healthyLow, 71_000)
assert.equal(state.tier, 'balanced', 'sustained healthy Low frames may retry Balanced after backoff')
assert.equal(state.probationTier, 'low', 'an upgrade must enter probation')

state = nextOfficeAutoQuality(state, overloadedBalanced, 76_000)
assert.equal(state.tier, 'balanced', 'one failed-probation window must not immediately roll back')
state = nextOfficeAutoQuality(state, overloadedBalanced, 81_000)
assert.equal(state.tier, 'low', 'a failed Balanced probation must roll back to Low')
assert.equal(state.upgradeFailures, 1)
assert.equal(state.upgradeBlockedUntil, 201_000, 'a failed retry must double the upgrade backoff')
state = nextOfficeAutoQuality(state, healthyLow, 130_000)
assert.equal(state.tier, 'low', 'failed upgrade backoff must prevent a fast Low/Balanced cycle')

state = initialOfficeAutoQuality(0)
for (const now of [2_000, 4_000, 6_000, 8_000, 10_000, 12_000]) {
  state = nextOfficeAutoQuality(state, healthyBalanced, now)
}
assert.equal(state.tier, 'high', 'sustained fast Balanced frames must permit High probation')
state = nextOfficeAutoQuality(state, overloadedHigh, 17_000)
assert.equal(state.tier, 'high', 'one slow High window must not fail probation')
state = nextOfficeAutoQuality(state, overloadedHigh, 22_000)
assert.equal(state.tier, 'balanced', 'a failed High probation must roll back to Balanced')
assert.equal(state.upgradeFailures, 1)
assert.equal(state.upgradeBlockedUntil, 142_000)

state = nextOfficeAutoQuality(initialOfficeAutoQuality(0), middleBand, 20_000)
assert.equal(state.tier, 'balanced', 'the hysteresis middle band must not change tiers')

state = initialOfficeAutoQuality(0)
for (const now of [2_000, 4_000, 6_000, 8_000, 10_000, 12_000]) {
  state = nextOfficeAutoQuality(state, healthyBalanced, now)
}
state = nextOfficeAutoQuality(state, { medianFrameMs: 16, p95FrameMs: 22 }, 21_000)
assert.equal(state.probationTier, null, 'a stable upgraded tier must complete probation')
assert.equal(state.upgradeFailures, 0, 'successful probation must reset prior upgrade failures')
state = nextOfficeAutoQuality(state, overloadedHigh, 100_000)
state = nextOfficeAutoQuality(state, overloadedHigh, 105_000)
assert.equal(state.tier, 'balanced', 'new workload pressure may still downgrade after successful probation')
assert.equal(state.upgradeFailures, 0, 'a later workload change is not a failed upgrade trial')
assert.equal(state.upgradeBlockedUntil, 165_000, 'a normal later downgrade uses the base retry backoff')

console.log('office quality policy smoke: pass')
