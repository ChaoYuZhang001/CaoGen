import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const esbuild = require('esbuild')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-indexer-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')
const waitTimeoutMs = positiveInteger(process.env.CAOGEN_INDEXER_SMOKE_TIMEOUT_MS, 15_000)

try {
  mkdirSync(path.join(projectDir, 'src/nested'), { recursive: true })
  mkdirSync(path.join(projectDir, 'ignored'), { recursive: true })
  writeFileSync(path.join(projectDir, '.gitignore'), 'ignored/\n*.gen.ts\n', 'utf8')
  writeFileSync(
    path.join(projectDir, 'src/util.ts'),
    [
      "export const VERSION = '1.0.0'",
      '',
      'export function normalizeName(name: string) {',
      '  return name.trim().toLowerCase()',
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    path.join(projectDir, 'src/math.ts'),
    [
      "import { VERSION, normalizeName } from './util'",
      '',
      'export interface Calculator {',
      '  add(a: number, b: number): number',
      '}',
      '',
      'export function add(a: number, b: number) {',
      '  return `${VERSION}:${normalizeName(String(a + b))}`',
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    path.join(projectDir, 'src/nested/consumer.ts'),
    ["import { add } from '../math'", '', 'export const total = add(1, 2)', ''].join('\n'),
    'utf8'
  )
  writeFileSync(
    path.join(projectDir, 'src/app.py'),
    ['class Worker:', '    def run(self):', '        return "ok"', ''].join('\n'),
    'utf8'
  )
  writeFileSync(
    path.join(projectDir, 'src/main.go'),
    ['package main', 'import "fmt"', 'func main() { fmt.Println("ok") }', ''].join('\n'),
    'utf8'
  )
  writeFileSync(path.join(projectDir, 'ignored/skip.ts'), 'export function shouldNotIndex() {}\n', 'utf8')

  const bundlePath = path.join(outDir, 'indexer.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src/main/indexer/index.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: [
      'chokidar',
      'sql.js',
      'tree-sitter',
      'tree-sitter-typescript',
      'tree-sitter-javascript',
      'tree-sitter-python',
      'tree-sitter-go',
      'tree-sitter-rust',
      'tree-sitter-java'
    ]
  })

  const indexerModule = await import(pathToFileURL(bundlePath).href)
  const indexer = await indexerModule.ensureProjectIndex(projectDir, { watch: true })

  await waitFor(() => existsSync(path.join(projectDir, '.caogen/index.db')), 'index.db should be persisted')
  const stats = indexer.stats()
  assert(stats?.files >= 5, `expected at least 5 indexed files, got ${stats?.files}`)
  assert(stats?.truncated === false, 'small project should not report a truncated index')
  assert(stats?.persistenceWrites === 1, 'initial rebuild should persist exactly one atomic index snapshot')

  const addSymbols = indexer.searchSymbols('add', 'function', 10)
  assert(addSymbols.some((item) => item.filePath === 'src/math.ts' && item.exported), 'should find exported add function')

  const workerSymbols = indexer.searchSymbols('Worker', 'class', 10)
  assert(workerSymbols.some((item) => item.filePath === 'src/app.py'), 'should find Python class')

  const skipped = indexer.searchSymbols('shouldNotIndex', undefined, 10)
  assert(skipped.length === 0, '.gitignore ignored file should not be indexed')

  const files = indexer.findFiles('math', 10)
  assert(files.some((item) => item.path === 'src/math.ts'), 'find_file should find math.ts')

  const mathDeps = indexer.dependencies('src/math.ts')
  assert(mathDeps.dependencies.includes('src/util.ts'), 'math.ts should depend on util.ts')

  const utilDeps = indexer.dependencies('src/util.ts')
  assert(utilDeps.dependents.includes('src/math.ts'), 'util.ts should have reverse dependent math.ts')

  const ripgrepConfigPath = path.join(tempRoot, 'malicious-ripgreprc')
  const ripgrepPreprocessorPath = path.join(tempRoot, 'ripgrep-preprocessor.sh')
  const ripgrepMarkerPath = path.join(tempRoot, 'ripgrep-preprocessor-ran')
  writeFileSync(
    ripgrepPreprocessorPath,
    `#!/bin/sh\ntouch ${JSON.stringify(ripgrepMarkerPath)}\ncat\n`,
    'utf8'
  )
  chmodSync(ripgrepPreprocessorPath, 0o700)
  writeFileSync(
    ripgrepConfigPath,
    [`--pre=${ripgrepPreprocessorPath}`, '--pre-glob=*.ts', 'x', '.'].join('\n') + '\n',
    'utf8'
  )
  const previousRipgrepConfigPath = process.env.RIPGREP_CONFIG_PATH
  process.env.RIPGREP_CONFIG_PATH = ripgrepConfigPath
  try {
    const hasRipgrep = await indexerModule.hasRipgrepBinary()
    const codeMatches = await indexer.searchCode('VERSION', 'src/**/*.ts', 10)
    assert(codeMatches.some((item) => item.filePath === 'src/util.ts'), 'search_code should find VERSION')
    if (hasRipgrep) {
      assert(!existsSync(ripgrepMarkerPath), 'search_code must not execute commands from RIPGREP_CONFIG_PATH')
    }
  } finally {
    if (previousRipgrepConfigPath === undefined) delete process.env.RIPGREP_CONFIG_PATH
    else process.env.RIPGREP_CONFIG_PATH = previousRipgrepConfigPath
  }

  writeFileSync(
    path.join(projectDir, 'src/util.ts'),
    `${readFileSync(path.join(projectDir, 'src/util.ts'), 'utf8')}\nexport function freshSymbol() {\n  return VERSION\n}\n`,
    'utf8'
  )
  await waitFor(() => indexer.searchSymbols('freshSymbol', 'function', 5).length > 0, 'watcher should incrementally index changed file')

  const burstDir = path.join(projectDir, 'src/burst')
  mkdirSync(burstDir, { recursive: true })
  const persistenceBeforeBurst = indexer.stats().persistenceWrites
  for (let index = 0; index < 24; index += 1) {
    writeFileSync(
      path.join(burstDir, `burst-${String(index).padStart(2, '0')}.ts`),
      `export function burstSymbol${index}() { return ${index} }\n`,
      'utf8'
    )
  }
  await waitFor(
    () => indexer.searchSymbols('burstSymbol', 'function', 100).length === 24,
    'watcher should index a burst of changed files'
  )
  await waitFor(
    () => indexer.stats().persistenceWrites > persistenceBeforeBurst,
    'burst update should persist an index snapshot'
  )
  await new Promise((resolve) => setTimeout(resolve, 750))
  const persistenceAfterBurst = indexer.stats().persistenceWrites
  assert(
    persistenceAfterBurst - persistenceBeforeBurst <= 3,
    `24 watcher updates should coalesce to at most 3 snapshots, got ${persistenceAfterBurst - persistenceBeforeBurst}`
  )
  assert(
    !readdirSync(path.join(projectDir, '.caogen')).some((name) => name.endsWith('.tmp')),
    'atomic index persistence should not leave temporary files'
  )

  await indexerModule.disposeProjectIndexers()
  const reopened = await indexerModule.ensureProjectIndex(projectDir, { watch: false })
  assert(
    reopened.searchSymbols('burstSymbol23', 'function', 5).some((item) => item.filePath.endsWith('burst-23.ts')),
    'coalesced snapshot should survive a fresh indexer process boundary'
  )
  assert(reopened.stats()?.files >= 29, 'live stats should include watcher-added files after reopen')
  await indexerModule.disposeProjectIndexers()
  const truncated = await indexerModule.ensureProjectIndex(projectDir, { watch: false, maxFiles: 10 })
  assert(truncated.stats()?.truncated === true, 'bounded scan should report truncation explicitly')
  assert(truncated.stats()?.files >= 29, 'truncated warm scan must not delete previously indexed rows it did not revisit')
  await indexerModule.disposeProjectIndexers()
  console.log('indexer smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function waitFor(fn, message) {
  const start = Date.now()
  while (Date.now() - start < waitTimeoutMs) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${message} (timeout ${waitTimeoutMs}ms)`)
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
