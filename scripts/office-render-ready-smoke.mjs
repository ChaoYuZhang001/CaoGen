#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  captureStableOfficeScreenshot,
  DEFAULT_OFFICE_RED_AREA_RATIO,
  officeNonErrorWorkAreaIsStable
} from './lib/office-render-ready.mjs'

const intelSoftwareWebglArea = {
  nonDarkRatio: 21_869 / 63_855,
  redRatio: 718 / 21_869,
  redAreaRatio: 718 / 63_855
}

assert(intelSoftwareWebglArea.redRatio > 0.02, 'the old non-dark denominator must reproduce the Intel false positive')
assert.equal(
  officeNonErrorWorkAreaIsStable(intelSoftwareWebglArea, 0.2),
  true,
  'the real Intel frame must not turn a small red area into a flood because the scene is dark'
)
assert.equal(
  officeNonErrorWorkAreaIsStable({ ...intelSoftwareWebglArea, redAreaRatio: 0.03 }, 0.2),
  false,
  'a red area covering three percent of the work region must remain blocked'
)
assert.equal(
  officeNonErrorWorkAreaIsStable({ ...intelSoftwareWebglArea, nonDarkRatio: 0.19 }, 0.2),
  false,
  'correcting the red denominator must not weaken the readability gate'
)

const frames = [
  { nonErrorWorkArea: { nonDarkRatio: 0.19, redAreaRatio: 0.004 } },
  { nonErrorWorkArea: { nonDarkRatio: 0.34, redAreaRatio: 0.03 } },
  { nonErrorWorkArea: intelSoftwareWebglArea }
]
let captures = 0
const selected = await captureStableOfficeScreenshot(
  async () => frames[captures++],
  (frame) => frame,
  0.2,
  DEFAULT_OFFICE_RED_AREA_RATIO
)

assert.equal(captures, 3, 'stable capture must reject dark and red-flooded frames before accepting a valid frame')
assert.equal(selected, frames[2], 'stable capture must return the first frame satisfying both independent gates')

console.log('office render readiness smoke: ok')
