#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const checks = []

async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (err) {
    checks.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function evaluateMacosController(platform = process.platform) {
  const input = source('src/main/gui/macos-controller.ts')
  const output = ts.transpileModule(input, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText

  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', output)(
    require,
    module,
    module.exports,
    { ...process, platform }
  )
  return module.exports
}

await check('macOS controller uses System Events accessibility bridge', () => {
  const text = source('src/main/gui/macos-controller.ts')
  for (const marker of [
    'application processes whose visible is true',
    'AXMinimized',
    'perform action "AXRaise"',
    'keystroke',
    'key code',
    'click at',
    'CGEventCreateScrollWheelEvent',
    'CGEventPost'
  ]) {
    assert(text.includes(marker), `missing ${marker}`)
  }
})

await check('macOS controller includes native AXUIElement helper path', () => {
  const text = source('src/main/gui/macos-controller.ts')
  for (const marker of [
    'MACOS_AX_HELPER_SOURCE',
    'AXUIElementCreateApplication',
    'AXUIElementCopyAttributeValue',
    'kAXWindowsAttribute',
    'kAXChildrenAttribute',
    'runSwiftAxHelper',
    'macosAxListWindows(input)'
  ]) {
    assert(text.includes(marker), `missing ${marker}`)
  }
  assert(text.indexOf('macosAxListWindows(input)') < text.indexOf('runOsascript(['), 'AX helper should run before System Events fallback')
})

await check('macOS controller exposes typed window/action APIs', () => {
  const text = source('src/main/gui/macos-controller.ts')
  for (const marker of [
    'export async function macosListWindows',
    'export async function macosActivateWindow',
    'export async function macosClick',
    'export async function macosTypeText',
    'export async function macosScroll',
    'export async function macosHotkey'
  ]) {
    assert(text.includes(marker), `missing ${marker}`)
  }
})

await check('macOS controller marks prototype-only capability boundaries', () => {
  const text = source('src/main/gui/macos-controller.ts')
  for (const marker of [
    'MACOS_GUI_PROTOTYPE_ONLY_CAPABILITIES',
    'prototype-only',
    'right/middle click',
    'element-level AX action click',
    'non-darwin runtime verification'
  ]) {
    assert(text.includes(marker), `missing ${marker}`)
  }
})

await check('gui controller routes macOS before nut.js fallback', () => {
  const text = source('src/main/gui/gui-controller.ts')
  for (const marker of [
    'macosListWindows(input)',
    'macosActivateWindow(input)',
    'macosClick(input)',
    'macosTypeText(input)',
    'macosScroll(input)',
    'macosHotkey(keys)'
  ]) {
    assert(text.includes(marker), `missing macOS route ${marker}`)
  }
  assert(
    text.indexOf('macosClick(input)') < text.indexOf('nutClick(input.x, input.y, input.button)'),
    'macOS click path must run before nut.js fallback'
  )
})

await check('macOS APIs fail closed on non-darwin hosts', async () => {
  const controller = evaluateMacosController('win32')
  const result = await controller.macosListWindows()
  assert(result.ok === false, `expected fail-closed result, got ${JSON.stringify(result)}`)
  assert(Array.isArray(result.windows) && result.windows.length === 0, 'non-darwin list must return empty windows')
})

await check('runtime macOS listWindows bridge returns structured data when available', async () => {
  if (process.platform !== 'darwin') return
  const controller = evaluateMacosController('darwin')
  const result = await controller.macosListWindows()
  assert(result.ok === true, `macosListWindows failed: ${result.error ?? 'unknown error'}`)
  assert(Array.isArray(result.windows), 'macosListWindows must return an array')
  if (result.windows.length > 0) {
    const first = result.windows[0]
    assert(typeof first.id === 'string' && first.id.startsWith('darwin:'), 'window id must use darwin: prefix')
    assert(typeof first.processName === 'string', 'window processName must be a string')
    assert(typeof first.pid === 'number', 'window pid must be a number')
    assert(typeof first.bounds?.width === 'number', 'window bounds must include width')
  }
})

await check('current macOS host has osascript when runtime test is active', async () => {
  if (process.platform !== 'darwin') return
  const stdout = await runOsascript(['return "ok"'])
  assert(stdout.trim() === 'ok', `osascript returned ${JSON.stringify(stdout)}`)
})

const failed = checks.filter((item) => !item.ok)
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : `: ${item.error}`}`)
}

if (failed.length > 0) {
  process.exitCode = 1
}

function runOsascript(lines) {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      lines.flatMap((line) => ['-e', line]),
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error([stderr.trim(), err.message].filter(Boolean).join('\n')))
          return
        }
        resolve(stdout)
      }
    )
  })
}
