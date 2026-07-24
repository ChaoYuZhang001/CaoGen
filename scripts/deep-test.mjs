#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import deepTestStatus from './deep-test-status.cjs'

const { DEEP_TEST_STATUS_PROTOCOL, DEEP_TEST_STATUSES } = deepTestStatus
const OPTIONAL_CHECKS = new Set([
  'chinaRealNetwork smoke',
  'chinaToolCallParity smoke',
  'claude real e2e'
])
const RUNTIME_REQUIRED = {
  'chinaRealNetwork smoke': {
    env: ['CAOGEN_CHINA_REAL_NETWORK_REQUIRED'],
    args: ['--required']
  },
  'chinaToolCallParity smoke': {
    env: ['CAOGEN_CHINA_TOOL_CALL_PARITY_REQUIRED'],
    args: ['--required']
  }
}

const commandDefinitions = [
  { name: 'typecheck', ...commandSpec('npm', ['run', 'typecheck']), category: 'static' },
  { name: 'coding standards required', command: 'node', args: ['scripts/coding-standards-audit.mjs', '--required'], category: 'static' },
  { name: 'build', ...commandSpec('npm', ['run', 'build']), category: 'build' },
  { name: 'deep-test four-state smoke', command: 'node', args: ['scripts/deep-test-four-state-smoke.mjs'], category: 'smoke' },
  { name: 'P0/P1/P2 contract smoke', command: 'node', args: ['scripts/p0-p1-p2-contract-smoke.mjs'], category: 'smoke' },
  { name: 'product 1.0 acceptance map smoke', command: 'node', args: ['scripts/product-1.0-acceptance-map-smoke.mjs'], category: 'smoke' },
  { name: 'product 1.0 acceptance map structure', command: 'node', args: ['scripts/product-1.0-acceptance-map.mjs'], category: 'static' },
  { name: 'product 1.0 soak audit smoke', command: 'node', args: ['scripts/product-1.0-soak-audit-smoke.mjs'], category: 'smoke' },
  { name: 'real default Provider release audit smoke', command: 'node', args: ['scripts/real-provider-release-audit-smoke.mjs'], category: 'smoke' },
  { name: 'real default Provider release runner smoke', command: 'node', args: ['scripts/real-provider-release-runner-smoke.mjs'], category: 'smoke' },
  { name: 'release packaging policy smoke', command: 'node', args: ['scripts/release-packaging-policy-smoke.mjs'], category: 'smoke' },
  { name: 'release workflow contract smoke', command: 'node', args: ['scripts/release-workflow-contract-smoke.mjs'], category: 'static' },
  { name: 'Windows release config audit', command: 'node', args: ['scripts/windows-release-audit.mjs', '--config-only'], category: 'static' },
  { name: 'CaoGen Drive smoke', command: 'node', args: ['scripts/drive-smoke.mjs'], category: 'smoke' },
  { name: 'Claude optional smoke', command: 'node', args: ['scripts/claude-optional-smoke.mjs'], category: 'smoke' },
  { name: 'integration core', command: 'node', args: ['scripts/integration-test.cjs'], category: 'integration' },
  { name: 'integration modules', command: 'node', args: ['scripts/integration-test-2.cjs'], category: 'integration' },
  { name: 'integration wired modules', command: 'node', args: ['scripts/integration-test-3.cjs'], category: 'integration' },
  { name: 'taskDag smoke', command: 'node', args: ['scripts/task-dag-smoke.cjs'], category: 'smoke' },
  { name: 'taskDag recovery smoke', command: 'node', args: ['scripts/task-dag-recovery-smoke.cjs'], category: 'smoke' },
  { name: 'attachmentOps smoke', command: 'node', args: ['scripts/attachment-ops-smoke.mjs'], category: 'smoke' },
  { name: 'browserAnnotations smoke', command: 'node', args: ['scripts/browser-annotations-smoke.mjs'], category: 'smoke' },
  { name: 'checkpointRestorePlan smoke', command: 'node', args: ['scripts/checkpoint-restore-plan-smoke.mjs'], category: 'smoke' },
  { name: 'fileOps smoke', command: 'node', args: ['scripts/file-ops-smoke.mjs'], category: 'smoke' },
  { name: 'searchReplace/view smoke', command: 'node', args: ['scripts/search-replace-smoke.mjs'], category: 'smoke' },
  { name: 'chat virtual list smoke', command: 'node', args: ['scripts/chat-virtual-list-smoke.mjs'], category: 'smoke' },
  { name: 'indexer smoke', command: 'node', args: ['scripts/indexer-smoke.mjs'], category: 'smoke' },
  { name: 'context loader smoke', command: 'node', args: ['scripts/context-loader-smoke.mjs'], category: 'smoke' },
  { name: 'projectRules UI smoke', command: 'node', args: ['scripts/project-rules-ui-smoke.mjs'], category: 'smoke' },
  { name: 'sandbox permission smoke', command: 'node', args: ['scripts/p0-004-sandbox-permission-smoke.mjs'], category: 'smoke' },
  { name: 'gui permission smoke', command: 'node', args: ['scripts/gui-permission-smoke.mjs'], category: 'smoke' },
  { name: 'gui windows smoke', command: 'node', args: ['scripts/gui-windows-smoke.mjs'], category: 'smoke' },
  { name: 'gui macos smoke', command: 'node', args: ['scripts/gui-macos-smoke.mjs'], category: 'smoke' },
  { name: 'gui nutjs smoke', command: 'node', args: ['scripts/gui-nutjs-smoke.mjs'], category: 'smoke' },
  { name: 'macOS tray icon smoke', command: 'node', args: ['scripts/macos-tray-icon-smoke.mjs'], category: 'smoke' },
  { name: 'task snapshot smoke', command: 'node', args: ['scripts/task-snapshot-smoke.mjs'], category: 'smoke' },
  { name: 'task evidence ledger smoke', command: 'node', args: ['scripts/task-evidence-ledger-smoke.mjs'], category: 'smoke' },
  { name: 'workflow evidence ledger smoke', command: 'node', args: ['scripts/workflow-evidence-store-smoke.mjs'], category: 'smoke' },
  { name: 'workflow evidence link idempotency smoke', command: 'node', args: ['scripts/workflow-evidence-link-idempotency-smoke.mjs'], category: 'smoke' },
  { name: 'digitalWorker domain smoke', command: 'node', args: ['scripts/digital-worker-smoke.mjs', '--required'], category: 'smoke' },
  { name: 'DigitalWorker action policy required', command: 'node', args: ['scripts/digital-worker-policy-action-smoke.mjs'], category: 'system' },
  { name: 'DigitalWorker recruitment policy E2E', command: 'node', args: ['scripts/digital-worker-recruitment-policy-e2e.mjs'], category: 'system' },
  { name: 'DigitalWorker recruitment real Electron E2E', command: 'node', args: ['scripts/digital-worker-recruitment-electron-e2e.mjs'], category: 'ui' },
  { name: 'Assignment owner coordinator crash smoke', command: 'node', args: ['scripts/assignment-owner-coordinator-smoke.mjs'], category: 'system' },
  { name: 'Session WorkItem ownership smoke', command: 'node', args: ['scripts/session-workitem-ownership-smoke.mjs'], category: 'system' },
  { name: 'workflow ledger smoke', command: 'node', args: ['scripts/workflow-ledger-smoke.mjs'], category: 'smoke' },
  { name: 'ModelAttempt ledger smoke', command: 'node', args: ['scripts/model-attempt-ledger-smoke.mjs'], category: 'smoke' },
  { name: 'ModelAttempt runtime smoke', command: 'node', args: ['scripts/model-attempt-runtime-smoke.mjs'], category: 'smoke' },
  { name: 'protocol adapter production boundary', command: 'node', args: ['scripts/protocol-adapter-boundary-smoke.mjs'], category: 'integration' },
  { name: 'Claude ModelAttempt smoke', command: 'node', args: ['scripts/claude-model-attempt-smoke.mjs'], category: 'smoke' },
  { name: 'Anthropic Messages smoke', command: 'node', args: ['scripts/anthropic-messages-smoke.mjs'], category: 'smoke' },
  { name: 'Anthropic tool-use loop required', command: 'node', args: ['scripts/anthropic-tool-use-loop-smoke.mjs'], category: 'integration' },
  { name: 'Anthropic image restart required', command: 'node', args: ['scripts/anthropic-tool-use-loop-smoke.mjs', '--image-restart-only'], category: 'integration' },
  { name: 'Anthropic failover required', command: 'node', args: ['scripts/anthropic-failover-smoke.mjs'], category: 'integration' },
  { name: 'Anthropic engine production registration required', command: 'node', args: ['scripts/anthropic-engine-registration-smoke.mjs'], category: 'integration' },
  { name: 'ModelAttempt reconciliation smoke', command: 'node', args: ['scripts/model-attempt-reconciliation-smoke.mjs'], category: 'smoke' },
  { name: 'ModelAttempt crash reconciliation E2E', command: 'node', args: ['scripts/model-attempt-reconciliation-crash-e2e.mjs'], category: 'system' },
  { name: 'workflow ledger canonical migration smoke', command: 'node', args: ['scripts/workflow-ledger-canonical-migration-smoke.mjs'], category: 'smoke' },
  { name: 'workflow ledger read source smoke', command: 'node', args: ['scripts/workflow-ledger-read-source-smoke.mjs'], category: 'smoke' },
  { name: 'workflow shadow consistency smoke', command: 'node', args: ['scripts/workflow-shadow-consistency-smoke.mjs'], category: 'smoke' },
  { name: 'artifact graph smoke', command: 'node', args: ['scripts/artifact-graph-smoke.mjs'], category: 'smoke' },
  { name: 'workflow ledger security smoke', command: 'node', args: ['scripts/workflow-ledger-security-smoke.mjs'], category: 'smoke' },
  { name: 'workflow ledger maintenance smoke', command: 'node', args: ['scripts/workflow-ledger-maintenance-smoke.mjs'], category: 'smoke' },
  { name: 'project workspace smoke', command: 'node', args: ['scripts/project-workspace-smoke.mjs'], category: 'smoke' },
  { name: 'ProjectWorkspace ledger migration smoke', command: 'node', args: ['scripts/project-workspace-ledger-migration-smoke.mjs'], category: 'smoke' },
  { name: 'Canonical Goal WorkItem schema parity smoke', command: 'node', args: ['scripts/canonical-goal-workitem-schema-parity-smoke.mjs'], category: 'smoke' },
  { name: 'Canonical ProjectWorkspace read cutover smoke', command: 'node', args: ['scripts/canonical-project-workspace-read-cutover-smoke.mjs'], category: 'smoke' },
  { name: 'Canonical ProjectWorkspace write-source crash smoke', command: 'node', args: ['scripts/canonical-project-workspace-write-source-smoke.mjs'], category: 'system' },
  { name: 'Project Ledger shadow dual-write crash E2E', command: 'node', args: ['scripts/project-ledger-shadow-write-crash-e2e.mjs'], category: 'system' },
  { name: 'Project command ingress smoke', command: 'node', args: ['scripts/project-command-ingress-smoke.mjs'], category: 'smoke' },
  { name: 'Workflow ingress static smoke', command: 'node', args: ['scripts/workflow-ingress-static-smoke.mjs'], category: 'static' },
  { name: 'ProjectWorkspace lifecycle required UI e2e', command: 'node', args: ['scripts/project-workspace-lifecycle-e2e.mjs'], category: 'ui' },
  { name: 'digital worker smoke', command: 'node', args: ['scripts/digital-worker-smoke.mjs'], category: 'smoke' },
  { name: 'acceptance gate smoke', command: 'node', args: ['scripts/acceptance-gate-smoke.mjs'], category: 'smoke' },
  { name: 'acceptance artifact integrity smoke', command: 'node', args: ['scripts/acceptance-artifact-integrity-smoke.mjs'], category: 'smoke' },
  { name: 'acceptance repair and retest smoke', command: 'node', args: ['scripts/acceptance-repair-retest-smoke.mjs'], category: 'smoke' },
  { name: 'acceptance failure ingress smoke', command: 'node', args: ['scripts/workflow-acceptance-failure-ingress-smoke.mjs'], category: 'smoke' },
  { name: 'workflow test failure runtime smoke', command: 'node', args: ['scripts/workflow-test-failure-runtime-smoke.mjs'], category: 'smoke' },
  { name: 'Assistant/Studio required UI e2e', command: 'node', args: ['scripts/assistant-studio-ui-e2e.mjs'], category: 'ui' },
  { name: 'Assistant/Studio canonical consistency required UI e2e', command: 'node', args: ['scripts/assistant-studio-consistency-e2e.mjs'], category: 'ui' },
  { name: 'Session model switch policy smoke', command: 'node', args: ['scripts/session-model-switch-policy-smoke.mjs'], category: 'smoke' },
  { name: 'Assistant/Studio live switch required UI e2e', command: 'node', args: ['scripts/assistant-studio-live-switch-e2e.mjs'], category: 'ui' },
  { name: 'Assistant/Studio performance required UI e2e', command: 'node', args: ['scripts/assistant-studio-performance-e2e.mjs'], category: 'ui' },
  { name: 'local Provider routing parity required', command: 'node', args: ['scripts/local-provider-parity-smoke.mjs'], category: 'integration' },
  { name: 'routing zero-choice required UI e2e', command: 'node', args: ['scripts/routing-zero-choice-e2e.mjs'], category: 'ui' },
  { name: 'taskRun state smoke', command: 'node', args: ['scripts/task-run-state-smoke.mjs'], category: 'smoke' },
  { name: 'event cursor crash smoke', command: 'node', args: ['scripts/event-cursor-crash-smoke.mjs'], category: 'system' },
  { name: 'effect reconciliation smoke', command: 'node', args: ['scripts/effect-reconciliation-smoke.mjs'], category: 'smoke' },
  { name: 'operation effect gateway smoke', command: 'node', args: ['scripts/operation-effect-gateway-smoke.mjs'], category: 'smoke' },
  { name: 'operation effect gateway e2e', command: 'node', args: ['scripts/operation-effect-gateway-e2e.mjs'], category: 'system' },
  { name: 'managed worktree effect smoke', command: 'node', args: ['scripts/managed-worktree-effect-smoke.mjs'], category: 'smoke' },
  { name: 'managed worktree effect crash e2e', command: 'node', args: ['scripts/managed-worktree-effect-crash-e2e.mjs'], category: 'system' },
  { name: 'git index effect e2e', command: 'node', args: ['scripts/git-index-effect-e2e.mjs'], category: 'system' },
  { name: 'git index effect crash e2e', command: 'node', args: ['scripts/git-index-effect-crash-e2e.mjs'], category: 'system' },
  { name: 'effect crash recovery e2e', command: 'node', args: ['scripts/effect-crash-recovery-e2e.mjs'], category: 'system' },
  { name: 'effect close race smoke', command: 'node', args: ['scripts/effect-close-race-smoke.mjs'], category: 'system' },
  { name: 'git tools smoke', command: 'node', args: ['scripts/git-tools-smoke.mjs'], category: 'smoke' },
  { name: 'code forge contract smoke', command: 'node', args: ['scripts/code-forge-smoke.mjs'], category: 'smoke' },
  { name: 'context compressor smoke', command: 'node', args: ['scripts/context-compressor-smoke.mjs'], category: 'smoke' },
  { name: 'memoryStore smoke', command: 'node', args: ['scripts/memory-store-smoke.mjs'], category: 'smoke' },
  { name: 'Learning draft contract required', command: 'node', args: ['scripts/learning-draft-contract-smoke.mjs'], category: 'system' },
  { name: 'Learning approval lifecycle required', command: 'node', args: ['scripts/learning-approval-lifecycle-smoke.mjs'], category: 'system' },
  { name: 'Effective Memory prompt required', command: 'node', args: ['scripts/effective-memory-prompt-smoke.mjs'], category: 'system' },
  { name: 'Learning approval panel required', command: 'node', args: ['scripts/learning-approval-panel-smoke.mjs'], category: 'system' },
  { name: 'layeredMemory smoke', command: 'node', args: ['scripts/layered-memory-smoke.mjs'], category: 'smoke' },
  { name: 'memorySuggestion e2e', command: 'node', args: ['scripts/memory-suggestion-e2e.mjs'], category: 'ui' },
  { name: 'pluginRegistry smoke', command: 'node', args: ['scripts/plugin-registry-smoke.mjs'], category: 'smoke' },
  { name: 'skillManager smoke', command: 'node', args: ['scripts/skill-manager-smoke.mjs'], category: 'smoke' },
  { name: 'skillLearner smoke', command: 'node', args: ['scripts/skill-learner-smoke.mjs'], category: 'smoke' },
  { name: 'autoSkillReview smoke', command: 'node', args: ['scripts/auto-skill-review-smoke.mjs'], category: 'smoke' },
  { name: 'skillOptimizer smoke', command: 'node', args: ['scripts/skill-optimizer-smoke.mjs'], category: 'smoke' },
  { name: 'skillInvocation smoke', command: 'node', args: ['scripts/skill-invocation-smoke.mjs'], category: 'smoke' },
  { name: 'mcpClient smoke', command: 'node', args: ['scripts/mcp-client-smoke.mjs'], category: 'smoke' },
  { name: 'plugin slash smoke', command: 'node', args: ['scripts/plugin-slash-smoke.mjs'], category: 'smoke' },
  { name: 'previewOps smoke', command: 'node', args: ['scripts/preview-ops-smoke.mjs'], category: 'smoke' },
  { name: 'Office visual preview smoke', command: 'node', args: ['scripts/office-visual-preview-smoke.mjs'], category: 'smoke' },
  { name: 'previewUtils smoke', command: 'node', args: ['scripts/preview-utils-smoke.mjs'], category: 'smoke' },
  { name: 'officePreviewRenderer smoke', command: 'node', args: ['scripts/office-preview-renderer-smoke.mjs'], category: 'smoke' },
  { name: 'previewAnnotations smoke', command: 'node', args: ['scripts/preview-annotations-smoke.mjs'], category: 'smoke' },
  { name: 'previewPrompt smoke', command: 'node', args: ['scripts/preview-prompt-smoke.mjs'], category: 'smoke' },
  { name: 'routineStore smoke', command: 'node', args: ['scripts/routine-store-smoke.mjs'], category: 'smoke' },
  { name: 'routineRunner smoke', command: 'node', args: ['scripts/routine-runner-smoke.mjs'], category: 'smoke' },
  { name: 'openai P1 tools smoke', command: 'node', args: ['scripts/openai-p1-tools-smoke.mjs'], category: 'smoke' },
  { name: 'startSuggestions smoke', command: 'node', args: ['scripts/start-suggestions-smoke.mjs'], category: 'smoke' },
  { name: 'startSuggestions e2e', command: 'node', args: ['scripts/start-suggestions-e2e.mjs'], category: 'ui' },
  { name: 'transcriptRestore smoke', command: 'node', args: ['scripts/transcript-restore-smoke.mjs'], category: 'smoke' },
  { name: 'transcriptSearch smoke', command: 'node', args: ['scripts/transcript-search-smoke.mjs'], category: 'smoke' },
  { name: 'pluginInstall smoke', command: 'node', args: ['scripts/plugin-install-smoke.mjs'], category: 'smoke' },
  { name: 'providerPresets smoke', command: 'node', args: ['scripts/provider-presets-smoke.mjs'], category: 'smoke' },
  { name: 'providerKeys smoke', command: 'node', args: ['scripts/provider-keys-smoke.mjs'], category: 'smoke' },
  { name: 'provider credential target binding smoke', command: 'node', args: ['scripts/provider-credential-target-binding-smoke.mjs'], category: 'smoke' },
  { name: 'providerConnectivity smoke', command: 'node', args: ['scripts/provider-connectivity-smoke.mjs'], category: 'smoke' },
  { name: 'provider runtime containment smoke', command: 'node', args: ['scripts/provider-runtime-containment-smoke.mjs'], category: 'smoke' },
  { name: 'modelStats smoke', command: 'node', args: ['scripts/model-stats-smoke.mjs'], category: 'smoke' },
  { name: 'modelRouter smoke', command: 'node', args: ['scripts/model-router-smoke.mjs'], category: 'smoke' },
  { name: 'routing visibility smoke', command: 'node', args: ['scripts/routing-visibility-smoke.mjs'], category: 'smoke' },
  { name: 'provider health history smoke', command: 'node', args: ['scripts/provider-health-history-smoke.mjs'], category: 'smoke' },
  { name: 'provider key failover smoke', command: 'node', args: ['scripts/provider-key-failover-smoke.mjs'], category: 'smoke' },
  { name: 'budget report smoke', command: 'node', args: ['scripts/budget-report-smoke.mjs'], category: 'smoke' },
  { name: 'failoverTarget smoke', command: 'node', args: ['scripts/failover-target-smoke.mjs'], category: 'smoke' },
  { name: 'modelOptimization smoke', command: 'node', args: ['scripts/model-optimization-smoke.mjs'], category: 'smoke' },
  { name: 'modelCrossValidation smoke', command: 'node', args: ['scripts/model-cross-validation-smoke.mjs'], category: 'smoke' },
  { name: 'chinaEcosystem smoke', command: 'node', args: ['scripts/china-ecosystem-smoke.mjs'], category: 'smoke' },
  { name: 'chinaModelProvider smoke', command: 'node', args: ['scripts/china-model-provider-smoke.mjs'], category: 'smoke' },
  { name: 'chinaRealNetwork smoke', command: 'node', args: ['scripts/china-real-network-smoke.mjs'], category: 'smoke', statusReporter: 'scripts/china-real-network-smoke.mjs' },
  { name: 'chinaToolCallParity smoke', command: 'node', args: ['scripts/china-tool-call-parity.mjs'], category: 'smoke', statusReporter: 'scripts/china-tool-call-parity.mjs' },
  { name: 'ideBridge smoke', command: 'node', args: ['scripts/ide-bridge-smoke.mjs'], category: 'smoke' },
  { name: 'openai P2 tools smoke', command: 'node', args: ['scripts/openai-p2-tools-smoke.mjs'], category: 'smoke' },
  { name: 'responses tools e2e', ...commandSpec('npx', ['electron', 'scripts/responses-tools-e2e.cjs']), category: 'system' },
  { name: 'history compress e2e', ...commandSpec('npx', ['electron', 'scripts/history-compress-e2e.cjs']), category: 'system' },
  { name: 'claude real e2e', ...commandSpec('npx', ['electron', 'scripts/claude-real-e2e.cjs']), category: 'system', statusReporter: 'scripts/claude-real-e2e.cjs' },
  { name: 'worktreeMerge smoke', command: 'node', args: ['scripts/worktree-merge-smoke.mjs'], category: 'smoke' },
  { name: 'taskDag autoMerge e2e', ...commandSpec('npx', ['electron', 'scripts/task-dag-automerge-e2e.cjs']), category: 'system' },
  { name: 'taskDag durable finalization crash e2e', command: 'node', args: ['scripts/task-dag-finalization-crash-e2e.cjs'], category: 'system' },
  { name: 'Electron main IPC smoke', ...commandSpec('npx', ['electron', 'scripts/electron-smoke.cjs']), category: 'system' },
  { name: 'OpenAI mock e2e', command: 'node', args: ['scripts/openai-mock-e2e.mjs'], category: 'system' },
  { name: 'orchestration mock e2e', command: 'node', args: ['scripts/orchestration-mock-e2e.mjs'], category: 'ui' },
  { name: 'X1/S3 e2e', command: 'node', args: ['scripts/x1-s3-e2e.mjs'], category: 'ui' },
  { name: 'page operations smoke', command: 'node', args: ['scripts/page-operation-smoke.mjs'], category: 'ui' }
]

