import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
mkdirSync(path.join(repoRoot, 'test-results'), { recursive: true })
const tempRoot = mkdtempSync(path.join(repoRoot, 'test-results', 'caogen-openai-p2-tools-'))
const outDir = path.join(tempRoot, 'compiled')
const projectRoot = path.join(tempRoot, 'project')

try {
  mkdirSync(projectRoot, { recursive: true })
  compile(['src/main/openaiTools.ts'], outDir)
  const toolsModule = await import(pathToFileURL(findCompiled(outDir, 'openaiTools.js')).href)
  const names = toolsModule.OPENAI_CODING_TOOLS.map((tool) => tool.function.name)
  for (const expected of ['draft_skill', 'optimize_skill', 'route_model', 'china_notify', 'gitee_prepare']) {
    assert(names.includes(expected), `${expected} should be registered`)
  }
  assert(toolsModule.READONLY_TOOLS.has('draft_skill'), 'draft_skill should be readonly')
  assert(toolsModule.READONLY_TOOLS.has('route_model'), 'route_model should be readonly')
  assert(!toolsModule.READONLY_TOOLS.has('optimize_skill'), 'optimize_skill writes project skill state and must not be readonly')

  const draft = await toolsModule.executeCodingTool(
    'draft_skill',
    {
      title: 'Tailwind 配置沉淀',
      taskSummary: '读取现有 Tailwind 配置，按项目约定补齐内容，并运行 typecheck 验证。',
      verification: ['npm.cmd run typecheck']
    },
    projectRoot
  )
  assertEqual(draft.ok, true)
  assert(draft.output.includes('SKILL.md') || draft.output.includes('markdown'), 'draft_skill should return a draft payload')

  const skillDir = path.join(projectRoot, '.caogen', 'skills', 'tailwind-config')
  mkdirSync(skillDir, { recursive: true })
  const skillPath = path.join(skillDir, 'SKILL.md')
  writeFileSync(
    skillPath,
    [
      '---',
      'name: Tailwind 配置沉淀',
      'description: Repair Tailwind setup in this project.',
      'trigger: tailwind config styles',
      'tags: [tailwind, frontend]',
      '---',
      '',
      '# Tailwind 配置沉淀',
      '',
      '## 执行步骤',
      '1. 检查 package.json。',
      '2. 更新 Tailwind 配置。',
      '',
      '## 验证',
      '1. npm.cmd run typecheck'
    ].join('\n'),
    'utf8'
  )
  const optimized = await toolsModule.executeCodingTool(
    'optimize_skill',
    {
      id: 'Tailwind 配置沉淀',
      outcome: 'corrected',
      summary: '用户修正: 需要同步检查 postcss.config.js,否则样式未生效。',
      correctionSteps: ['同步检查 postcss.config.js 是否加载 tailwindcss。'],
      verification: ['npm.cmd run build']
    },
    projectRoot
  )
  assertEqual(optimized.ok, true)
  assert(optimized.output.includes('"status": "updated"'), 'optimize_skill should update project skill after correction')
  assert(readFileSync(skillPath, 'utf8').includes('自动优化记录'), 'optimized skill should include optimization section')

  const routed = await toolsModule.executeCodingTool(
    'route_model',
    {
      prompt: '审查高风险 TypeScript 变更并给出修复建议',
      requestedTasks: ['review', 'reasoning'],
      strategy: 'balanced',
      crossValidation: true,
      providers: [
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
        { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com', models: ['gpt-4o-mini'] }
      ]
    },
    projectRoot
  )
  assertEqual(routed.ok, true)
  assert(routed.output.includes('crossValidationPlan'), 'route_model should return cross validation plan')

  const notify = await toolsModule.executeCodingTool(
    'china_notify',
    { channel: 'feishu', title: 'P2 smoke', text: 'dry-run only' },
    projectRoot
  )
  assertEqual(notify.ok, true)
  assert(notify.output.includes('"dryRun": true'), 'china_notify should default to dry-run')

  const gitee = await toolsModule.executeCodingTool(
    'gitee_prepare',
    {
      action: 'issue',
      owner: 'org',
      repo: 'repo',
      title: 'P2 smoke',
      labels: ['p2'],
      baseApiUrl: 'https://gitee.example.test/api/v5',
      webBaseUrl: 'https://gitee.example.test'
    },
    projectRoot
  )
  assertEqual(gitee.ok, true)
  assert(gitee.output.includes('gitee.example.test/org/repo/issues/new'), 'gitee_prepare should return a custom web URL')
  assert(gitee.output.includes('gitee.example.test/api/v5/repos/org/repo/issues'), 'gitee_prepare should return a custom API URL')

  console.log('openaiP2Tools smoke ok')
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
  const found = findCompiledOptional(root, fileName)
  if (!found) throw new Error(`compiled ${fileName} not found`)
  return found
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
