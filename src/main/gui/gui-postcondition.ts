export type GuiPostconditionKind = 'window' | 'element' | 'visual'
export type GuiPostconditionState =
  | 'exists'
  | 'absent'
  | 'enabled'
  | 'disabled'
  | 'visible'
  | 'hidden'
  | 'changed'
  | 'unchanged'

export interface GuiPostcondition {
  kind: GuiPostconditionKind
  state: GuiPostconditionState
  windowId?: string
  title?: string
  processName?: string
  pid?: number
  elementId?: string
  elementName?: string
  automationId?: string
  className?: string
  controlType?: string
  elementIndex?: number
  maxElements?: number
  sourceId?: string
  minimumChangedRatio?: number
  maximumChangedRatio?: number
  pixelDifferenceThreshold?: number
  timeoutMs: number
  intervalMs: number
}

interface ObservedBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface GuiObservedElement {
  id: string
  index: number
  name: string
  automationId: string
  className: string
  controlType: string
  bounds: ObservedBounds
  enabled: boolean
  offscreen: boolean
}

export interface GuiObservedWindow {
  id: string
  title?: string
  name: string
  processName?: string
  pid?: number
  elements?: GuiObservedElement[]
}

export interface GuiObservationResult {
  ok: boolean
  windows: GuiObservedWindow[]
  error?: string
}

export interface GuiPostconditionVerification {
  status: 'passed' | 'failed'
  kind: GuiPostconditionKind
  state: GuiPostconditionState
  attempts: number
  durationMs: number
  observed: {
    windowCount: number
    elementCount: number
    matchedWindow?: Pick<GuiObservedWindow, 'id' | 'title' | 'name' | 'processName' | 'pid'>
    matchedElement?: Pick<
      GuiObservedElement,
      'id' | 'index' | 'name' | 'automationId' | 'className' | 'controlType' | 'enabled' | 'offscreen'
    >
    visual?: {
      sourceId: string
      width: number
      height: number
      baselineDigest: string
      currentDigest: string
      changedPixelRatio: number
      pixelDifferenceThreshold: number
    }
  }
  error?: string
}

export interface GuiVisualCapture {
  ok: boolean
  sourceId?: string
  width?: number
  height?: number
  digest?: string
  pixels?: Uint8Array
  error?: string
}

export interface GuiVisualBaseline {
  sourceId: string
  width: number
  height: number
  digest: string
  pixels: Uint8Array
}

export type GuiVisualCaptureObserver = (input: {
  sourceId?: string
  windowId?: string
  title?: string
  processName?: string
  pid?: number
  maxWidth?: number
}) => Promise<GuiVisualCapture>

export type GuiPostconditionObserver = (
  input: Omit<GuiPostcondition, 'kind' | 'state' | 'timeoutMs' | 'intervalMs'> & {
    includeElements: boolean
  }
) => Promise<GuiObservationResult>

const ALLOWED_KEYS = new Set([
  'kind', 'state', 'windowId', 'title', 'processName', 'pid',
  'elementId', 'elementName', 'automationId', 'className', 'controlType',
  'elementIndex', 'maxElements', 'sourceId', 'minimumChangedRatio', 'maximumChangedRatio',
  'pixelDifferenceThreshold', 'timeoutMs', 'intervalMs'
])
const WINDOW_STATES = new Set<GuiPostconditionState>(['exists', 'absent'])
const ELEMENT_STATES = new Set<GuiPostconditionState>([
  'exists', 'absent', 'enabled', 'disabled', 'visible', 'hidden'
])
const VISUAL_STATES = new Set<GuiPostconditionState>(['changed', 'unchanged'])