export const commands = commandDefinitions.map((item) => ({
  ...item,
  requirement: OPTIONAL_CHECKS.has(item.name) ? 'optional' : 'required',
  ...(RUNTIME_REQUIRED[item.name] ? { requiredWhen: RUNTIME_REQUIRED[item.name] } : {})
}))

export async function runDeepTest(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd())
  const outRoot = path.resolve(options.outRoot ?? path.join(repoRoot, 'test-results', 'caogen-deep'))
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = path.join(outRoot, runId)
  const baseEnv = options.env ?? process.env
  const plannedCommands = normalizeCommands(options.commands ?? commands, baseEnv)
  const log = options.log ?? console.log
  const stopOnBlocking = options.stopOnBlocking !== false
  const startedAt = new Date().toISOString()
  const gitStart = readGitState(repoRoot)
  const results = []

  mkdirSync(runDir, { recursive: true })

  for (let index = 0; index < plannedCommands.length; index += 1) {
    const item = plannedCommands[index]
    const result = await runCommand(item, { repoRoot, runDir, baseEnv })
    results.push(result)
    log(`[${result.status.toUpperCase()}] ${item.name} [${item.requirement}] (${result.durationMs}ms)`)
    if (stopOnBlocking && result.blocksGate) {
      for (const pending of plannedCommands.slice(index + 1)) {
        results.push(blockedResult(pending, result))
      }
      break
    }
  }

  const finishedAt = new Date().toISOString()
  const gitEnd = readGitState(repoRoot)
  const blockingResults = results.filter((item) => item.blocksGate)
  const status = blockingResults.length === 0 && results.length === plannedCommands.length ? 'pass' : 'fail'
  const report = {
    schemaVersion: 2,
    runId,
    startedAt,
    finishedAt,
    status,
    exitCode: status === 'pass' ? 0 : 1,
    gatePolicy: {
      fail: 'always-blocking',
      required: 'must-pass',
      optional: 'skip-or-blocked-is-non-blocking; fail-is-blocking'
    },
    repoRoot,
    runDir,
    git: {
      commit: gitEnd.commit,
      worktreeClean: gitStart.worktreeClean && gitEnd.worktreeClean,
      unchanged: gitStart.commit === gitEnd.commit && gitStart.worktreeClean === gitEnd.worktreeClean,
      start: gitStart,
      end: gitEnd
    },
    summary: buildSummary(results, plannedCommands.length),
    results,
    missingCommands: results.filter((item) => item.executed === false).map((item) => item.name),
    recommendations: buildRecommendations(results, plannedCommands.length)
  }

  writeReports(report, outRoot)
  return report
}

