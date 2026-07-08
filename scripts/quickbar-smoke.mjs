#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8')
}

function assertIncludes(file, needle, label = needle) {
  const text = read(file)
  if (!text.includes(needle)) {
    throw new Error(`${file} is missing ${label}`)
  }
}

function assertMatches(file, pattern, label = String(pattern)) {
  const text = read(file)
  if (!pattern.test(text)) {
    throw new Error(`${file} is missing ${label}`)
  }
}

const checks = [
  () => assertIncludes('src/main/quickbar/index.ts', 'globalShortcut.register', 'global shortcut registration'),
  () => assertIncludes('src/main/quickbar/index.ts', 'clipboard.readText', 'clipboard text read'),
  () => assertIncludes('src/main/quickbar/index.ts', 'copyImageAttachment', 'screenshot attachment copy'),
  () => assertIncludes('src/main/quickbar/index.ts', 'createGuiController', 'GUI/Desktop Control reuse'),
  () => assertIncludes('src/main/quickbar/index.ts', "dialog.showOpenDialog", 'native file picker'),
  () => assertIncludes('src/main/index.ts', 'registerQuickbarGlobalShortcut', 'app lifecycle shortcut install'),
  () => assertIncludes('src/main/index.ts', 'disposeQuickbar', 'app lifecycle shortcut cleanup'),
  () => assertIncludes('src/main/ipc.ts', 'registerQuickbarIpc', 'Quickbar IPC registration'),
  () => assertIncludes('src/preload/index.ts', 'quickbarCaptureScreenshot', 'preload screenshot bridge'),
  () => assertIncludes('src/preload/index.ts', 'onQuickbarEvent', 'preload Quickbar event bridge'),
  () => assertIncludes('src/shared/types.ts', 'QuickbarWindowContext', 'shared window context type'),
  () => assertIncludes('src/shared/types.ts', 'quickbarPrepareFiles', 'AgentDeskApi file bridge type'),
  () => assertIncludes('src/renderer/src/App.tsx', '<Quickbar />', 'renderer Quickbar mount'),
  () => assertIncludes('src/renderer/src/components/Quickbar.tsx', 'sendQuickbarClipboard', 'renderer clipboard action'),
  () => assertIncludes('src/renderer/src/components/Quickbar.tsx', 'quickbarPickFiles', 'renderer file picker action'),
  () => assertIncludes('src/renderer/src/store.ts', 'sendQuickbarScreenshot', 'store screenshot dispatcher'),
  () => assertMatches('src/main/quickbar/index.ts', /CommandOrControl\+Shift\+Space/, 'default accelerator')
]

for (const check of checks) check()

console.log(`quickbar-smoke: ${checks.length} checks passed`)
