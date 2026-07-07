import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-model-router-build-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-model-router-data-'))

try {
  mkdirSync(buildDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/model/model-profile.ts',
      'src/main/model/model-router.ts',
      'src/main/model/session-routing.ts',
      'src/main/modelStats.ts',
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

  const stats = await import(pathToFileURL(findCompiled(buildDir, 'modelStats.js')).href)
  const router = await import(pathToFileURL(findCompiled(buildDir, 'model-router.js')).href)
  const sessionRouting = await import(pathToFileURL(findCompiled(buildDir, 'session-routing.js')).href)
  stats.configureModelStatsDir(dataDir)
  for (let i = 0; i < 6; i += 1) stats.recordModelSuccess('deepseek-chat', 600)
  for (let i = 0; i < 6; i += 1) stats.recordModelFailure('expensive-reasoner')

  const providers = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true
    },
    {
      id: 'premium',
      name: 'Premium',
      baseUrl: 'https://example.test',
      models: ['expensive-reasoner', 'gpt-4o-mini'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true
    }
  ]

  const chatOnlyProviders = [
    {
      id: 'chat-only',
      name: 'Chat Only',
      baseUrl: 'https://example.test/v1',
      models: ['gpt-4o-mini'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true,
      openaiProtocol: 'chat'
    }
  ]

  const manual = router.routeModel({
    providers,
    prompt: 'implement TypeScript router and run tests',
    strategy: 'balanced',
    manualOverride: { providerId: 'deepseek-official', model: 'deepseek-reasoner' }
  })
  assert(manual.manualOverrideApplied, 'manual override should be applied')
  assert(manual.selected.profile.model === 'deepseek-reasoner', 'manual override should pick requested model')

  const budget = router.routeModel({
    providers,
    prompt: 'high risk architecture reasoning and code review',
    requestedTasks: ['reasoning', 'review'],
    strategy: 'quality',
    contextTokens: 200_000,
    expectedOutputTokens: 20_000,
    budget: { remainingUsd: 0.02, hardLimit: true }
  })
  assert(budget.budgetDowngraded, 'hard budget should downgrade from the primary quality pick')
  assert(budget.selected.estimatedCostUsd <= budget.candidates[0].estimatedCostUsd, 'budget pick should not be more expensive than primary')

  const validation = router.routeModel({
    providers,
    prompt: 'review this release plan risk',
    requestedTasks: ['reasoning', 'review'],
    riskLevel: 'high',
    strategy: 'balanced',
    crossValidation: { enabled: true, maxValidators: 2, minRiskLevel: 'medium' }
  })
  assert(validation.crossValidationPlan.enabled, 'cross validation plan should be enabled for high risk')
  assert(validation.crossValidationPlan.validators.length > 0, 'cross validation should include validators')

  const vision = router.routeModel({
    providers,
    prompt: 'analyze UI issues in this image',
    attachments: [{ mime: 'image/png' }],
    strategy: 'balanced'
  })
  assert(vision.selected.profile.supportsVision, 'vision task should pick a vision-capable model')

  const disabledSessionRoute = sessionRouting.resolveSessionModelRoute({
    enabled: false,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'implement production database migration code', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0
  })
  assert(disabledSessionRoute.kind === 'disabled', 'disabled setting should keep old session behavior')

  const enabledSessionRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'implement production database migration code and review risks', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0
  })
  assert(enabledSessionRoute.kind === 'routed', 'enabled setting should route real session payload')
  assert(enabledSessionRoute.model, 'enabled session route should choose an executable model')
  assert(
    enabledSessionRoute.crossValidationPlan.enabled &&
      enabledSessionRoute.crossValidationPlan.validators.length > 0,
    'critical coding session route should include cross-validation plan'
  )

  const manualSessionRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'route this coding task with manual override', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    manualOverride: { providerId: 'premium', model: 'gpt-4o-mini' }
  })
  assert(manualSessionRoute.kind === 'routed', 'manual session route should route')
  assert(manualSessionRoute.providerId === 'premium', 'manual session route should honor provider override')
  assert(manualSessionRoute.model === 'gpt-4o-mini', 'manual session route should honor model override')

  const claudeChatOnlyRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'chat-only',
    providers: chatOnlyProviders,
    engine: 'claude',
    payload: { text: 'implement code with a chat-only provider', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0
  })
  assert(claudeChatOnlyRoute.kind === 'disabled', 'Claude routing must skip OpenAI/chat-only providers')

  const openaiChatRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'chat-only',
    providers: chatOnlyProviders,
    engine: 'openai',
    payload: { text: 'implement code with a chat-only provider', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0
  })
  assert(openaiChatRoute.kind === 'routed', 'OpenAI routing should accept OpenAI/chat providers')

  console.log('model-router smoke ok')
} finally {
  rmSync(buildDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
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
