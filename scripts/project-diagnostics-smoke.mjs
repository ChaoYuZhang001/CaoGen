import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const esbuild = require('esbuild')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-diagnostics-'))
const projectDir = path.join(tempRoot, 'project')

try {
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  mkdirSync(path.join(projectDir, 'node_modules', 'ignored'), { recursive: true })
  writeFileSync(path.join(projectDir, 'src', 'valid.ts'), 'export const valid = true\n', 'utf8')
  writeFileSync(path.join(projectDir, 'src', 'broken.ts'), 'export function broken( {\n', 'utf8')
  writeFileSync(path.join(projectDir, 'src', 'broken.py'), 'def broken():\n    return (\n', 'utf8')
  writeFileSync(path.join(projectDir, 'node_modules', 'ignored', 'broken.ts'), 'export function ignored( {\n', 'utf8')

  const bundlePath = path.join(tempRoot, 'project-diagnostics.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src/main/projectDiagnostics.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: [
      'tree-sitter',
      'tree-sitter-typescript',
      'tree-sitter-javascript',
      'tree-sitter-python',
      'tree-sitter-go',
      'tree-sitter-rust',
      'tree-sitter-java'
    ]
  })

  const diagnosticsModule = await import(pathToFileURL(bundlePath).href)
  const result = await diagnosticsModule.collectProjectDiagnostics(projectDir)
  assert.equal(result.ok, true)
  assert.equal(result.supportedFiles, 3)
  assert.equal(result.analyzedFiles, 3)
  assert(result.diagnostics.some((item) => item.path === 'src/broken.ts' && item.line === 1))
  assert(result.diagnostics.some((item) => item.path === 'src/broken.py'), JSON.stringify(result.diagnostics))
  assert(result.diagnostics.every((item) => !item.path.includes('node_modules')))
  assert(result.diagnostics.every((item) => item.source === 'tree-sitter' && item.code === 'syntax'))
  console.log(`project diagnostics smoke ok: ${result.diagnostics.length} problems across ${result.analyzedFiles} files`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
