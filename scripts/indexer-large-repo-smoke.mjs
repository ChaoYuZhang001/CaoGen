#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const esbuild = require('esbuild')
const fileCount = boundedInteger(process.env.CAOGEN_INDEXER_LARGE_FILES, 50_000, 5_001, 50_000)
const coldLimitMs = boundedInteger(process.env.CAOGEN_INDEXER_COLD_LIMIT_MS, 300_000, 5_000, 600_000)
const warmLimitMs = boundedInteger(process.env.CAOGEN_INDEXER_WARM_LIMIT_MS, 90_000, 2_000, 300_000)
const queryLimitMs = boundedInteger(process.env.CAOGEN_INDEXER_QUERY_LIMIT_MS, 5_000, 100, 30_000)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-indexer-large-'))
const projectDir = path.join(tempRoot, 'project')
const report = { fileCount, coldLimitMs, warmLimitMs, queryLimitMs }

try {
  const tailCount = 7
  const bulkCount = fileCount - tailCount
  const languages = [
    { extension: 'ts', language: 'typescript', symbol: 'deepTypeScriptWorker', source: (index) => `export function bulkTypeScript${index}() { return ${index} }\n`, tail: `import { bulkTypeScript0 } from '../b/p000/f00000.ts'\nexport function deepTypeScriptWorker() { return bulkTypeScript0() }\n` },
    { extension: 'tsx', language: 'tsx', symbol: 'deepTsxWorker', source: (index) => `export function bulkTsx${index}() { return ${index} }\n`, tail: 'export function deepTsxWorker() { return <div /> }\n' },
    { extension: 'js', language: 'javascript', symbol: 'deepJavaScriptWorker', source: (index) => `export function bulkJavaScript${index}() { return ${index} }\n`, tail: 'export function deepJavaScriptWorker() { return 42 }\n' },
    { extension: 'py', language: 'python', symbol: 'deepPythonWorker', source: (index) => `def bulk_python_${index}():\n    return ${index}\n`, tail: 'def deepPythonWorker():\n    return 42\n' },
    { extension: 'go', language: 'go', symbol: 'deepGoWorker', source: (index) => `package fixture\nfunc BulkGo${index}() int { return ${index} }\n`, tail: 'package fixture\nfunc DeepGoWorker() int { return 42 }\n' },
    { extension: 'rs', language: 'rust', symbol: 'deepRustWorker', source: (index) => `pub fn bulk_rust_${index}() -> i32 { ${index} }\n`, tail: 'pub fn deepRustWorker() -> i32 { 42 }\n' },
    { extension: 'java', language: 'java', symbol: 'deepJavaWorker', source: (index) => `class BulkJava${index} { int value() { return ${index}; } }\n`, tail: 'class DeepJavaWorker { int value() { return 42; } }\n' }
  ]
  const bulkRoot = path.join(projectDir, 'b')
  mkdirSync(bulkRoot, { recursive: true })
  for (let index = 0; index < bulkCount; index += 1) {
    const spec = languages[index % languages.length]
    const directory = path.join(bulkRoot, `p${String(Math.floor(index / 100)).padStart(3, '0')}`)
    if (index % 100 === 0) mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, `f${String(index).padStart(5, '0')}.${spec.extension}`), spec.source(index), 'utf8')
  }
  const tailRoot = path.join(projectDir, 'z-tail')
  mkdirSync(tailRoot, { recursive: true })
  for (const spec of languages) {
    writeFileSync(path.join(tailRoot, `${spec.language}-deep-special-worker.${spec.extension}`), spec.tail, 'utf8')
  }
  const targetRelative = 'z-tail/typescript-deep-special-worker.ts'
  const extraRelative = 'b/p499/zz-after-limit.ts'
  const extraPath = path.join(projectDir, extraRelative)

  const bundlePath = path.join(tempRoot, 'compiled', 'indexer.cjs')
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
  const coldStarted = performance.now()
  const cold = await indexerModule.ensureProjectIndex(projectDir, { watch: false })
  report.coldWallMs = rounded(performance.now() - coldStarted)
  report.coldStats = publicStats(cold.stats())
  assert(report.coldStats?.files === fileCount, `expected ${fileCount} indexed files, got ${report.coldStats?.files}`)
  assert(report.coldStats?.truncated === false, '50,000-file mixed-language fixture must be complete at the supported ceiling')
  assert(report.coldStats?.persistenceWrites === 1, 'cold build should emit one atomic database snapshot')
  assert(report.coldWallMs <= coldLimitMs, `cold index ${report.coldWallMs}ms exceeds ${coldLimitMs}ms`)
  assert(existsSync(path.join(projectDir, '.caogen', 'index.db')), 'cold index should persist index.db')

  const languageEvidence = {}
  for (const spec of languages) {
    const started = performance.now()
    const matches = cold.searchSymbols(spec.symbol, undefined, 10)
    languageEvidence[spec.language] = { matches: matches.length, queryMs: rounded(performance.now() - started) }
    assert(matches.some((symbol) => symbol.filePath.startsWith('z-tail/')), `${spec.language} tail symbol should be indexed`)
    assert(languageEvidence[spec.language].queryMs <= queryLimitMs, `${spec.language} symbol query exceeds ${queryLimitMs}ms`)
  }
  report.languageEvidence = languageEvidence

  const fileQueryStarted = performance.now()
  const targetFiles = cold.findFiles('deep-special-worker', 10)
  report.fileQueryMs = rounded(performance.now() - fileQueryStarted)
  assert(targetFiles.some((file) => file.path === targetRelative), 'file search must find entries beyond the old 5,000-row window')
  assert(report.fileQueryMs <= queryLimitMs, `file query ${report.fileQueryMs}ms exceeds ${queryLimitMs}ms`)

  const fuzzyQueryStarted = performance.now()
  const fuzzyFiles = cold.findFiles('dspw', 10)
  report.fuzzyQueryMs = rounded(performance.now() - fuzzyQueryStarted)
  assert(fuzzyFiles.some((file) => file.path === targetRelative), 'bounded fuzzy search must cover the complete indexed file set')
  assert(report.fuzzyQueryMs <= queryLimitMs, `fuzzy query ${report.fuzzyQueryMs}ms exceeds ${queryLimitMs}ms`)

  const symbolQueryStarted = performance.now()
  const symbols = cold.searchSymbols('deepTypeScriptWorker', 'function', 10)
  report.symbolQueryMs = rounded(performance.now() - symbolQueryStarted)
  assert(symbols.some((symbol) => symbol.filePath === targetRelative), 'symbol search should find the TypeScript tail-file symbol')
  assert(report.symbolQueryMs <= queryLimitMs, `symbol query ${report.symbolQueryMs}ms exceeds ${queryLimitMs}ms`)

  const emptySearchStarted = performance.now()
  const emptyMatches = await cold.searchCode('__CAOGEN_LARGE_REPO_NO_MATCH_7F9C__', 'b/**/*.ts', 10)
  report.emptyCodeSearchMs = rounded(performance.now() - emptySearchStarted)
  assert(emptyMatches.length === 0, 'no-match code search should remain empty')
  assert(report.emptyCodeSearchMs <= 6_000, `no-match ripgrep search ${report.emptyCodeSearchMs}ms should not fall back to a full synchronous scan`)

  await indexerModule.disposeProjectIndexers()
  const warmStarted = performance.now()
  const warm = await indexerModule.ensureProjectIndex(projectDir, { watch: false })
  report.warmWallMs = rounded(performance.now() - warmStarted)
  report.warmStats = publicStats(warm.stats())
  assert(report.warmStats?.files === fileCount, 'warm reopen should preserve every mixed-language indexed file')
  assert(report.warmStats?.truncated === false, 'warm reopen should remain complete')
  assert(report.warmWallMs <= warmLimitMs, `warm index ${report.warmWallMs}ms exceeds ${warmLimitMs}ms`)
  assert(report.warmWallMs < report.coldWallMs, `warm index ${report.warmWallMs}ms should be faster than cold ${report.coldWallMs}ms`)
  assert(warm.searchSymbols('deepTypeScriptWorker', undefined, 10).some((symbol) => symbol.filePath === targetRelative), 'warm database should retain the TypeScript tail symbol')

  writeFileSync(extraPath, 'export function afterLimitSentinel() { return 50_001 }\n', 'utf8')
  await indexerModule.disposeProjectIndexers()
  const truncated = await indexerModule.ensureProjectIndex(projectDir, { watch: false, maxFiles: fileCount })
  report.truncatedStats = publicStats(truncated.stats())
  assert(report.truncatedStats?.truncated === true, '50,001-file reopen must report explicit truncation at the 50,000-file ceiling')
  assert(report.truncatedStats?.files === fileCount, `truncated reopen must preserve exactly ${fileCount} rows, got ${report.truncatedStats?.files}`)
  assert(truncated.searchSymbols('deepTypeScriptWorker', undefined, 10).some((symbol) => symbol.filePath === targetRelative), 'truncated reopen must preserve an existing tail row')
  assert(truncated.searchSymbols('afterLimitSentinel', undefined, 10).length === 0, 'file beyond the ceiling must not enter the bounded index')
  await indexerModule.disposeProjectIndexers()

  const reportDir = path.join(repoRoot, 'test-results', 'indexer-large-repo')
  mkdirSync(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, `${new Date().toISOString().replaceAll(':', '-')}.json`)
  report.requirement = 'IDE-001/IDE-002 50,000-file mixed-language monorepo performance'
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`indexer large-repo smoke ok: ${reportPath}`)
  console.log(JSON.stringify(report))
} finally {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback
}

function rounded(value) {
  return Math.round(value * 10) / 10
}

function publicStats(stats) {
  if (!stats) return null
  return {
    files: stats.files,
    symbols: stats.symbols,
    dependencies: stats.dependencies,
    durationMs: stats.durationMs,
    truncated: stats.truncated,
    persistenceWrites: stats.persistenceWrites
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
