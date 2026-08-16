export const DEFAULT_PERFORMANCE_SAMPLE_INTEGRITY_POLICY = Object.freeze({
  thresholdMs: 300,
  minimumGapShare: 0.75,
  maximumRendererTaskShare: 0.25,
  minimumUnattributedDelayMs: 200
})

export function classifyPerformanceSampleIntegrity(sample, overrides = {}) {
  const policy = { ...DEFAULT_PERFORMANCE_SAMPLE_INTEGRITY_POLICY, ...overrides }
  const durationMs = finiteNumber(sample.durationMs)
  const maxFrameGapMs = finiteNumber(sample.maxFrameGapMs)
  const rendererTaskDurationMs = finiteNumber(sample.rendererTaskDurationMs)
  const gapShare = durationMs > 0 && maxFrameGapMs !== null ? maxFrameGapMs / durationMs : null
  const rendererTaskShare = durationMs > 0 && rendererTaskDurationMs !== null
    ? rendererTaskDurationMs / durationMs
    : null
  const unattributedDelayMs = durationMs !== null && rendererTaskDurationMs !== null
    ? Math.max(0, durationMs - rendererTaskDurationMs)
    : null
  const diagnostic = {
    status: 'valid',
    reason: 'sample-valid',
    gapShare: roundedRatio(gapShare),
    rendererTaskShare: roundedRatio(rendererTaskShare),
    unattributedDelayMs: roundedMs(unattributedDelayMs)
  }

  if (sample.temperature !== 'cold') return { ...diagnostic, reason: 'warm-sample' }
  if (durationMs === null || durationMs < policy.thresholdMs) {
    return { ...diagnostic, reason: 'within-threshold' }
  }
  if (maxFrameGapMs === null || rendererTaskDurationMs === null) {
    return { ...diagnostic, reason: 'integrity-evidence-unavailable' }
  }

  const schedulerContaminated =
    gapShare >= policy.minimumGapShare &&
    rendererTaskShare <= policy.maximumRendererTaskShare &&
    unattributedDelayMs >= policy.minimumUnattributedDelayMs

  if (!schedulerContaminated) return { ...diagnostic, reason: 'renderer-or-readiness-cost' }
  return {
    ...diagnostic,
    status: 'scheduler-contaminated',
    reason: 'dominant-unattributed-frame-gap'
  }
}

export function classifyPerformanceAttemptDisposition(phase, overrides = {}) {
  const thresholdMs = finiteNumber(overrides.thresholdMs) ?? DEFAULT_PERFORMANCE_SAMPLE_INTEGRITY_POLICY.thresholdMs
  const attempt = Math.max(1, Math.trunc(finiteNumber(overrides.attempt) ?? finiteNumber(phase?.attempt) ?? 1))
  const maxAttempts = Math.max(attempt, Math.trunc(finiteNumber(overrides.maxAttempts) ?? 1))
  const coldSample = phase?.samples?.find((sample) => sample.temperature === 'cold') ?? null
  const coldDurationMs = finiteNumber(coldSample?.durationMs)
  const retryReason = retryableAttemptReason(phase, coldDurationMs, thresholdMs)

  if (!retryReason && phase?.status === 'pass') {
    return { action: 'accept', reason: 'attempt-passed', retryable: false, attemptsRemaining: maxAttempts - attempt }
  }
  if (!retryReason) {
    return { action: 'fail', reason: 'non-retryable-failure', retryable: false, attemptsRemaining: maxAttempts - attempt }
  }
  if (attempt < maxAttempts) {
    return { action: 'retry', reason: retryReason, retryable: true, attemptsRemaining: maxAttempts - attempt }
  }
  return { action: 'fail', reason: `repeated-${retryReason}`, retryable: true, attemptsRemaining: 0 }
}

export function recordPerformancePhaseAttempt(report, phase, overrides = {}) {
  const disposition = classifyPerformanceAttemptDisposition(phase, overrides)
  phase.retryDecision = disposition
  phase.accepted = disposition.action === 'accept'
  report.phases.push(phase)
  if (phase.accepted) report.acceptedPhaseAttempts[phase.name] = phase.attempt
  return disposition
}

export function performanceMetricDeltas(before, after) {
  return {
    taskDurationMs: metricDeltaMs(before, after, 'TaskDuration'),
    scriptDurationMs: metricDeltaMs(before, after, 'ScriptDuration'),
    layoutDurationMs: metricDeltaMs(before, after, 'LayoutDuration'),
    styleDurationMs: metricDeltaMs(before, after, 'RecalcStyleDuration')
  }
}

export function frameHealthDiagnosticsOrThrow(result) {
  const diagnostics = {
    waitedMs: roundedMs(finiteNumber(result?.waitedMs)),
    maxObservedGapMs: roundedMs(finiteNumber(result?.maxObservedGapMs)),
    resetCount: Math.max(0, Math.trunc(finiteNumber(result?.resetCount) ?? 0))
  }
  if (result?.status !== 'scheduler-contaminated') return diagnostics

  const maxGap = diagnostics.maxObservedGapMs === null
    ? 'unavailable'
    : `${diagnostics.maxObservedGapMs.toFixed(1)}ms`
  const error = new Error(`foreground frame health unavailable: max gap ${maxGap}`)
  error.code = 'scheduler-contaminated'
  error.frameHealthDiagnostics = diagnostics
  throw error
}

export async function waitForFrameHealth(page) {
  const result = await page.evaluate(() => new Promise((resolve) => {
    const startedAt = performance.now()
    const deadline = startedAt + 5_000
    let consecutive = 0
    let lastFrameAt = startedAt
    let maxObservedGapMs = 0
    let resetCount = 0
    const sample = () => {
      const now = performance.now()
      const gap = now - lastFrameAt
      lastFrameAt = now
      maxObservedGapMs = Math.max(maxObservedGapMs, gap)
      if (gap <= 50) consecutive += 1
      else {
        consecutive = 0
        resetCount += 1
      }
      if (consecutive >= 4) {
        resolve({ status: 'healthy', waitedMs: now - startedAt, maxObservedGapMs, resetCount })
        return
      }
      if (now >= deadline) {
        resolve({ status: 'scheduler-contaminated', waitedMs: now - startedAt, maxObservedGapMs, resetCount })
        return
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
  return frameHealthDiagnosticsOrThrow(result)
}

function metricDeltaMs(before, after, name) {
  const previous = finiteNumber(before?.[name])
  const current = finiteNumber(after?.[name])
  if (previous === null || current === null || current < previous) return null
  return roundedMs((current - previous) * 1_000)
}

function retryableAttemptReason(phase, coldDurationMs, thresholdMs) {
  if (
    phase?.status === 'scheduler-contaminated' ||
    phase?.failureCode === 'scheduler-contaminated' ||
    phase?.coldSampleIntegrity?.status === 'scheduler-contaminated'
  ) {
    return 'scheduler-contaminated'
  }
  if (phase?.status === 'studio-data-readiness-timeout' || phase?.failureCode === 'studio-data-readiness-timeout') {
    return 'studio-data-readiness-timeout'
  }
  if (phase?.status === 'cold-threshold-exceeded' || (coldDurationMs !== null && coldDurationMs >= thresholdMs)) {
    return 'cold-threshold-exceeded'
  }
  return null
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function roundedMs(value) {
  return value === null ? null : Math.round(value * 100) / 100
}

function roundedRatio(value) {
  return value === null ? null : Math.round(value * 10_000) / 10_000
}
