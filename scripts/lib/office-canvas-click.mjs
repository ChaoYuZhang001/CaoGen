const FACILITY_RETRY_OFFSETS = [
  [0, 0],
  [0, -6],
  [0, 6],
  [-8, 0],
  [8, 0]
]
const WORKSTATION_RETRY_OFFSETS = [
  [0, 0],
  [0, -8],
  [0, 8],
  [-12, 0],
  [12, 0]
]
const WALKER_TARGET_RETRY_OFFSETS = [
  [0, 0],
  [0, -8],
  [-10, -6],
  [10, -6],
  [0, 8],
  [-14, 0],
  [14, 0]
]
const WALKER_PATH_STEP = 0.35
const WALKER_CLICK_HEIGHT = 2.35
const WALKER_HOME_EXCLUSION_DISTANCE = 1.4
const WALKER_SELECTION_SETTLE_MS = 130
const WALKER_SCAN_TIMEOUT_MS = 20_000
const CAMERA_RESET_MIN_BUDGET_MS = 1_500

export async function clickProjectedFacilityTarget(page, target, camera) {
  let lastState
  for (let attempt = 0; attempt < FACILITY_RETRY_OFFSETS.length; attempt += 1) {
    if (attempt > 0) await resetFacilitiesCamera(page)
    const [offsetX, offsetY] = FACILITY_RETRY_OFFSETS[attempt]
    const click = await clickProjectedOfficeTarget(page, target, camera, { offsetX, offsetY })
    lastState = await waitForFacilitySelection(page, target.id, 1_250)
    if (lastState.selected === target.id && lastState.panel === target.id) {
      return { ...click, attempt: attempt + 1 }
    }
  }
  throw new Error(`facility canvas click did not select ${target.id}: ${JSON.stringify(lastState)}`)
}

export async function clickProjectedWorkstationTarget(page, target, camera) {
  const initialState = await readOfficeSessionSelection(page)
  assert(
    initialState.selected !== target.id,
    `workstation target is already selected before a canvas click: ${JSON.stringify({ target, initialState })}`
  )
  let lastState = initialState

  for (let attempt = 0; attempt < WORKSTATION_RETRY_OFFSETS.length; attempt += 1) {
    if (attempt > 0 && (lastState.preset !== 'overview' || lastState.selectedFacility)) {
      await resetOverviewCamera(page)
    }
    const [offsetX, offsetY] = WORKSTATION_RETRY_OFFSETS[attempt]
    const click = await clickProjectedOfficeTarget(page, target, camera, { offsetX, offsetY })
    lastState = await waitForOfficeState(
      page,
      (state) => isAgentSelection(state, target.id, 'workstation', initialState.hitSeq),
      600
    )
    if (isAgentSelection(lastState, target.id, 'workstation', initialState.hitSeq)) {
      return { ...click, attempt: attempt + 1, receipt: hitReceipt(lastState) }
    }
  }

  throw new Error(`workstation canvas click did not select ${target.id}: ${JSON.stringify(lastState)}`)
}

