#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  classifyPerformanceSampleIntegrity,
  performanceMetricDeltas
} from './lib/performance-sample-integrity.mjs'

assert.deepEqual(
  performanceMetricDeltas(
    { TaskDuration: 1, ScriptDuration: 0.5, LayoutDuration: 0.1, RecalcStyleDuration: 0.05 },
    { TaskDuration: 1.02514, ScriptDuration: 0.51103, LayoutDuration: 0.10823, RecalcStyleDuration: 0.05275 }
  ),
  { taskDurationMs: 25.14, scriptDurationMs: 11.03, layoutDurationMs: 8.23, styleDurationMs: 2.75 }
)
assert.equal(performanceMetricDeltas({ TaskDuration: null }, { TaskDuration: 1 }).taskDurationMs, null)

const contaminated = classifyPerformanceSampleIntegrity({
  temperature: 'cold',
  durationMs: 410.6,
  maxFrameGapMs: 383.3,
  rendererTaskDurationMs: 18.4
})
assert.equal(contaminated.status, 'scheduler-contaminated')
assert.equal(contaminated.reason, 'dominant-unattributed-frame-gap')

const rendererLongTask = classifyPerformanceSampleIntegrity({
  temperature: 'cold',
  durationMs: 410.6,
  maxFrameGapMs: 383.3,
  rendererTaskDurationMs: 350
})
assert.equal(rendererLongTask.status, 'valid')
assert.equal(rendererLongTask.reason, 'renderer-or-readiness-cost')

const slowReadiness = classifyPerformanceSampleIntegrity({
  temperature: 'cold',
  durationMs: 410.6,
  maxFrameGapMs: 34,
  rendererTaskDurationMs: 18.4
})
assert.equal(slowReadiness.status, 'valid')
assert.equal(slowReadiness.reason, 'renderer-or-readiness-cost')

const missingEvidence = classifyPerformanceSampleIntegrity({
  temperature: 'cold',
  durationMs: 410.6,
  maxFrameGapMs: 383.3,
  rendererTaskDurationMs: null
})
assert.equal(missingEvidence.status, 'valid')
assert.equal(missingEvidence.reason, 'integrity-evidence-unavailable')

const withinThreshold = classifyPerformanceSampleIntegrity({
  temperature: 'cold',
  durationMs: 211.7,
  maxFrameGapMs: 207.9,
  rendererTaskDurationMs: 8
})
assert.equal(withinThreshold.status, 'valid')
assert.equal(withinThreshold.reason, 'within-threshold')

console.log('performance sample integrity smoke: ok')
