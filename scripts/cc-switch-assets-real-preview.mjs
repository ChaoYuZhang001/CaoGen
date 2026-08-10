#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const home = homedir()
const databasePath = path.join(home, '.cc-switch', 'cc-switch.db')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-assets-real-preview-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  const before = databaseIdentity()
  compileMigration()
  const migration = await import(pathToFileURL(findCompiled('migration.js')).href)
  const scan = migration.scanMigration(undefined, home)
  const assets = scan.assets.filter((asset) => asset.agent === 'CC Switch')
  const after = databaseIdentity()
  if (before !== after) throw new Error('CC Switch database changed during read-only asset preview')
  console.log(JSON.stringify({
    ok: true,
    databaseUnchanged: true,
    assetCount: assets.length,
    kinds: countBy(assets, (asset) => asset.kind),
    importableByKind: countBy(assets.filter((asset) => asset.importable), (asset) => asset.kind),
    blockedByKind: countBy(assets.filter((asset) => asset.risk === 'blocked'), (asset) => asset.kind),
    conflicts: countBy(assets, (asset) => asset.conflict),
    ignoredFields: countBy(assets.flatMap((asset) => asset.ignoredFields), (field) => field)
  }, null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileMigration() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/migration.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function countBy(values, keyOf) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = keyOf(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function databaseIdentity() {
  const stat = statSync(databasePath)
  const digest = createHash('sha256').update(readFileSync(databasePath)).digest('hex')
  return `${stat.size}:${stat.mtimeMs}:${digest}`
}

function findCompiled(fileName) {
  const queue = [outDir]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(candidate)
      else if (entry.name === fileName) return candidate
    }
  }
  throw new Error(`compiled module missing: ${fileName}`)
}
