import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
mkdirSync(path.join(repoRoot, 'test-results'), { recursive: true })
const tempRoot = mkdtempSync(path.join(repoRoot, 'test-results', 'caogen-genesis-smoke-'))
const outDir = path.join(tempRoot, 'compiled')
const projectRoot = path.join(tempRoot, 'project')

try {
  mkdirSync(projectRoot, { recursive: true })
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          typecheck: 'tsc --noEmit',
          build: 'vite build',
          'test:model-router': 'node scripts/model-router-smoke.mjs'
        }
      },
      null,
      2
    ),
    'utf8'
  )

  compile(
    [
      'src/main/genesis/orchestrator.ts',
      'src/main/openaiTools.ts',
      'src/main/model/drive.ts',
      'src/main/permission/tool-permission.ts'
    ],
    outDir
  )

  const genesis = await import(pathToFileURL(findCompiled(outDir, 'orchestrator.js')).href)
  const tools = await import(pathToFileURL(findCompiled(outDir, 'openaiTools.js')).href)
  const drive = await import(pathToFileURL(findCompiled(outDir, 'drive.js')).href)
  const permission = await import(pathToFileURL(findCompiled(outDir, 'tool-permission.js')).href)

  const baseSettings = {
    driveMode: 'core',
    defaultModel: 'auto',
    defaultPermissionMode: 'default',
    schedulerStrategy: 'balanced',
    smartModelRoutingEnabled: true,
    modelCrossValidationAutoRunEnabled: false,
    budgetUsdPerSession: 0,
    allowedTools: '',
    disallowedTools: '',
    permissionAllowlist: '',
    permissionDenylist: '',
    permissionTemporaryAllowlist: '',
    sandboxMode: 'loose',
    guiAutomationEnabled: false
  }

  const names = tools.OPENAI_CODING_TOOLS.map((tool) => tool.function.name)
  const responseNames = tools.RESPONSES_CODING_TOOLS.map((tool) => tool.name)
  assert(names.includes('genesis_orchestrate'), 'genesis_orchestrate should be registered for Chat tools')
  assert(responseNames.includes('genesis_orchestrate'), 'genesis_orchestrate should be registered for Responses tools')
  assert(tools.READONLY_TOOLS.has('genesis_orchestrate'), 'genesis_orchestrate should be plan-mode readable')

  for (const mode of ['spark', 'core', 'forge']) {
    const settings = drive.settingsForCaoGenDrive(baseSettings, mode)
    assert(
      settings.permissionDenylist.includes('tool=genesis_orchestrate'),
      `${mode} should deny Genesis orchestration by policy`
    )
    const decision = permission.evaluateToolPermission(settings, {
      toolName: 'genesis_orchestrate',
      input: { request: 'Plan a multi-agent delivery', cwd: projectRoot },
      cwd: projectRoot
    })
    assertEqual(decision.kind, 'deny', `${mode} should not default to Genesis orchestration`)
    assertEqual(decision.risk.level, 'high', 'Genesis orchestration should be high risk')
  }

  for (const mode of ['command', 'genesis']) {
    const settings = drive.settingsForCaoGenDrive(baseSettings, mode)
    assert(
      !settings.permissionDenylist.includes('tool=genesis_orchestrate'),
      `${mode} should not deny Genesis orchestration by policy`
    )
    const decision = permission.evaluateToolPermission(settings, {
      toolName: 'genesis_orchestrate',
      input: { request: 'Plan a multi-agent delivery', cwd: projectRoot },
      cwd: projectRoot
    })
    assertEqual(decision.kind, 'neutral', `${mode} should leave Genesis orchestration to permission mode`)
    assertEqual(decision.risk.level, 'high', 'Genesis orchestration should retain high-risk audit metadata')
  }

  const directReport = await genesis.buildGenesisOrchestration({
    request: '多模块 Agent Work OS 发布任务:拆解实现、审查、验证、交付,包含 DAG、worktree 和 Code Forge commit 策略。',
    cwd: projectRoot,
    driveMode: 'genesis',
    deliveryMode: 'commit',
    validationCommands: ['npm run typecheck', 'npm run build'],
    maxWorkerLanes: 4,
    requireHumanConfirmation: true
  })
  assertEqual(directReport.version, 'a9-genesis-v1')
  assertEqual(directReport.status, 'planned')
  assert(directReport.modeStrategy.orchestrationAllowed, 'Genesis mode should allow orchestration planning')
  assert(directReport.taskPlan.dag.tasks.length >= 2, 'Genesis plan should include a task breakdown')
  assert(directReport.taskPlan.layers.length >= 1, 'Genesis plan should include DAG layers')
  assert(directReport.workerLanes.length >= 2, 'Genesis plan should include worker lanes')
  assertEqual(directReport.isolation.mode, 'planned-isolated-worktrees')
  assertEqual(directReport.isolation.actualWorktreesCreated, false)
  assert(directReport.isolation.lanes.every((lane) => lane.created === false), 'isolation lanes must be planned only')
  assert(
    directReport.validationGates.some((gate) => gate.command === 'npm run typecheck') &&
      directReport.validationGates.some((gate) => gate.command === 'npm run build'),
    'Genesis validation gates should include explicit commands'
  )
  assertEqual(directReport.risk.level, 'high')
  assert(directReport.humanConfirmationPoints.length >= 3, 'Genesis report should include human confirmation points')
  assertEqual(directReport.deliveryStrategy.tool, 'code_forge_delivery')
  assertEqual(directReport.deliveryStrategy.requestedMode, 'commit')
  assertEqual(directReport.deliveryStrategy.recommendedMode, 'patch')
  assertEqual(directReport.deliveryStrategy.verificationTool, 'bash')
  assert(directReport.deliveryStrategy.handoff.includes('显式 bash'), 'Genesis handoff must run validation via bash')
  assert(directReport.deliveryStrategy.handoff.includes('git_commit'), 'commit handoff must use the explicit Git tool')
  assert(!directReport.deliveryStrategy.handoff.includes('并传入 verificationCommands'), 'handoff must not embed shell validation in Code Forge')
  assertEqual(directReport.deliveryStrategy.executed, false)
  assertEqual(directReport.truthBoundary.externalAgentsControlled, false)
  assertEqual(directReport.truthBoundary.childSessionsCreated, 0)
  assertEqual(directReport.truthBoundary.worktreesCreated, 0)
  assert(directReport.executionReport.notExecuted.includes('external sub-agent control'), 'truth boundary should list non-executed external control')

  const coreReport = await genesis.buildGenesisOrchestration({
    request: '计划一个普通跨模块 DAG 工作。',
    cwd: projectRoot,
    driveMode: 'core'
  })
  assertEqual(coreReport.status, 'gated')
  assert(!coreReport.modeStrategy.orchestrationAllowed, 'Core mode should gate Genesis orchestration')

  const toolResult = await tools.executeCodingTool(
    'genesis_orchestrate',
    {
      request: '跨模块实现、审查、验证和交付:需要多 Agent lanes、worktree 隔离、validation gates。',
      cwd: projectRoot,
      driveMode: 'command',
      deliveryMode: 'report'
    },
    projectRoot
  )
  assertEqual(toolResult.ok, true)
  const toolReport = JSON.parse(toolResult.output)
  assertEqual(toolReport.status, 'planned')
  assertEqual(toolReport.truthBoundary.externalAgentsControlled, false)
  assert(!toolResult.output.includes('"externalAgentsControlled": true'), 'tool output must not claim external agent control')
  assert(!toolResult.output.includes('"actualWorktreesCreated": true'), 'tool output must not claim worktrees were created')
  assert(toolReport.deliveryStrategy.verificationCommands.includes('npm run typecheck'), 'tool should infer package validation gates')
  assertEqual(toolReport.deliveryStrategy.recommendedMode, 'report')
  assertEqual(toolReport.deliveryStrategy.verificationTool, 'bash')

  console.log('genesis smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile(files, outDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files.map((file) => path.join(repoRoot, file)),
      '--outDir',
      outDir,
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

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message = 'values differ') {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