export async function clickProjectedWalkerPath(page, home, target, camera) {
  assert(home?.id && home.id === target?.id, `walker path endpoints do not share a session: ${JSON.stringify({ home, target })}`)
  const initialState = await readOfficeSessionSelection(page)
  assert(
    initialState.selected !== target.id,
    `walker path target is already selected before a canvas click: ${JSON.stringify({ target, initialState })}`
  )
  const samples = sampleOfficePath(home, target)
  const deadline = Date.now() + WALKER_SCAN_TIMEOUT_MS
  let lastState = initialState
  let attempt = 0
  let sweep = 0
  const trace = []

  scan: while (Date.now() < deadline) {
    sweep += 1
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const sample = samples[sampleIndex]
      const offsets = sweep === 1 ? [[0, 0]] : sampleIndex < 3 ? WALKER_TARGET_RETRY_OFFSETS : [[0, 0]]
      for (const [offsetX, offsetY] of offsets) {
        attempt += 1
        const click = await clickProjectedOfficeTarget(page, sample, camera, { offsetX, offsetY })
        lastState = await waitForOfficeState(
          page,
          (state) => isCanvasHit(state, target.id, 'walker', initialState.hitSeq) && state.selected === target.id,
          WALKER_SELECTION_SETTLE_MS
        )
        trace.push({ attempt, sweep, pathDistance: Number(sample.pathDistance.toFixed(2)), click, state: lastState })
        if (trace.length > 12) trace.shift()
        if (isCanvasHit(lastState, target.id, 'walker', initialState.hitSeq) && lastState.selected === target.id) {
          return {
            ...click,
            attempt,
            sweep,
            sampleCount: samples.length,
            pathDistance: Number(sample.pathDistance.toFixed(2)),
            receipt: hitReceipt(lastState)
          }
        }
        if (lastState.preset !== 'facilities' || lastState.selectedFacility) {
          if (deadline - Date.now() < CAMERA_RESET_MIN_BUDGET_MS) break scan
          await restoreFacilitiesCamera(page, lastState, deadline)
          lastState = await readOfficeSessionSelection(page)
          break
        }
        if (Date.now() >= deadline) break scan
      }
      if (Date.now() >= deadline) break scan
    }
  }

  throw new Error(
    `walker canvas path did not select ${target.id}: ${JSON.stringify({ lastState, samples: samples.length, attempts: attempt, sweeps: sweep, trace })}`
  )
}

export async function clickProjectedOfficeTarget(
  page,
  target,
  camera,
  { offsetX = 0, offsetY = 0 } = {}
) {
  const rect = await officeCanvasRect(page)
  assert(rect && rect.width >= 300 && rect.height >= 200, `office canvas rect unavailable: ${JSON.stringify(rect)}`)
  const projected = projectOfficePoint(target, rect, camera)
  projected.x += offsetX
  projected.y += offsetY
  assert(
    projected.x >= rect.left && projected.x <= rect.left + rect.width &&
      projected.y >= rect.top && projected.y <= rect.top + rect.height,
    `projected office click outside canvas: ${JSON.stringify({ target, rect, projected })}`
  )
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return {
      tag: element?.tagName ?? '',
      className: typeof element?.className === 'string' ? element.className : '',
      isCanvas: element?.tagName === 'CANVAS'
    }
  }, projected)
  assert(hit.isCanvas, `projected office click is covered before reaching canvas: ${JSON.stringify({ target, projected, hit })}`)
  await page.mouse.click(Math.round(projected.x), Math.round(projected.y))
  return {
    x: Math.round(projected.x),
    y: Math.round(projected.y),
    ndcX: Number(projected.ndcX.toFixed(3)),
    ndcY: Number(projected.ndcY.toFixed(3))
  }
}

async function resetFacilitiesCamera(page, deadline = Number.POSITIVE_INFINITY) {
  await page.click('.office-camera-button:nth-child(1)')
  await waitForCameraPreset(page, 'overview', remainingTimeout(deadline, 5_000))
  await page.click('.office-camera-button:nth-child(3)')
  await waitForCameraPreset(page, 'facilities', remainingTimeout(deadline, 5_000))
  await sleep(Math.min(1_300, remainingTimeout(deadline, 1_300)))
}

async function restoreFacilitiesCamera(page, state, deadline) {
  if (state.selectedFacility) {
    await resetFacilitiesCamera(page, deadline)
    return
  }
  await page.click('.office-camera-button:nth-child(3)')
  await waitForCameraPreset(page, 'facilities', remainingTimeout(deadline, 5_000))
  await sleep(Math.min(1_300, remainingTimeout(deadline, 1_300)))
}

async function resetOverviewCamera(page) {
  await page.click('.office-camera-button:nth-child(1)')
  await waitForCameraPreset(page, 'overview')
  await sleep(1_300)
}