export function normalizeGuiPostcondition(value: unknown): GuiPostcondition | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('postcondition 必须是对象')
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) throw new Error(`postcondition 包含未知字段: ${unknown.join(', ')}`)
  const kind = record.kind
  const state = record.state
  if (kind !== 'window' && kind !== 'element' && kind !== 'visual') {
    throw new Error('postcondition.kind 必须是 window、element 或 visual')
  }
  const allowedStates = kind === 'window' ? WINDOW_STATES : kind === 'element' ? ELEMENT_STATES : VISUAL_STATES
  if (typeof state !== 'string' || !allowedStates.has(state as GuiPostconditionState)) {
    throw new Error(`postcondition.state 不支持 ${String(state)}`)
  }
  const windowSelector = normalizeStringSelectors(record, ['windowId', 'title', 'processName', 'sourceId'])
  const pid = optionalInteger(record.pid, 'postcondition.pid', 1)
  if (Object.keys(windowSelector).length === 0 && pid === undefined) {
    throw new Error('postcondition 必须绑定 windowId、title、processName、pid 或 sourceId')
  }
  const elementSelector = normalizeStringSelectors(record, [
    'elementId', 'elementName', 'automationId', 'className', 'controlType'
  ])
  const elementIndex = optionalInteger(record.elementIndex, 'postcondition.elementIndex', 0)
  if (kind === 'element' && Object.keys(elementSelector).length === 0 && elementIndex === undefined) {
    throw new Error('element postcondition 必须绑定明确元素 selector')
  }
  if (kind !== 'visual' && record.sourceId !== undefined) {
    throw new Error('postcondition.sourceId 仅支持 visual')
  }
  const minimumChangedRatio = optionalRatio(record.minimumChangedRatio, 'postcondition.minimumChangedRatio')
  const maximumChangedRatio = optionalRatio(record.maximumChangedRatio, 'postcondition.maximumChangedRatio')
  if (kind !== 'visual' && (minimumChangedRatio !== undefined || maximumChangedRatio !== undefined || record.pixelDifferenceThreshold !== undefined)) {
    throw new Error('视觉阈值仅支持 visual postcondition')
  }
  if (state === 'changed' && maximumChangedRatio !== undefined) {
    throw new Error('changed 不接受 maximumChangedRatio')
  }
  if (minimumChangedRatio === 0) {
    throw new Error('minimumChangedRatio 必须大于 0')
  }
  if (state === 'unchanged' && minimumChangedRatio !== undefined) {
    throw new Error('unchanged 不接受 minimumChangedRatio')
  }
  return {
    kind,
    state: state as GuiPostconditionState,
    ...windowSelector,
    ...(pid === undefined ? {} : { pid }),
    ...elementSelector,
    ...(elementIndex === undefined ? {} : { elementIndex }),
    ...(minimumChangedRatio === undefined ? {} : { minimumChangedRatio }),
    ...(maximumChangedRatio === undefined ? {} : { maximumChangedRatio }),
    ...(record.pixelDifferenceThreshold === undefined
      ? {}
      : { pixelDifferenceThreshold: requiredInteger(record.pixelDifferenceThreshold, 'postcondition.pixelDifferenceThreshold', 0, 255) }),
    ...(record.maxElements === undefined
      ? {}
      : { maxElements: requiredInteger(record.maxElements, 'postcondition.maxElements', 1, 300) }),
    timeoutMs: record.timeoutMs === undefined
      ? 1_500
      : requiredInteger(record.timeoutMs, 'postcondition.timeoutMs', 0, 5_000),
    intervalMs: record.intervalMs === undefined
      ? 150
      : requiredInteger(record.intervalMs, 'postcondition.intervalMs', 50, 1_000)
  }
}

export async function captureGuiVisualBaseline(
  capture: GuiVisualCaptureObserver,
  postcondition: GuiPostcondition,
  signal?: AbortSignal
): Promise<{ ok: true; baseline: GuiVisualBaseline } | { ok: false; error: string }> {
  if (postcondition.kind !== 'visual') return { ok: false, error: '仅 visual postcondition 需要视觉基线' }
  if (signal?.aborted) return { ok: false, error: 'postcondition 基线捕获已中断' }
  const value = await capture(visualCaptureInput(postcondition))
  const validated = validateVisualCapture(value)
  if ('error' in validated) return validated
  return { ok: true, baseline: validated.capture }
}

