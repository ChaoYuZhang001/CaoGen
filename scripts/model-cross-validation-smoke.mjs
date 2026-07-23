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
      'src/main/model/cross-validation-failure.ts',
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
    crossValidationFailureVerdict,
    firstCrossValidationTarget,
    needsCrossValidationArbitration,
    parseCrossValidationArbitrationConclusion,
    parseCrossValidationReviewConclusion
  } = await import(pathToFileURL(modulePath).href)
  const { planCrossValidationFailureIngress } = await import(
    pathToFileURL(findCompiled(buildDir, 'cross-validation-failure.js')).href
  )
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
  const validReviewConclusions = [
    ['Conclusion: PASS', 'PASS'],
    ['Review Conclusion: CONCERNS', 'CONCERNS'],
    ['复核结论：BLOCKED', 'BLOCKED'],
    ['结论: ARBITRATION_REQUIRED', 'ARBITRATION_REQUIRED'],
    ['## Conclusion: PASS', 'PASS'],
    ['1. 复核结论：CONCERNS', 'CONCERNS'],
    ['### 2) **Conclusion:** **BLOCKED**', 'BLOCKED'],
    ['**结论：ARBITRATION_REQUIRED**', 'ARBITRATION_REQUIRED'],
    ['\n\t\n1、**复核结论**：PASS\n正文含 CONCERNS 不影响首行结论。', 'PASS']
  ]
  for (const [text, expected] of validReviewConclusions) {
    assert.equal(parseCrossValidationReviewConclusion(text), expected, `review conclusion should parse: ${text}`)
  }
  for (const text of [
    '说明：正文提到 CONCERNS\n结论: BLOCKED',
    '分析包含 BLOCKED，但没有规范结论行。',
    'Conclusion: PASS because checks passed',
    'Conclusion: ARBITRATION_REQUIRED.',
    'prefix Conclusion: BLOCKED',
    'Conclusion: CONCERNS suffix',
    'Conclusion: UNKNOWN',
    'Conclusion: concerns',
    '结论 PASS'
  ]) {
    assert.equal(parseCrossValidationReviewConclusion(text), null, `review conclusion must be strict: ${text}`)
  }
  assert.equal(
    parseCrossValidationReviewConclusion('结论: PASS\nConclusion: BLOCKED'),
    'PASS',
    'only the first non-empty line may supply the review conclusion'
  )
  assert.equal(needsCrossValidationArbitration('Conclusion: PASS\n正文含 BLOCKED'), false, 'PASS must not arbitrate')
  assert.equal(needsCrossValidationArbitration('正文含 CONCERNS\n结论: BLOCKED'), false, 'body terms must not arbitrate')
  assert.equal(needsCrossValidationArbitration('Conclusion: CONCERNS'), true, 'CONCERNS should arbitrate')
  assert.equal(needsCrossValidationArbitration('复核结论：BLOCKED'), true, 'BLOCKED should arbitrate')
  assert.equal(
    needsCrossValidationArbitration('1. **Conclusion:** ARBITRATION_REQUIRED'),
    true,
    'explicit arbitration request should arbitrate'
  )

  const validArbitrationConclusions = [
    ['Arbitration Conclusion: PRIMARY_OK', 'PRIMARY_OK'],
    ['仲裁结论：REVIEWER_OK', 'REVIEWER_OK'],
    ['## 1. **仲裁结论：** **BOTH_NEED_FIX**', 'BOTH_NEED_FIX'],
    ['**Arbitration Conclusion: NEED_HUMAN**', 'NEED_HUMAN']
  ]
  for (const [text, expected] of validArbitrationConclusions) {
    assert.equal(parseCrossValidationArbitrationConclusion(text), expected, `arbitration conclusion should parse: ${text}`)
  }
  for (const text of [
    'Reason mentions NEED_HUMAN\nArbitration Conclusion: NEED_HUMAN',
    'Arbitration Conclusion: PRIMARY_OK because it passed',
    'prefix Arbitration Conclusion: REVIEWER_OK',
    'Arbitration Conclusion: UNKNOWN',
    'Conclusion: PRIMARY_OK'
  ]) {
    assert.equal(parseCrossValidationArbitrationConclusion(text), null, `arbitration conclusion must be strict: ${text}`)
  }
  assert.equal(crossValidationFailureVerdict('BLOCKED', 'REVIEWER_OK'), 'blocked')
  assert.equal(crossValidationFailureVerdict('CONCERNS', 'REVIEWER_OK'), 'concerns')
  assert.equal(crossValidationFailureVerdict('ARBITRATION_REQUIRED', 'REVIEWER_OK'), null)
  assert.equal(crossValidationFailureVerdict('BLOCKED', 'BOTH_NEED_FIX'), 'blocked')
  assert.equal(crossValidationFailureVerdict('ARBITRATION_REQUIRED', 'BOTH_NEED_FIX'), 'blocked')
  assert.equal(crossValidationFailureVerdict('PASS', 'BOTH_NEED_FIX'), null)
  assert.equal(crossValidationFailureVerdict('BLOCKED', 'PRIMARY_OK'), null)
  assert.equal(crossValidationFailureVerdict('BLOCKED', 'NEED_HUMAN'), null)
  assert.equal(crossValidationFailureVerdict(null, null), null)
  const ownedParent = {
    id: 'owned-parent',
    title: 'Release Fix',
    cwd: repoRoot,
    workspaceId: 'project-1',
    goalId: 'goal-1',
    workItemId: 'work-item-1',
    model: 'primary-model',
    providerId: 'primary-provider',
    permissionMode: 'default',
    status: 'idle',
    costUsd: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    contextTokens: 0,
    createdAt: 1
  }
  const failureCandidate = {
    arbitrationSessionId: 'arbitration-session-1',
    parentRunId: 'run-1',
    eventId: 'event-1',
    observedAt: 1234,
    resultText: 'Arbitration Conclusion: BOTH_NEED_FIX\nConfirmed release defect.',
    reviewerConclusion: 'BLOCKED',
    parentMeta: ownedParent,
    verifier: 'model-arbitration:qwen/qwen-turbo'
  }
  const ingressPlan = planCrossValidationFailureIngress(failureCandidate)
  assert.equal(ingressPlan.disposition, 'ingest')
  assert.equal(ingressPlan.input.projectId, 'project-1')
  assert.equal(ingressPlan.input.goalId, 'goal-1')
  assert.equal(ingressPlan.input.workItemId, 'work-item-1')
  assert.equal(ingressPlan.input.runId, 'run-1')
  assert.equal(ingressPlan.input.verdict, 'blocked')
  assert.match(ingressPlan.input.sourceEventId, /^model-arbitration:[a-f0-9]{64}$/)
  assert.match(ingressPlan.input.contentDigest, /^[a-f0-9]{64}$/)
  assert(!ingressPlan.input.summary.includes('\n'), 'failure summary must be normalized to one line')
  assert.deepEqual(planCrossValidationFailureIngress(failureCandidate), ingressPlan, 'producer replay must be stable')
  const conflictingPlan = planCrossValidationFailureIngress({
    ...failureCandidate,
    resultText: `${failureCandidate.resultText} changed`
  })
  assert.equal(conflictingPlan.disposition, 'ingest')
  assert.equal(conflictingPlan.input.sourceEventId, ingressPlan.input.sourceEventId)
  assert.notEqual(conflictingPlan.input.contentDigest, ingressPlan.input.contentDigest)
  assert.equal(planCrossValidationFailureIngress({
    ...failureCandidate,
    parentMeta: { ...ownedParent, workspaceId: undefined }
  }).disposition, 'unowned')
  for (const [reviewerConclusion, resultText] of [
    ['PASS', 'Arbitration Conclusion: BOTH_NEED_FIX'],
    ['ARBITRATION_REQUIRED', 'Arbitration Conclusion: REVIEWER_OK'],
    ['BLOCKED', 'Arbitration Conclusion: PRIMARY_OK'],
    ['BLOCKED', 'Arbitration Conclusion: NEED_HUMAN'],
    ['BLOCKED', 'Analysis mentions BOTH_NEED_FIX without a conclusion line.']
  ]) {
    assert.equal(planCrossValidationFailureIngress({
      ...failureCandidate,
      reviewerConclusion,
      resultText
    }).disposition, 'ignore', `producer must ignore ${reviewerConclusion}/${resultText}`)
  }
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
  assert(prompt.includes('首个非空行只能是“结论: <TOKEN>”'), 'review prompt should require a parseable first line')
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
  assert(
    arbitrationPrompt.includes('首个非空行只能是“仲裁结论: <TOKEN>”'),
    'arbitration prompt should require a parseable first line'
  )

  const sessionManager = read('src/main/sessionManager.ts')
  const runtime = read('src/main/model/cross-validation-runtime.ts')
  const failurePlanner = read('src/main/model/cross-validation-failure.ts')
  assert(sessionManager.includes('new ModelCrossValidationRuntime'), 'cross-validation runtime wiring missing')
  assert(runtime.includes('routePlans = new Map<string, ModelRoutePlanView>()'), 'route plan cache missing')
  assert(runtime.includes('started = new Set<string>()'), 'duplicate guard missing')
  assert(runtime.includes('reviews = new Map<string, ReviewContext>()'), 'review association cache missing')
  assert(runtime.includes('arbitrations = new Map<string, ArbitrationContext>()'), 'arbitration association cache missing')
  assert(runtime.includes('modelCrossValidationAutoRunEnabled'), 'auto-run setting gate missing')
  assert(runtime.includes("childRole: 'model-review'"), 'review child role missing')
  assert(runtime.includes("childRole: 'model-arbitration'"), 'arbitration child role missing')
  assert(runtime.includes("permissionMode: 'plan'"), 'review child must be plan-only')
  assert(runtime.includes('buildCrossValidationReviewPrompt'), 'review child must receive validation prompt')
  assert(runtime.includes('buildCrossValidationArbitrationPrompt'), 'arbitration child must receive arbitration prompt')
  assert(runtime.includes("event: 'model-cross-validation'"), 'timeline event missing')
  assert(runtime.includes("event: 'model-cross-validation-arbitration'"), 'arbitration event missing')
  assert(runtime.includes('ingestWorkflowAcceptanceFailure'), 'structured failure ingress missing')
  assert(failurePlanner.includes('workspaceId, goalId, workItemId'), 'canonical ownership guard missing')
  assert(runtime.includes('meta.parentSessionId || meta.childRole'), 'recursion guard missing')
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
