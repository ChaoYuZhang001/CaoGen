import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const repoRoot = process.cwd()
const outDir = mkdtempSync(path.join(tmpdir(), 'caogen-provider-authorization-routing-'))

try {
  compileRuntime()
  const require = createRequire(import.meta.url)
  const routing = require(findCompiled(outDir, 'providerAuthorizationRouting.js'))
  verifyNormalization(routing)
  verifyRoutingModes(routing)
  verifyQuotaAndHealth(routing)
  verifyStableSelection(routing)
  verifyRuntimeIntegration()
  console.log('provider authorization routing smoke ok')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

function verifyNormalization(routing) {
  assert.deepEqual(routing.normalizeProviderAuthorizationAccountPolicy(undefined), {
    enabled: true,
    priority: 50,
    minimumQuotaRemainingPercent: 0,
    requireKnownQuota: false,
    failureCooldownMinutes: 5
  })
  assert.deepEqual(routing.normalizeProviderAuthorizationAccountPolicy({
    enabled: false,
    priority: -2,
    minimumQuotaRemainingPercent: 120,
    requireKnownQuota: true,
    failureCooldownMinutes: 9_999
  }), {
    enabled: false,
    priority: 1,
    minimumQuotaRemainingPercent: 100,
    requireKnownQuota: true,
    failureCooldownMinutes: 1440
  })
}

function verifyRoutingModes(routing) {
  const accounts = [account('bound', 80, 2), account('best', 10, 1)]
  assert.equal(routing.selectProviderAuthorizationAccount(accounts, {
    activeAccountId: 'bound', routingMode: 'manual'
  }).account.id, 'bound')
  assert.equal(routing.selectProviderAuthorizationAccount(accounts, {
    activeAccountId: 'bound', routingMode: 'preferred'
  }).account.id, 'bound')
  assert.equal(routing.selectProviderAuthorizationAccount(accounts, {
    activeAccountId: 'bound', routingMode: 'automatic'
  }).account.id, 'best')
  assert.equal(routing.selectProviderAuthorizationAccount(accounts, {
    activeAccountId: 'bound', explicitAccountId: 'bound', routingMode: 'automatic'
  }).account.id, 'bound')
}

function verifyQuotaAndHealth(routing) {
  const now = Date.UTC(2026, 7, 9)
  const accounts = [
    account('disabled', 1, 1, { enabled: false }),
    account('expired', 2, 2),
    account('low', 3, 3, { minimumQuotaRemainingPercent: 20 }),
    account('unknown', 4, 4, { requireKnownQuota: true }),
    { ...account('cooldown', 5, 5), lastFailureAt: now - 60_000 },
    account('healthy', 6, 6)
  ]
  const quotas = new Map([
    ['expired', quota('expired', [])],
    ['low', quota('ready', [85])],
    ['healthy', quota('ready', [25, 40])]
  ])
  const decision = routing.selectProviderAuthorizationAccount(accounts, {
    routingMode: 'automatic', quotas, now
  })
  assert.equal(decision.account.id, 'healthy')
  assert.equal(decision.blocked.get('disabled'), '已禁用')
  assert.equal(decision.blocked.get('expired'), '授权或配额已过期')
  assert.equal(decision.blocked.get('low'), '剩余配额低于保留底线')
  assert.equal(decision.blocked.get('unknown'), '缺少可用配额数据')
  assert.equal(decision.blocked.get('cooldown'), '失败冷却中')
  assert.equal(routing.quotaRemainingPercent(quotas.get('healthy')), 60)
}

function verifyStableSelection(routing) {
  const accounts = [account('zeta', 10, 1), account('alpha', 10, 1)]
  const selected = routing.selectProviderAuthorizationAccount(accounts, { routingMode: 'automatic' })
  assert.equal(selected.account.id, 'alpha')
}

function verifyRuntimeIntegration() {
  const service = read('src/main/provider/providerAuthorizationService.ts')
  const accountService = read('src/main/provider/providerAuthorizationAccountService.ts')
  const store = read('src/main/provider/providerAuthorizationStore.ts')
  const engine = read('src/main/openaiEngine.ts')
  const openAiRouting = read('src/main/provider/openAiAuthorizationRouting.ts')
  const panel = read('src/renderer/src/components/settings/ProviderAuthorizationRouting.tsx')
  const preload = read('src/preload/index.ts')
  assert(accountService.includes('resolveProviderAuthorizationAccountSelection'))
  assert(service.includes('issueProviderAuthorizationAccountLease'))
  assert(accountService.includes('quotaCache'))
  assert(store.includes('updateStoredProviderAuthorizationAccountPolicy'))
  assert(store.includes('markStoredProviderAuthorizationAccountFailure'))
  assert(openAiRouting.includes('providerAuthorizationAccountKeyId'))
  assert(engine.includes('resolveOpenAiAuthConfig'))
  assert(openAiRouting.includes('resolveOpenAiAuthorizationRoute'))
  assert(engine.includes('recordProviderAuthorizationAccountFailure'))
  assert(panel.includes('data-provider-authorization-routing'))
  assert(panel.includes('minimumQuotaRemainingPercent'))
  assert(preload.includes("providers:authorization:bind"))
  assert(!preload.includes("providers:authorization:account-policy"))
  assert(!preload.includes("providers:authorization:routing-mode"))
  assert(!panel.includes('refreshToken') && !panel.includes('accessToken'))
}

function account(id, priority, updatedAt, patch = {}) {
  return {
    id,
    providerId: 'provider',
    service: 'codex-oauth',
    label: id,
    authenticatedAt: 1,
    updatedAt,
    bound: id === 'bound',
    requiresReauth: false,
    credentialStorage: 'encrypted',
    policy: {
      enabled: true,
      priority,
      minimumQuotaRemainingPercent: 0,
      requireKnownQuota: false,
      failureCooldownMinutes: 5,
      ...patch
    }
  }
}

function quota(status, utilization) {
  return {
    providerId: 'provider',
    accountId: 'account',
    status,
    tiers: utilization.map((value, index) => ({ name: `tier-${index}`, utilization: value })),
    queriedAt: 1
  }
}

function compileRuntime() {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerAuthorizationRouting.ts',
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
