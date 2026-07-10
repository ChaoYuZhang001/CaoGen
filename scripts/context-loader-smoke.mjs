import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const esbuild = require('esbuild')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-context-loader-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')

try {
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: 'context-smoke',
        scripts: { dev: 'vite', build: 'tsc && vite build', test: 'vitest run' },
        dependencies: { react: '^18.3.1' },
        devDependencies: { typescript: '^5.7.2', vite: '^6.0.0' }
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(path.join(projectDir, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8')
  writeFileSync(path.join(projectDir, 'README.md'), '# README fallback\n', 'utf8')
  writeFileSync(path.join(projectDir, '.caogen.md'), '# 项目概述\n来自 dotfile\n', 'utf8')
  writeFileSync(
    path.join(projectDir, 'caogen.md'),
    [
      '# 项目概述',
      '技术栈: React + TypeScript',
      '# 代码规范',
      '- 禁止 any',
      '# 常用命令',
      '- test: npm test',
      '# 测试要求',
      '- smoke 必须通过',
      '# 注意事项',
      '- 不要改生成文件',
      ''
    ].join('\n'),
    'utf8'
  )

  const bundlePath = path.join(outDir, 'context-loader.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src/main/agent/context-loader.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
  })

  const loader = require(bundlePath)
  const nestedRoot = path.join(projectDir, 'src')
  const read = loader.readProjectContext(nestedRoot)
  assertEqual(read.projectRoot, projectDir)
  assertEqual(read.source.fileName, 'caogen.md')
  assert(read.content.includes('禁止 any'), 'caogen.md content should be loaded first')
  assert(read.detected.techStack.includes('React'), 'React should be detected')
  assert(read.detected.techStack.includes('TypeScript'), 'TypeScript should be detected')
  assert(read.detected.packageManager === 'npm', 'package-lock should infer npm')
  assert(read.prompt.includes('# 项目身份'), 'prompt should include project identity')
  assert(read.prompt.includes(`项目根目录: ${projectDir}`), 'project identity should include resolved root')
  assert(read.prompt.includes('项目规则文件: caogen.md'), 'project identity should include active project rules file')
  assert(read.prompt.indexOf('# 项目永久上下文') < read.prompt.indexOf('# 自动识别项目栈'))
  assert(read.prompt.includes('build: tsc && vite build'), 'scripts should be injected')

  const template = loader.generateProjectContextTemplate(projectDir)
  for (const section of [
    '# 项目提示词',
    '# 项目背景',
    '# 技术栈与架构',
    '# 代码规范',
    '# 常用命令',
    '# 测试命令',
    '# 构建命令',
    '# 禁止修改目录',
    '# 工作区隔离策略',
    '# 模型调度策略',
    '# 项目记忆',
    '# 历史决策',
    '# 交付验收'
  ]) {
    assert(template.includes(section), `template should include ${section}`)
  }

  rmSync(path.join(projectDir, 'caogen.md'), { force: true })
  const dotRead = loader.readProjectContext(projectDir)
  assertEqual(dotRead.source.fileName, '.caogen.md')
  rmSync(path.join(projectDir, '.caogen.md'), { force: true })
  const readmeRead = loader.readProjectContext(projectDir)
  assertEqual(readmeRead.source.fileName, 'README.md')

  const saved = loader.writeProjectContext(projectDir, '# 项目概述\n保存后的上下文\n')
  assertEqual(saved.source.fileName, 'caogen.md')
  assert(readFileSync(path.join(projectDir, 'caogen.md'), 'utf8').includes('保存后的上下文'))
  assert(loader.buildProjectContextSystemAppendSync(projectDir).includes('保存后的上下文'))
  const scopedPrompt = loader.buildProjectScopedPromptSync(projectDir, '实现登录流程')
  assert(scopedPrompt.includes('# CaoGen 项目规则'), 'scoped prompt should include project rules heading')
  assert(scopedPrompt.includes('保存后的上下文'), 'scoped prompt should include caogen.md content')
  assert(scopedPrompt.includes('# 当前用户请求'), 'scoped prompt should include user request heading')
  assert(scopedPrompt.includes('实现登录流程'), 'scoped prompt should preserve user request')
  const otherProjectDir = path.join(tempRoot, 'other-project')
  mkdirSync(otherProjectDir, { recursive: true })
  writeFileSync(path.join(otherProjectDir, 'caogen.md'), '# 项目提示词\n只允许改文档\n', 'utf8')
  const otherScopedPrompt = loader.buildProjectScopedPromptSync(otherProjectDir, '更新说明')
  assert(otherScopedPrompt.includes('只允许改文档'), 'different projects should inject different rules')
  assert(!otherScopedPrompt.includes('保存后的上下文'), 'project rules should not leak between projects')
  const projectDispatchA = path.join(tempRoot, 'project-dispatch-a')
  const projectDispatchB = path.join(tempRoot, 'project-dispatch-b')
  const projectDispatchC = path.join(tempRoot, 'project-dispatch-c')
  mkdirSync(projectDispatchA, { recursive: true })
  mkdirSync(projectDispatchB, { recursive: true })
  mkdirSync(projectDispatchC, { recursive: true })
  writeFileSync(
    path.join(projectDispatchA, 'caogen.md'),
    [
      '# 模型调度策略',
      '- 成本 / 速度 / 质量偏好: 成本优先',
      '- 简单任务: provider=premium model=gpt-4o-mini',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    path.join(projectDispatchB, 'caogen.md'),
    [
      '# 模型调度策略',
      '- 成本 / 速度 / 质量偏好: 质量优先',
      '- 简单任务: provider=deepseek-official model=deepseek-chat',
      ''
    ].join('\n'),
    'utf8'
  )
  writeFileSync(
    path.join(projectDispatchC, 'caogen.md'),
    [
      '# 模型调度策略',
      '- 成本 / 速度 / 质量偏好: 速度优先',
      '- 简单任务: provider=deepseek-official model=deepseek-chat',
      ''
    ].join('\n'),
    'utf8'
  )
  const dispatchA = loader.readProjectModelDispatchHintsSync(projectDispatchA)
  const dispatchB = loader.readProjectModelDispatchHintsSync(projectDispatchB)
  const dispatchC = loader.readProjectModelDispatchHintsSync(projectDispatchC)
  assertEqual(dispatchA.strategy, 'cost')
  assertEqual(dispatchA.lowCost.providerId, 'premium')
  assertEqual(dispatchA.lowCost.model, 'gpt-4o-mini')
  assertEqual(dispatchB.strategy, 'quality')
  assertEqual(dispatchB.lowCost.providerId, 'deepseek-official')
  assertEqual(dispatchB.lowCost.model, 'deepseek-chat')
  assertEqual(dispatchC.strategy, 'speed')
  assert(dispatchC.strategy !== 'balanced', 'project speed-first strategy must not collapse into balanced')
  assert(dispatchB.lowCost.providerId !== dispatchA.lowCost.providerId, 'project dispatch hints should not leak across projects')
  const emptyProjectDir = path.join(tempRoot, 'empty-project')
  mkdirSync(emptyProjectDir, { recursive: true })
  const emptyRead = loader.readProjectContext(emptyProjectDir)
  assertEqual(emptyRead.projectRoot, emptyProjectDir)
  assert(!emptyRead.source, 'empty project should not pretend to have a rules file')
  assert(emptyRead.prompt.includes('# 项目身份'), 'empty project should still inject project identity')
  assert(
    emptyRead.prompt.includes('项目规则文件: 未找到 caogen.md/.caogen.md'),
    'empty project should explain missing project rules'
  )
  const emptyScopedPrompt = loader.buildProjectScopedPromptSync(emptyProjectDir, '整理资料')
  assert(emptyScopedPrompt.includes('项目根目录:'), 'empty project scoped prompt should include project root')
  assert(emptyScopedPrompt.includes('整理资料'), 'empty project scoped prompt should preserve user request')
  assert(!emptyScopedPrompt.includes('只允许改文档'), 'empty project should not leak other project rules')
  assert(existsSync(path.join(projectDir, 'caogen.md')), 'caogen.md should be written')
  assertSourceContains('src/main/agentSession.ts', [
    'buildProjectContextSystemAppend',
    '[projectContextAppend, persona, memoryAppend]',
    '# 项目上下文已更新'
  ])
  assertSourceContains('src/main/openaiEngine.ts', [
    'buildProjectContextSystemAppendSync',
    'const projectContext = buildProjectContextSystemAppendSync',
    'projectContext',
    'instructions',
    'String(this.systemMessage().content'
  ])
  assertSourceContains('scripts/openai-mock-e2e.mjs', [
    'projectContextNeedle',
    'caogen.md context missing from Responses instructions'
  ])
  assertSourceContains('src/renderer/src/pages/ProjectSettings.tsx', [
    'void load(defaultPath)',
    '[defaultPath]'
  ])
  assertSourceContains('src/main/ipc.ts', [
    "projectContext:read",
    "projectContext:write",
    "projectContext:template"
  ])
  assertSourceContains('src/preload/index.ts', [
    'readProjectContext',
    'writeProjectContext',
    'generateProjectContextTemplate'
  ])
  assertSourceContains('src/renderer/src/components/SettingsModal.tsx', [
    "type Tab = 'control' | 'general' | 'permissions' | 'project'",
    '<ProjectSettings />'
  ])

  console.log('context-loader smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function assertSourceContains(relPath, needles) {
  const text = readFileSync(path.join(repoRoot, relPath), 'utf8')
  for (const needle of needles) {
    assert(text.includes(needle), `${relPath} should contain ${needle}`)
  }
}
