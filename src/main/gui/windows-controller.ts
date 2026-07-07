import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type WindowsBridgeAction = 'listWindows' | 'activateWindow' | 'click' | 'typeText' | 'scroll' | 'hotkey'
type MouseButton = 'left' | 'right' | 'middle'

export interface WindowsBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowsWindowInfo {
  id: string
  hwnd: number
  name: string
  title: string
  processName: string
  pid: number
  bounds: WindowsBounds
  minimized: boolean
  className: string
  automationId: string
  controlType: string
  platform: 'win32'
  elements?: WindowsElementInfo[]
}

export interface WindowsElementInfo {
  id: string
  hwnd?: number
  index: number
  name: string
  automationId: string
  className: string
  controlType: string
  bounds: WindowsBounds
  enabled: boolean
  offscreen: boolean
}

export interface WindowsForegroundInfo {
  hwnd: number
  pid: number
  matched: boolean
  expectedHwnd?: number
  expectedPid?: number
}

interface WindowsBaseResult {
  ok: boolean
  error?: string
  detail?: string
}

export interface WindowsListWindowsResult extends WindowsBaseResult {
  windows: WindowsWindowInfo[]
}

export interface WindowsActionResult extends WindowsBaseResult {
  window?: WindowsWindowInfo
  element?: WindowsElementInfo
  foreground?: WindowsForegroundInfo
  method?: string
}

interface WindowsWindowSelector {
  windowId?: string
  title?: string
  processName?: string
  pid?: number
}

interface WindowsElementSelector extends WindowsWindowSelector {
  elementId?: string
  elementName?: string
  automationId?: string
  className?: string
  controlType?: string
  elementIndex?: number
  maxElements?: number
}

interface WindowsListWindowsInput extends WindowsWindowSelector {
  includeElements?: boolean
  maxElements?: number
}

interface WindowsClickInput extends WindowsElementSelector {
  x?: number
  y?: number
  button: MouseButton
}

interface WindowsTypeTextInput extends WindowsElementSelector {
  text: string
  allowForegroundMismatch?: boolean
  inputMode?: 'auto' | 'keyboard' | 'clipboard'
  strict?: boolean
}

interface WindowsScrollInput extends WindowsElementSelector {
  x?: number
  y?: number
  deltaX?: number
  deltaY?: number
}

interface WindowsHotkeyInput extends WindowsWindowSelector {
  keys: string[]
  allowForegroundMismatch?: boolean
}

const WINDOWS_BRIDGE_TIMEOUT_MS = 10_000
const WINDOWS_BRIDGE_MAX_BUFFER = 1024 * 1024
let cachedBridgePath: string | null = null

export async function windowsListWindows(input: WindowsListWindowsInput = {}): Promise<WindowsListWindowsResult> {
  if (input.includeElements !== true) {
    const fallback = await windowsListWindowsFallback(input, undefined)
    if (fallback.ok) return fallback
  }
  const primary = await runWindowsBridge<WindowsListWindowsResult>('listWindows', input)
  if (primary.ok) {
    const normalized = normalizeWindowsListResult(primary, input)
    if (normalized.windows.length > 0 || !hasWindowSelectorInput(input)) return normalized
  }
  return windowsListWindowsFallback(input, primary.error)
}

export async function windowsActivateWindow(input: WindowsWindowSelector): Promise<WindowsActionResult> {
  return runWindowsBridge<WindowsActionResult>('activateWindow', input)
}

export async function windowsClick(input: WindowsClickInput): Promise<WindowsActionResult> {
  return runWindowsBridge<WindowsActionResult>('click', input)
}

export async function windowsTypeText(input: WindowsTypeTextInput): Promise<WindowsActionResult> {
  return runWindowsBridge<WindowsActionResult>('typeText', input)
}

export async function windowsScroll(input: WindowsScrollInput): Promise<WindowsActionResult> {
  return runWindowsBridge<WindowsActionResult>('scroll', input)
}

export async function windowsHotkey(input: string[] | WindowsHotkeyInput): Promise<WindowsActionResult> {
  return runWindowsBridge<WindowsActionResult>('hotkey', Array.isArray(input) ? { keys: input } : input)
}

function runWindowsBridge<T extends WindowsBaseResult>(
  action: WindowsBridgeAction,
  input: object
): Promise<T> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'Windows GUI 主路径仅支持 win32 平台' } as T)
  }

  const payload = Buffer.from(JSON.stringify({ action, input }), 'utf8').toString('base64')
  const bridgePath = ensureWindowsBridgeScript()

  return new Promise((resolvePromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', bridgePath, payload],
      {
        timeout: WINDOWS_BRIDGE_TIMEOUT_MS,
        maxBuffer: WINDOWS_BRIDGE_MAX_BUFFER,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const parsed = parseBridgeJson(stdout)
        if (parsed) {
          resolvePromise(parsed as T)
          return
        }

        const detail = [stderr.trim(), err instanceof Error ? err.message : ''].filter(Boolean).join('\n')
        resolvePromise({
          ok: false,
          error: detail || 'Windows GUI 桥接脚本未返回有效 JSON'
        } as T)
      }
    )
  })
}

function ensureWindowsBridgeScript(): string {
  if (cachedBridgePath) return cachedBridgePath
  const dir = join(tmpdir(), 'caogen-gui')
  mkdirSync(dir, { recursive: true })
  const bridgePath = join(dir, `windows-bridge-${process.pid}.ps1`)
  writeFileSync(bridgePath, `\ufeff${windowsBridgeScript()}`, 'utf8')
  cachedBridgePath = bridgePath
  return bridgePath
}

function parseBridgeJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()

  for (const line of lines) {
    if (!line.startsWith('{')) continue
    try {
      const value: unknown = JSON.parse(line)
      return isRecord(value) ? value : null
    } catch {
      continue
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function boolField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

function normalizeWindowInfo(value: unknown): WindowsWindowInfo | null {
  if (!isRecord(value)) return null
  const boundsRaw = value.bounds
  const boundsRecord = isRecord(boundsRaw) ? boundsRaw : {}
  const hwnd = numberField(value, 'hwnd')
  const id = stringField(value, 'id') || (hwnd > 0 ? `win32:${hwnd}` : '')
  if (!id) return null
  const elementsRaw = value.elements
  const elements = Array.isArray(elementsRaw)
    ? elementsRaw
        .map((item, index) => normalizeElementInfo(item, hwnd, index))
        .filter((item): item is WindowsElementInfo => item !== null)
    : undefined
  return {
    id,
    hwnd,
    name: stringField(value, 'name'),
    title: stringField(value, 'title'),
    processName: stringField(value, 'processName'),
    pid: numberField(value, 'pid'),
    bounds: {
      x: numberField(boundsRecord, 'x'),
      y: numberField(boundsRecord, 'y'),
      width: numberField(boundsRecord, 'width'),
      height: numberField(boundsRecord, 'height')
    },
    minimized: boolField(value, 'minimized'),
    className: stringField(value, 'className'),
    automationId: stringField(value, 'automationId'),
    controlType: stringField(value, 'controlType'),
    platform: 'win32',
    ...(elements !== undefined ? { elements } : {})
  }
}

function normalizeElementInfo(value: unknown, parentHwnd: number, fallbackIndex: number): WindowsElementInfo | null {
  if (!isRecord(value)) return null
  const boundsRaw = value.bounds
  const boundsRecord = isRecord(boundsRaw) ? boundsRaw : {}
  const index = numberField(value, 'index') || fallbackIndex
  const hwnd = numberField(value, 'hwnd')
  const id = stringField(value, 'id') || (parentHwnd > 0 ? `win32el:${parentHwnd}:${index}` : '')
  if (!id) return null
  return {
    id,
    ...(hwnd > 0 ? { hwnd } : {}),
    index,
    name: stringField(value, 'name'),
    automationId: stringField(value, 'automationId'),
    className: stringField(value, 'className'),
    controlType: stringField(value, 'controlType'),
    bounds: {
      x: numberField(boundsRecord, 'x'),
      y: numberField(boundsRecord, 'y'),
      width: numberField(boundsRecord, 'width'),
      height: numberField(boundsRecord, 'height')
    },
    enabled: boolField(value, 'enabled'),
    offscreen: boolField(value, 'offscreen')
  }
}

function normalizeWindowsListResult(
  result: WindowsListWindowsResult,
  input: WindowsListWindowsInput
): WindowsListWindowsResult {
  const rawWindows = Array.isArray(result.windows) ? result.windows : []
  const windows = rawWindows
    .map((item) => normalizeWindowInfo(item))
    .filter((item): item is WindowsWindowInfo => item !== null)
    .filter((item) => matchesWindowSelector(item, input))
    .map((item) => (input.includeElements ? { ...item, elements: Array.isArray(item.elements) ? item.elements : [] } : item))
  return { ...result, ok: true, windows }
}

function hasWindowSelectorInput(input: WindowsListWindowsInput): boolean {
  return Boolean(input.windowId || input.title || input.processName || typeof input.pid === 'number')
}

function matchesWindowSelector(window: WindowsWindowInfo, input: WindowsListWindowsInput): boolean {
  if (input.windowId) {
    const hwnd = parseWindowId(input.windowId)
    if (window.id !== input.windowId && (hwnd === undefined || window.hwnd !== hwnd)) return false
  }
  if (typeof input.pid === 'number' && window.pid !== input.pid) return false
  if (input.title && !window.title.toLowerCase().includes(input.title.toLowerCase())) return false
  if (input.processName) {
    const processName = input.processName.toLowerCase().replace(/\.[^.]+$/, '')
    if (!window.processName.toLowerCase().includes(processName)) return false
  }
  return true
}

function parseWindowId(id: string): number | undefined {
  const match = /^(?:win32|window):(\d+)$/.exec(id)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

async function windowsListWindowsFallback(
  input: WindowsListWindowsInput,
  primaryError: string | undefined
): Promise<WindowsListWindowsResult> {
  if (process.platform !== 'win32') return { ok: false, windows: [], error: primaryError }
  const script = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct CaoGenRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class CaoGenWindowRect {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out CaoGenRect rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$Items = @()
foreach ($Process in Get-Process) {
  try {
    if ($Process.MainWindowHandle -eq 0) { continue }
    if ([string]::IsNullOrWhiteSpace($Process.MainWindowTitle)) { continue }
    $Rect = New-Object CaoGenRect
    [void][CaoGenWindowRect]::GetWindowRect($Process.MainWindowHandle, [ref]$Rect)
    $Hwnd = [int64]$Process.MainWindowHandle
    $Items += [pscustomobject]@{
      id = ('win32:{0}' -f $Hwnd)
      hwnd = $Hwnd
      name = [string]$Process.MainWindowTitle
      title = [string]$Process.MainWindowTitle
      processName = [string]$Process.ProcessName
      pid = [int]$Process.Id
      bounds = [pscustomobject]@{
        x = [int]$Rect.Left
        y = [int]$Rect.Top
        width = [Math]::Max(1, [int]($Rect.Right - $Rect.Left))
        height = [Math]::Max(1, [int]($Rect.Bottom - $Rect.Top))
      }
      minimized = [bool][CaoGenWindowRect]::IsIconic($Process.MainWindowHandle)
      className = ''
      automationId = ''
      controlType = 'Window'
      platform = 'win32'
    }
  } catch {}
}
@{ ok = $true; windows = @($Items) } | ConvertTo-Json -Depth 6 -Compress
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolvePromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 8_000, maxBuffer: WINDOWS_BRIDGE_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        const parsed = parseBridgeJson(stdout)
        const rawWindows = isRecord(parsed) && Array.isArray(parsed.windows) ? parsed.windows : []
        const windows = rawWindows
          .map((item) => normalizeWindowInfo(item))
          .filter((item): item is WindowsWindowInfo => item !== null)
          .filter((item) => matchesWindowSelector(item, input))
          .map((item) => (input.includeElements ? { ...item, elements: [] } : item))
        if (parsed && parsed.ok === true) {
          resolvePromise({ ok: true, windows })
          return
        }
        const fallbackError = [stderr.trim(), err instanceof Error ? err.message : primaryError]
          .filter(Boolean)
          .join('\n')
        resolvePromise({ ok: false, windows: [], error: fallbackError || primaryError })
      }
    )
  })
}

