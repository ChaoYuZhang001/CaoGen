import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
mkdirSync(path.join(repoRoot, 'test-results'), { recursive: true })
const tempRoot = mkdtempSync(path.join(repoRoot, 'test-results', 'caogen-openai-p1-tools-'))
const outDir = path.join(tempRoot, 'compiled')
const projectRoot = path.join(tempRoot, 'project')
const memoryRoot = path.join(tempRoot, 'memory')

try {
  process.env.CAOGEN_MEMORY_DIR = memoryRoot
  mkdirSync(path.join(projectRoot, '.caogen', 'skills', 'api-review'), { recursive: true })
  writeFileSync(
    path.join(projectRoot, '.caogen', 'skills', 'api-review', 'SKILL.md'),
    [
      '---',
      'name: API Review',
      'description: Review API contracts and compatibility.',
      'trigger: api review',
      'tags: api, review',
      '---',
      '',
      'Check request and response types.'
    ].join('\n'),
    'utf8'
  )

  compile([
    'src/main/openaiTools.ts',
    'src/main/permission/tool-permission.ts',
    'src/main/task/tool-idempotency.ts'
  ], outDir)
  const toolsModule = await import(pathToFileURL(findCompiled(outDir, 'openaiTools.js')).href)
  const permissions = await import(pathToFileURL(findCompiled(outDir, 'tool-permission.js')).href)
  const idempotency = await import(pathToFileURL(findCompiled(outDir, 'tool-idempotency.js')).href)
  const names = toolsModule.OPENAI_CODING_TOOLS.map((tool) => tool.function.name)
  for (const expected of [
    'task_decompose',
    'task_dispatch_dag',
    'task_decompose_and_dispatch_dag',
    'browser_navigate',
    'browser_click',
    'browser_automation_status',
    'list_skills',
    'load_skill',
    'run_skill',
    'memory_search',
    'memory_add',
    'mcp_discover',
    'mcp_call_tool',
    'mcp_builtin_servers',
    'mcp_import_claude_desktop'
  ]) {
    assert(names.includes(expected), `${expected} should be registered`)
  }

  const browserWithoutSession = await toolsModule.executeCodingTool('browser_click', { selector: '#submit' }, projectRoot)
  assertEqual(browserWithoutSession.ok, false)
  assert(browserWithoutSession.output.includes('sessionId'), 'browser tool should require sessionId')
  const browserStatus = await toolsModule.executeCodingTool('browser_automation_status', {}, projectRoot)
  assertEqual(browserStatus.ok, true)
  assert(browserStatus.output.includes('puppeteerCoreAvailable'), 'browser_automation_status should report puppeteer-core availability')

  const skills = await toolsModule.executeCodingTool(
    'list_skills',
    { query: 'api review', limit: 5 },
    projectRoot
  )
  assertEqual(skills.ok, true)
  assert(skills.output.includes('API Review'), 'list_skills should include project skill')

  const unconfirmedSkill = await toolsModule.executeCodingTool(
    'run_skill',
    { id: 'API Review' },
    projectRoot
  )
  assertEqual(unconfirmedSkill.ok, false)
  assert(unconfirmedSkill.output.includes('requiresConfirmation'), 'run_skill should require explicit confirmation')
  const confirmedSkill = await toolsModule.executeCodingTool(
    'run_skill',
    { id: 'API Review', confirmed: true, parameters: { scope: 'contracts' } },
    projectRoot
  )
  assertEqual(confirmedSkill.ok, true)
  assert(confirmedSkill.output.includes('confirmed'), 'run_skill should produce confirmed execution plan')

  const added = await toolsModule.executeCodingTool(
    'memory_add',
    {
      layer: 'project',
      title: 'P1 verification rule',
      body: 'P1 changes must report typecheck and deep-test results.',
      source: 'smoke',
      tags: ['p1', 'verify']
    },
    projectRoot
  )
  assertEqual(added.ok, true)
  assert(added.output.includes('"status": "draft"'), 'memory_add should create a pending Learning draft')
  assert(added.output.includes('"scope": "project"'), 'memory_add draft should disclose project scope')
  const searched = await toolsModule.executeCodingTool(
    'memory_search',
    { query: 'deep-test results', layers: ['project'], limit: 3 },
    projectRoot
  )
  assertEqual(searched.ok, true)
  assert(!searched.output.includes('P1 verification rule'), 'unapproved memory_add draft must not enter active search')

  const mcpMissingConfig = await toolsModule.executeCodingTool('mcp_discover', {}, projectRoot)
  assertEqual(mcpMissingConfig.ok, false)
  assert(mcpMissingConfig.output.includes('MCP'), 'mcp_discover should report missing config clearly')

  for (const toolName of ['mcp_discover', 'mcp_call_tool']) {
    const tool = toolsModule.OPENAI_CODING_TOOLS.find((item) => item.function.name === toolName)
    assert(tool, `${toolName} should be registered`)
    assert(!Object.hasOwn(tool.function.parameters.properties, 'env'), `${toolName} schema must not expose env`)
    assert(!Object.hasOwn(tool.function.parameters.properties, 'headers'), `${toolName} schema must not expose headers`)
    const legacy = await toolsModule.executeCodingTool(
      toolName,
      {
        command: process.execPath,
        env: { CAOGEN_MCP_SECRET_CANARY: 'must-not-be-accepted' },
        headers: { Authorization: 'Bearer must-not-be-accepted' },
        ...(toolName === 'mcp_call_tool' ? { toolName: 'echo', arguments: {} } : {})
      },
      projectRoot
    )
    assertEqual(legacy.ok, false)
    assert(legacy.output.includes('不允许传入 env 或 headers'), `${toolName} legacy secrets must fail closed`)
    assert(!legacy.output.includes('must-not-be-accepted'), `${toolName} failure output must not echo secret values`)
    assert(!legacy.output.includes('Authorization'), `${toolName} failure output must not echo header names`)
    assertEqual(
      permissions.classifyToolRisk(toolName, { command: process.execPath }, projectRoot).level,
      'high'
    )
  }
  assert(
    idempotency.requiresDuplicateConfirmation('mcp_call_tool', { toolName: 'write_remote' }),
    'repeated MCP tool calls must require confirmation because the remote effect can change'
  )

  const templates = await toolsModule.executeCodingTool('mcp_builtin_servers', {}, projectRoot)
  assertEqual(templates.ok, true)
  assert(templates.output.includes('filesystem'), 'mcp_builtin_servers should include filesystem template')

  assert(toolsModule.READONLY_TOOLS.has('task_decompose'), 'task_decompose should be readonly')
  assert(!toolsModule.READONLY_TOOLS.has('task_dispatch_dag'), 'task_dispatch_dag should require approval')
  assert(!toolsModule.READONLY_TOOLS.has('task_decompose_and_dispatch_dag'), 'combined DAG dispatch should require approval')
  for (const toolName of ['task_dispatch_dag', 'task_decompose_and_dispatch_dag']) {
    const tool = toolsModule.OPENAI_CODING_TOOLS.find((item) => item.function.name === toolName)
    assert(tool?.function.parameters?.properties?.taskTimeoutMs, `${toolName} should expose taskTimeoutMs`)
  }

  const missingSession = await toolsModule.executeCodingTool(
    'task_decompose',
    { request: '实现完整登录功能，含前端/后端/测试', useModel: false },
    projectRoot
  )
  assertEqual(missingSession.ok, false)
  assert(missingSession.output.includes('sessionId'), 'DAG tools should require sessionId')

  const importTool = toolsModule.OPENAI_CODING_TOOLS.find((item) => item.function.name === 'mcp_import_claude_desktop')
  assert(importTool, 'mcp_import_claude_desktop should be registered')
  assert(!Object.hasOwn(importTool.function.parameters.properties, 'configPath'), 'model schema must not expose configPath')
  const imported = await toolsModule.executeCodingTool(
    'mcp_import_claude_desktop',
    { configPath: path.join(tempRoot, 'claude_desktop_config.json') },
    projectRoot
  )
  assertEqual(imported.ok, false)
  assert(imported.output.includes('只读取系统默认配置位置'), 'legacy configPath must fail closed')

  console.log('openaiP1Tools smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile(files, outDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
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
  throw new Error(`compiled ${fileName} not found`)
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

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
