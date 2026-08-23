#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const repoRoot = process.cwd()
const source = (relativePath) => readFileSync(path.join(repoRoot, relativePath), 'utf8')

const sessionExperienceSource = source('src/renderer/src/store/session-experience.ts')
const compiled = ts.transpileModule(sessionExperienceSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText
const module = { exports: {} }
vm.runInNewContext(
  `(function (exports, require, module) { ${compiled}\n})`,
  {},
  { filename: 'session-experience.js' }
)(module.exports, (specifier) => {
  if (specifier === './project-workspace-actions') {
    return { nextStudioSessionNonce: (nonce) => nonce }
  }
  throw new Error(`Unexpected session-experience dependency: ${specifier}`)
}, module)

const { sessionExperienceMode } = module.exports
assert(typeof sessionExperienceMode === 'function', 'sessionExperienceMode export is missing')
assertEqual(
  sessionExperienceMode({ projectId: 'legacy-context', experienceModeOverride: 'assistant' }),
  'assistant',
  'Assistant override must outrank a retained projectId'
)
assertEqual(
  sessionExperienceMode({ experienceModeOverride: 'studio' }),
  'studio',
  'Studio override must outrank missing ownership fields'
)
assertEqual(sessionExperienceMode({ projectId: 'project-owned' }), 'studio', 'Project ownership fallback regressed')
assertEqual(sessionExperienceMode({}), 'assistant', 'Unowned session fallback regressed')

const appSource = source('src/renderer/src/App.tsx')
const appListSource = source('src/renderer/src/components/AppListView.tsx')
const paletteSource = source('src/renderer/src/components/CommandPalette.tsx')
const sidebarGroupsSource = source('src/renderer/src/components/sidebar-project-groups.ts')
assert(
  appSource.includes('return mode === sessionExperienceMode(meta)'),
  'App numeric session shortcuts must use the authoritative experience projection'
)
assert(
  paletteSource.includes('return mode === sessionExperienceMode(record)'),
  'Command palette session and history filtering must use the authoritative experience projection'
)
assert(
  appListSource.includes("sessionExperienceMode(activeSession) === 'studio'"),
  'Main session surface must use the authoritative experience projection'
)
assert(
  sidebarGroupsSource.includes("sessionExperienceMode(record) === 'assistant'"),
  'Sidebar grouping must keep Assistant override sessions out of Project groups'
)

console.log('session experience projection smoke passed')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`)
}
