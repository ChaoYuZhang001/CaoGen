export async function primeOfficeIntentPreload(page) {
  const preloadStateBeforeIntent = await page.$eval(
    '[data-sidebar-action="control-room"]',
    (button) => button.getAttribute('data-office-preload-state')
  )
  if (preloadStateBeforeIntent !== null) {
    throw new Error(`Office preload started before explicit Control Room intent: ${preloadStateBeforeIntent}`)
  }

  const startedAt = Date.now()
  await page.mouse.move(4, 4)
  await page.hover('[data-sidebar-action="control-room"]')
  await page.waitForFunction(
    () => document.querySelector('[data-sidebar-action="control-room"]')
      ?.getAttribute('data-office-preload-state') === 'ready',
    { timeout: 10_000 }
  )
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))
  return {
    trigger: 'pointerenter',
    preloadTriggered: true,
    officeModuleAndGraphicsReadyBeforeClick: true,
    preloadStateBeforeIntent,
    durationMs: Date.now() - startedAt
  }
}

export function formatOfficeActivation(measurement) {
  if (measurement.activationMode === 'pointer-immediate') {
    const before = measurement.preloadStateBeforePointer ?? 'empty'
    return `pointer-immediate / ${before} -> ${measurement.preloadStateAtClick ?? 'missing'} at click`
  }
  const intentPreload = measurement.intentPreload
  if (!intentPreload) return measurement.activationMode ?? 'direct'
  const readiness = intentPreload.officeModuleAndGraphicsReadyBeforeClick ? 'ready' : 'not ready'
  return `${intentPreload.trigger} / ${readiness} / ${intentPreload.durationMs}ms`
}

export function formatOfficeLoadMs(duration) {
  return Number.isFinite(duration) ? duration.toFixed(1) : 'n/a'
}

export function evaluateOfficeIntentPreload(measurement) {
  if (measurement.activationMode === 'pointer-immediate' && measurement.preloadStateBeforePointer !== null) {
    return [`${measurement.kind}: expected no preload before pointer intent, observed ${measurement.preloadStateBeforePointer}`]
  }
  if (measurement.activationMode === 'pointer-immediate' && measurement.preloadStateAtClick !== 'loading') {
    return [`${measurement.kind}: expected loading preload at immediate click, observed ${measurement.preloadStateAtClick ?? 'missing'}`]
  }
  if (!measurement.intentPreload) return []
  const durationMs = measurement.intentPreload.durationMs
  return Number.isFinite(durationMs) && durationMs <= 1_000
    ? []
    : [`${measurement.kind}: intent preload ${durationMs}ms exceeds 1000ms`]
}

function evaluateOfficePhaseOrder(measurement, prefix) {
  const violations = []
  if (
    Number.isFinite(measurement.shellReadyMs) &&
    Number.isFinite(measurement.canvasReadyMs) &&
    measurement.canvasReadyMs < measurement.shellReadyMs
  ) violations.push(`${prefix}Canvas mounted before the Office shell`)
  if (
    Number.isFinite(measurement.canvasReadyMs) &&
    Number.isFinite(measurement.basicNonblankMs) &&
    measurement.basicNonblankMs < measurement.canvasReadyMs
  ) violations.push(`${prefix}nonblank timing precedes Canvas mount`)
  return violations
}

function evaluateOfficeWorkers(measurement, prefix) {
  const violations = []
  if (measurement.observed?.digitalWorkers !== measurement.expectedAgents) {
    violations.push(`${prefix}observed ${measurement.observed?.digitalWorkers ?? 'missing'} digital workers, expected ${measurement.expectedAgents}`)
  }
  if (measurement.observed?.renderedDigitalWorkers !== measurement.expectedAgents) {
    violations.push(`${prefix}scene probe observed ${measurement.observed?.renderedDigitalWorkers ?? 'missing'} digital workers, expected ${measurement.expectedAgents}`)
  }
  if (measurement.observed?.sceneAssetsReady !== true) violations.push(`${prefix}business scene assets were not ready`)
  return violations
}

export function evaluateOfficeLoadPhases(measurement, budget) {
  if (!measurement) return ['missing Office load phase measurement']
  const violations = evaluateOfficeIntentPreload(measurement)
  const prefix = `${measurement.kind}: `
  const checks = [
    ['shellReadyMs', 'office shell', budget.shellReadyMsMaximum],
    ['canvasReadyMs', 'Canvas mount', budget.canvasReadyMsMaximum],
    ['basicNonblankMs', 'basic nonblank', budget.basicNonblankMsMaximum],
    ['interactiveReadyMs', 'interactive ready', budget.interactiveReadyMsMaximum],
    ['sceneAssetsReadyMs', 'business scene assets ready', budget.sceneAssetsReadyMsMaximum],
    ['charactersReadyMs', '3D digital workers ready', budget.charactersReadyMsMaximum]
  ]
  for (const [field, label, maximum] of checks) {
    const value = measurement[field]
    if (!Number.isFinite(value)) violations.push(`${prefix}${label} timing is missing`)
    else if (value > maximum) violations.push(`${prefix}${label} ${value.toFixed(1)}ms exceeds ${maximum}ms`)
  }
  violations.push(...evaluateOfficePhaseOrder(measurement, prefix))
  violations.push(...evaluateOfficeWorkers(measurement, prefix))
  return violations
}