async function runCommand(item, context) {
  const started = Date.now()
  const baseName = slug(item.name)
  const outputPath = path.join(context.runDir, `${baseName}.log`)
  const statusPath = path.join(context.runDir, `${baseName}.status.json`)
  let stdout = ''
  let stderr = ''
  let spawnError = null
  const childEnv = { ...context.baseEnv, ...(item.env ?? {}) }
  delete childEnv.CAOGEN_DEEP_TEST_STATUS_FILE
  delete childEnv.CAOGEN_DEEP_TEST_STATUS_REPORTER
  if (item.statusReporter) {
    childEnv.CAOGEN_DEEP_TEST_STATUS_FILE = statusPath
    childEnv.CAOGEN_DEEP_TEST_STATUS_REPORTER = path.resolve(context.repoRoot, item.statusReporter)
  }
  const child = spawn(item.command, item.args, {
    cwd: context.repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exit = await new Promise((resolve) => {
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => resolve({ code, signal, error: spawnError }))
  })
  const durationMs = Date.now() - started
  const output = [
    `$ ${item.command} ${item.args.join(' ')}`,
    '',
    stdout.trim(),
    stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  writeFileSync(outputPath, output)

  const resolved = resolveCommandStatus({ statusPath, exit })
  return {
    ...item,
    commandLine: `${item.command} ${item.args.join(' ')}`,
    status: resolved.status,
    requirement: item.requirement,
    blocksGate: blocksGate(item.requirement, resolved.status),
    executed: true,
    exitCode: exit.code,
    signal: exit.signal,
    durationMs,
    outputPath,
    statusPath: resolved.protocolSource === 'structured' ? statusPath : null,
    protocolSource: resolved.protocolSource,
    reason: resolved.reason,
    details: resolved.details,
    summary: summarize(stdout, stderr, exit.error)
  }
}

function resolveCommandStatus({ statusPath, exit }) {
  const structured = readStructuredStatus(statusPath)
  if (structured.error) {
    return {
      status: 'fail',
      protocolSource: 'structured',
      reason: `invalid deep-test status protocol: ${structured.error}`
    }
  }
  if (structured.value) {
    if (structured.value.status !== 'fail' && (exit.code !== 0 || exit.signal || exit.error)) {
      return {
        status: 'fail',
        protocolSource: 'structured',
        reason: `child reported ${structured.value.status} but exited with ${describeExit(exit)}`,
        details: structured.value.details
      }
    }
    return {
      status: structured.value.status,
      protocolSource: 'structured',
      reason: structured.value.reason,
      details: structured.value.details
    }
  }
  if (exit.signal) {
    return {
      status: 'fail',
      protocolSource: 'exit-code',
      reason: `child terminated by signal ${exit.signal}`
    }
  }
  if (exit.error) {
    return {
      status: 'blocked',
      protocolSource: 'exit-code',
      reason: String(exit.error.message || exit.error)
    }
  }
  return {
    status: exit.code === 0 ? 'pass' : 'fail',
    protocolSource: 'exit-code',
    reason: exit.code === 0 ? undefined : `child exited with code ${exit.code}`
  }
}

function readStructuredStatus(statusPath) {
  if (!existsSync(statusPath)) return { value: null, error: null }
  try {
    const parsed = JSON.parse(readFileSync(statusPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('payload must be an object')
    if (parsed.protocol !== DEEP_TEST_STATUS_PROTOCOL) throw new Error(`unsupported protocol ${String(parsed.protocol)}`)
    if (!DEEP_TEST_STATUSES.has(parsed.status)) throw new Error(`unsupported status ${String(parsed.status)}`)
    if (parsed.status !== 'pass' && (typeof parsed.reason !== 'string' || !parsed.reason.trim())) {
      throw new Error(`${parsed.status} requires a reason`)
    }
    return {
      value: {
        status: parsed.status,
        reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined,
        details: parsed.details
      },
      error: null
    }
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function blockedResult(item, blocker) {
  const reason = `not run because ${blocker.name} blocked the gate with status ${blocker.status}`
  return {
    ...item,
    commandLine: `${item.command} ${item.args.join(' ')}`,
    status: 'blocked',
    requirement: item.requirement,
    blocksGate: blocksGate(item.requirement, 'blocked'),
    executed: false,
    exitCode: null,
    signal: null,
    durationMs: 0,
    outputPath: null,
    statusPath: null,
    protocolSource: 'runner',
    reason,
    blockedBy: blocker.name,
    summary: reason
  }
}

function blocksGate(requirement, status) {
  return status === 'fail' || (requirement === 'required' && status !== 'pass')
}

function normalizeCommands(items, baseEnv) {
  return items.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('deep-test command must be an object')
    if (!item.name || !item.command || !Array.isArray(item.args)) throw new Error('deep-test command needs name, command, and args')
    if (item.requirement !== 'required' && item.requirement !== 'optional') {
      throw new Error(`deep-test command ${item.name} needs explicit requirement: required or optional`)
    }
    const runtimeRequired = matchesRuntimeRequirement(item, { ...baseEnv, ...(item.env ?? {}) })
    return {
      ...item,
      declaredRequirement: item.requirement,
      requirement: runtimeRequired ? 'required' : item.requirement,
      requirementSource: runtimeRequired && item.requirement !== 'required' ? 'runtime' : 'declared'
    }
  })
}

function matchesRuntimeRequirement(item, env) {
  const rule = item.requiredWhen
  if (!rule) return false
  const envMatch = Array.isArray(rule.env) && rule.env.some((name) => env[name] === '1')
  const argMatch = Array.isArray(rule.args) && rule.args.some((arg) => item.args.includes(arg))
  return envMatch || argMatch
}

function buildSummary(items, total) {
  const counts = countStatuses(items)
  return {
    total,
    executed: items.filter((item) => item.executed).length,
    counts,
    required: summarizeRequirement(items, 'required'),
    optional: summarizeRequirement(items, 'optional'),
    blocking: items.filter((item) => item.blocksGate).map((item) => item.name)
  }
}

function summarizeRequirement(items, requirement) {
  const scoped = items.filter((item) => item.requirement === requirement)
  return {
    total: scoped.length,
    counts: countStatuses(scoped),
    blocking: scoped.filter((item) => item.blocksGate).length
  }
}

function countStatuses(items) {
  const counts = { pass: 0, skip: 0, blocked: 0, fail: 0 }
  for (const item of items) counts[item.status] += 1
  return counts
}

function buildRecommendations(items, total) {
  const blocking = items.filter((item) => item.blocksGate && item.executed !== false)
  if (blocking.length === 0 && items.length === total) {
    const optionalUnavailable = items.filter(
      (item) => item.requirement === 'optional' && (item.status === 'skip' || item.status === 'blocked')
    )
    const recommendations = ['本轮所有 required 检查通过。']
    if (optionalUnavailable.length > 0) {
      recommendations.push(
        `以下 optional 外部检查未形成通过证据,不得计作已验证: ${optionalUnavailable.map((item) => `${item.name}(${item.status})`).join(', ')}。`
      )
    }
    return recommendations
  }

  const recommendations = []
  for (const item of blocking) {
    if (item.status === 'skip' || item.status === 'blocked') {
      recommendations.push(`${item.name} 是 required 检查但状态为 ${item.status}: ${item.reason || '缺少执行条件'}。`)
    } else if (item.category === 'ui') {
      recommendations.push('页面操作 smoke 失败:优先查看截图与 JSON 报告,确认是否为选择器漂移、Electron 启动失败或真实 UI 回归。')
    } else if (item.category === 'system') {
      recommendations.push('真 Electron/IPC 系统冒烟失败:优先确认 build 产物、Electron runtime 与 ipcMain handler 注册是否一致。')
    } else if (item.category === 'build' || item.category === 'static') {
      recommendations.push('编译/类型检查失败:阻断提测,先修复 TS/build 输出再跑后续 smoke。')
    } else {
      recommendations.push(`${item.name} 失败:从 ${item.outputPath || 'runner report'} 定位模块级回归,修复后单跑该脚本再跑 test:deep。`)
    }
  }
  return [...new Set(recommendations)]
}

export function renderMarkdown(report) {
  const counts = report.summary.counts
  const lines = []
  lines.push(`# CaoGen Deep Test ${report.runId}`)
  lines.push('')
  lines.push(`- Status: ${report.status}`)
  lines.push(`- Exit code: ${report.exitCode}`)
  lines.push(`- Checks: ${report.summary.total} total; ${counts.pass} pass; ${counts.skip} skip; ${counts.blocked} blocked; ${counts.fail} fail`)
  lines.push('- Gate policy: fail always blocks; required checks must pass; optional skip/blocked is retained but does not block')
  lines.push(`- Required blocking checks: ${report.summary.required.blocking}`)
  lines.push(`- Optional blocking checks: ${report.summary.optional.blocking}`)
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Repo: ${report.repoRoot}`)
  lines.push(`- Git commit: ${report.git.commit || 'unknown'}`)
  lines.push(`- Clean worktree: ${report.git.worktreeClean ? 'yes' : 'no'}`)
  lines.push(`- Git state unchanged: ${report.git.unchanged ? 'yes' : 'no'}`)
  lines.push('')
  lines.push('| Check | Category | Requirement | Status | Gate | Duration | Log |')
  lines.push('|---|---|---|---|---|---:|---|')
  for (const item of report.results) {
    const logPath = item.outputPath ? path.relative(report.repoRoot, item.outputPath) : '(not run)'
    const requirement = item.requirementSource === 'runtime' ? `${item.requirement} (runtime)` : item.requirement
    lines.push(
      `| ${escapePipe(item.name)} | ${item.category} | ${requirement} | ${item.status} | ${item.blocksGate ? 'blocking' : 'non-blocking'} | ${item.durationMs}ms | ${escapePipe(logPath)} |`
    )
  }
  if (report.missingCommands.length > 0) {
    lines.push('')
    lines.push(`Blocked after gate failure: ${report.missingCommands.join(', ')}`)
  }
  lines.push('')
  lines.push('## Recommendations')
  for (const item of report.recommendations) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Latest Output Summaries')
  for (const item of report.results) {
    lines.push(`### ${item.name} [${item.status}]`)
    if (item.reason) lines.push(`Reason: ${item.reason}`)
    lines.push('```text')
    lines.push(item.summary || '(no output)')
    lines.push('```')
  }
  lines.push('')
  return lines.join('\n')
}

function writeReports(report, outRoot) {
  const json = `${JSON.stringify(report, null, 2)}\n`
  const markdown = renderMarkdown(report)
  writeFileSync(path.join(report.runDir, 'deep-test-report.json'), json)
  writeFileSync(path.join(report.runDir, 'deep-test-report.md'), markdown)
  writeFileSync(path.join(outRoot, 'latest.json'), json)
  writeFileSync(path.join(outRoot, 'latest.md'), markdown)
}

function summarize(stdout, stderr, error) {
  if (error) return String(error.message || error)
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
  return lines.slice(-30).join('\n')
}

function describeExit(exit) {
  if (exit.error) return String(exit.error.message || exit.error)
  if (exit.signal) return `signal ${exit.signal}`
  return `code ${exit.code}`
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'command'
}

function commandSpec(command, args) {
  return process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', command, ...args] }
    : { command, args }
}

function readGitState(repoRoot) {
  const commit = gitOutput(repoRoot, ['rev-parse', 'HEAD'])
  const status = gitOutput(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    commit,
    worktreeClean: status.length === 0,
    statusEntryCount: status ? status.split(/\r?\n/).filter(Boolean).length : 0
  }
}

function gitOutput(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return ''
  }
}

function escapePipe(value) {
  return String(value).replace(/\|/g, '\\|')
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
}
if (isMainModule()) {
  const report = await runDeepTest()
  for (const result of report.results.filter((item) => item.blocksGate)) console.error(result.summary || result.reason || '(no output)')
  console.log(`deep test report: ${path.join(report.runDir, 'deep-test-report.md')}`)
  process.exitCode = report.exitCode
}
