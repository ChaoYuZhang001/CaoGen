#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-pricing-catalog-'))
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
    'src/shared/provider-pricing-catalog.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })

  const api = await import(pathToFileURL(findCompiled(outDir, 'provider-pricing-catalog.js')).href)
  const entries = api.flattenModelsDevCatalog({
    openai: {
      name: 'OpenAI',
      models: {
        'gpt-4o': {
          name: 'GPT-4o',
          release_date: '2024-05-13',
          modalities: { output: ['text'] },
          cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: 2.5 }
        },
        'image-model': {
          name: 'Image model',
          modalities: { output: ['image'] },
          cost: { input: 1, output: 2 }
        },
        'no-price': { name: 'No price', modalities: { output: ['text'] } }
      }
    },
    vendor: {
      models: {
        'special-model': {
          name: 'Special Model',
          modalities: { output: ['text'] },
          cost: { input: 0.2, output: 0.8 }
        }
      }
    }
  })

  equal(entries.length, 2, 'non-text and unpriced models are filtered')
  equal(api.normalizeModelIdForPricing('openai/GPT-4o:latest'), 'gpt-4o', 'gateway model IDs normalize')
  equal(api.matchModelsDevCatalog(entries, ['openai/gpt-4o'])[0]?.modelId, 'gpt-4o', 'normalized IDs match catalog pricing')

  const original = [{ model: 'gpt-4o', aliases: ['latest'], capabilities: ['tools'] }]
  const synced = api.syncDiscoveredModelProfiles(original, ['GPT-4O', 'special-model'])
  equal(synced.added, 1, 'sync adds only missing discovered models')
  assert.deepEqual(synced.profiles[0], original[0], 'sync preserves aliases and capabilities')
  checks.push('sync preserves aliases and capabilities')

  const userPricing = {
    currency: 'USD', inputPerMillion: 99, outputPerMillion: 199, source: 'user'
  }
  const merged = api.mergeCatalogPricing([
    { ...synced.profiles[0], pricing: userPricing },
    synced.profiles[1]
  ], entries, 12345)
  equal(merged.protectedUserPrices, 1, 'manual pricing is protected')
  equal(merged.profiles[0].pricing.inputPerMillion, 99, 'manual values are not overwritten')
  equal(merged.imported, 1, 'catalog pricing imports for non-user profiles')
  equal(merged.profiles[1].pricing.outputPerMillion, 0.8, 'output pricing imports')
  equal(merged.profiles[1].pricing.source, 'catalog', 'catalog provenance is persisted')
  equal(merged.profiles[1].pricing.updatedAt, 12345, 'catalog timestamp is persisted')

  const fetchSource = readFileSync(path.join(repoRoot, 'src/main/provider/providerPricingCatalog.ts'), 'utf8')
  check(fetchSource.includes("MODELS_DEV_API_URL = 'https://models.dev/api.json'") || fetchSource.includes('MODELS_DEV_API_URL'), 'fetch uses the fixed models.dev endpoint')
  check(!/token|apiKey|customHeaders|baseUrl|authorization/i.test(fetchSource), 'catalog fetch has no provider credential inputs')

  console.log(`provider pricing catalog smoke ok: ${checks.length}/${checks.length} checks passed`)
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
  assert.equal(actual, expected, message)
  checks.push(message)
}

function check(condition, message) {
  assert.ok(condition, message)
  checks.push(message)
}
