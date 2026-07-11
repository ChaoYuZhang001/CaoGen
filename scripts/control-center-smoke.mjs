import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-control-center-build-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/renderer/src/controlCenter.ts',
      '--outDir',
      buildDir,
      '--target',
      'ES2022',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--esModuleInterop',
      '--strict',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const controlCenter = await import(pathToFileURL(findCompiled(buildDir, 'controlCenter.js')).href)
  const secretProbe = 'REDACTED_TOKEN_PLACEHOLDER_THAT_MUST_NOT_RENDER'
  const now = Date.UTC(2026, 6, 10, 12)
  const settings = {
    driveMode: 'command',
    defaultModel: 'auto',
    defaultPermissionMode: 'default',
    defaultProviderId: 'deepseek-official',
    fallbackProviderId: 'openrouter',
    fallbackModel: 'gpt-4o-mini',
    lowCostProviderId: 'deepseek-official',
    lowCostModel: 'deepseek-chat',
    strongReasoningProviderId: 'deepseek-official',
    strongReasoningModel: 'deepseek-reasoner',
    reviewProviderId: 'openrouter',
    reviewModel: 'gpt-4o-mini',
    schedulerStrategy: 'speed',
    modelRoutingRules: [
      {
        id: 'release-rule',
        enabled: true,
        name: 'Release',
        match: 'release,发布',
        providerId: 'deepseek-official',
        model: 'deepseek-reasoner'
      },
      {
        id: 'structured-review-rule',
        enabled: true,
        name: 'Structured review',
        match: '',
        taskKinds: ['review'],
        minRiskLevel: 'high',
        whenStrategy: 'speed',
        providerId: 'openrouter',
        model: 'gpt-4o-mini'
      }
    ],
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: true,
    budgetUsdPerSession: 2,
    budgetUsdPerMonth: 30,
    failoverEnabled: true,
    language: 'zh',
    theme: 'dark',
    persona: '',
    allowedTools: '',
    disallowedTools: '',
    sandboxMode: 'restrictedLocal',
    chinaEcosystemMirrorEnabled: false,
    chinaNpmRegistry: '',
    chinaPipIndexUrl: '',
    permissionAllowlist: '',
    permissionDenylist: '',
    permissionTemporaryAllowlist: '',
    guiAutomationEnabled: true,
    guiAutomationTemporaryGrantUntil: 0,
    notificationsEnabled: true,
    preventDisplaySleep: true,
    sdkAgentsEnabled: false,
    ideBridgeEnabled: false,
    ideBridgeHost: '127.0.0.1',
    ideBridgePort: 17365,
    ideBridgeToken: '',
    hookPostEditCommand: '',
    hookTurnEndCommand: '',
    autoSkillLearningEnabled: false,
    office: { showBadges: true, liveliness: 1, catEars: false }
  }
  const providers = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true,
      keyCount: 2,
      activeKeyLabel: 'primary',
      apiKeys: [
        { id: 'deepseek-key-primary', label: 'primary', createdAt: Date.now(), disabled: false, active: true },
        { id: 'deepseek-key-backup', label: 'backup', createdAt: Date.now(), disabled: false, active: false }
      ],
      note: secretProbe
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['gpt-4o-mini'],
      budgetUsd: 5,
      createdAt: Date.now(),
      hasToken: false,
      keyCount: 0,
      apiKeys: []
    }
  ]
  const health = [
    {
      providerId: 'deepseek-official',
      successes: 5,
      failures: 0,
      consecutiveFailures: 0,
      healthy: true,
      lastLatencyMs: 420,
      latencyEmaMs: 390,
      recentFailures: [],
      lastUsedAt: Date.now()
    },
    {
      providerId: 'openrouter',
      successes: 0,
      failures: 2,
      consecutiveFailures: 2,
      healthy: false,
      lastError: '401',
      latencyEmaMs: 870,
      recentFailures: [
        {
          at: Date.now() - 1_000,
          label: '鉴权失败',
          message: 'HTTP 401 invalid API key [redacted]',
          switchable: true
        }
      ]
    }
  ]
  const history = [
    {
      id: 'historical-session',
      title: 'Historical review',
      cwd: '/tmp/project',
      model: 'gpt-4o-mini',
      providerId: 'openrouter',
      engine: 'openai',
      permissionMode: 'default',
      sdkSessionId: 'sdk-history',
      createdAt: Date.UTC(2026, 6, 4),
      updatedAt: Date.UTC(2026, 6, 8),
      costUsd: 4
    },
    {
      id: 'duplicate-active-history',
      title: 'Duplicate active history',
      cwd: '/tmp/project',
      model: 'deepseek-chat',
      providerId: 'deepseek-official',
      engine: 'openai',
      permissionMode: 'default',
      sdkSessionId: 'sdk-active',
      createdAt: Date.UTC(2026, 6, 5),
      updatedAt: Date.UTC(2026, 6, 9),
      costUsd: 9
    }
  ]
  const activeSessions = [
    {
      id: 'active-session',
      title: 'Active implementation',
      cwd: '/tmp/project',
      model: 'deepseek-chat',
      providerId: 'deepseek-official',
      engine: 'openai',
      permissionMode: 'default',
      status: 'idle',
      sdkSessionId: 'sdk-active',
      costUsd: 3,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: Date.UTC(2026, 6, 9)
    }
  ]
  const pluginRegistry = {
    roots: ['/tmp/project/.claude'],
    items: [
      {
        id: 'mcp-filesystem',
        name: 'filesystem',
        kind: 'mcp',
        sourceRoot: '/tmp/project/.claude',
        path: '/tmp/project/.claude/settings.json',
        enabled: true,
        permissions: ['FILESYSTEM_TOKEN']
      },
      {
        id: 'skill-reviewer',
        name: 'reviewer',
        kind: 'skill',
        sourceRoot: '/tmp/project/.claude',
        path: '/tmp/project/.claude/skills/reviewer/SKILL.md',
        enabled: true
      }
    ],
    diagnostics: [],
    limits: { maxFiles: 2000, maxDepth: 6 },
    scannedAt: new Date().toISOString(),
    truncated: false
  }
  const view = controlCenter.buildControlCenterView({
    settings,
    providers,
    history,
    activeSessions,
    health,
    engines: [
      { kind: 'claude', label: 'Claude SDK', available: true, optional: true, configured: true },
      { kind: 'openai', label: 'OpenAI-compatible', available: true }
    ],
    pluginRegistry,
    mcpProbeResults: {
      'mcp-filesystem': {
        id: 'mcp-filesystem',
        ok: true,
        transport: 'stdio',
        serverName: 'filesystem',
        serverVersion: '1.0.0',
        latencyMs: 31
      }
    },
    now
  })

  assert(view.policy.mode === 'command', 'Control Center should expose active Drive policy')
  assert(view.route.providerStatus === 'available', 'selected provider should be available')
  assert(view.route.strategyLabel === 'speed', 'Control Center should expose the user speed strategy')
  assert(view.providerSummary.configuredKeys === 1, 'provider summary should count hasToken only')
  assert(view.providerSummary.totalKeys === 2, 'provider summary should count all usable keys')
  assert(view.providerSummary.missingKeys === 1, 'provider summary should count missing keys')
  assert(view.providers.some((provider) => provider.id === 'deepseek-official' && provider.healthLabel.includes('390ms EMA')), 'provider health should surface EMA latency')
  assert(view.providers.some((provider) => provider.id === 'deepseek-official' && provider.successRateLabel === '100% success'), 'provider health should surface success rate')
  assert(view.providers.some((provider) => provider.id === 'openrouter' && provider.recentFailures.length === 1), 'provider row should expose recent failure history')
  assert(view.providers.some((provider) => provider.id === 'deepseek-official' && provider.tokenLabel.includes('2 keys') && provider.tokenLabel.includes('primary')), 'provider row should show key count and active label')
  assert(view.providers.some((provider) => provider.id === 'openrouter' && provider.status === 'external-required'), 'missing key provider should require external credential')
  assert(view.modelRoles.length === 4, 'control center should expose all model role preferences')
  assert(view.modelRoles.some((role) => role.key === 'lowCost' && role.modelLabel === 'deepseek-chat' && role.status === 'available'), 'low-cost role should show configured model')
  assert(view.modelRoles.some((role) => role.key === 'strongReasoning' && role.modelLabel === 'deepseek-reasoner' && role.status === 'available'), 'strong reasoning role should show configured model')
  assert(view.modelRoles.some((role) => role.key === 'review' && role.status === 'external-required'), 'review role should show missing-key provider status')
  assert(view.modelRoles.some((role) => role.key === 'fallback' && role.status === 'external-required'), 'fallback role should show missing-key provider status')
  assert(view.route.customRulesLabel === '2/2 custom rules enabled', 'control center should count keyword and structured routing rules')
  assert(view.budget.report.monthlySpentUsd === 7, 'budget report should combine deduplicated active and historical cost')
  assert(view.budget.report.activeCostUsd === 3 && view.budget.report.historicalCostUsd === 4, 'budget report should split active and historical cost')
  assert(view.budget.report.activeSessions[0]?.sessionLimitUsd === 2, 'active session should inherit the global session budget')
  assert(view.budget.report.activeSessions[0]?.overBudget, 'active session should expose over-budget state')
  assert(view.budget.status === 'needs-config', 'an over-budget active session should raise the Control Center budget status')
  assert(view.budget.report.providers.some((provider) => provider.providerId === 'openrouter' && provider.spentUsd === 4), 'budget report should aggregate provider cost')
  assert(view.mcp.status === 'available', 'reachable enabled MCP should be available')
  assert(view.mcp.ok === 1, 'MCP ok count should be surfaced')
  assert(view.engines.every((engine) => engine.kind === 'claude' || engine.kind === 'openai'), 'only formal engines should be exposed')
  assert(view.engines.find((engine) => engine.kind === 'claude')?.status === 'unknown', 'unverified optional Claude must not be ready')
  assert(view.engines.find((engine) => engine.kind === 'claude')?.statusLabel === '有凭据，兼容性未验证', 'Claude status must be explicit')
  assert(
    view.capabilities.find((capability) => capability.title === 'Agent engines')?.detail === 'OpenAI-compatible',
    'Agent engine capability must count only configured engines'
  )
  assert(view.capabilities.some((capability) => capability.title === 'Model routing' && capability.status === 'available'), 'model routing should connect Drive/provider state')
  assert(!JSON.stringify(view).includes(secretProbe), 'Control Center view must not expose provider note/token-like secret values')

  console.log('control-center smoke ok')
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function findCompiled(root, fileName) {
  const found = findCompiledMaybe(root, fileName)
  if (!found) throw new Error(`compiled file not found: ${fileName}`)
  return found
}

function findCompiledMaybe(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledMaybe(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}
