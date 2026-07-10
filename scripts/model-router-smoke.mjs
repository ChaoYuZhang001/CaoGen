import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  const providerHealth = await import(pathToFileURL(findCompiled(buildDir, 'providerHealth.js')).href)
  const router = await import(pathToFileURL(findCompiled(buildDir, 'model-router.js')).href)
  const sessionRouting = await import(pathToFileURL(findCompiled(buildDir, 'session-routing.js')).href)
  stats.configureModelStatsDir(dataDir)
  providerHealth.configureProviderHealthDir(path.join(dataDir, 'provider-health'))
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

  const speedFirst = router.routeModel({
    providers,
    prompt: 'review and reason about a production architecture change',
    requestedTasks: ['reasoning', 'review'],
    strategy: 'speed'
  })
  const qualityFirst = router.routeModel({
    providers,
    prompt: 'review and reason about a production architecture change',
    requestedTasks: ['reasoning', 'review'],
    strategy: 'quality'
  })
  assert(speedFirst.task.strategy === 'speed', 'speed route should preserve its strategy')
  assert(speedFirst.selected.profile.latency === 'fast', 'speed route should prefer the fast latency class')
  assert(speedFirst.selected.profile.model === 'deepseek-chat', 'speed route should use the fastest measured model')
  assert(
    speedFirst.selected.profile.model !== qualityFirst.selected.profile.model,
    'speed and quality strategies should make different routing decisions for the same complex task'
  )
  assert(
    speedFirst.selected.reasons.some((reason) => reason.includes('延迟档 fast')),
    'speed route should expose the selected latency class'
  )
  assert(
    speedFirst.selected.reasons.some((reason) => reason.includes('历史延迟 EMA 600ms')),
    'speed route should expose the measured latency EMA'
  )

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
  assert(enabledSessionRoute.providerName, 'enabled session route should expose the selected provider name')
  assert(enabledSessionRoute.decision.providerId === enabledSessionRoute.providerId, 'decision should preserve provider id')
  assert(enabledSessionRoute.decision.model === enabledSessionRoute.model, 'decision should preserve selected model')
  assert(enabledSessionRoute.decision.strategy === 'quality', 'Core should preserve the user-selected quality strategy')
  assert(enabledSessionRoute.decision.taskKinds.includes('coding'), 'decision should expose inferred coding task')
  assert(enabledSessionRoute.decision.riskLevel === 'high', 'release/migration route should expose high risk')
  assert(enabledSessionRoute.decision.candidateCount >= 2, 'decision should expose candidate count')
  assert(enabledSessionRoute.decision.selectedReasons.length >= 2, 'decision should explain selected score inputs')
  assert(enabledSessionRoute.decision.alternatives.length > 0, 'decision should expose top alternatives')
  assert(Number.isFinite(enabledSessionRoute.decision.estimatedCostUsd), 'decision should expose estimated cost')
  assert(
    enabledSessionRoute.crossValidationPlan.enabled &&
      enabledSessionRoute.crossValidationPlan.validators.length > 0,
    'critical coding session route should include cross-validation plan'
  )

  const coreSpeedRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    driveMode: 'core',
    payload: { text: 'implement production database migration code and review risks', images: [] },
    strategy: 'speed',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0
  })
  assert(coreSpeedRoute.kind === 'routed', 'Core speed route should route')
  assert(coreSpeedRoute.decision.strategy === 'speed', 'Core should preserve the user-selected speed strategy')
  assert(coreSpeedRoute.reason.includes('策略=speed'), 'Core speed route reason should expose the effective strategy')
  assert(coreSpeedRoute.decision.selectionReason.includes('速度优先'), 'Core speed decision should explain the speed preference')
  assert(
    coreSpeedRoute.decision.selectedReasons.some((reason) => reason.includes('延迟档 fast')),
    'Core speed decision should expose the selected latency class'
  )
  assert(
    coreSpeedRoute.model !== enabledSessionRoute.model,
    'Core speed and quality strategies should choose different models for the same task'
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

  const lowCostRoleRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'quickly summarize this file', images: [] },
    strategy: 'cost',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    lowCostProviderId: 'premium',
    lowCostModel: 'gpt-4o-mini'
  })
  assert(lowCostRoleRoute.kind === 'routed', 'low-cost role route should route')
  assert(lowCostRoleRoute.providerId === 'premium', 'low-cost role route should honor provider preference')
  assert(lowCostRoleRoute.model === 'gpt-4o-mini', 'low-cost role route should honor model preference')
  assert(lowCostRoleRoute.reason.includes('低成本模型偏好'), 'low-cost route reason should explain role preference')

  const strongRoleRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'plan a production database migration architecture', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    strongReasoningProviderId: 'premium',
    strongReasoningModel: 'expensive-reasoner'
  })
  assert(strongRoleRoute.kind === 'routed', 'strong reasoning role route should route')
  assert(strongRoleRoute.providerId === 'premium', 'strong reasoning role route should honor provider preference')
  assert(strongRoleRoute.model === 'expensive-reasoner', 'strong reasoning role route should honor model preference')
  assert(strongRoleRoute.reason.includes('强推理模型偏好'), 'strong reasoning route reason should explain role preference')

  const reviewRoleRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'review this diff and list release risks', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    reviewProviderId: 'premium',
    reviewModel: 'gpt-4o-mini'
  })
  assert(reviewRoleRoute.kind === 'routed', 'review role route should route')
  assert(reviewRoleRoute.providerId === 'premium', 'review role route should honor provider preference')
  assert(reviewRoleRoute.model === 'gpt-4o-mini', 'review role route should honor model preference')
  assert(reviewRoleRoute.reason.includes('审查模型偏好'), 'review route reason should explain role preference')

  const customRuleRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: '准备发布前 review release 风险', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    modelRoutingRules: [
      {
        id: 'disabled-release-rule',
        enabled: false,
        name: '禁用规则',
        match: 'release,发布',
        providerId: 'premium',
        model: 'expensive-reasoner'
      },
      {
        id: 'release-rule',
        enabled: true,
        name: '发布审查',
        match: 'release,发布',
        providerId: 'premium',
        model: 'gpt-4o-mini'
      }
    ]
  })
  assert(customRuleRoute.kind === 'routed', 'custom routing rule should route')
  assert(customRuleRoute.providerId === 'premium', 'custom routing rule should honor provider preference')
  assert(customRuleRoute.model === 'gpt-4o-mini', 'custom routing rule should honor model preference')
  assert(customRuleRoute.reason.includes('自定义调度规则:发布审查'), 'custom route reason should name matched rule')

  const structuredPolicyRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    driveMode: 'command',
    payload: { text: '检查生产发布清单并给出审查结论', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    modelRoutingRules: [
      {
        id: 'structured-review-rule',
        enabled: true,
        name: '高风险质量审查',
        match: '',
        keywordMode: 'any',
        taskKinds: ['review'],
        minRiskLevel: 'high',
        whenStrategy: 'quality',
        providerId: 'premium',
        model: 'gpt-4o-mini'
      }
    ]
  })
  assert(structuredPolicyRoute.kind === 'routed', 'structured routing rule should route')
  assert(structuredPolicyRoute.providerId === 'premium', 'structured routing rule should honor provider target')
  assert(structuredPolicyRoute.model === 'gpt-4o-mini', 'structured routing rule should honor model target')
  assert(structuredPolicyRoute.reason.includes('任务=review'), 'structured rule reason should expose task condition')
  assert(structuredPolicyRoute.reason.includes('风险>=high'), 'structured rule reason should expose risk threshold')
  assert(structuredPolicyRoute.reason.includes('策略=quality'), 'structured rule reason should expose strategy condition')

  const structuredPolicyMismatch = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    driveMode: 'command',
    payload: { text: '总结生产发布清单', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    modelRoutingRules: [
      {
        id: 'structured-review-rule',
        enabled: true,
        name: '高风险质量审查',
        match: '',
        taskKinds: ['review'],
        minRiskLevel: 'high',
        whenStrategy: 'quality',
        providerId: 'premium',
        model: 'gpt-4o-mini'
      }
    ]
  })
  assert(structuredPolicyMismatch.kind === 'routed', 'structured mismatch should still use normal routing')
  assert(!structuredPolicyMismatch.reason.includes('高风险质量审查'), 'structured rule must not match outside its task/risk/strategy conditions')

  const allKeywordMiss = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'prepare release review', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    modelRoutingRules: [
      {
        id: 'all-keywords-rule',
        enabled: true,
        name: '发布部署联合规则',
        match: 'release,deploy',
        keywordMode: 'all',
        providerId: 'premium',
        model: 'gpt-4o-mini'
      }
    ]
  })
  assert(allKeywordMiss.kind === 'routed', 'all-keyword miss should fall through to normal routing')
  assert(!allKeywordMiss.reason.includes('发布部署联合规则'), 'all-keyword mode should require every keyword')

  const allKeywordHit = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'prepare release deploy review', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    modelRoutingRules: [
      {
        id: 'all-keywords-rule',
        enabled: true,
        name: '发布部署联合规则',
        match: 'release,deploy',
        keywordMode: 'all',
        providerId: 'premium',
        model: 'gpt-4o-mini'
      }
    ]
  })
  assert(allKeywordHit.kind === 'routed', 'all-keyword hit should route')
  assert(allKeywordHit.providerId === 'premium' && allKeywordHit.model === 'gpt-4o-mini', 'all-keyword hit should honor its target')
  assert(allKeywordHit.reason.includes('关键词=全部'), 'all-keyword rule reason should expose the keyword relation')

  const budgetConstrainedCustomRule = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'release database migration reason review', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0.02,
    modelRoutingRules: [
      {
        id: 'expensive-release-rule',
        enabled: true,
        name: '昂贵发布模型',
        match: 'release',
        providerId: 'premium',
        model: 'expensive-reasoner'
      }
    ]
  })
  assert(budgetConstrainedCustomRule.kind === 'routed', 'budget constrained custom rule should route')
  assert(
    budgetConstrainedCustomRule.model !== 'expensive-reasoner',
    'hard budget should be able to downgrade an over-budget custom rule target'
  )
  assert(
    budgetConstrainedCustomRule.reason.includes('手动覆盖命中预算上限'),
    'budget constrained custom route should explain why the rule target was not used'
  )
  assert(
    budgetConstrainedCustomRule.decision.selectionReason === '自定义调度规则:昂贵发布模型',
    'budget constrained decision should preserve the rule that requested the original target'
  )
  assert(
    budgetConstrainedCustomRule.decision.warnings.some((warning) => warning.includes('预算上限')),
    'budget constrained decision should expose the budget warning structurally'
  )

  const projectRouteDir = path.join(dataDir, 'project-routing')
  mkdirSync(projectRouteDir, { recursive: true })
  writeFileSync(
    path.join(projectRouteDir, 'caogen.md'),
    [
      '# 项目提示词',
      '- 本项目偏向低成本日常处理。',
      '',
      '# 模型调度策略',
      '- 成本 / 速度 / 质量偏好: 成本优先',
      '- 简单任务: premium/gpt-4o-mini',
      '- 复杂任务: provider=premium model=expensive-reasoner',
      '- 审查 / 复核任务: provider=premium model=gpt-4o-mini',
      ''
    ].join('\n'),
    'utf8'
  )

  const projectLowCostRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'quickly summarize this file', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    projectPath: projectRouteDir
  })
  assert(projectLowCostRoute.kind === 'routed', 'project low-cost route should route')
  assert(projectLowCostRoute.providerId === 'premium', 'project low-cost route should honor project provider preference')
  assert(projectLowCostRoute.model === 'gpt-4o-mini', 'project low-cost route should honor project model preference')
  assert(projectLowCostRoute.reason.includes('项目调度策略=成本优先'), 'project route reason should explain project strategy')
  assert(projectLowCostRoute.reason.includes('项目简单/低成本模型偏好'), 'project route reason should explain project role preference')

  const projectStrongRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'plan a production database migration architecture', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    projectPath: projectRouteDir
  })
  assert(projectStrongRoute.kind === 'routed', 'project strong route should route')
  assert(projectStrongRoute.providerId === 'premium', 'project strong route should honor project provider preference')
  assert(projectStrongRoute.model === 'expensive-reasoner', 'project strong route should honor project model preference')
  assert(projectStrongRoute.reason.includes('项目复杂/强推理模型偏好'), 'project strong route reason should explain project role preference')

  const otherProjectRouteDir = path.join(dataDir, 'other-project-routing')
  mkdirSync(otherProjectRouteDir, { recursive: true })
  writeFileSync(
    path.join(otherProjectRouteDir, 'caogen.md'),
    [
      '# 项目提示词',
      '- 本项目日常处理固定走 DeepSeek。',
      '',
      '# 模型调度策略',
      '- 成本 / 速度 / 质量偏好: 成本优先',
      '- 简单任务: provider=deepseek-official model=deepseek-chat',
      '- 复杂任务: provider=deepseek-official model=deepseek-reasoner',
      ''
    ].join('\n'),
    'utf8'
  )
  const otherProjectLowCostRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'premium',
    providers,
    payload: { text: 'quickly summarize this file', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0,
    projectPath: otherProjectRouteDir
  })
  assert(otherProjectLowCostRoute.kind === 'routed', 'second project low-cost route should route')
  assert(
    otherProjectLowCostRoute.providerId === 'deepseek-official',
    'second project should honor its own provider preference without leaking the first project'
  )
  assert(
    otherProjectLowCostRoute.model === 'deepseek-chat',
    'second project should honor its own model preference without leaking the first project'
  )
  assert(
    !otherProjectLowCostRoute.reason.includes('Premium/gpt-4o-mini'),
    'second project route reason should not include the first project model preference'
  )

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

  for (let index = 0; index < 3; index += 1) providerHealth.recordFailure('premium', 'HTTP 503 unavailable')
  const healthyProviderRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'premium',
    providers,
    payload: { text: 'plan and implement a production database migration', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0
  })
  assert(healthyProviderRoute.kind === 'routed', 'health-filtered route should still select a model')
  assert(healthyProviderRoute.providerId === 'deepseek-official', 'smart routing should skip an unhealthy provider')
  assert(
    healthyProviderRoute.decision.warnings.some((warning) => warning.includes('已跳过 1 个')),
    'routing decision should disclose excluded unhealthy providers'
  )

  for (let index = 0; index < 3; index += 1) providerHealth.recordFailure('deepseek-official', 'HTTP 503 unavailable')
  const allUnhealthyRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'review production release risks', images: [] },
    strategy: 'quality',
    sessionCostUsd: 0,
    settingsBudgetUsd: 0
  })
  assert(allUnhealthyRoute.kind === 'routed', 'all-unhealthy routing should fail open with an explicit warning')
  assert(
    allUnhealthyRoute.decision.warnings.some((warning) => warning.includes('所有可路由 Provider 均标记为不健康')),
    'all-unhealthy routing should expose the fallback warning'
  )

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
