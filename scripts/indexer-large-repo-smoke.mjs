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
const fileCount = boundedInteger(process.env.CAOGEN_INDEXER_LARGE_FILES, 5_200, 5_001, 20_000)
const coldLimitMs = boundedInteger(process.env.CAOGEN_INDEXER_COLD_LIMIT_MS, 90_000, 5_000, 300_000)
const warmLimitMs = boundedInteger(process.env.CAOGEN_INDEXER_WARM_LIMIT_MS, 30_000, 2_000, 120_000)
const queryLimitMs = boundedInteger(process.env.CAOGEN_INDEXER_QUERY_LIMIT_MS, 2_000, 100, 30_000)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-indexer-large-'))
const projectDir = path.join(tempRoot, 'project')
const report = { fileCount: fileCount + 1, coldLimitMs, warmLimitMs, queryLimitMs }

try {
  const bulkRoot = path.join(projectDir, 'b')
  mkdirSync(bulkRoot, { recursive: true })
  for (let index = 0; index < fileCount; index += 1) {
    const directory = path.join(bulkRoot, `p${String(Math.floor(index / 100)).padStart(3, '0')}`)
    if (index % 100 === 0) mkdirSync(directory, { recursive: true })
    writeFileSync(
      path.join(directory, `f${String(index).padStart(5, '0')}.ts`),
      `export const bulkSymbol${index} = ${index}\n`,
      'utf8'
    )
  }
  const targetRelative = 'very-long-directory-name-that-sorts-after-the-first-five-thousand-files/deep-special-worker.ts'
  const targetPath = path.join(projectDir, targetRelative)
  mkdirSync(path.dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, 'export function deepSpecialWorker() { return 42 }\n', 'utf8')

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
  assert(report.coldStats?.files === fileCount + 1, `expected ${fileCount + 1} indexed files, got ${report.coldStats?.files}`)
  assert(report.coldStats?.truncated === false, 'large fixture below 50,000 files must not be truncated')
  assert(report.coldStats?.persistenceWrites === 1, 'cold build should emit one atomic database snapshot')
  assert(report.coldWallMs <= coldLimitMs, `cold index ${report.coldWallMs}ms exceeds ${coldLimitMs}ms`)
  assert(existsSync(path.join(projectDir, '.caogen', 'index.db')), 'cold index should persist index.db')

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
  const symbols = cold.searchSymbols('deepSpecialWorker', 'function', 10)
  report.symbolQueryMs = rounded(performance.now() - symbolQueryStarted)
  assert(symbols.some((symbol) => symbol.filePath === targetRelative), 'symbol search should find the tail-file symbol')
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
  assert(report.warmStats?.files === fileCount + 1, 'warm reopen should preserve every indexed file')
  assert(report.warmStats?.truncated === false, 'warm reopen should remain complete')
  assert(report.warmWallMs <= warmLimitMs, `warm index ${report.warmWallMs}ms exceeds ${warmLimitMs}ms`)
  assert(report.warmWallMs < report.coldWallMs, `warm index ${report.warmWallMs}ms should be faster than cold ${report.coldWallMs}ms`)
  assert(warm.searchSymbols('deepSpecialWorker', 'function', 10).length === 1, 'warm database should retain the tail symbol')
  await indexerModule.disposeProjectIndexers()

  const reportDir = path.join(repoRoot, 'test-results', 'indexer-large-repo')
  mkdirSync(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, `${new Date().toISOString().replaceAll(':', '-')}.json`)
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