export async function verifyGuiVisualPostcondition(
  capture: GuiVisualCaptureObserver,
  postcondition: GuiPostcondition,
  baseline: GuiVisualBaseline,
  signal?: AbortSignal
): Promise<GuiPostconditionVerification> {
  const startedAt = Date.now()
  const deadline = startedAt + postcondition.timeoutMs
  let attempts = 0
  let observed = emptyObserved()
  while (true) {
    if (signal?.aborted) return failed(postcondition, attempts, startedAt, observed, 'postcondition 验证已中断')
    attempts += 1
    const value = await capture({ sourceId: baseline.sourceId, maxWidth: 1440 })
    const validated = validateVisualCapture(value)
    if ('error' in validated) {
      return failed(postcondition, attempts, startedAt, observed, validated.error)
    } else {
      const current = validated.capture
      if (current.sourceId !== baseline.sourceId) {
        return failed(postcondition, attempts, startedAt, observed, '视觉断言截图源发生漂移')
      }
      if (current.width !== baseline.width || current.height !== baseline.height || current.pixels.length !== baseline.pixels.length) {
        return failed(postcondition, attempts, startedAt, observed, '视觉断言截图尺寸发生变化')
      }
      const pixelDifferenceThreshold = postcondition.pixelDifferenceThreshold ?? 16
      const changedPixelRatio = visualChangedPixelRatio(baseline.pixels, current.pixels, pixelDifferenceThreshold)
      observed = {
        windowCount: 0,
        elementCount: 0,
        visual: {
          sourceId: baseline.sourceId,
          width: baseline.width,
          height: baseline.height,
          baselineDigest: baseline.digest,
          currentDigest: current.digest,
          changedPixelRatio,
          pixelDifferenceThreshold
        }
      }
      if (postcondition.state === 'changed' && changedPixelRatio >= (postcondition.minimumChangedRatio ?? 0.0001)) {
        return passedVisual(postcondition, attempts, startedAt, observed)
      }
      if (postcondition.state === 'unchanged' && changedPixelRatio > (postcondition.maximumChangedRatio ?? 0.001)) {
        return failed(postcondition, attempts, startedAt, observed, `视觉变化比例 ${changedPixelRatio} 超过上限`)
      }
    }
    const now = Date.now()
    if (now >= deadline) {
      if (postcondition.state === 'unchanged') return passedVisual(postcondition, attempts, startedAt, observed)
      return failed(postcondition, attempts, startedAt, observed, '视觉变化未达到预期阈值')
    }
    await abortableDelay(Math.min(postcondition.intervalMs, deadline - now), signal)
  }
}

export async function verifyGuiPostcondition(
  observe: GuiPostconditionObserver,
  postcondition: GuiPostcondition,
  signal?: AbortSignal
): Promise<GuiPostconditionVerification> {
  if (postcondition.kind === 'visual') {
    return failed(postcondition, 0, Date.now(), emptyObserved(), 'visual postcondition 必须使用动作前基线验证')
  }
  const startedAt = Date.now()
  const deadline = startedAt + postcondition.timeoutMs
  let attempts = 0
  let lastObserved = emptyObserved()
  let lastError: string | undefined
  while (true) {
    if (signal?.aborted) {
      return failed(postcondition, attempts, startedAt, lastObserved, 'postcondition 验证已中断')
    }
    attempts += 1
    const observation = await observe({
      ...selectorFields(postcondition),
      includeElements: postcondition.kind === 'element'
    })
    if (observation.ok) {
      const assessment = assessObservation(postcondition, observation.windows)
      lastObserved = assessment.observed
      lastError = undefined
      if (assessment.passed) {
        return {
          status: 'passed',
          kind: postcondition.kind,
          state: postcondition.state,
          attempts,
          durationMs: Date.now() - startedAt,
          observed: lastObserved
        }
      }
    } else {
      lastObserved = emptyObserved()
      lastError = observation.error || 'GUI observation failed'
    }
    const now = Date.now()
    if (now >= deadline) {
      return failed(
        postcondition,
        attempts,
        startedAt,
        lastObserved,
        lastError ?? `postcondition 未达到预期状态 ${postcondition.state}`
      )
    }
    await abortableDelay(Math.min(postcondition.intervalMs, deadline - now), signal)
  }
}

function assessObservation(postcondition: GuiPostcondition, windows: GuiObservedWindow[]) {
  const matchedWindow = windows.find((window) => matchesWindow(window, postcondition))
  const elements = matchedWindow?.elements ?? []
  const matchedElement = elements.find((element) => matchesElement(element, postcondition))
  const passed = postcondition.kind === 'window'
    ? postcondition.state === 'exists' ? Boolean(matchedWindow) : !matchedWindow
    : assessElementState(postcondition.state, matchedElement)
  return {
    passed,
    observed: {
      windowCount: windows.length,
      elementCount: elements.length,
      ...(matchedWindow ? { matchedWindow: publicWindow(matchedWindow) } : {}),
      ...(matchedElement ? { matchedElement: publicElement(matchedElement) } : {})
    }
  }
}

function assessElementState(state: GuiPostconditionState, element: GuiObservedElement | undefined): boolean {
  if (state === 'absent') return !element
  if (!element) return false
  if (state === 'exists') return true
  if (state === 'enabled') return element.enabled
  if (state === 'disabled') return !element.enabled
  const visible = !element.offscreen && element.bounds.width > 0 && element.bounds.height > 0
  return state === 'visible' ? visible : !visible
}

