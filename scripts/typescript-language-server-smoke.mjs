#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
mkdirSync(path.join(repoRoot, 'tmp'), { recursive: true })
const tempRoot = mkdtempSync(path.join(repoRoot, 'tmp', 'typescript-lsp-smoke-'))
const projectDir = path.join(tempRoot, 'project')
let runtime

try {
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['src/**/*.ts']
  }, null, 2))
  const util = 'export function greet(name: string): string { return `Hello ${name}` }\n'
  const consumer = "import { greet } from './util'\nconst result: number = greet('x')\ngre\n"
  writeFileSync(path.join(projectDir, 'src', 'util.ts'), util)
  writeFileSync(path.join(projectDir, 'src', 'consumer.ts'), consumer)

  const bundlePath = path.join(tempRoot, 'typescript-language-server.mjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src', 'main', 'typescriptLanguageServer.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['typescript', 'typescript-language-server']
  })
  runtime = await import(pathToFileURL(bundlePath).href)

  const completion = await runtime.getTypeScriptCompletions(projectDir, request(consumer, 3, 4))
  assert.equal(completion.ok, true, completion.error)
  assert(completion.items.some((item) => item.label === 'greet'), 'LSP completion includes imported project symbol')

  const hover = await runtime.getTypeScriptHover(projectDir, {
    path: 'src/util.ts', content: util, line: 1, column: 19
  })
  assert.equal(hover.ok, true, hover.error)
  assert.match(hover.markdown, /greet.*string/is, 'LSP hover includes the function signature')

  const definition = await runtime.getTypeScriptDefinitions(projectDir, request(consumer, 2, 26))
  assert.equal(definition.ok, true, definition.error)
  assert(definition.locations.some((item) => item.path === 'src/util.ts' && item.line === 1),
    `LSP definition resolves across files: ${JSON.stringify(definition.locations)}`)

  const diagnostics = await runtime.getTypeScriptDiagnostics(projectDir, request(consumer, 2, 26))
  assert.equal(diagnostics.ok, true, diagnostics.error)
  assert(diagnostics.diagnostics.some((item) => item.code === '2322' && item.severity === 'error'),
    `LSP publishes semantic TS2322 diagnostic: ${JSON.stringify(diagnostics.diagnostics)}`)

  const traversal = await runtime.getTypeScriptDefinitions(projectDir, {
    path: '../outside.ts', content: 'greet()', line: 1, column: 1
  })
  assert.equal(traversal.ok, false)
  assert.deepEqual(traversal.locations, [])

  console.log('typescript language server smoke ok: completion, hover, definition, diagnostics, containment')
} finally {
  await runtime?.disposeTypeScriptLanguageServers?.().catch(() => undefined)
  rmSync(tempRoot, { recursive: true, force: true })
}

function request(content, line, column) {
  return { path: 'src/consumer.ts', content, line, column }
}
