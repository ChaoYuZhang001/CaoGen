#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const retiredPaths = [
  'src/main/ide/ide-bridge.ts',
  'src/main/ide/ide-bridge-manager.ts',
  'plugins/vscode/package.json',
  'plugins/vscode/src/extension.ts',
  'plugins/jetbrains/build.gradle.kts',
  'plugins/jetbrains/src/main/resources/META-INF/plugin.xml'
]
for (const relativePath of retiredPaths) {
  assert(!existsSync(path.join(repoRoot, relativePath)), `retired IDE plugin path restored: ${relativePath}`)
}

const packageJson = JSON.parse(read('package.json'))
const retiredScripts = [
  'test:ide-bridge',
  'test:ide-plugins',
  'test:ide-plugins:required',
  'test:jetbrains-ide-interaction',
  'test:jetbrains-ide-interaction:required',
  'test:jetbrains-recorder-e2e',
  'test:jetbrains-recorder-e2e:required',
  'test:vscode-extension-host:required',
  'test:p2-ide-build-and-vscode:required',
  'test:p2-ide:required'
]
for (const scriptName of retiredScripts) {
  assert(!packageJson.scripts?.[scriptName], `retired IDE plugin script restored: ${scriptName}`)
}

const productSources = [
  'src/main/index.ts',
  'src/main/ipc.ts',
  'src/main/settings.ts',
  'src/shared/types.ts',
  'src/renderer/src/store.ts',
  'src/renderer/src/components/SettingsModal.tsx'
].map(read).join('\n')
for (const marker of ['ideBridgeEnabled', 'ideBridgeHost', 'ideBridgePort', 'ideBridgeToken', 'syncIdeBridgeFromSettings']) {
  assert(!productSources.includes(marker), `retired IDE Bridge marker restored: ${marker}`)
}

const requiredGate = read('scripts/p2-required-gate.mjs')
const releaseScopeGate = read('scripts/p2-release-scope-gate.mjs')
for (const marker of ['ide_build_and_vscode_required', 'jetbrains_ide_interaction_required']) {
  assert(!requiredGate.includes(marker), `P2 required gate restored retired check: ${marker}`)
  assert(!releaseScopeGate.includes(marker), `P2 release gate restored retired check: ${marker}`)
}

const contributing = read('CONTRIBUTING.md')
assert(
  contributing.includes('以 `package.json` 中当前可用的 required gate 为准') &&
    contributing.includes('required gates in `package.json` as the public source of truth'),
  'public contribution guides must identify package.json required gates as the source of truth'
)

const readme = read('README.md')
assert(
  readme.includes('在应用内使用终端、文件、浏览器、Git'),
  'public README must describe the built-in coding workbench surface'
)

const workbench = read('src/renderer/src/components/workbench/WorkbenchRoot.tsx')
for (const marker of ["openPanel('diff')", "openPanel('terminal')", "openPanel('browser')", "openPanel('files')"]) {
  assert(workbench.includes(marker), `built-in coding workbench surface is missing: ${marker}`)
}
for (const scriptName of [
  'test:file-editor-tabs:required',
  'test:project-tests:required',
  'test:project-debugger:required',
  'test:project-refactor:required'
]) {
  assert(packageJson.scripts?.[scriptName], `built-in coding workbench required gate is missing: ${scriptName}`)
}

console.log('IDE plugin retirement smoke ok')

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}
