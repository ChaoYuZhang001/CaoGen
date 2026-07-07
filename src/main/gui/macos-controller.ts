import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type MouseButton = 'left' | 'right' | 'middle'

export interface MacosBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface MacosElementInfo {
  id: string
  index: number
  name: string
  automationId: string
  className: string
  controlType: string
  bounds: MacosBounds
  enabled: boolean
  offscreen: boolean
}

export interface MacosWindowInfo {
  id: string
  name: string
  title: string
  processName: string
  pid: number
  index: number
  bounds: MacosBounds
  minimized: boolean
  platform: 'darwin'
  elements?: MacosElementInfo[]
}

interface MacosBaseResult {
  ok: boolean
  error?: string
  detail?: string
}

export interface MacosListWindowsResult extends MacosBaseResult {
  windows: MacosWindowInfo[]
}

export interface MacosActionResult extends MacosBaseResult {
  window?: MacosWindowInfo
}

interface MacosWindowSelector {
  windowId?: string
  title?: string
  processName?: string
  pid?: number
}

interface MacosElementSelector extends MacosWindowSelector {
  elementId?: string
  elementName?: string
  automationId?: string
  className?: string
  controlType?: string
  elementIndex?: number
  maxElements?: number
}

interface MacosListWindowsInput extends MacosWindowSelector {
  includeElements?: boolean
  maxElements?: number
}

interface MacosClickInput extends MacosElementSelector {
  x?: number
  y?: number
  button: MouseButton
}

interface MacosTypeTextInput extends MacosElementSelector {
  text: string
}

interface MacosScrollInput extends MacosElementSelector {
  x?: number
  y?: number
  deltaX?: number
  deltaY?: number
}

interface OsascriptResult {
  ok: boolean
  stdout: string
  stderr: string
  error?: string
}

const OSASCRIPT_TIMEOUT_MS = 10_000
const OSASCRIPT_MAX_BUFFER = 1024 * 1024
const SWIFT_AX_TIMEOUT_MS = 12_000

/** prototype-only 能力边界：这些能力需要 nut.js 兜底或后续原生 AXUIElement 扩展。 */
export const MACOS_GUI_PROTOTYPE_ONLY_CAPABILITIES = [
  'right/middle click',
  'element-level AX action click',
  'non-darwin runtime verification'
] as const

