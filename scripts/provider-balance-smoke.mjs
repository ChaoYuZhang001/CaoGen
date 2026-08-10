#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Module } from 'node:module'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-balance-'))
const outDir = path.join(tempRoot, 'compiled')
const checks = []

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    'src/main/provider/providerBalanceService.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
  globalThis.app = { getPath: () => tempRoot }
  process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
  Module._initPaths()
  const api = await import(pathToFileURL(findCompiled(outDir, 'providerBalanceService.js')).href)

  const deepseek = api.extractProviderBalanceItems({ balance_infos: [
    { currency: 'USD', total_balance: '12.50' },
    { currency: 'CNY', total_balance: 8 }
  ] }, { itemsPath: '/balance_infos', labelPath: '/currency', unitPath: '/currency', remainingPath: '/total_balance' })
  equal(deepseek?.[0]?.remaining, 12.5, 'DeepSeek remaining balance parses')
  equal(deepseek?.[1]?.unit, 'CNY', 'array balance unit parses')

  const openrouter = api.extractProviderBalanceItems({ data: { total_credits: 20, total_usage: 7.25 } }, {
    totalPath: '/data/total_credits', usedPath: '/data/total_usage', label: 'OpenRouter', unit: 'USD'
  })
  equal(openrouter?.[0]?.remaining, 12.75, 'OpenRouter remaining is total minus usage')

  const novita = api.extractProviderBalanceItems({ availableBalance: 123456 }, {
    remainingPath: '/availableBalance', scale: 0.0001, unit: 'USD'
  })
  equal(novita?.[0]?.remaining, 12.3456, 'Novita scale is applied')

  const url = api.buildProviderBalanceUrl('https://api.example.test/v1', {
    path: '/balance', query: { scope: 'all' }, response: { remainingPath: '/remaining' }
  })
  equal(url?.toString(), 'https://api.example.test/balance?scope=all', 'same-origin balance URL is built')
  equal(api.buildProviderBalanceUrl('https://api.example.test/v1', {
    path: 'https://evil.example.test/balance', response: { remainingPath: '/remaining' }
  }), undefined, 'cross-origin balance URL is rejected')

  const providerList = readFileSync(path.join(repoRoot, 'src/renderer/src/components/settings/ProviderList.tsx'), 'utf8')
  equal(providerList.includes('data-provider-balance-overview'), true, 'Provider account overview exposes live balance status')
  equal(providerList.includes('inspectProviderBalance') && providerList.includes('queryProviderBalance'), true, 'balance overview uses the brokered balance IPC contract')
  equal(providerList.includes('values.join') && !providerList.includes('responseBody'), true, 'balance overview renders normalized values without response bodies')

  console.log(`provider balance smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* keep searching */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function equal(actual, expected, message) {
  const pass = actual === expected
  checks.push({ name: message, status: pass ? 'pass' : 'fail' })
  if (!pass) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
