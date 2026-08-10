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
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-language-'))
const projectDir = path.join(tempRoot, 'project')
let intelligence

try {
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  writeFileSync(path.join(projectDir, 'src', 'util.ts'), 'export function normalizeName(value: string) { return value.trim() }\n', 'utf8')
  writeFileSync(path.join(projectDir, 'src', 'consumer.ts'), "import { normalizeName } from './util'\nexport const selected = normalizeName('x')\n", 'utf8')

  const bundlePath = path.join(tempRoot, 'project-language.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src/main/projectLanguageIntelligence.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: [
      'chokidar', 'sql.js', 'tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript',
      'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust', 'tree-sitter-java'
    ]
  })
  intelligence = await import(pathToFileURL(bundlePath).href)
  const completion = await intelligence.searchProjectSymbols(projectDir, 'normalize', 20)
  assert.equal(completion.ok, true)
  assert(completion.symbols.some((item) => item.name === 'normalizeName' && item.path === 'src/util.ts'))
  assert.equal(completion.symbols.filter((item) => item.name === 'normalizeName' && item.path === 'src/util.ts').length, 1,
    'completion results deduplicate export wrappers and concrete declarations')

  const definition = await intelligence.resolveProjectDefinition(projectDir, 'src/consumer.ts', 'normalizeName')
  assert.equal(definition.ok, true)
  assert.equal(definition.symbols.length, 1, 'export wrappers and concrete declarations are deduplicated')
  assert.equal(definition.symbols[0]?.path, 'src/util.ts')
  assert.equal(definition.symbols[0]?.line, 1)
  assert.notEqual(definition.symbols[0]?.kind, 'export')

  const traversal = await intelligence.resolveProjectDefinition(projectDir, '../outside.ts', 'normalizeName')
  assert.equal(traversal.ok, false)
  assert.deepEqual(traversal.symbols, [])
  console.log('project language intelligence smoke ok')
} finally {
  await intelligence?.disposeProjectLanguageIntelligence?.().catch(() => undefined)
  rmSync(tempRoot, { recursive: true, force: true })
}
