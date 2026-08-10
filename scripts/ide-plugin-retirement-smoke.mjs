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

const replacementPlan = read('docs/COMPETITOR-REPLACEMENT-MASTER-PLAN.md')
assert(replacementPlan.includes('`IDE-001`'), 'built-in coding workbench replacement target is missing')
assert(replacementPlan.includes('`IDE-002`'), 'built-in coding workbench acceptance target is missing')
assert(replacementPlan.includes('不依赖 VS Code/JetBrains 插件'), 'replacement plan must forbid IDE plugin dependency')

console.log('IDE plugin retirement smoke ok')

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}
