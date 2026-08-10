import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const outDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-routing-'))

try {
  compileRuntime()
  const require = createRequire(import.meta.url)
  const routing = require(findCompiled(outDir, 'providerKeyRouting.js'))
  verifyNormalization(routing)
  verifyRoutingModes(routing)
  verifyHardConstraints(routing)
  verifyStableFailover(routing)
  verifyRuntimeIntegration()
  console.log('provider credential routing smoke ok')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

function verifyNormalization(routing) {
  assert.deepEqual(routing.normalizeProviderCredentialPolicy(undefined), {
    priority: 50,
    monthlyBudgetUsd: 0,
    minimumBalanceUsd: 0,
    failureCooldownMinutes: 5
  })
  assert.deepEqual(routing.normalizeProviderCredentialPolicy({
    priority: -2,
    monthlyBudgetUsd: -1,
    minimumBalanceUsd: Number.NaN,
    failureCooldownMinutes: 9_999
  }), {
    priority: 1,
    monthlyBudgetUsd: 0,
    minimumBalanceUsd: 0,
    failureCooldownMinutes: 1440
  })
  assert.equal(routing.normalizeProviderCredentialRoutingMode('unknown'), 'preferred')
}

function verifyRoutingModes(routing) {
  const keys = [key('preferred', 80, 1), key('cheap', 10, 2)]
  assert.equal(routing.selectProviderKey(keys, {
    activeKeyId: 'preferred', routingMode: 'manual'
  }).key.id, 'preferred')
  assert.equal(routing.selectProviderKey(keys, {
    activeKeyId: 'preferred', routingMode: 'preferred'
  }).key.id, 'preferred')
  const automatic = routing.selectProviderKey(keys, {
    activeKeyId: 'preferred', routingMode: 'automatic'
  })
  assert.equal(automatic.key.id, 'cheap')
  assert.match(automatic.reason, /自动路由.*优先级 10/)
}

function verifyHardConstraints(routing) {
  const now = Date.UTC(2026, 7, 9)
  const keys = [
    key('budget', 1, 1, { monthlyBudgetUsd: 5 }),
    key('balance', 2, 2, { minimumBalanceUsd: 10 }),
    { ...key('cooldown', 3, 3, { failureCooldownMinutes: 30 }), lastFailureAt: now - 60_000 },
    key('healthy', 4, 4)
  ]
  const metrics = new Map([
    ['budget', { monthlySpendUsd: 5 }],
    ['balance', { balanceRemainingUsd: 9 }]
  ])
  const decision = routing.selectProviderKey(keys, { routingMode: 'automatic', metrics, now })
  assert.equal(decision.key.id, 'healthy')
  assert.equal(decision.blocked.get('budget'), '已达到月度预算')
  assert.equal(decision.blocked.get('balance'), '余额低于保留底线')
  assert.equal(decision.blocked.get('cooldown'), '失败冷却中')
  const preferredFallback = routing.selectProviderKey(keys, {
    activeKeyId: 'budget', routingMode: 'preferred', metrics, now
  })
  assert.equal(preferredFallback.key.id, 'healthy')
  assert.match(preferredFallback.reason, /首选凭据不可用/)
  assert.equal(routing.selectProviderKey(keys, {
    activeKeyId: 'budget', routingMode: 'manual', metrics, now
  }).key, undefined)
}

function verifyStableFailover(routing) {
  const keys = [key('a', 10, 2), key('b', 10, 1), key('c', 20, 3)]
  const next = routing.pickNextProviderKey(keys, {
    activeKeyId: 'a',
    failedKeyId: 'a',
    routingMode: 'automatic',
    now: 100
  })
  assert.equal(next.id, 'b')
  assert.equal(routing.pickNextProviderKey(keys, {
    activeKeyId: 'a', failedKeyId: 'a', routingMode: 'manual', now: 100
  }), undefined)
}

function verifyRuntimeIntegration() {
  const providers = read('src/main/providers.ts')
  const types = read('src/shared/provider-credential-routing-types.ts')
  const editor = read('src/renderer/src/components/settings/ProviderSavedKeys.tsx')
  const usage = read('src/main/provider/providerUsage.ts')
  const balance = read('src/main/provider/providerBalanceService.ts')
  const anthropic = read('src/main/provider/anthropicMessagesTarget.ts')
  const openai = read('src/main/openaiEngine.ts')
  assert(types.includes("export type ProviderCredentialRoutingMode = 'manual' | 'preferred' | 'automatic'"))
  assert(providers.includes('providerKeyDecision(provider') && providers.includes('providerCredentialMetrics(provider.id'))
  assert(providers.includes('withNormalizedProviderCredentialRouting'))
  assert(editor.includes('data-provider-credential-routing-mode') && editor.includes('credentialMonthlyBudget'))
  assert(usage.includes('refreshProviderCredentialMetrics'))
  assert(balance.includes('recordProviderCredentialBalance'))
  assert(anthropic.includes('selectProviderCredential(provider)'))
  assert(openai.includes('selectProviderCredential(provider)'))
  assert(!editor.includes('encryptedToken'))
}

function key(id, priority, createdAt, patch = {}) {
  return {
    id,
    label: id,
    encryptedToken: `enc:${id}`,
    createdAt,
    disabled: false,
    policy: {
      priority,
      monthlyBudgetUsd: 0,
      minimumBalanceUsd: 0,
      failureCooldownMinutes: 5,
      ...patch
    }
  }
}

function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/providerKeyRouting.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--types', 'node',
    '--lib', 'ES2022,DOM',
    '--strict',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(fullPath, fileName) } catch { /* continue */ }
    } else if (entry.name === fileName) return fullPath
  }
  throw new Error(`compiled file not found: ${fileName}`)
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}