const MACOS_AX_HELPER_SOURCE = String.raw`
import AppKit
import ApplicationServices
import Foundation

struct Bounds: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct ElementInfo: Codable {
  let id: String
  let index: Int
  let name: String
  let automationId: String
  let className: String
  let controlType: String
  let bounds: Bounds
  let enabled: Bool
  let offscreen: Bool
}

struct WindowInfo: Codable {
  let id: String
  let name: String
  let title: String
  let processName: String
  let pid: Int32
  let index: Int
  let bounds: Bounds
  let minimized: Bool
  let platform: String
  let elements: [ElementInfo]?
}

let includeElements = CommandLine.arguments.contains("--include-elements")
let maxElements = Int(CommandLine.arguments.drop { $0 != "--max-elements" }.dropFirst().first ?? "40") ?? 40

func axString(_ element: AXUIElement, _ attribute: CFString) -> String {
  var value: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let text = value as? String {
    return text
  }
  return ""
}

func axBool(_ element: AXUIElement, _ attribute: CFString, defaultValue: Bool) -> Bool {
  var value: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let boolValue = value as? Bool {
    return boolValue
  }
  return defaultValue
}

func axBounds(_ element: AXUIElement) -> Bounds {
  var point = CGPoint.zero
  var size = CGSize.zero
  var positionValue: CFTypeRef?
  var sizeValue: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
     let axPosition = positionValue, CFGetTypeID(axPosition) == AXValueGetTypeID() {
    AXValueGetValue(axPosition as! AXValue, .cgPoint, &point)
  }
  if AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
     let axSize = sizeValue, CFGetTypeID(axSize) == AXValueGetTypeID() {
    AXValueGetValue(axSize as! AXValue, .cgSize, &size)
  }
  return Bounds(x: point.x, y: point.y, width: size.width, height: size.height)
}

func childElements(_ element: AXUIElement, prefix: String, limit: Int) -> [ElementInfo] {
  var output: [ElementInfo] = []
  var queue: [AXUIElement] = [element]
  while !queue.isEmpty && output.count < limit {
    let current = queue.removeFirst()
    var childrenValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &childrenValue) == .success,
       let children = childrenValue as? [AXUIElement] {
      queue.append(contentsOf: children.prefix(max(0, limit - output.count)))
    }
    let role = axString(current, kAXRoleAttribute as CFString)
    let title = axString(current, kAXTitleAttribute as CFString)
    let description = axString(current, kAXDescriptionAttribute as CFString)
    let bounds = axBounds(current)
    if bounds.width > 0 && bounds.height > 0 {
      let index = output.count + 1
      output.append(ElementInfo(
        id: "\(prefix):element:\(index)",
        index: index,
        name: title.isEmpty ? description : title,
        automationId: "",
        className: role,
        controlType: role,
        bounds: bounds,
        enabled: axBool(current, kAXEnabledAttribute as CFString, defaultValue: true),
        offscreen: false
      ))
    }
  }
  return output
}

let apps = NSWorkspace.shared.runningApplications.filter { app in
  app.activationPolicy == .regular && !app.isTerminated
}

var windows: [WindowInfo] = []
for app in apps {
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  var windowsValue: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsValue) == .success,
        let axWindows = windowsValue as? [AXUIElement] else {
    continue
  }
  for (offset, window) in axWindows.enumerated() {
    let bounds = axBounds(window)
    if bounds.width <= 0 || bounds.height <= 0 { continue }
    let index = offset + 1
    let id = "darwin:\(app.processIdentifier):\(index)"
    let title = axString(window, kAXTitleAttribute as CFString)
    let processName = app.localizedName ?? app.bundleIdentifier ?? String(app.processIdentifier)
    windows.append(WindowInfo(
      id: id,
      name: title.isEmpty ? processName : title,
      title: title,
      processName: processName,
      pid: app.processIdentifier,
      index: index,
      bounds: bounds,
      minimized: axBool(window, kAXMinimizedAttribute as CFString, defaultValue: false),
      platform: "darwin",
      elements: includeElements ? childElements(window, prefix: id, limit: maxElements) : nil
    ))
  }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
let data = try encoder.encode(windows)
FileHandle.standardOutput.write(data)
`

export async function macosListWindows(input: MacosListWindowsInput = {}): Promise<MacosListWindowsResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, windows: [], error: 'macOS GUI 主路径仅支持 darwin 平台' }
  }

  const axResult = await macosAxListWindows(input)
  if (axResult.ok) {
    return { ok: true, windows: axResult.windows.filter((windowInfo) => matchesSelector(windowInfo, input)) }
  }

  const result = await runOsascript([
    'set rows to {}',
    'tell application "System Events"',
    '  repeat with proc in (application processes whose visible is true)',
    '    set procName to name of proc as text',
    '    set procPid to unix id of proc as integer',
    '    set winIndex to 0',
    '    repeat with win in windows of proc',
    '      set winIndex to winIndex + 1',
    '      try',
    '        set winTitle to name of win as text',
    '        set winPosition to position of win',
    '        set winSize to size of win',
    '        set minimizedValue to false',
    '        try',
    '          set minimizedValue to value of attribute "AXMinimized" of win as boolean',
    '        end try',
    '        set rowText to (procPid as text) & tab & (winIndex as text) & tab & procName & tab & winTitle & tab & (item 1 of winPosition as text) & tab & (item 2 of winPosition as text) & tab & (item 1 of winSize as text) & tab & (item 2 of winSize as text) & tab & (minimizedValue as text)',
    '        set end of rows to rowText',
    '      end try',
    '    end repeat',
    '  end repeat',
    'end tell',
    'set AppleScript\'s text item delimiters to linefeed',
    'return rows as text'
  ])
  if (!result.ok) return { ok: false, windows: [], error: result.error }

  const windows = parseWindowRows(result.stdout).filter((windowInfo) => matchesSelector(windowInfo, input))
  return { ok: true, windows }
}