function validateVisualCapture(value: GuiVisualCapture):
  | { ok: true; capture: GuiVisualBaseline }
  | { ok: false; error: string } {
  if (!value.ok) return { ok: false, error: value.error || '视觉截图失败' }
  if (!value.sourceId || !value.digest || !Number.isInteger(value.width) || !Number.isInteger(value.height) ||
      !value.pixels || value.width! <= 0 || value.height! <= 0 || value.pixels.length !== value.width! * value.height! * 4) {
    return { ok: false, error: '视觉截图为空或元数据无效' }
  }
  return {
    ok: true,
    capture: {
      sourceId: value.sourceId,
      width: value.width!,
      height: value.height!,
      digest: value.digest,
      pixels: value.pixels
    }
  }
}

function visualCaptureInput(postcondition: GuiPostcondition) {
  return {
    sourceId: postcondition.sourceId,
    windowId: postcondition.windowId,
    title: postcondition.title,
    processName: postcondition.processName,
    pid: postcondition.pid,
    maxWidth: 1440
  }
}

function visualChangedPixelRatio(before: Uint8Array, after: Uint8Array, threshold: number): number {
  let changed = 0
  const pixels = before.length / 4
  for (let index = 0; index < before.length; index += 4) {
    if (Math.abs(before[index] - after[index]) > threshold ||
        Math.abs(before[index + 1] - after[index + 1]) > threshold ||
        Math.abs(before[index + 2] - after[index + 2]) > threshold) changed += 1
  }
  return changed / pixels
}

function passedVisual(
  postcondition: GuiPostcondition,
  attempts: number,
  startedAt: number,
  observed: GuiPostconditionVerification['observed']
): GuiPostconditionVerification {
  return {
    status: 'passed',
    kind: postcondition.kind,
    state: postcondition.state,
    attempts,
    durationMs: Date.now() - startedAt,
    observed
  }
}

function matchesWindow(window: GuiObservedWindow, selector: GuiPostcondition): boolean {
  if (selector.windowId && window.id !== selector.windowId) return false
  if (selector.title && !includes(window.title ?? window.name, selector.title)) return false
  if (selector.processName && !includes(window.processName ?? window.name, selector.processName)) return false
  if (selector.pid !== undefined && window.pid !== selector.pid) return false
  return true
}

function matchesElement(element: GuiObservedElement, selector: GuiPostcondition): boolean {
  if (selector.elementId && element.id !== selector.elementId) return false
  if (selector.elementName && !includes(element.name, selector.elementName)) return false
  if (selector.automationId && !includes(element.automationId, selector.automationId)) return false
  if (selector.className && !includes(element.className, selector.className)) return false
  if (selector.controlType && !includes(element.controlType, selector.controlType)) return false
  if (selector.elementIndex !== undefined && element.index !== selector.elementIndex) return false
  return true
}

function selectorFields(postcondition: GuiPostcondition) {
  const {
    kind: _kind,
    state: _state,
    timeoutMs: _timeoutMs,
    intervalMs: _intervalMs,
    ...selector
  } = postcondition
  return selector
}

function publicWindow(window: GuiObservedWindow) {
  const { id, title, name, processName, pid } = window
  return { id, title, name, processName, pid }
}

function publicElement(element: GuiObservedElement) {
  const { id, index, name, automationId, className, controlType, enabled, offscreen } = element
  return { id, index, name, automationId, className, controlType, enabled, offscreen }
}

function failed(
  postcondition: GuiPostcondition,
  attempts: number,
  startedAt: number,
  observed: GuiPostconditionVerification['observed'],
  error: string
): GuiPostconditionVerification {
  return {
    status: 'failed',
    kind: postcondition.kind,
    state: postcondition.state,
    attempts,
    durationMs: Date.now() - startedAt,
    observed,
    error
  }
}

function emptyObserved(): GuiPostconditionVerification['observed'] {
  return { windowCount: 0, elementCount: 0 }
}

function normalizeStringSelectors(record: Record<string, unknown>, keys: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of keys) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || !value.trim()) throw new Error(`postcondition.${key} 必须是非空字符串`)
    result[key] = value.trim()
  }
  return result
}

function optionalInteger(value: unknown, label: string, minimum: number): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, label, minimum, Number.MAX_SAFE_INTEGER)
}

function requiredInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 的整数`)
  }
  return value
}

function optionalRatio(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} 必须是 0 到 1 的有限数值`)
  }
  return value
}

function includes(value: string, expected: string): boolean {
  return value.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = (): void => done()
    signal?.addEventListener('abort', onAbort, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
  })
}
