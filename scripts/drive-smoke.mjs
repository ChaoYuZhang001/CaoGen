import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-drive-build-'))
const dataDir = mkdtempSync(path.join(tmpdir(), 'caogen-drive-data-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/model/drive.ts',
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
  const drive = await import(pathToFileURL(findCompiled(buildDir, 'drive.js')).href)
  const sessionRouting = await import(pathToFileURL(findCompiled(buildDir, 'session-routing.js')).href)
  stats.configureModelStatsDir(dataDir)

  const baseSettings = {
    driveMode: 'core',
    defaultModel: 'deepseek-chat',
    defaultPermissionMode: 'default',
    schedulerStrategy: 'balanced',
    smartModelRoutingEnabled: false,
    modelCrossValidationAutoRunEnabled: false,
    budgetUsdPerSession: 0,
    permissionAllowlist: '',
    permissionDenylist: '',
    sandboxMode: 'loose',
    guiAutomationEnabled: false
  }

  const spark = drive.settingsForCaoGenDrive(baseSettings, 'spark')
  const core = drive.settingsForCaoGenDrive(baseSettings, 'core')
  const coreSpeed = drive.settingsForCaoGenDrive({ ...baseSettings, schedulerStrategy: 'speed' }, 'core')
  const forge = drive.settingsForCaoGenDrive(baseSettings, 'forge')
  const disabledForge = drive.settingsForCaoGenDrive({ ...baseSettings, sandboxMode: 'disabled' }, 'forge')
  const command = drive.settingsForCaoGenDrive(baseSettings, 'command')
  const genesis = drive.settingsForCaoGenDrive(baseSettings, 'genesis')
  const sparkPolicy = drive.getCaoGenDrivePolicy('spark')
  const corePolicy = drive.getCaoGenDrivePolicy('core')
  const commandPolicy = drive.getCaoGenDrivePolicy('command')
  const genesisPolicy = drive.getCaoGenDrivePolicy('genesis')

  assert(spark.schedulerStrategy === 'cost', 'Spark should force cost routing')
  assert(spark.permissionDenylist.includes('risk>=high'), 'Spark should deny high-risk tools')
  assert(!spark.modelCrossValidationAutoRunEnabled, 'Spark should not auto-run model review')
  assert(spark.budgetUsdPerSession === 0, 'settingsForCaoGenDrive must preserve explicit unlimited session budget')
  assert(core.schedulerStrategy === 'balanced', 'Core should preserve the default balanced user strategy')
  assert(coreSpeed.schedulerStrategy === 'speed', 'Core should preserve an explicit user speed strategy')
  assert(corePolicy.sessionBudgetUsd > sparkPolicy.sessionBudgetUsd, 'Core policy budget should exceed Spark')
  assert(forge.defaultPermissionMode === 'acceptEdits', 'Forge should auto-accept edits')
  assert(forge.sandboxMode === 'restrictedLocal', 'Forge should use restricted local execution')
  assert(disabledForge.sandboxMode === 'disabled', 'Drive policy must not bypass a pending local-execution migration')
  assert(command.modelCrossValidationAutoRunEnabled, 'Command should auto-run model review')
  assert(command.guiAutomationEnabled, 'Command should enable GUI tools behind approval')
  assert(genesisPolicy.sessionBudgetUsd > commandPolicy.sessionBudgetUsd, 'Genesis policy budget should exceed Command')

  const providers = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      engine: 'claude',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true
    },
    {
      id: 'premium',
      name: 'Premium',
      baseUrl: 'https://example.test',
      engine: 'claude',
      models: ['gpt-4o-mini', 'expensive-reasoner', 'opus'],
      budgetUsd: 0,
      createdAt: Date.now(),
      hasToken: true
    }
  ]

  const missingEngineRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    payload: { text: 'do not infer an engine', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: spark.budgetUsdPerSession,
    driveMode: 'spark'
  })
  assert(missingEngineRoute.kind === 'disabled', 'Drive routing must not infer Claude when engine is missing')

  const sparkRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    engine: 'claude',
    payload: { text: 'summarize this README quickly', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: spark.budgetUsdPerSession,
    driveMode: 'spark'
  })
  assert(sparkRoute.kind === 'routed', 'Spark route should route auto sessions')
  assert(sparkRoute.reason.includes('Drive=Spark'), 'Spark route reason should name Drive')
  assert(sparkRoute.reason.includes('策略=cost'), 'Spark route should use cost strategy')
  assert(!sparkRoute.crossValidationPlan.enabled, 'Spark route should not create cross-validation')

  const coreSpeedRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    engine: 'claude',
    payload: { text: 'review and implement production database migration code', images: [] },
    strategy: coreSpeed.schedulerStrategy,
    sessionCostUsd: 0,
    settingsBudgetUsd: coreSpeed.budgetUsdPerSession,
    driveMode: 'core'
  })
  assert(coreSpeedRoute.kind === 'routed', 'Core speed route should route auto sessions')
  assert(coreSpeedRoute.reason.includes('策略=speed'), 'Core route should use the user speed strategy')
  assert(coreSpeedRoute.decision.strategy === 'speed', 'Core route should preserve speed in structured routing data')
  assert(
    coreSpeedRoute.decision.selectedReasons.some((reason) => reason.includes('延迟档 fast')),
    'Core speed route should explain the selected latency class'
  )

  const commandRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    engine: 'claude',
    payload: { text: 'review and implement production database migration release plan', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: command.budgetUsdPerSession,
    driveMode: 'command'
  })
  assert(commandRoute.kind === 'routed', 'Command route should route auto sessions')
  assert(commandRoute.reason.includes('Drive=Command'), 'Command route reason should name Drive')
  assert(commandRoute.reason.includes('策略=quality'), 'Command route should use quality strategy')
  assert(commandRoute.crossValidationPlan.enabled, 'Command should create cross-validation')
  assert(commandRoute.crossValidationPlan.validators.length > 0, 'Command should include validator models')

  const genesisRoute = sessionRouting.resolveSessionModelRoute({
    enabled: true,
    currentModel: 'auto',
    providerId: 'deepseek-official',
    providers,
    engine: 'claude',
    payload: { text: 'decompose full-stack launch work into DAG, implement, review, test, and summarize delivery', images: [] },
    strategy: 'balanced',
    sessionCostUsd: 0,
    settingsBudgetUsd: genesis.budgetUsdPerSession,
    driveMode: 'genesis'
  })
  assert(genesisRoute.kind === 'routed', 'Genesis route should route auto sessions')
  assert(genesisRoute.reason.includes('longContext'), 'Genesis route should request long-context planning')
  assert(genesisRoute.crossValidationPlan.enabled, 'Genesis should create cross-validation')

  console.log('drive smoke ok')
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
