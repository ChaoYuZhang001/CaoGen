import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-cross-validation-build-'))

try {
  mkdirSync(buildDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/model/cross-validation.ts',
      '--outDir',
      buildDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const modulePath = findCompiled(buildDir, 'cross-validation.js')
  const {
    arbitrationCrossValidationTarget,
    buildCrossValidationArbitrationPrompt,
    buildCrossValidationReviewPrompt,
    firstCrossValidationTarget,
    needsCrossValidationArbitration
  } = await import(pathToFileURL(modulePath).href)
  const plan = {
    enabled: true,
    primary: { providerId: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-chat' },
    validators: [
      { providerId: 'premium', providerName: 'Premium', model: 'gpt-4o-mini' },
      { providerId: 'qwen', providerName: 'Qwen', model: 'qwen-turbo' }
    ],
    policy: 'review-primary',
    reason: 'high risk code generation'
  }
  assert.equal(firstCrossValidationTarget(plan)?.model, 'gpt-4o-mini', 'validator should be selected')
  assert.equal(arbitrationCrossValidationTarget(plan)?.model, 'qwen-turbo', 'arbitration target should be selected')
  assert.equal(needsCrossValidationArbitration('Conclusion: PASS'), false, 'PASS review should not arbitrate')
  assert.equal(
    needsCrossValidationArbitration('Conclusion: ARBITRATION_REQUIRED'),
    true,
    'explicit arbitration request should arbitrate'
  )
  const prompt = buildCrossValidationReviewPrompt({
    parentMeta: {
      id: 'parent-1',
      title: 'Release Fix',
      cwd: repoRoot,
      model: 'auto',
      providerId: 'deepseek-official',
      permissionMode: 'default',
      status: 'idle',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: Date.now()
    },
    routePlan: plan,
    resultText: 'Implemented critical TypeScript migration and tests.',
    transcript: [{ seq: 1, event: { kind: 'user-message', text: 'implement production database migration code' } }],
    turnSeq: 42
  })
  assert(prompt.includes('[P2-003 模型交叉复核]'), 'review prompt should be identifiable')
  assert(prompt.includes('DeepSeek/deepseek-chat'), 'primary model should be included')
  assert(prompt.includes('Premium/gpt-4o-mini'), 'validator model should be included')
  assert(prompt.includes('implement production database migration code'), 'user request should be included')
  assert(prompt.includes('Implemented critical TypeScript migration'), 'primary result should be included')
  const arbitrationPrompt = buildCrossValidationArbitrationPrompt({
    parentMeta: {
      id: 'parent-1',
      title: 'Release Fix',
      cwd: repoRoot,
      model: 'auto',
      providerId: 'deepseek-official',
      permissionMode: 'default',
      status: 'idle',
      costUsd: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0,
      createdAt: Date.now()
    },
    routePlan: plan,
    primaryResultText: 'Implemented critical TypeScript migration and tests.',
    reviewerResultText: 'Conclusion: ARBITRATION_REQUIRED. Migration misses rollback.',
    transcript: [{ seq: 1, event: { kind: 'user-message', text: 'implement production database migration code' } }],
    turnSeq: 43
  })
  assert(arbitrationPrompt.includes('[P2-003 模型交叉仲裁]'), 'arbitration prompt should be identifiable')
  assert(arbitrationPrompt.includes('Qwen/qwen-turbo'), 'arbitrator model should be included')
  assert(arbitrationPrompt.includes('ARBITRATION_REQUIRED'), 'review disagreement should be included')

  const sessionManager = read('src/main/sessionManager.ts')
  assert(sessionManager.includes('routePlans = new Map<string, ModelRoutePlanView>()'), 'route plan cache missing')
  assert(sessionManager.includes('crossValidationStarted = new Set<string>()'), 'duplicate guard missing')
  assert(sessionManager.includes('crossValidationReviews = new Map'), 'review association cache missing')
  assert(sessionManager.includes('handleModelCrossValidation'), 'cross validation handler missing')
  assert(sessionManager.includes('handleModelReviewArbitration'), 'review arbitration handler missing')
  assert(sessionManager.includes('modelCrossValidationAutoRunEnabled'), 'auto-run setting gate missing')
  assert(sessionManager.includes("childRole: 'model-review'"), 'review child role missing')
  assert(sessionManager.includes("childRole: 'model-arbitration'"), 'arbitration child role missing')
  assert(sessionManager.includes("permissionMode: 'plan'"), 'review child must be plan-only')
  assert(sessionManager.includes('this.send(\n      reviewMeta.id,'), 'review child must receive validation prompt')
  assert(sessionManager.includes('this.send(\n      arbitrationMeta.id,'), 'arbitration child must receive arbitration prompt')
  assert(sessionManager.includes("event: 'model-cross-validation'"), 'timeline event missing')
  assert(sessionManager.includes("event: 'model-cross-validation-arbitration'"), 'arbitration event missing')
  assert(sessionManager.includes('session.meta.parentSessionId || session.meta.childRole ==='), 'recursion guard missing')
  assert(
    read('scripts/integration-test.cjs').includes('T18 P2 cross-validation: routing event creates review and arbitration child sessions'),
    'behavior-level cross-validation integration test missing'
  )
  assert(read('src/main/model/session-routing.ts').includes('crossValidation: drive.crossValidation'), 'session route should use Drive cross-validation policy')
  assert(read('src/main/model/drive.ts').includes("crossValidation: { enabled: true, minRiskLevel: 'medium', maxValidators: 2 }"), 'Command Drive policy should keep backup validator for arbitration')
  assert(read('src/main/model/drive.ts').includes("crossValidation: { enabled: true, minRiskLevel: 'low', maxValidators: 2 }"), 'Genesis Drive policy should keep backup validator for arbitration')

  assert(read('src/shared/types.ts').includes('modelCrossValidationAutoRunEnabled: boolean'), 'AppSettings type missing')
  assert(read('src/main/settings.ts').includes('modelCrossValidationAutoRunEnabled: false'), 'main default must be off')
  assert(read('src/renderer/src/store.ts').includes('modelCrossValidationAutoRunEnabled: false'), 'renderer default must be off')
  assert(
    read('src/renderer/src/components/SettingsModal.tsx').includes('modelCrossValidationAutoRunEnabled'),
    'settings UI switch missing'
  )

  console.log('modelCrossValidation smoke ok')
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
}

function findCompiledOptional(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}
