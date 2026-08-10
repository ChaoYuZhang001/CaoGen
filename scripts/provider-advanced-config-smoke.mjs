#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-advanced-config-'))
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
    'src/main/provider/providerAdvancedConfig.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
  const api = await import(pathToFileURL(findCompiled(outDir, 'providerAdvancedConfig.js')).href)
  const config = api.normalizeProviderAdvancedConfig({
    schemaVersion: 1,
    modelProfiles: [{
      model: 'vendor-model',
      aliases: ['latest'],
      pricing: {
        currency: 'USD',
        inputPerMillion: 1,
        outputPerMillion: 3,
        cacheReadPerMillion: 0.5,
        cacheWritePerMillion: 1.5,
        source: 'provider'
      }
    }]
  })
  equal(api.providerPricingForModel(config, 'LATEST')?.outputPerMillion, 3, 'aliases resolve pricing')
  equal(api.estimateProviderCostUsd(config.modelProfiles[0].pricing, {
    input: 1_000_000,
    output: 2_000_000,
    cacheRead: 100_000,
    cacheCreation: 100_000
  }), 7.2, 'configured pricing calculates token cost')
  equal(api.builtinOpenAiPricingForModel('gpt-4o-mini').inputPerMillion, 0.15, 'builtin pricing covers gpt-4o-mini')
  equal(api.normalizeProviderAdvancedConfig({
    modelProfiles: [{
      model: 'catalog-model',
      pricing: { inputPerMillion: 1, outputPerMillion: 2, source: 'catalog' }
    }]
  }).modelProfiles[0].pricing.source, 'catalog', 'catalog pricing provenance normalizes')
  const runtime = api.normalizeProviderAdvancedConfig({
    runtime: {
      reasoningEffort: 'high',
      verbosity: 'low',
      temperature: 0.4,
      topP: 0.85,
      maxOutputTokens: 4096,
      parallelToolCalls: true,
      storeResponses: false,
      serviceTier: 'priority'
    }
  })
  equal(runtime.runtime.reasoningEffort, 'high', 'typed reasoning effort normalizes')
  equal(runtime.runtime.maxOutputTokens, 4096, 'typed output limit normalizes')
  equal(runtime.runtime.storeResponses, false, 'explicit response storage preference is preserved')
  const anthropicRuntime = api.normalizeProviderAdvancedConfig({
    runtime: {
      maxOutputTokens: 8192,
      anthropic: {
        thinking: { mode: 'enabled', budgetTokens: 4096, display: 'omitted' },
        promptCaching: { enabled: true, ttl: '1h', strategy: 'last-user' },
        topK: 32
      }
    }
  })
  equal(anthropicRuntime.runtime.anthropic.thinking.mode, 'enabled', 'Anthropic thinking mode normalizes')
  equal(anthropicRuntime.runtime.anthropic.thinking.budgetTokens, 4096, 'Anthropic thinking budget normalizes')
  equal(anthropicRuntime.runtime.anthropic.promptCaching.ttl, '1h', 'Anthropic prompt cache TTL normalizes')
  equal(anthropicRuntime.runtime.anthropic.topK, 32, 'Anthropic top K normalizes')
  const reliability = api.normalizeProviderAdvancedConfig({
    reliability: {
      failoverEnabled: false,
      maxRetries: 6,
      streamingFirstByteTimeoutSeconds: 90,
      streamingIdleTimeoutSeconds: 180,
      requestTimeoutSeconds: 600,
      circuitBreaker: {
        failureThreshold: 8,
        successThreshold: 3,
        timeoutSeconds: 90,
        errorRateThreshold: 0.7,
        minRequests: 15
      }
    }
  })
  equal(reliability.reliability.failoverEnabled, false, 'Provider failover override preserves false')
  equal(reliability.reliability.circuitBreaker.failureThreshold, 8, 'Provider circuit policy normalizes')
  const balance = api.normalizeProviderAdvancedConfig({
    balanceQuery: {
      path: '/v1/balance',
      method: 'POST',
      query: { scope: 'all' },
      response: { itemsPath: '/data', totalPath: '/total', usedPath: '/used', scale: 0.01 }
    }
  })
  equal(balance.balanceQuery.response.scale, 0.01, 'balance query normalizes scale and pointers')
  const billing = api.normalizeProviderAdvancedConfig({
    billingQuery: {
      path: '/v1/billing',
      method: 'GET',
      credentialMode: 'provider',
      keyLabel: 'billing-key',
      query: { granularity: 'day' },
      periodStart: { target: 'query', name: 'start_time', format: 'unix-seconds' },
      periodEnd: { target: 'query', name: 'end_time', format: 'unix-ms' },
      response: { itemsPath: '/data/items', amountPath: '/amount', currencyPath: '/currency', scale: 0.01 }
    }
  })
  equal(billing.billingQuery.keyLabel, 'billing-key', 'billing query retains the selected safe key label')
  equal(billing.billingQuery.response.scale, 0.01, 'billing query normalizes amount mappings')
  const postBilling = api.normalizeProviderAdvancedConfig({
    billingQuery: {
      path: '/v1/billing/export',
      method: 'POST',
      body: { period: { zone: 'UTC' } },
      periodStart: { target: 'body', path: '/period/start', format: 'iso' },
      periodEnd: { target: 'body', path: '/period/end', format: 'iso' },
      response: { amountPath: '/amount', currency: 'USD' }
    }
  })
  equal(postBilling.billingQuery.periodStart.path, '/period/start',
    'POST billing query retains a nested period JSON Pointer')
  assertThrows(() => api.normalizeProviderAdvancedConfig({ request: { headers: { authorization: 'secret' } } }),
    'authorization headers are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({ request: { body: { apiKey: 'secret' } } }),
    'credential-like request fields are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    balanceQuery: { path: '/balance', headers: { authorization: 'Bearer secret' }, response: { remainingPath: '/remaining' } }
  }), 'balance credential headers are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    balanceQuery: { path: 'https://evil.example.test/balance', response: { remainingPath: '/remaining' } }
  }), 'absolute balance paths are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    balanceQuery: { path: '/balance', query: { value: 'sk-secret' }, response: { remainingPath: '/remaining' } }
  }), 'balance query credential-like values are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    balanceQuery: { path: '/balance', body: { value: 'Bearer secret' }, response: { remainingPath: '/remaining' } }
  }), 'balance body credential-like values are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    billingQuery: {
      path: 'https://evil.example.test/billing',
      periodStart: { target: 'query', name: 'start', format: 'unix-ms' },
      periodEnd: { target: 'query', name: 'end', format: 'unix-ms' },
      response: { amountPath: '/amount', currency: 'USD' }
    }
  }), 'absolute billing paths are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    billingQuery: {
      path: '/billing',
      query: { token: 'sk-secret' },
      periodStart: { target: 'query', name: 'start', format: 'unix-ms' },
      periodEnd: { target: 'query', name: 'end', format: 'unix-ms' },
      response: { amountPath: '/amount', currency: 'USD' }
    }
  }), 'billing query credential-like values are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    billingQuery: {
      path: '/billing',
      method: 'GET',
      periodStart: { target: 'body', path: '/period/start', format: 'iso' },
      periodEnd: { target: 'query', name: 'end', format: 'unix-ms' },
      response: { amountPath: '/amount', currency: 'USD' }
    }
  }), 'GET billing queries cannot inject period values into a body')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    billingQuery: {
      path: '/billing',
      method: 'POST',
      periodStart: { target: 'body', path: '/__proto__/value', format: 'iso' },
      periodEnd: { target: 'body', path: '/period/end', format: 'iso' },
      response: { amountPath: '/amount', currency: 'USD' }
    }
  }), 'unsafe billing body pointers are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    request: { body: { messages: [] } }
  }), 'request overrides cannot replace protected messages')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    request: { body: { model: 'other-model' } }
  }), 'request overrides cannot replace protected model')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    request: { body: { max_tokens: 1 } }
  }), 'request overrides cannot replace protected max_tokens')
  assertThrows(() => api.normalizeProviderAdvancedConfig({ runtime: { temperature: 2.1 } }),
    'runtime temperature is range checked')
  assertThrows(() => api.normalizeProviderAdvancedConfig({ runtime: { topP: -0.1 } }),
    'runtime top P is range checked')
  assertThrows(() => api.normalizeProviderAdvancedConfig({ runtime: { reasoningEffort: 'extreme' } }),
    'runtime reasoning effort is enumerated')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    runtime: { anthropic: { thinking: { mode: 'enabled', budgetTokens: 1023 } } }
  }), 'Anthropic thinking minimum budget is enforced')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    runtime: { maxOutputTokens: 4096, anthropic: { thinking: { mode: 'enabled', budgetTokens: 4096 } } }
  }), 'Anthropic thinking budget stays below maximum output tokens')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    runtime: { anthropic: { thinking: { mode: 'adaptive', budgetTokens: 2048 } } }
  }), 'Anthropic adaptive thinking rejects a fixed budget')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    runtime: { anthropic: { promptCaching: { enabled: false, ttl: '1h' } } }
  }), 'disabled Anthropic prompt caching rejects dormant TTL settings')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    runtime: { anthropic: { topK: 0 } }
  }), 'Anthropic top K is range checked')
  assertThrows(() => api.normalizeProviderAdvancedConfig({ reliability: { maxRetries: 21 } }),
    'Provider retry limit is range checked')
  assertThrows(() => api.normalizeProviderAdvancedConfig({ reliability: {
    circuitBreaker: { failureThreshold: 0, successThreshold: 2, timeoutSeconds: 60, errorRateThreshold: 0.6, minRequests: 10 }
  } }), 'Provider circuit policy is range checked')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    endpoints: [{ id: 'primary', url: 'https://user:password@example.test/v1' }]
  }), 'endpoint URL userinfo is rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    modelProfiles: [{ model: 'model-a', aliases: ['latest'] }, { model: 'model-b', aliases: ['LATEST'] }]
  }), 'duplicate model aliases are rejected')
  assertThrows(() => api.normalizeProviderAdvancedConfig({
    endpoints: [{ id: 'primary', url: 'https://example.test/v1' }],
    appBindings: { openai: { endpointId: 'missing' } }
  }), 'app bindings cannot reference unknown endpoints')
  console.log(`provider advanced config smoke ok: ${checks.length}/${checks.length} checks passed`)
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

function assertThrows(action, message) {
  let thrown = false
  try { action() } catch { thrown = true }
  checks.push({ name: message, status: thrown ? 'pass' : 'fail' })
  if (!thrown) throw new Error(message)
}
