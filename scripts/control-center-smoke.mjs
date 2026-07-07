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
  const settings = {
    driveMode: 'command',
    defaultModel: 'auto',
    defaultPermissionMode: 'default',
    defaultProviderId: 'deepseek-official',
    schedulerStrategy: 'quality',
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
    sandboxMode: 'standardSystem',
    sandboxDockerImage: 'caogen-sandbox:latest',
    chinaEcosystemMirrorEnabled: false,
    chinaNpmRegistry: '',
    chinaPipIndexUrl: '',
    chinaDockerRegistryMirror: '',
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
      note: secretProbe
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['gpt-4o-mini'],
      budgetUsd: 5,
      createdAt: Date.now(),
      hasToken: false
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
      lastUsedAt: Date.now()
    },
    {
      providerId: 'openrouter',
      successes: 0,
      failures: 2,
      consecutiveFailures: 2,
      healthy: false,
      lastError: '401'
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
    health,
    engines: [
      { kind: 'claude', label: 'Claude SDK', available: true },
      { kind: 'codex', label: 'Codex CLI', available: false }
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
    }
  })

  assert(view.policy.mode === 'command', 'Control Center should expose active Drive policy')
  assert(view.route.providerStatus === 'available', 'selected provider should be available')
  assert(view.providerSummary.configuredKeys === 1, 'provider summary should count hasToken only')
  assert(view.providerSummary.missingKeys === 1, 'provider summary should count missing keys')
  assert(view.providers.some((provider) => provider.id === 'openrouter' && provider.status === 'external-required'), 'missing key provider should require external credential')
  assert(view.mcp.status === 'available', 'reachable enabled MCP should be available')
  assert(view.mcp.ok === 1, 'MCP ok count should be surfaced')
  assert(view.engines.some((engine) => engine.kind === 'codex' && engine.status === 'external-required'), 'unavailable CLI engine should require external setup')
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