export async function macosActivateWindow(input: MacosWindowSelector): Promise<MacosActionResult> {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS GUI 主路径仅支持 darwin 平台' }
  const target = await findWindow(input)
  if (!target) return { ok: false, error: '未找到匹配窗口' }

  const result = await runOsascript([
    'tell application "System Events"',
    `  set targetProc to first application process whose unix id is ${target.pid}`,
    '  set frontmost of targetProc to true',
    `  if (count of windows of targetProc) >= ${target.index} then`,
    `    perform action "AXRaise" of window ${target.index} of targetProc`,
    '  end if',
    'end tell'
  ])
  return result.ok
    ? { ok: true, detail: target.name, window: target }
    : { ok: false, error: result.error, window: target }
}

export async function macosClick(input: MacosClickInput): Promise<MacosActionResult> {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS GUI 主路径仅支持 darwin 平台' }
  if (input.button !== 'left') {
    return { ok: false, error: 'macOS System Events 主路径当前仅支持 left click；right/middle 需 nut.js 兜底或原生扩展' }
  }
  if (typeof input.x !== 'number' || typeof input.y !== 'number') {
    return { ok: false, error: 'macOS System Events 主路径当前仅支持坐标点击；元素级点击需后续 AXUIElement 原生扩展' }
  }
  if (hasWindowSelector(input)) {
    const activated = await macosActivateWindow(input)
    if (!activated.ok) return activated
  }

  const result = await runOsascript([
    'tell application "System Events"',
    `  click at {${Math.round(input.x)}, ${Math.round(input.y)}}`,
    'end tell'
  ])
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function macosTypeText(input: MacosTypeTextInput): Promise<MacosActionResult> {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS GUI 主路径仅支持 darwin 平台' }
  if (hasWindowSelector(input)) {
    const activated = await macosActivateWindow(input)
    if (!activated.ok) return activated
  }

  const result = await runOsascript([
    'tell application "System Events"',
    `  keystroke ${appleScriptString(input.text)}`,
    'end tell'
  ])
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function macosScroll(input: MacosScrollInput): Promise<MacosActionResult> {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS GUI 主路径仅支持 darwin 平台' }
  if (hasWindowSelector(input)) {
    const activated = await macosActivateWindow(input)
    if (!activated.ok) return activated
  }

  const scrollX = normalizeScrollLines(input.deltaX)
  const scrollY = normalizeScrollLines(input.deltaY ?? 360)
  const result = await runOsascript([
    'use framework "CoreGraphics"',
    `set scrollX to ${scrollX}`,
    `set scrollY to ${-scrollY}`,
    "set eventRef to current application's CGEventCreateScrollWheelEvent(missing value, current application's kCGScrollEventUnitLine, 2, scrollY, scrollX)",
    "current application's CGEventPost(current application's kCGHIDEventTap, eventRef)"
  ])
  return result.ok ? { ok: true, detail: `deltaX=${input.deltaX ?? 0}; deltaY=${input.deltaY ?? 360}` } : { ok: false, error: result.error }
}

export async function macosHotkey(keys: string[]): Promise<MacosActionResult> {
  if (process.platform !== 'darwin') return { ok: false, error: 'macOS GUI 主路径仅支持 darwin 平台' }
  const normalized = keys.map((key) => key.trim().toLowerCase()).filter(Boolean)
  const mainKey = normalized.find((key) => !isModifierKey(key))
  if (!mainKey) return { ok: false, error: '快捷键至少需要一个非修饰键' }
  const modifiers = normalized.filter(isModifierKey).map(modifierName)
  const modifierClause = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : ''
  const keyCode = keyCodeFor(mainKey)
  const command = keyCode === undefined
    ? `  keystroke ${appleScriptString(printableKey(mainKey))}${modifierClause}`
    : `  key code ${keyCode}${modifierClause}`

  const result = await runOsascript(['tell application "System Events"', command, 'end tell'])
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

async function macosAxListWindows(input: MacosListWindowsInput): Promise<MacosListWindowsResult> {
  const args = ['list-windows']
  if (input.includeElements === true) {
    args.push('--include-elements', '--max-elements', String(normalizeMaxElements(input.maxElements)))
  }
  const result = await runSwiftAxHelper(args)
  if (!result.ok) return { ok: false, windows: [], error: result.error }
  try {
    const parsed = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(parsed)) return { ok: false, windows: [], error: 'macOS AXUIElement helper returned non-array JSON' }
    return {
      ok: true,
      windows: parsed
        .map(parseAxWindow)
        .filter((item): item is MacosWindowInfo => item !== null)
        .map((item) => (input.includeElements ? item : { ...item, elements: undefined }))
    }
  } catch (err) {
    return { ok: false, windows: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function runSwiftAxHelper(args: string[]): Promise<OsascriptResult> {
  const dir = mkdtempSync(join(tmpdir(), 'caogen-macos-ax-'))
  const scriptPath = join(dir, 'caogen-ax-helper.swift')
  writeFileSync(scriptPath, MACOS_AX_HELPER_SOURCE, 'utf8')
  return new Promise((resolvePromise) => {
    execFile(
      '/usr/bin/swift',
      [scriptPath, ...args],
      {
        timeout: SWIFT_AX_TIMEOUT_MS,
        maxBuffer: OSASCRIPT_MAX_BUFFER,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true })
        const error = [stderr.trim(), err instanceof Error ? err.message : ''].filter(Boolean).join('\n')
        resolvePromise({
          ok: !err,
          stdout,
          stderr,
          error: error || undefined
        })
      }
    )
  })
}

function runOsascript(lines: string[]): Promise<OsascriptResult> {
  return new Promise((resolvePromise) => {
    execFile(
      'osascript',
      lines.flatMap((line) => ['-e', line]),
      {
        timeout: OSASCRIPT_TIMEOUT_MS,
        maxBuffer: OSASCRIPT_MAX_BUFFER,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const error = [stderr.trim(), err instanceof Error ? err.message : ''].filter(Boolean).join('\n')
        resolvePromise({
          ok: !err,
          stdout,
          stderr,
          error: error || undefined
        })
      }
    )
  })
}

function parseWindowRows(stdout: string): MacosWindowInfo[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseWindowRow)
    .filter((item): item is MacosWindowInfo => item !== null)
}

function parseWindowRow(line: string): MacosWindowInfo | null {
  const parts = line.split('\t')
  if (parts.length < 9) return null
  const pid = numberFromText(parts[0])
  const index = numberFromText(parts[1])
  const x = numberFromText(parts[4])
  const y = numberFromText(parts[5])
  const width = numberFromText(parts[6])
  const height = numberFromText(parts[7])
  if (!pid || !index || width <= 0 || height <= 0) return null
  const processName = parts[2] ?? ''
  const title = parts[3] ?? ''
  return {
    id: `darwin:${pid}:${index}`,
    name: title || processName,
    title,
    processName,
    pid,
    index,
    bounds: { x, y, width, height },
    minimized: (parts[8] ?? '').toLowerCase() === 'true',
    platform: 'darwin'
  }
}

function parseAxWindow(value: unknown): MacosWindowInfo | null {
  if (!isRecord(value)) return null
  const bounds = parseBounds(value.bounds)
  const pid = numberFromUnknown(value.pid)
  const index = numberFromUnknown(value.index)
  const id = stringFromUnknown(value.id)
  if (!id || !pid || !index || !bounds || bounds.width <= 0 || bounds.height <= 0) return null
  const elements = Array.isArray(value.elements)
    ? value.elements.map(parseAxElement).filter((item): item is MacosElementInfo => item !== null)
    : undefined
  return {
    id,
    name: stringFromUnknown(value.name) || stringFromUnknown(value.processName),
    title: stringFromUnknown(value.title),
    processName: stringFromUnknown(value.processName),
    pid,
    index,
    bounds,
    minimized: booleanFromUnknown(value.minimized),
    platform: 'darwin',
    ...(elements ? { elements } : {})
  }
}

function parseAxElement(value: unknown): MacosElementInfo | null {
  if (!isRecord(value)) return null
  const bounds = parseBounds(value.bounds)
  const index = numberFromUnknown(value.index)
  const id = stringFromUnknown(value.id)
  if (!id || !index || !bounds) return null
  return {
    id,
    index,
    name: stringFromUnknown(value.name),
    automationId: stringFromUnknown(value.automationId),
    className: stringFromUnknown(value.className),
    controlType: stringFromUnknown(value.controlType),
    bounds,
    enabled: booleanFromUnknown(value.enabled, true),
    offscreen: booleanFromUnknown(value.offscreen)
  }
}

function parseBounds(value: unknown): MacosBounds | null {
  if (!isRecord(value)) return null
  return {
    x: numberFromUnknown(value.x),
    y: numberFromUnknown(value.y),
    width: numberFromUnknown(value.width),
    height: numberFromUnknown(value.height)
  }
}

function numberFromText(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numberFromUnknown(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringFromUnknown(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function booleanFromUnknown(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeMaxElements(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 40
  return Math.max(1, Math.min(200, Math.round(value)))
}

function matchesSelector(windowInfo: MacosWindowInfo, selector: MacosWindowSelector): boolean {
  if (selector.windowId && windowInfo.id !== selector.windowId) return false
  if (typeof selector.pid === 'number' && windowInfo.pid !== selector.pid) return false
  if (selector.title && !windowInfo.title.toLowerCase().includes(selector.title.toLowerCase())) return false
  if (
    selector.processName &&
    !windowInfo.processName.toLowerCase().includes(selector.processName.toLowerCase())
  ) {
    return false
  }
  return true
}

async function findWindow(selector: MacosWindowSelector): Promise<MacosWindowInfo | null> {
  const result = await macosListWindows(selector)
  return result.ok ? (result.windows[0] ?? null) : null
}

function hasWindowSelector(selector: MacosWindowSelector): boolean {
  return Boolean(selector.windowId || selector.title || selector.processName || typeof selector.pid === 'number')
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function isModifierKey(value: string): boolean {
  return ['cmd', 'command', 'meta', 'ctrl', 'control', 'alt', 'option', 'shift'].includes(value)
}

function modifierName(value: string): string {
  if (value === 'cmd' || value === 'command' || value === 'meta') return 'command down'
  if (value === 'ctrl' || value === 'control') return 'control down'
  if (value === 'alt' || value === 'option') return 'option down'
  return 'shift down'
}

function printableKey(value: string): string {
  if (value === 'space') return ' '
  return value.length === 1 ? value : value.slice(0, 1)
}

function keyCodeFor(value: string): number | undefined {
  const codes: Record<string, number> = {
    enter: 36,
    return: 36,
    tab: 48,
    escape: 53,
    esc: 53,
    backspace: 51,
    delete: 51,
    left: 123,
    right: 124,
    down: 125,
    up: 126
  }
  return codes[value]
}

function normalizeScrollLines(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 0
  return Math.max(1, Math.min(100, Math.round(Math.abs(value) / 120) || 1)) * (value < 0 ? -1 : 1)
}
