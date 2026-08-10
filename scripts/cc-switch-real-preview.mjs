#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const sourceRoot = path.join(homedir(), '.cc-switch')
const databasePath = path.join(sourceRoot, 'cc-switch.db')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-cc-switch-real-preview-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  const before = databaseIdentity()
  compileSourceReader()
  installRuntimeDependencies()
  const reader = await import(pathToFileURL(findCompiled('ccSwitchProviderSource.js')).href)
  const snapshot = reader.readCcSwitchSourceSnapshot()
  const after = databaseIdentity()
  if (before !== after) throw new Error('CC Switch database changed during read-only preview')
  console.log(JSON.stringify(safeSummary(snapshot), null, 2))
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compileSourceReader() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/ccSwitchProviderSource.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installRuntimeDependencies() {
  const electronRoot = path.join(outDir, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0', main: 'index.js' }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = { app: { getPath(name) {\n` +
    `  if (name === 'home') return ${JSON.stringify(homedir())}\n` +
    `  throw new Error('unsupported Electron path: ' + name)\n} } }\n`)
  cpSync(path.join(repoRoot, 'node_modules', '@iarna', 'toml'), path.join(outDir, 'node_modules', '@iarna', 'toml'), { recursive: true })
}

function safeSummary(snapshot) {
  return {
    ok: true,
    databaseUnchanged: true,
    providerCount: snapshot.providerCount,
    importableCount: snapshot.providers.filter((provider) => provider.input).length,
    credentialCount: snapshot.providers.filter((provider) => provider.token).length,
    pricingRecordCount: snapshot.pricingCount,
    pricedProviderCount: snapshot.providers.filter((provider) => provider.pricedModelCount > 0).length,
    sourceApps: countBy(snapshot.providers, (provider) => provider.sourceApp),
    engines: countBy(snapshot.providers, (provider) => provider.input?.engine ?? 'unparsed'),
    protocols: countBy(snapshot.providers, protocolName),
    reliabilityByApp: reliabilityByApp(snapshot.providers),
    warnings: countBy(snapshot.providers.flatMap((provider) => provider.warnings), (warning) => warning)
  }
}

function reliabilityByApp(providers) {
  const policies = new Map()
  for (const provider of providers) {
    const reliability = provider.input?.advancedConfig?.reliability
    if (!reliability || policies.has(provider.sourceApp)) continue
    policies.set(provider.sourceApp, {
      failoverEnabled: reliability.failoverEnabled,
      maxRetries: reliability.maxRetries,
      circuitBreaker: reliability.circuitBreaker
    })
  }
  return Object.fromEntries([...policies.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

function protocolName(provider) {
  if (!provider.input) return 'unparsed'
  if (provider.input.engine === 'anthropic') return 'anthropic-messages'
  return provider.input.openaiProtocol === 'chat' ? 'openai-chat' : 'openai-responses'
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