function windowsBridgeScript(): string {
  return `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Write-BridgeResult($Value) {
  $Value | ConvertTo-Json -Depth 8 -Compress
}

try {
  $PayloadBase64 = [string]$args[0]
  if ([string]::IsNullOrWhiteSpace($PayloadBase64)) {
    throw 'Windows GUI bridge payload is empty'
  }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms

  if (-not ('CaoGenNativeInput' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CaoGenNativeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION union;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)]
    public KEYBDINPUT keyboard;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SendMessageText(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll", EntryPoint = "SendMessageW", SetLastError = true)] public static extern IntPtr SendMessagePtr(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  public static bool SendVirtualKey(ushort virtualKey, bool keyUp) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 1;
    inputs[0].union.keyboard.virtualKey = virtualKey;
    inputs[0].union.keyboard.scanCode = 0;
    inputs[0].union.keyboard.flags = keyUp ? 2u : 0u;
    inputs[0].union.keyboard.time = 0;
    inputs[0].union.keyboard.extraInfo = UIntPtr.Zero;
    return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool SendUnicodeText(string text) {
    if (text == null) { text = ""; }
    foreach (char ch in text) {
      bool sent = false;
      for (int attempt = 0; attempt < 5; attempt++) {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = 1;
        inputs[0].union.keyboard.virtualKey = 0;
        inputs[0].union.keyboard.scanCode = ch;
        inputs[0].union.keyboard.flags = 4u;
        inputs[0].union.keyboard.time = 0;
        inputs[0].union.keyboard.extraInfo = UIntPtr.Zero;
        inputs[1].type = 1;
        inputs[1].union.keyboard.virtualKey = 0;
        inputs[1].union.keyboard.scanCode = ch;
        inputs[1].union.keyboard.flags = 4u | 2u;
        inputs[1].union.keyboard.time = 0;
        inputs[1].union.keyboard.extraInfo = UIntPtr.Zero;
        if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2) {
          sent = true;
          break;
        }
        System.Threading.Thread.Sleep(10 + (attempt * 10));
      }
      if (!sent) { return false; }
      System.Threading.Thread.Sleep(1);
    }
    return true;
  }

  public static bool SendSetTextMessage(IntPtr hWnd, string text) {
    if (hWnd == IntPtr.Zero) { return false; }
    SendMessageText(hWnd, 0x000C, IntPtr.Zero, text ?? "");
    return true;
  }

  public static bool SendCommandMessage(IntPtr hWnd, int commandId) {
    if (hWnd == IntPtr.Zero) { return false; }
    SendMessagePtr(hWnd, 0x0111, new IntPtr(commandId), IntPtr.Zero);
    return true;
  }
}
"@
  }

  $PayloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  $Request = $PayloadJson | ConvertFrom-Json

  function Convert-ToInt($Value) {
    if ($null -eq $Value) { return 0 }
    try {
      $DoubleValue = [double]$Value
    } catch {
      return 0
    }
    if ([double]::IsNaN($DoubleValue) -or [double]::IsInfinity($DoubleValue)) { return 0 }
    return [int][Math]::Round($DoubleValue)
  }

  function Test-FiniteNumber($Value) {
    if ($null -eq $Value) { return $false }
    try {
      $DoubleValue = [double]$Value
    } catch {
      return $false
    }
    return (-not [double]::IsNaN($DoubleValue)) -and (-not [double]::IsInfinity($DoubleValue))
  }

  function Normalize-MaxElements($Value) {
    if ($null -eq $Value) { return 80 }
    $Number = [int]$Value
    if ($Number -le 0) { return 80 }
    if ($Number -gt 300) { return 300 }
    return $Number
  }

  function Get-ElementInfos($WindowInfo, $MaxElements) {
    $Items = New-Object System.Collections.ArrayList
    $Limit = Normalize-MaxElements $MaxElements
    try {
      $Root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$WindowInfo.hwnd)
      if ($null -eq $Root) { return $Items.ToArray() }
      $Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $Queue = New-Object System.Collections.ArrayList
      $Child = $Walker.GetFirstChild($Root)
      while ($null -ne $Child -and $Queue.Count -lt 200) {
        [void]$Queue.Add($Child)
        $Child = $Walker.GetNextSibling($Child)
      }
      $Index = 0
      $Cursor = 0
      $VisitedLimit = [Math]::Max(100, $Limit * 20)
      while ($Cursor -lt $Queue.Count -and $Items.Count -lt $Limit -and $Cursor -lt $VisitedLimit) {
        $Element = $Queue[$Cursor]
        $Cursor += 1
        try {
          $Child = $Walker.GetFirstChild($Element)
          while ($null -ne $Child -and $Queue.Count -lt $VisitedLimit) {
            [void]$Queue.Add($Child)
            $Child = $Walker.GetNextSibling($Child)
          }
        } catch {}
        if ($Items.Count -ge $Limit) { break }
        try {
          $Current = $Element.Current
        } catch {
          continue
        }
        $Rect = $Current.BoundingRectangle
        $Width = Convert-ToInt $Rect.Width
        $Height = Convert-ToInt $Rect.Height
        if ($Width -le 0 -or $Height -le 0) { continue }
        $Name = [string]$Current.Name
        $AutomationId = [string]$Current.AutomationId
        $ClassName = [string]$Current.ClassName
        $ControlType = ''
        try {
          $ControlType = [string]$Current.ControlType.ProgrammaticName
        } catch {}
        if ([string]::IsNullOrWhiteSpace($Name) -and [string]::IsNullOrWhiteSpace($AutomationId) -and [string]::IsNullOrWhiteSpace($ClassName)) {
          continue
        }

        [void]$Items.Add([pscustomobject]@{
          id = ('win32el:{0}:{1}' -f $WindowInfo.hwnd, $Index)
          hwnd = [int64]$Current.NativeWindowHandle
          index = $Index
          name = $Name
          automationId = $AutomationId
          className = $ClassName
          controlType = $ControlType
          bounds = [pscustomobject]@{
            x = Convert-ToInt $Rect.X
            y = Convert-ToInt $Rect.Y
            width = $Width
            height = $Height
          }
          enabled = [bool]$Current.IsEnabled
          offscreen = [bool]$Current.IsOffscreen
        })
        $Index += 1
      }
    } catch {}
    return $Items.ToArray()
  }

  function Test-WindowMatchesSelector($WindowInfo, $Selector) {
    if ($null -eq $Selector) { return $true }

    $WindowId = [string]$Selector.windowId
    if (-not [string]::IsNullOrWhiteSpace($WindowId)) {
      $Hwnd = Convert-WindowIdToHwnd $WindowId
      if (-not ($WindowInfo.id -eq $WindowId -or ($null -ne $Hwnd -and $WindowInfo.hwnd -eq $Hwnd))) { return $false }
    }

    if ($null -ne $Selector.pid) {
      if ($WindowInfo.pid -ne [int]$Selector.pid) { return $false }
    }

    $ProcessName = [string]$Selector.processName
    if (-not [string]::IsNullOrWhiteSpace($ProcessName)) {
      $Needle = [IO.Path]::GetFileNameWithoutExtension($ProcessName).ToLowerInvariant()
      if (-not ([string]$WindowInfo.processName).ToLowerInvariant().Contains($Needle)) { return $false }
    }

    $Title = [string]$Selector.title
    if (-not [string]::IsNullOrWhiteSpace($Title)) {
      if (-not ([string]$WindowInfo.title).ToLowerInvariant().Contains($Title.ToLowerInvariant())) { return $false }
    }

    return $true
  }

  function Has-WindowSelector($Selector) {
    if ($null -eq $Selector) { return $false }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.windowId)) { return $true }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.title)) { return $true }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.processName)) { return $true }
    if ($null -ne $Selector.pid) { return $true }
    return $false
  }

  function Get-WindowInfo($Selector, [bool]$IncludeElements, [int]$MaxElements) {
    $Items = New-Object System.Collections.ArrayList
    $FilterWindows = Has-WindowSelector $Selector
    $Root = [System.Windows.Automation.AutomationElement]::RootElement
    $Children = $Root.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      [System.Windows.Automation.Condition]::TrueCondition
    )

    foreach ($Element in $Children) {
      $Current = $Element.Current
      if ($Current.NativeWindowHandle -eq 0) { continue }
      $Title = [string]$Current.Name
      if ([string]::IsNullOrWhiteSpace($Title)) { continue }

      $ProcessName = ''
      try {
        $ProcessName = (Get-Process -Id $Current.ProcessId -ErrorAction Stop).ProcessName
      } catch {}

      $Rect = $Current.BoundingRectangle
      $Hwnd = [int64]$Current.NativeWindowHandle
      $ControlType = ''
      try {
        $ControlType = [string]$Current.ControlType.ProgrammaticName
      } catch {}

      $WindowInfo = [pscustomobject]@{
        id = ('win32:{0}' -f $Hwnd)
        hwnd = $Hwnd
        name = $Title
        title = $Title
        processName = $ProcessName
        pid = [int]$Current.ProcessId
        bounds = [pscustomobject]@{
          x = Convert-ToInt $Rect.X
          y = Convert-ToInt $Rect.Y
          width = Convert-ToInt $Rect.Width
          height = Convert-ToInt $Rect.Height
        }
        minimized = [bool][CaoGenNativeInput]::IsIconic([IntPtr]$Hwnd)
        className = [string]$Current.ClassName
        automationId = [string]$Current.AutomationId
        controlType = $ControlType
        platform = 'win32'
      }

      if ($FilterWindows -and -not (Test-WindowMatchesSelector $WindowInfo $Selector)) { continue }

      if ($IncludeElements) {
        $WindowInfo | Add-Member -NotePropertyName elements -NotePropertyValue @(Get-ElementInfos $WindowInfo $MaxElements)
      }

      [void]$Items.Add($WindowInfo)
    }

    return $Items.ToArray()
  }

  function Convert-WindowIdToHwnd($WindowId) {
    if ($null -eq $WindowId) { return $null }
    $Id = [string]$WindowId
    if ($Id -match 'win32:(\\d+)') { return [int64]$Matches[1] }
    if ($Id -match 'window:(\\d+)') { return [int64]$Matches[1] }
    return $null
  }

  function Find-TargetWindow($Selector) {
    $Windows = @(Get-WindowInfo $null $false 0)

    $WindowId = [string]$Selector.windowId
    if (-not [string]::IsNullOrWhiteSpace($WindowId)) {
      $Hwnd = Convert-WindowIdToHwnd $WindowId
      $Match = $Windows | Where-Object { $_.id -eq $WindowId -or ($null -ne $Hwnd -and $_.hwnd -eq $Hwnd) } | Select-Object -First 1
      if ($null -ne $Match) { return $Match }
    }

    if ($null -ne $Selector.pid) {
      $PidValue = [int]$Selector.pid
      $Match = $Windows | Where-Object { $_.pid -eq $PidValue } | Select-Object -First 1
      if ($null -ne $Match) { return $Match }
    }

    $ProcessName = [string]$Selector.processName
    if (-not [string]::IsNullOrWhiteSpace($ProcessName)) {
      $Needle = [IO.Path]::GetFileNameWithoutExtension($ProcessName).ToLowerInvariant()
      $Match = $Windows | Where-Object { ([string]$_.processName).ToLowerInvariant().Contains($Needle) } | Select-Object -First 1
      if ($null -ne $Match) { return $Match }
    }

    $Title = [string]$Selector.title
    if (-not [string]::IsNullOrWhiteSpace($Title)) {
      $Needle = $Title.ToLowerInvariant()
      $Match = $Windows | Where-Object { ([string]$_.title).ToLowerInvariant().Contains($Needle) } | Select-Object -First 1
      if ($null -ne $Match) { return $Match }
    }

    return $null
  }

  function Has-ElementSelector($Selector) {
    if ($null -eq $Selector) { return $false }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.elementId)) { return $true }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.elementName)) { return $true }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.automationId)) { return $true }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.className)) { return $true }
    if (-not [string]::IsNullOrWhiteSpace([string]$Selector.controlType)) { return $true }
    if ($null -ne $Selector.elementIndex) { return $true }
    return $false
  }

  function Find-TargetElement($Selector) {
    if (-not (Has-ElementSelector $Selector)) { return $null }
    $TargetWindow = Find-TargetWindow $Selector
    if ($null -eq $TargetWindow) { return $null }
    $Elements = @(Get-ElementInfos $TargetWindow (Normalize-MaxElements $Selector.maxElements))

    $ElementId = [string]$Selector.elementId
    if (-not [string]::IsNullOrWhiteSpace($ElementId)) {
      $Match = $Elements | Where-Object { $_.id -eq $ElementId } | Select-Object -First 1
      if ($null -ne $Match) { return @{ window = $TargetWindow; element = $Match } }
    }

    if ($null -ne $Selector.elementIndex) {
      $IndexValue = [int]$Selector.elementIndex
      $Match = $Elements | Where-Object { $_.index -eq $IndexValue } | Select-Object -First 1
      if ($null -ne $Match) { return @{ window = $TargetWindow; element = $Match } }
    }

    $Matches = $Elements
    $ElementName = [string]$Selector.elementName
    if (-not [string]::IsNullOrWhiteSpace($ElementName)) {
      $Needle = $ElementName.ToLowerInvariant()
      $Matches = @($Matches | Where-Object { ([string]$_.name).ToLowerInvariant().Contains($Needle) })
    }
    $AutomationId = [string]$Selector.automationId
    if (-not [string]::IsNullOrWhiteSpace($AutomationId)) {
      $Needle = $AutomationId.ToLowerInvariant()
      $Matches = @($Matches | Where-Object { ([string]$_.automationId).ToLowerInvariant().Contains($Needle) })
    }
    $ClassName = [string]$Selector.className
    if (-not [string]::IsNullOrWhiteSpace($ClassName)) {
      $Needle = $ClassName.ToLowerInvariant()
      $Matches = @($Matches | Where-Object { ([string]$_.className).ToLowerInvariant().Contains($Needle) })
    }
    $ControlType = [string]$Selector.controlType
    if (-not [string]::IsNullOrWhiteSpace($ControlType)) {
      $Needle = $ControlType.ToLowerInvariant()
      $Matches = @($Matches | Where-Object { ([string]$_.controlType).ToLowerInvariant().Contains($Needle) })
    }

    $Match = @($Matches | Where-Object { -not $_.offscreen -and $_.enabled } | Select-Object -First 1)
    if ($Match.Count -gt 0) { return @{ window = $TargetWindow; element = $Match[0] } }
    $Fallback = @($Matches | Select-Object -First 1)
    if ($Fallback.Count -gt 0) { return @{ window = $TargetWindow; element = $Fallback[0] } }
    return $null
  }

  function Invoke-MouseClick($X, $Y, $Button) {
    [void][CaoGenNativeInput]::SetCursorPos([int]$X, [int]$Y)
    Start-Sleep -Milliseconds 40
    switch ([string]$Button) {
      'right' {
        [CaoGenNativeInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
        [CaoGenNativeInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
      }
      'middle' {
        [CaoGenNativeInput]::mouse_event(0x0020, 0, 0, 0, [UIntPtr]::Zero)
        [CaoGenNativeInput]::mouse_event(0x0040, 0, 0, 0, [UIntPtr]::Zero)
      }
      default {
        [CaoGenNativeInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        [CaoGenNativeInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      }
    }
  }

  function Invoke-ElementClick($Element, $Button) {
    $Bounds = $Element.bounds
    $X = [int]($Bounds.x + ($Bounds.width / 2))
    $Y = [int]($Bounds.y + ($Bounds.height / 2))
    Invoke-MouseClick $X $Y $Button
    return ('已点击元素: {0} ({1})' -f $Element.name, $Element.controlType)
  }

  function Find-AutomationElementByInfo($WindowInfo, $ElementInfo, [int]$MaxElements) {
    if ($null -eq $WindowInfo -or $null -eq $ElementInfo) { return $null }
    try {
      $Root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$WindowInfo.hwnd)
      if ($null -eq $Root) { return $null }
      $TargetIndex = [int]$ElementInfo.index
      $TargetHwnd = 0
      try { $TargetHwnd = [int64]$ElementInfo.hwnd } catch {}
      $Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $Queue = New-Object System.Collections.ArrayList
      $Child = $Walker.GetFirstChild($Root)
      while ($null -ne $Child -and $Queue.Count -lt 200) {
        [void]$Queue.Add($Child)
        $Child = $Walker.GetNextSibling($Child)
      }
      $Index = 0
      $Cursor = 0
      $Limit = Normalize-MaxElements $MaxElements
      $VisitedLimit = [Math]::Max(100, $Limit * 20)
      while ($Cursor -lt $Queue.Count -and $Cursor -lt $VisitedLimit) {
        $Element = $Queue[$Cursor]
        $Cursor += 1
        try {
          $Child = $Walker.GetFirstChild($Element)
          while ($null -ne $Child -and $Queue.Count -lt $VisitedLimit) {
            [void]$Queue.Add($Child)
            $Child = $Walker.GetNextSibling($Child)
          }
        } catch {}
        try { $Current = $Element.Current } catch { continue }
        $Rect = $Current.BoundingRectangle
        $Width = Convert-ToInt $Rect.Width
        $Height = Convert-ToInt $Rect.Height
        if ($Width -le 0 -or $Height -le 0) { continue }
        $Name = [string]$Current.Name
        $AutomationId = [string]$Current.AutomationId
        $ClassName = [string]$Current.ClassName
        if ([string]::IsNullOrWhiteSpace($Name) -and [string]::IsNullOrWhiteSpace($AutomationId) -and [string]::IsNullOrWhiteSpace($ClassName)) { continue }
        if ($TargetHwnd -gt 0 -and [int64]$Current.NativeWindowHandle -eq $TargetHwnd) { return $Element }
        if ($Index -eq $TargetIndex) { return $Element }
        $Index += 1
      }
    } catch {}
    return $null
  }

  function Find-EditableAutomationElement($WindowInfo) {
    if ($null -eq $WindowInfo) { return $null }
    try {
      $Root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$WindowInfo.hwnd)
      if ($null -eq $Root) { return $null }
      $Walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $Queue = New-Object System.Collections.ArrayList
      [void]$Queue.Add($Root)
      $Cursor = 0
      $Best = $null
      $BestScore = -9999
      while ($Cursor -lt $Queue.Count -and $Cursor -lt 500) {
        $Element = $Queue[$Cursor]
        $Cursor += 1
        try {
          $Child = $Walker.GetFirstChild($Element)
          while ($null -ne $Child -and $Queue.Count -lt 500) {
            [void]$Queue.Add($Child)
            $Child = $Walker.GetNextSibling($Child)
          }
        } catch {}
        try { $Current = $Element.Current } catch { continue }
        if (-not [bool]$Current.IsEnabled -or [bool]$Current.IsOffscreen) { continue }
        $ControlType = ''
        try { $ControlType = [string]$Current.ControlType.ProgrammaticName } catch {}
        $ClassName = [string]$Current.ClassName
        $Name = [string]$Current.Name
        $Score = 0
        if ($ControlType.ToLowerInvariant().Contains('edit')) { $Score += 50 }
        if ($ControlType.ToLowerInvariant().Contains('document')) { $Score += 45 }
        if ($ClassName.ToLowerInvariant().Contains('edit')) { $Score += 70 }
        if ($ClassName.ToLowerInvariant().Contains('richedit')) { $Score += 70 }
        if ([int64]$Current.NativeWindowHandle -gt 0) { $Score += 30 }
        if ($Name.ToLowerInvariant().Contains('.ts') -or $Name.ToLowerInvariant().Contains('.txt')) { $Score += 10 }
        try {
          $Pattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          if ($null -ne $Pattern) {
            if ($Pattern.Current.IsReadOnly) {
              $Score -= 30
            } else {
              $Score += 40
            }
          }
        } catch {}
        if ($Score -gt $BestScore) {
          $Best = $Element
          $BestScore = $Score
        }
      }
      if ($BestScore -gt 0) { return $Best }
    } catch {}
    return $null
  }

  function Invoke-UiaTextValue($WindowInfo, $ElementInfo, [string]$Value) {
    try {
      $Element = Find-AutomationElementByInfo $WindowInfo $ElementInfo 300
      if ($null -eq $Element) { $Element = Find-EditableAutomationElement $WindowInfo }
      if ($null -eq $Element) { return @{ ok = $false; error = 'no editable UI Automation element found' } }
      try { $Element.SetFocus() } catch {}
      $Pattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($null -eq $Pattern) { return @{ ok = $false; error = 'editable element does not expose ValuePattern' } }
      if ($Pattern.Current.IsReadOnly) { return @{ ok = $false; error = 'editable element ValuePattern is read-only' } }
      $Pattern.SetValue($Value)
      Start-Sleep -Milliseconds 300
      return @{ ok = $true; method = 'uia-valuepattern' }
    } catch {
      return @{ ok = $false; error = $_.Exception.Message }
    }
  }

  function Invoke-Win32TextValue($WindowInfo, $ElementInfo, [string]$Value) {
    try {
      $Element = Find-AutomationElementByInfo $WindowInfo $ElementInfo 300
      if ($null -eq $Element) { $Element = Find-EditableAutomationElement $WindowInfo }
      if ($null -eq $Element) { return @{ ok = $false; error = 'no editable native element found' } }
      $Hwnd = 0
      try { $Hwnd = [int64]$Element.Current.NativeWindowHandle } catch {}
      if ($Hwnd -le 0) { return @{ ok = $false; error = 'editable element does not expose a native hwnd' } }
      if ([CaoGenNativeInput]::SendSetTextMessage([IntPtr][int64]$Hwnd, $Value)) {
        Start-Sleep -Milliseconds 300
        return @{ ok = $true; method = 'win32-wm-settext'; hwnd = $Hwnd }
      }
      return @{ ok = $false; error = 'WM_SETTEXT returned false' }
    } catch {
      return @{ ok = $false; error = $_.Exception.Message }
    }
  }

  function Test-KeyComboMatch($Keys, [string[]]$Expected) {
    $Actual = @($Keys | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($Actual.Count -ne $Expected.Count) { return $false }
    for ($Index = 0; $Index -lt $Expected.Count; $Index += 1) {
      if ($Actual[$Index] -ne $Expected[$Index]) { return $false }
    }
    return $true
  }

  function Invoke-HotkeyCommandFallback($WindowInfo, $Keys) {
    if ($null -eq $WindowInfo) { return @{ ok = $false; error = 'no target window for command fallback' } }
    $ProcessName = ([string]$WindowInfo.processName).ToLowerInvariant()
    if ($ProcessName.Contains('notepad') -and (Test-KeyComboMatch $Keys @('ctrl', 's'))) {
      if ([CaoGenNativeInput]::SendCommandMessage([IntPtr][int64]$WindowInfo.hwnd, 3)) {
        Start-Sleep -Milliseconds 500
        return @{ ok = $true; method = 'win32-wm-command'; commandId = 3 }
      }
      return @{ ok = $false; error = 'WM_COMMAND save returned false' }
    }
    return @{ ok = $false; error = 'no command fallback for this window/key combo' }
  }

  function Convert-ToWheelDelta($Value) {
    $Delta = Convert-ToInt $Value
    if ($Delta -eq 0) { return 0 }
    $Sign = 1
    if ($Delta -lt 0) { $Sign = -1 }
    $Magnitude = [Math]::Abs($Delta)
    if ($Magnitude -lt 120) { $Magnitude = 120 }
    return [int]($Sign * $Magnitude)
  }

  function Invoke-MouseMove($X, $Y) {
    [void][CaoGenNativeInput]::SetCursorPos([int]$X, [int]$Y)
    Start-Sleep -Milliseconds 40
  }

  function Invoke-WindowFocus($Window) {
    if ($null -eq $Window) { return }
    $Hwnd = [IntPtr][int64]$Window.hwnd
    $ForegroundHwnd = [CaoGenNativeInput]::GetForegroundWindow()
    $ForegroundPid = [uint32]0
    $ForegroundThread = [uint32]0
    if ($ForegroundHwnd -ne [IntPtr]::Zero) {
      $ForegroundThread = [CaoGenNativeInput]::GetWindowThreadProcessId($ForegroundHwnd, [ref]$ForegroundPid)
    }
    $TargetPid = [uint32]0
    $TargetThread = [CaoGenNativeInput]::GetWindowThreadProcessId($Hwnd, [ref]$TargetPid)
    $CurrentThread = [CaoGenNativeInput]::GetCurrentThreadId()
    $AttachedForeground = $false
    $AttachedTarget = $false
    if ($ForegroundThread -ne 0 -and $ForegroundThread -ne $CurrentThread) {
      $AttachedForeground = [CaoGenNativeInput]::AttachThreadInput($CurrentThread, $ForegroundThread, $true)
    }
    if ($TargetThread -ne 0 -and $TargetThread -ne $CurrentThread) {
      $AttachedTarget = [CaoGenNativeInput]::AttachThreadInput($CurrentThread, $TargetThread, $true)
    }
    [void][CaoGenNativeInput]::ShowWindowAsync($Hwnd, 9)
    Start-Sleep -Milliseconds 40
    [void][CaoGenNativeInput]::BringWindowToTop($Hwnd)
    [void][CaoGenNativeInput]::SetForegroundWindow($Hwnd)
    [void][CaoGenNativeInput]::SetFocus($Hwnd)
    if ($AttachedTarget) {
      [void][CaoGenNativeInput]::AttachThreadInput($CurrentThread, $TargetThread, $false)
    }
    if ($AttachedForeground) {
      [void][CaoGenNativeInput]::AttachThreadInput($CurrentThread, $ForegroundThread, $false)
    }
  }

  function Get-ForegroundInfo($ExpectedWindow) {
    $ForegroundHwnd = [CaoGenNativeInput]::GetForegroundWindow()
    $ForegroundPid = [uint32]0
    if ($ForegroundHwnd -ne [IntPtr]::Zero) {
      [void][CaoGenNativeInput]::GetWindowThreadProcessId($ForegroundHwnd, [ref]$ForegroundPid)
    }

    $ExpectedHwnd = 0
    $ExpectedPid = 0
    if ($null -ne $ExpectedWindow) {
      $ExpectedHwnd = [int64]$ExpectedWindow.hwnd
      $ExpectedPid = [int]$ExpectedWindow.pid
    }

    $ForegroundHwndValue = $ForegroundHwnd.ToInt64()
    $Matched = $false
    if ($ExpectedHwnd -gt 0 -and $ForegroundHwndValue -eq $ExpectedHwnd) { $Matched = $true }
    if (-not $Matched -and $ExpectedPid -gt 0 -and [int]$ForegroundPid -eq $ExpectedPid) { $Matched = $true }

    return [pscustomobject]@{
      hwnd = $ForegroundHwndValue
      pid = [int]$ForegroundPid
      matched = [bool]$Matched
      expectedHwnd = $ExpectedHwnd
      expectedPid = $ExpectedPid
    }
  }

  function Move-ToScrollTarget($Input) {
    if ($null -ne $Input.x -and $null -ne $Input.y) {
      Invoke-MouseMove ([int]$Input.x) ([int]$Input.y)
      return @{ ok = $true; detail = ('屏幕坐标 ({0}, {1})' -f ([int]$Input.x), ([int]$Input.y)) }
    }

    if (Has-ElementSelector $Input) {
      $Resolved = Find-TargetElement $Input
      if ($null -eq $Resolved) {
        return @{ ok = $false; error = '未找到匹配元素' }
      }
      Invoke-WindowFocus $Resolved.window
      $Bounds = $Resolved.element.bounds
      Invoke-MouseMove ([int]($Bounds.x + ($Bounds.width / 2))) ([int]($Bounds.y + ($Bounds.height / 2)))
      return @{
        ok = $true
        detail = ('元素 {0} ({1})' -f $Resolved.element.name, $Resolved.element.controlType)
        window = $Resolved.window
        element = $Resolved.element
      }
    }

    $Target = Find-TargetWindow $Input
    if ($null -ne $Target) {
      Invoke-WindowFocus $Target
      $Bounds = $Target.bounds
      Invoke-MouseMove ([int]($Bounds.x + ($Bounds.width / 2))) ([int]($Bounds.y + ($Bounds.height / 2)))
      return @{ ok = $true; detail = ('窗口 {0}' -f $Target.title); window = $Target }
    }

    return @{ ok = $true; detail = '当前鼠标位置' }
  }

  function Invoke-MouseScroll($DeltaX, $DeltaY) {
    $WheelY = Convert-ToWheelDelta $DeltaY
    $WheelX = Convert-ToWheelDelta $DeltaX
    if ($WheelY -ne 0) {
      [CaoGenNativeInput]::mouse_event(0x0800, 0, 0, [int](-1 * $WheelY), [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 30
    }
    if ($WheelX -ne 0) {
      [CaoGenNativeInput]::mouse_event(0x1000, 0, 0, [int]$WheelX, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 30
    }
  }

  function Resolve-VirtualKey($KeyName) {
    $Name = ([string]$KeyName).Trim().ToLowerInvariant()
    switch ($Name) {
      'ctrl' { return 0x11 }
      'control' { return 0x11 }
      'shift' { return 0x10 }
      'alt' { return 0x12 }
      'option' { return 0x12 }
      'win' { return 0x5B }
      'meta' { return 0x5B }
      'cmd' { return 0x5B }
      'command' { return 0x5B }
      'enter' { return 0x0D }
      'return' { return 0x0D }
      'esc' { return 0x1B }
      'escape' { return 0x1B }
      'tab' { return 0x09 }
      'space' { return 0x20 }
      'grave' { return 0xC0 }
      'backtick' { return 0xC0 }
      'backspace' { return 0x08 }
      'delete' { return 0x2E }
      'insert' { return 0x2D }
      'home' { return 0x24 }
      'end' { return 0x23 }
      'pageup' { return 0x21 }
      'pagedown' { return 0x22 }
      'left' { return 0x25 }
      'up' { return 0x26 }
      'right' { return 0x27 }
      'down' { return 0x28 }
    }

    if ($Name -match '^f([1-9]|1[0-9]|2[0-4])$') {
      return 0x6F + [int]$Matches[1]
    }

    if ($Name.Length -eq 1) {
      $Code = [int][char]$Name.ToUpperInvariant()[0]
      if (($Code -ge 0x30 -and $Code -le 0x39) -or ($Code -ge 0x41 -and $Code -le 0x5A)) {
        return $Code
      }
    }

    throw ('不支持的快捷键: {0}' -f $KeyName)
  }

  function Convert-KeyToSendKeysToken($KeyName) {
    $Name = ([string]$KeyName).Trim().ToLowerInvariant()
    switch ($Name) {
      'ctrl' { return '^' }
      'control' { return '^' }
      'shift' { return '+' }
      'alt' { return '%' }
      'option' { return '%' }
      'enter' { return '{ENTER}' }
      'return' { return '{ENTER}' }
      'esc' { return '{ESC}' }
      'escape' { return '{ESC}' }
      'tab' { return '{TAB}' }
      'space' { return ' ' }
      'backspace' { return '{BACKSPACE}' }
      'delete' { return '{DELETE}' }
      'insert' { return '{INSERT}' }
      'home' { return '{HOME}' }
      'end' { return '{END}' }
      'pageup' { return '{PGUP}' }
      'pagedown' { return '{PGDN}' }
      'left' { return '{LEFT}' }
      'up' { return '{UP}' }
      'right' { return '{RIGHT}' }
      'down' { return '{DOWN}' }
    }
    if ($Name -match '^f([1-9]|1[0-9]|2[0-4])$') { return ('{F' + $Matches[1] + '}') }
    if ($Name.Length -eq 1) { return $Name }
    return $null
  }

  function Convert-ComboToSendKeys($Keys) {
    $Tokens = @()
    foreach ($Key in @($Keys)) {
      $Token = Convert-KeyToSendKeysToken $Key
      if ($null -eq $Token) { return $null }
      $Tokens += $Token
    }
    return ($Tokens -join '')
  }

  function Invoke-SendKeysCombo($Keys) {
    $Sequence = Convert-ComboToSendKeys $Keys
    if ([string]::IsNullOrWhiteSpace($Sequence)) { return $false }
    try {
      $Shell = New-Object -ComObject WScript.Shell
      $Shell.SendKeys($Sequence)
      Start-Sleep -Milliseconds 80
      return $true
    } catch {
      return $false
    }
  }

  function Convert-TextCharToSendKeysToken([char]$Char) {
    $Code = [int]$Char
    if ($Code -eq 13) { return '' }
    if ($Code -eq 10) { return '{ENTER}' }

    $Text = [string]$Char
    switch ($Text) {
      '+' { return '{+}' }
      '^' { return '{^}' }
      '%' { return '{%}' }
      '~' { return '{~}' }
      '(' { return '{(}' }
      ')' { return '{)}' }
      '[' { return '{[}' }
      ']' { return '{]}' }
      '{' { return '{{}' }
      '}' { return '{}}' }
      default { return $Text }
    }
  }

  function Invoke-SendKeysTextInput([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return $true }
    try {
      foreach ($Char in $Value.ToCharArray()) {
        $Token = Convert-TextCharToSendKeysToken $Char
        if ([string]::IsNullOrEmpty($Token)) { continue }
        [System.Windows.Forms.SendKeys]::SendWait($Token)
        Start-Sleep -Milliseconds 3
      }
      Start-Sleep -Milliseconds 120
      return $true
    } catch {
      return $false
    }
  }

  function Invoke-KeyCombo($Keys) {
    $VirtualKeys = @($Keys | ForEach-Object { Resolve-VirtualKey $_ })
    foreach ($VirtualKey in $VirtualKeys) {
      $Sent = [CaoGenNativeInput]::SendVirtualKey([uint16]$VirtualKey, $false)
      if (-not $Sent) {
        [CaoGenNativeInput]::keybd_event([byte]$VirtualKey, 0, 0, [UIntPtr]::Zero)
      }
      Start-Sleep -Milliseconds 20
    }
    Start-Sleep -Milliseconds 40
    foreach ($VirtualKey in @($VirtualKeys)[($VirtualKeys.Count - 1)..0]) {
      $Sent = [CaoGenNativeInput]::SendVirtualKey([uint16]$VirtualKey, $true)
      if (-not $Sent) {
        [CaoGenNativeInput]::keybd_event([byte]$VirtualKey, 0, 2, [UIntPtr]::Zero)
      }
      Start-Sleep -Milliseconds 20
    }
  }

  function Invoke-UnicodeTextInput([string]$Value) {
    if ([string]::IsNullOrEmpty($Value)) { return $true }
    return [CaoGenNativeInput]::SendUnicodeText($Value)
  }

  function Get-TextClipboardSnapshot() {
    for ($Attempt = 1; $Attempt -le 8; $Attempt += 1) {
      try {
        return @{
          hadText = $true
          text = (Get-Clipboard -Raw -ErrorAction Stop)
        }
      } catch {
        try {
          if ([System.Windows.Forms.Clipboard]::ContainsText()) {
            return @{
              hadText = $true
              text = [System.Windows.Forms.Clipboard]::GetText()
            }
          }
        } catch {}
      }
      Start-Sleep -Milliseconds (80 * $Attempt)
    }

    return @{ hadText = $false; text = '' }
  }

  function Set-TextClipboardWithRetry([string]$Value) {
    $LastError = $null
    for ($Attempt = 1; $Attempt -le 10; $Attempt += 1) {
      try {
        Set-Clipboard -Value $Value -ErrorAction Stop
        return $true
      } catch {
        $LastError = $_
      }

      try {
        [System.Windows.Forms.Clipboard]::SetText($Value)
        return $true
      } catch {
        $LastError = $_
      }

      Start-Sleep -Milliseconds (100 * $Attempt)
    }

    throw ('Windows clipboard is unavailable for text entry: {0}' -f $LastError)
  }

  switch ([string]$Request.action) {
    'listWindows' {
      $IncludeElements = [bool]$Request.input.includeElements
      $MaxElements = Normalize-MaxElements $Request.input.maxElements
      Write-BridgeResult @{ ok = $true; windows = @(Get-WindowInfo $Request.input $IncludeElements $MaxElements) }
    }
    'activateWindow' {
      $Target = Find-TargetWindow $Request.input
      if ($null -eq $Target) {
        Write-BridgeResult @{ ok = $false; error = '未找到匹配窗口' }
        break
      }

      $Hwnd = [IntPtr][int64]$Target.hwnd
      try {
        $Automation = [System.Windows.Automation.AutomationElement]::FromHandle($Hwnd)
        if ($null -ne $Automation) {
          try {
            $Pattern = $Automation.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
            if ($null -ne $Pattern) {
              $Pattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
            }
          } catch {}
          try { $Automation.SetFocus() } catch {}
        }
      } catch {}

      Invoke-WindowFocus $Target
      Start-Sleep -Milliseconds 80
      $BringResult = [CaoGenNativeInput]::BringWindowToTop($Hwnd)
      $ForegroundResult = [CaoGenNativeInput]::SetForegroundWindow($Hwnd)
      $AppActivateResult = $false
      try {
        $Shell = New-Object -ComObject WScript.Shell
        $AppActivateResult = [bool]$Shell.AppActivate([int]$Target.pid)
      } catch {}
      Start-Sleep -Milliseconds 120
      $Foreground = Get-ForegroundInfo $Target

      Write-BridgeResult @{
        ok = [bool]($Foreground.matched -or $ForegroundResult -or $BringResult -or $AppActivateResult)
        detail = ('已请求激活窗口: {0}' -f $Target.title)
        window = $Target
        foreground = $Foreground
      }
    }
    'click' {
      $Button = [string]$Request.input.button
      if (Has-ElementSelector $Request.input) {
        $Resolved = Find-TargetElement $Request.input
        if ($null -eq $Resolved) {
          Write-BridgeResult @{ ok = $false; error = '未找到匹配元素' }
          break
        }
        $Detail = Invoke-ElementClick $Resolved.element $Button
        Write-BridgeResult @{ ok = $true; detail = $Detail; window = $Resolved.window; element = $Resolved.element }
        break
      }

      if (-not (Test-FiniteNumber $Request.input.x) -or -not (Test-FiniteNumber $Request.input.y)) {
        Write-BridgeResult @{ ok = $false; error = 'gui_click requires finite x and y when no element selector is provided' }
        break
      }

      $X = Convert-ToInt $Request.input.x
      $Y = Convert-ToInt $Request.input.y
      Invoke-MouseClick $X $Y $Button
      Write-BridgeResult @{ ok = $true; detail = ('已点击屏幕坐标 ({0}, {1})' -f $X, $Y) }
    }
    'typeText' {
      $Text = [string]$Request.input.text
      $AllowForegroundMismatch = [bool]$Request.input.allowForegroundMismatch
      $InputMode = [string]$Request.input.inputMode
      $Strict = [bool]$Request.input.strict
      $NormalizedInputMode = $InputMode.ToLowerInvariant()
      $UseValueBackends = -not ($NormalizedInputMode -eq 'keyboard' -or $NormalizedInputMode -eq 'clipboard')
      $Resolved = $null
      $Foreground = $null
      $TargetWindow = $null
      if (Has-ElementSelector $Request.input) {
        $Resolved = Find-TargetElement $Request.input
        if ($null -eq $Resolved) {
          Write-BridgeResult @{ ok = $false; error = '未找到匹配元素' }
          break
        }
        $TargetWindow = $Resolved.window
        [void][CaoGenNativeInput]::ShowWindowAsync([IntPtr][int64]$Resolved.window.hwnd, 9)
        [void][CaoGenNativeInput]::SetForegroundWindow([IntPtr][int64]$Resolved.window.hwnd)
        Start-Sleep -Milliseconds 120
        [void](Invoke-ElementClick $Resolved.element 'left')
        Start-Sleep -Milliseconds 120
        $Foreground = Get-ForegroundInfo $Resolved.window
        if ($UseValueBackends) {
          $UiaText = Invoke-UiaTextValue $Resolved.window $Resolved.element $Text
          if ([bool]$UiaText.ok) {
            Write-BridgeResult @{
              ok = $true
              detail = 'text set through UI Automation ValuePattern'
              method = [string]$UiaText.method
              window = $Resolved.window
              element = $Resolved.element
              foreground = $Foreground
            }
            break
          }
          $Win32Text = Invoke-Win32TextValue $Resolved.window $Resolved.element $Text
          if ([bool]$Win32Text.ok) {
            Write-BridgeResult @{
              ok = $true
              detail = 'text set through native window message'
              method = [string]$Win32Text.method
              window = $Resolved.window
              element = $Resolved.element
              foreground = $Foreground
            }
            break
          }
        }
        if (-not [bool]$Foreground.matched -and -not $AllowForegroundMismatch) {
          Write-BridgeResult @{
            ok = $false
            error = 'target window is not foreground after element focus'
            method = 'clipboard-ctrl-v'
            window = $Resolved.window
            element = $Resolved.element
            foreground = $Foreground
            uiaTextError = $(if ($null -ne $UiaText) { [string]$UiaText.error } else { $null })
            win32TextError = $(if ($null -ne $Win32Text) { [string]$Win32Text.error } else { $null })
          }
          break
        }
      } elseif (Has-WindowSelector $Request.input) {
        $TargetWindow = Find-TargetWindow $Request.input
        if ($null -eq $TargetWindow) {
          Write-BridgeResult @{ ok = $false; error = '未找到匹配窗口' }
          break
        }
        Invoke-WindowFocus $TargetWindow
        Start-Sleep -Milliseconds 120
        $Foreground = Get-ForegroundInfo $TargetWindow
        if ($UseValueBackends) {
          $UiaText = Invoke-UiaTextValue $TargetWindow $null $Text
          if ([bool]$UiaText.ok) {
            Write-BridgeResult @{
              ok = $true
              detail = 'text set through UI Automation ValuePattern'
              method = [string]$UiaText.method
              window = $TargetWindow
              foreground = $Foreground
            }
            break
          }
          $Win32Text = Invoke-Win32TextValue $TargetWindow $null $Text
          if ([bool]$Win32Text.ok) {
            Write-BridgeResult @{
              ok = $true
              detail = 'text set through native window message'
              method = [string]$Win32Text.method
              window = $TargetWindow
              foreground = $Foreground
            }
            break
          }
        }
        if (-not [bool]$Foreground.matched -and -not $AllowForegroundMismatch) {
          Write-BridgeResult @{
            ok = $false
            error = 'target window is not foreground before typing'
            method = 'clipboard-ctrl-v'
            window = $TargetWindow
            foreground = $Foreground
            uiaTextError = $(if ($null -ne $UiaText) { [string]$UiaText.error } else { $null })
            win32TextError = $(if ($null -ne $Win32Text) { [string]$Win32Text.error } else { $null })
          }
          break
        }
      }

      $NativeTextError = $null
      if ($NormalizedInputMode -ne 'clipboard') {
        try {
          if (Invoke-UnicodeTextInput $Text) {
            Start-Sleep -Milliseconds 500
            Write-BridgeResult @{
              ok = $true
              detail = 'text entered through native SendInput unicode events'
              method = 'sendinput-unicode'
              window = $TargetWindow
              element = $(if ($null -ne $Resolved) { $Resolved.element } else { $null })
              foreground = $Foreground
            }
            break
          }
          $NativeTextError = 'SendInput unicode returned false'
        } catch {
          $NativeTextError = $_.Exception.Message
        }
      } else {
        $NativeTextError = 'SendInput unicode skipped by clipboard inputMode'
      }

      $SendKeysTextError = $null
      $UseSendKeysTextFallback = ([string]$env:CAOGEN_GUI_ALLOW_SENDKEYS_TEXT_FALLBACK -eq '1')
      if ($NormalizedInputMode -ne 'clipboard' -and $UseSendKeysTextFallback) {
        try {
          if (Invoke-SendKeysTextInput $Text) {
            Start-Sleep -Milliseconds 500
            Write-BridgeResult @{
              ok = $true
              detail = 'text entered through native SendKeys events'
              method = 'sendkeys-text'
              window = $TargetWindow
              element = $(if ($null -ne $Resolved) { $Resolved.element } else { $null })
              foreground = $Foreground
            }
            break
          }
          $SendKeysTextError = 'SendKeys text input returned false'
        } catch {
          $SendKeysTextError = $_.Exception.Message
        }
      } else {
        $SendKeysTextError = $(if ($NormalizedInputMode -eq 'clipboard') { 'SendKeys text input skipped by clipboard inputMode' } else { 'SendKeys text input disabled by default' })
      }

      if ($Strict) {
        $StrictReason = @($NativeTextError, $SendKeysTextError) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
        Write-BridgeResult @{
          ok = $false
          error = ('strict text entry failed before clipboard fallback: {0}' -f ($StrictReason -join '; '))
          method = 'sendinput-unicode/sendkeys-text'
          window = $TargetWindow
          element = $(if ($null -ne $Resolved) { $Resolved.element } else { $null })
          foreground = $Foreground
        }
        break
      }

      $ClipboardSnapshot = Get-TextClipboardSnapshot
      [void](Set-TextClipboardWithRetry $Text)
      Start-Sleep -Milliseconds 120
      Invoke-KeyCombo @('ctrl', 'v')
      Start-Sleep -Milliseconds 800

      if ([bool]$ClipboardSnapshot.hadText) {
        try { [void](Set-TextClipboardWithRetry ([string]$ClipboardSnapshot.text)) } catch {}
      }

      if ($null -eq $Foreground -and (Has-WindowSelector $Request.input)) {
        $Target = Find-TargetWindow $Request.input
        if ($null -ne $Target) { $Foreground = Get-ForegroundInfo $Target }
      }

      Write-BridgeResult @{
        ok = $true
        detail = 'text pasted through clipboard'
        method = 'clipboard-ctrl-v'
        nativeTextError = $NativeTextError
        window = $TargetWindow
        element = $(if ($null -ne $Resolved) { $Resolved.element } else { $null })
        foreground = $Foreground
      }
      break

      Write-BridgeResult @{ ok = $true; detail = '已通过剪贴板粘贴文本；若剪贴板含非文本格式，仅保证恢复文本内容' }
    }
    'scroll' {
      $Target = Move-ToScrollTarget $Request.input
      if (-not [bool]$Target.ok) {
        Write-BridgeResult $Target
        break
      }

      $DeltaX = Convert-ToInt $Request.input.deltaX
      $DeltaY = Convert-ToInt $Request.input.deltaY
      if ($DeltaX -eq 0 -and $DeltaY -eq 0) {
        $DeltaY = 360
      }
      Invoke-MouseScroll $DeltaX $DeltaY
      Write-BridgeResult @{
        ok = $true
        detail = ('已滚动 {0}; deltaX={1}; deltaY={2}' -f $Target.detail, $DeltaX, $DeltaY)
        window = $Target.window
        element = $Target.element
      }
    }
    'hotkey' {
      $TargetWindow = $null
      $Foreground = $null
      $AllowForegroundMismatch = [bool]$Request.input.allowForegroundMismatch
      if (Has-WindowSelector $Request.input) {
        $TargetWindow = Find-TargetWindow $Request.input
        if ($null -eq $TargetWindow) {
          Write-BridgeResult @{ ok = $false; error = '未找到匹配窗口' }
          break
        }
        Invoke-WindowFocus $TargetWindow
        Start-Sleep -Milliseconds 160
        $Foreground = Get-ForegroundInfo $TargetWindow
        if (-not [bool]$Foreground.matched -and -not $AllowForegroundMismatch) {
          $CommandFallback = Invoke-HotkeyCommandFallback $TargetWindow @($Request.input.keys)
          if ([bool]$CommandFallback.ok) {
            Write-BridgeResult @{
              ok = $true
              detail = ('sent command fallback for hotkey: {0}' -f (@($Request.input.keys) -join '+'))
              method = [string]$CommandFallback.method
              window = $TargetWindow
              foreground = $Foreground
            }
            break
          }
          Write-BridgeResult @{
            ok = $false
            error = 'target window is not foreground before hotkey'
            window = $TargetWindow
            foreground = $Foreground
            commandFallbackError = [string]$CommandFallback.error
          }
          break
        }
      }
      Invoke-KeyCombo @($Request.input.keys)
      Write-BridgeResult @{
        ok = $true
        detail = ('已发送快捷键: {0}' -f (@($Request.input.keys) -join '+'))
        window = $TargetWindow
        foreground = $Foreground
      }
    }
    default {
      Write-BridgeResult @{ ok = $false; error = ('未知 Windows GUI 动作: {0}' -f $Request.action) }
    }
  }
} catch {
  Write-BridgeResult @{ ok = $false; error = $_.Exception.Message; detail = $_.Exception.ToString() }
}
`
}
