#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const esbuild = require('esbuild')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-indexer-network-'))
const localProjectDir = path.join(tempRoot, 'project')
const projectDir = localhostUncPath(localProjectDir)
const waves = positiveInteger(process.env.CAOGEN_INDEXER_STORM_WAVES, 16)
const waveIntervalMs = positiveInteger(process.env.CAOGEN_INDEXER_STORM_INTERVAL_MS, 500)
const settleTimeoutMs = positiveInteger(process.env.CAOGEN_INDEXER_STORM_TIMEOUT_MS, 45_000)
const report = {
  transport: 'SMB UNC loopback',
  waves,
  waveIntervalMs,
  operations: 0,
  expectedFiles: 0
}
const watcherErrors = []
const persistenceErrors = []
const originalError = console.error
console.error = (...args) => {
  if (args.some((arg) => String(arg).includes('Project index watcher'))) watcherErrors.push(args.map(String).join(' '))
  if (args.some((arg) => String(arg).includes('Project index persistence failed'))) persistenceErrors.push(args.map(String).join(' '))
  originalError(...args)
}

let indexerModule
try {
  mkdirSync(path.join(projectDir, 'src', 'base'), { recursive: true })
  for (let index = 0; index < 32; index += 1) {
    writeSource(path.join(projectDir, 'src', 'base', `base-${pad(index)}.ts`), `baseSymbol${index}`, index)
  }

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

  indexerModule = await import(pathToFileURL(bundlePath).href)
  const indexer = await indexerModule.ensureProjectIndex(projectDir, { watch: true })
  assert(indexer.stats()?.root.startsWith('\\\\'), 'indexer must retain the UNC project identity')
  const persistenceBeforeStorm = indexer.stats()?.persistenceWrites ?? 0
  const stormStarted = performance.now()

  for (let wave = 0; wave < waves; wave += 1) {
    const liveDir = path.join(projectDir, 'src', 'live')
    const historyDir = path.join(projectDir, 'src', 'history', `wave-${pad(wave)}`)
    const renameDir = path.join(projectDir, 'src', 'renamed', `wave-${pad(wave)}`)
    mkdirSync(liveDir, { recursive: true })
    mkdirSync(historyDir, { recursive: true })
    mkdirSync(renameDir, { recursive: true })

    for (let index = 0; index < 32; index += 1) {
      writeSource(path.join(liveDir, `item-${pad(index)}.ts`), `stormWave${wave}Item${index}`, wave * 100 + index)
      report.operations += 1
    }
    for (let index = 0; index < 16; index += 1) {
      writeSource(path.join(historyDir, `history-${pad(index)}.ts`), `historyWave${wave}Item${index}`, wave * 100 + index)
      report.operations += 1
    }
    for (let index = 0; index < 8; index += 1) {
      const pending = path.join(renameDir, `pending-${pad(index)}.ts`)
      const settled = path.join(renameDir, `settled-${pad(index)}.ts`)
      writeSource(pending, `renamedWave${wave}Item${index}`, wave * 100 + index)
      renameSync(pending, settled)
      report.operations += 2
    }
    if (wave > 0) {
      await removeNetworkTree(path.join(projectDir, 'src', 'history', `wave-${pad(wave - 1)}`))
      await removeNetworkTree(path.join(projectDir, 'src', 'renamed', `wave-${pad(wave - 1)}`))
      report.operations += 24
    }
    await delay(waveIntervalMs)
  }

  report.stormDurationMs = rounded(performance.now() - stormStarted)
  assert(report.stormDurationMs >= waves * waveIntervalMs, 'storm must remain active for the configured duration')
  const lastWave = waves - 1
  await waitFor(
    () => indexer.searchSymbols(`stormWave${lastWave}Item`, 'function', 100).length === 32,
    'watcher must converge on all latest overwritten files'
  )
  await waitFor(
    () => indexer.searchSymbols(`historyWave${lastWave}Item`, 'function', 100).length === 16,
    'watcher must converge on the latest created history wave'
  )
  await waitFor(
    () => indexer.searchSymbols(`renamedWave${lastWave}Item`, 'function', 100).length === 8,
    'watcher must converge on every renamed file'
  )
  await waitFor(
    () => indexer.searchSymbols('stormWave0Item0', 'function', 10).length === 0,
    'overwritten symbols from the first wave must disappear'
  )
  await waitFor(
    () => indexer.searchSymbols('historyWave0Item0', 'function', 10).length === 0,
    'deleted history symbols from the first wave must disappear'
  )

  for (let index = 0; index < 8; index += 1) {
    await removeNetworkTree(path.join(projectDir, 'src', 'base', `base-${pad(index)}.ts`))
    report.operations += 1
  }
  report.expectedFiles = 24 + 32 + 16 + 8
  await waitFor(() => indexer.stats()?.files === report.expectedFiles, 'watcher file count must converge after deletes')
  await waitFor(
    () => (indexer.stats()?.persistenceWrites ?? 0) > persistenceBeforeStorm,
    'watcher storm must persist at least one new snapshot'
  )
  await delay(1_000)

  const liveStats = indexer.stats()
  report.liveStats = publicStats(liveStats)
  report.persistenceWritesDuringStorm = (liveStats?.persistenceWrites ?? 0) - persistenceBeforeStorm
  assert(report.persistenceWritesDuringStorm > 0, 'watcher storm must produce durable snapshots')
  assert(
    report.persistenceWritesDuringStorm <= waves * 3,
    `watcher storm persistence must remain coalesced, got ${report.persistenceWritesDuringStorm} snapshots`
  )
  assert(
    !readdirSync(path.join(projectDir, '.caogen')).some((name) => name.endsWith('.tmp')),
    'network persistence must not leave temporary snapshots'
  )

  await indexerModule.disposeProjectIndexers()
  const reopened = await indexerModule.ensureProjectIndex(projectDir, { watch: false })
  report.reopenedStats = publicStats(reopened.stats())
  assert(watcherErrors.length === 0, `UNC watcher must not emit errors, got ${watcherErrors.length}`)
  assert(persistenceErrors.length === 0, `UNC persistence must not emit errors, got ${persistenceErrors.length}`)
  assert(report.reopenedStats?.files === report.expectedFiles, 'UNC database reopen must preserve the exact final file count')
  assert(
    reopened.searchSymbols(`stormWave${lastWave}Item31`, 'function', 10).some((item) => item.filePath === 'src/live/item-031.ts'),
    'UNC database reopen must retain the final overwritten symbol'
  )
  assert(
    reopened.searchSymbols(`renamedWave${lastWave}Item7`, 'function', 10).some((item) => item.filePath.endsWith('settled-007.ts')),
    'UNC database reopen must retain renamed-file identity'
  )
  assert(reopened.searchSymbols('baseSymbol0', 'function', 10).length === 0, 'UNC database reopen must retain deletes')
  assert(existsSync(path.join(projectDir, '.caogen', 'index.db')), 'UNC index database must remain durable')
  await indexerModule.disposeProjectIndexers()
  indexerModule = undefined

  const reportDir = path.join(repoRoot, 'test-results', 'indexer-network-watcher')
  mkdirSync(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, `${new Date().toISOString().replaceAll(':', '-')}.json`)
  report.requirement = 'IDE-001/IDE-002 sustained watcher storm and network-filesystem recovery'
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`indexer network watcher smoke ok: ${reportPath}`)
  console.log(JSON.stringify(report))
} finally {
  if (indexerModule) await indexerModule.disposeProjectIndexers().catch(() => undefined)
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

function localhostUncPath(localPath) {
  const parsed = path.win32.parse(path.resolve(localPath))
  const drive = parsed.root.match(/^([A-Za-z]):\\$/)?.[1]
  if (!drive) throw new Error(`network watcher smoke requires a drive-letter temporary directory, got ${parsed.root}`)
  const remainder = path.resolve(localPath).slice(parsed.root.length)
  return `\\\\localhost\\${drive}$\\${remainder}`
}

function writeSource(filePath, symbol, value) {
  writeFileSync(filePath, `export function ${symbol}() { return ${value} }\n`, 'utf8')
}

async function waitFor(producer, message) {
  const started = Date.now()
  while (Date.now() - started < settleTimeoutMs) {
    if (producer()) return
    await delay(100)
  }
  throw new Error(`${message} (timeout ${settleTimeoutMs}ms)`)
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

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function pad(value) {
  return String(value).padStart(3, '0')
}

function rounded(value) {
  return Math.round(value * 10) / 10
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function removeNetworkTree(target) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
      return
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error
      await delay(150)
    }
  }
  throw new Error(`unable to remove UNC fixture path after retries: ${target}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