async function waitForCameraPreset(page, expected, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const preset = await page.evaluate(() =>
      document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-active-camera-preset') ?? ''
    )
    if (preset === expected) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for office camera preset ${expected}`)
}

async function waitForFacilitySelection(page, expected, timeout) {
  const deadline = Date.now() + timeout
  let last = { selected: '', panel: '' }
  while (Date.now() < deadline) {
    last = await page.evaluate(() => ({
      selected: document.querySelector('.office-canvas-wrap')?.getAttribute('data-office-selected-facility') ?? '',
      panel: document.querySelector('.office-facility-panel')?.getAttribute('data-office-facility-panel') ?? ''
    }))
    if (last.selected === expected && last.panel === expected) return last
    if (last.selected && last.selected !== expected) return last
    await sleep(100)
  }
  return last
}

async function waitForOfficeState(page, predicate, timeout) {
  const deadline = Date.now() + timeout
  let last = await readOfficeSessionSelection(page)
  while (Date.now() < deadline) {
    if (predicate(last)) return last
    await sleep(30)
    last = await readOfficeSessionSelection(page)
  }
  return last
}

async function readOfficeSessionSelection(page) {
  return page.evaluate(() => {
    const wrap = document.querySelector('.office-canvas-wrap')
    return {
      selected: wrap?.getAttribute('data-office-selected-session') ?? '',
      preset: wrap?.getAttribute('data-office-active-camera-preset') ?? '',
      selectedFacility: wrap?.getAttribute('data-office-selected-facility') ?? '',
      panel: document.querySelector('.office-selection-panel')?.getAttribute('data-office-selection-panel') ?? '',
      hitSeq: Number(wrap?.getAttribute('data-office-last-hit-seq') ?? 0),
      hitKind: wrap?.getAttribute('data-office-last-hit-kind') ?? '',
      hitId: wrap?.getAttribute('data-office-last-hit-id') ?? ''
    }
  })
}

function isAgentSelection(state, expected, kind, afterSeq) {
  return isCanvasHit(state, expected, kind, afterSeq) && state.selected === expected && state.panel === expected && state.preset === 'agent'
}

function isCanvasHit(state, expected, kind, afterSeq) {
  return state.hitSeq > afterSeq && state.hitKind === kind && state.hitId === expected
}

function hitReceipt(state) {
  return { seq: state.hitSeq, kind: state.hitKind, id: state.hitId }
}

function remainingTimeout(deadline, maximum) {
  if (!Number.isFinite(deadline)) return maximum
  return Math.max(1, Math.min(maximum, deadline - Date.now()))
}

async function officeCanvasRect(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.office canvas')
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height }
  })
}

function projectOfficePoint(target, rect, camera) {
  const forward = normalize(subtract(camera.target, camera.position))
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = normalize(cross(right, forward))
  const relative = subtract([target.x, target.y, target.z], camera.position)
  const depth = dot(relative, forward)
  assert(depth > 0.1, `office target is behind camera: ${JSON.stringify({ target, depth, camera })}`)
  const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * depth
  const halfWidth = halfHeight * (rect.width / rect.height)
  const ndcX = dot(relative, right) / halfWidth
  const ndcY = dot(relative, up) / halfHeight
  return {
    x: rect.left + ((ndcX + 1) / 2) * rect.width,
    y: rect.top + ((1 - ndcY) / 2) * rect.height,
    ndcX,
    ndcY
  }
}

function sampleOfficePath(home, target) {
  const dx = target.x - home.x
  const dz = target.z - home.z
  const distance = Math.hypot(dx, dz)
  assert(
    distance > WALKER_HOME_EXCLUSION_DISTANCE,
    `walker path is too short to clear its workstation hitbox: ${JSON.stringify({ home, target, distance })}`
  )
  const samples = []
  for (let pathDistance = distance; pathDistance > WALKER_HOME_EXCLUSION_DISTANCE; pathDistance -= WALKER_PATH_STEP) {
    const progress = pathDistance / distance
    samples.push({
      id: target.id,
      x: home.x + dx * progress,
      y: WALKER_CLICK_HEIGHT,
      z: home.z + dz * progress,
      pathDistance
    })
  }
  samples.push({
    id: target.id,
    x: home.x + (dx * WALKER_HOME_EXCLUSION_DISTANCE) / distance,
    y: WALKER_CLICK_HEIGHT,
    z: home.z + (dz * WALKER_HOME_EXCLUSION_DISTANCE) / distance,
    pathDistance: WALKER_HOME_EXCLUSION_DISTANCE
  })
  return samples
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function normalize(value) {
  const length = Math.hypot(value[0], value[1], value[2]) || 1
  return [value[0] / length, value[1] / length, value[2] / length]
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
