#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  classifyPerformanceAttemptDisposition,
  classifyPerformanceSampleIntegrity,
  frameHealthDiagnosticsOrThrow,
  performanceMetricDeltas,
  recordPerformancePhaseAttempt
} from './lib/performance-sample-integrity.mjs'
import { renderAssistantStudioPerformanceMarkdown } from './lib/assistant-studio-performance-support.mjs'

assert.deepEqual(
  performanceMetricDeltas(
    { TaskDuration: 1, ScriptDuration: 0.5, LayoutDuration: 0.1, RecalcStyleDuration: 0.05 },
    { TaskDuration: 1.02514, ScriptDuration: 0.51103, LayoutDuration: 0.10823, RecalcStyleDuration: 0.05275 }
  ),
  { taskDurationMs: 25.14, scriptDurationMs: 11.03, layoutDurationMs: 8.23, styleDurationMs: 2.75 }
)
assert.equal(performanceMetricDeltas({ TaskDuration: null }, { TaskDuration: 1 }).taskDurationMs, null)

assert.deepEqual(
  frameHealthDiagnosticsOrThrow({ status: 'healthy', waitedMs: 48.126, maxObservedGapMs: 17.884, resetCount: 1 }),
  { waitedMs: 48.13, maxObservedGapMs: 17.88, resetCount: 1 }
)
assert.throws(
  () => frameHealthDiagnosticsOrThrow({ status: 'scheduler-contaminated', waitedMs: 5001.2, maxObservedGapMs: 68.14, resetCount: 74 }),
  (error) => {
    assert.equal(error.code, 'scheduler-contaminated')
    assert.equal(error.message, 'foreground frame health unavailable: max gap 68.1ms')
    assert.deepEqual(error.frameHealthDiagnostics, { waitedMs: 5001.2, maxObservedGapMs: 68.14, resetCount: 74 })
    return true
  }
)

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

assert.deepEqual(
  classifyPerformanceAttemptDisposition({ status: 'pass', attempt: 1, samples: [{ temperature: 'cold', durationMs: 31 }] }, { maxAttempts: 2 }),
  { action: 'accept', reason: 'attempt-passed', retryable: false, attemptsRemaining: 1 }
)
assert.deepEqual(
  classifyPerformanceAttemptDisposition({ status: 'cold-threshold-exceeded', attempt: 1, samples: [{ temperature: 'cold', durationMs: 301 }] }, { maxAttempts: 2 }),
  { action: 'retry', reason: 'cold-threshold-exceeded', retryable: true, attemptsRemaining: 1 }
)
assert.deepEqual(
  classifyPerformanceAttemptDisposition({ status: 'cold-threshold-exceeded', attempt: 2, samples: [{ temperature: 'cold', durationMs: 301 }] }, { maxAttempts: 2 }),
  { action: 'fail', reason: 'repeated-cold-threshold-exceeded', retryable: true, attemptsRemaining: 0 }
)
assert.equal(
  classifyPerformanceAttemptDisposition({ status: 'studio-data-readiness-timeout', attempt: 1, samples: [] }, { maxAttempts: 2 }).action,
  'retry'
)
assert.equal(
  classifyPerformanceAttemptDisposition({ status: 'scheduler-contaminated', attempt: 2, samples: [] }, { maxAttempts: 2 }).action,
  'fail'
)
assert.deepEqual(
  classifyPerformanceAttemptDisposition({ status: 'fail', failureCode: 'scheduler-contaminated', attempt: 1, samples: [] }, { maxAttempts: 2 }),
  { action: 'retry', reason: 'scheduler-contaminated', retryable: true, attemptsRemaining: 1 }
)
assert.deepEqual(
  classifyPerformanceAttemptDisposition({ status: 'fail', failureCode: 'scheduler-contaminated', attempt: 2, samples: [] }, { maxAttempts: 2 }),
  { action: 'fail', reason: 'repeated-scheduler-contaminated', retryable: true, attemptsRemaining: 0 }
)
assert.deepEqual(
  classifyPerformanceAttemptDisposition({ status: 'fail', attempt: 1, samples: [] }, { maxAttempts: 2 }),
  { action: 'fail', reason: 'non-retryable-failure', retryable: false, attemptsRemaining: 1 }
)

const syntheticReport = { phases: [], acceptedPhaseAttempts: {} }
const firstAttempt = {
  name: 'desktop',
  attempt: 1,
  status: 'studio-data-readiness-timeout',
  failureCode: 'studio-data-readiness-timeout',
  samples: [],
  viewport: { width: 1320, height: 860 },
  metrics: null,
  studioDataReady: null
}
const secondAttempt = {
  name: 'desktop',
  attempt: 2,
  status: 'pass',
  samples: [{ temperature: 'cold', durationMs: 31 }],
  viewport: { width: 1320, height: 860 },
  metrics: {
    cold: { count: 1, p95Ms: 31 },
    warm: { count: 20, p95Ms: 33 },
    all: { p95Ms: 33 }
  },
  studioDataReady: { fromColdSwitchStartMs: 1200 }
}
assert.equal(recordPerformancePhaseAttempt(syntheticReport, firstAttempt, { maxAttempts: 2 }).action, 'retry')
assert.equal(recordPerformancePhaseAttempt(syntheticReport, secondAttempt, { maxAttempts: 2 }).action, 'accept')
assert.equal(syntheticReport.phases.length, 2)
assert.equal(syntheticReport.phases[0].accepted, false)
assert.equal(syntheticReport.phases[1].accepted, true)
assert.equal(syntheticReport.acceptedPhaseAttempts.desktop, 2)

const syntheticMarkdown = renderAssistantStudioPerformanceMarkdown({
  status: 'pass',
  hardware: { modelIdentifier: 'test', cpuModel: 'test', memoryBytes: 1 },
  runtime: { platform: 'test', arch: 'test', electronVersion: 'test', nodeVersion: 'test' },
  phases: syntheticReport.phases,
  measurementAttempts: [{ viewport: 'desktop', attempt: 1, retryDecision: firstAttempt.retryDecision }],
  metrics: { cold: { count: 1, p95Ms: 31 }, warm: { count: 20, p95Ms: 33 }, all: { p95Ms: 33 } },
  error: null
}, 300)
assert.match(syntheticMarkdown, /desktop #1.*studio-data-readiness-timeout.*no.*0.*n\/a/)
assert.match(syntheticMarkdown, /desktop attempt 1: studio-data-readiness-timeout; failed attempt retained in report\.phases/)

console.log('performance sample integrity smoke: ok')
