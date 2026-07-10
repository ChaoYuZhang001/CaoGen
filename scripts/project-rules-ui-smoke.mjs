import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const esbuild = require('esbuild')
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-project-rules-ui-'))

try {
  const bundlePath = path.join(tempRoot, 'project-rule-draft.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src/renderer/src/pages/projectRuleDraft.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22'
  })

  const helper = require(bundlePath)
  const content = [
    '自定义前言必须保留',
    '',
    '# 项目提示词',
    '- 使用中文',
    '',
    '# 禁止修改目录',
    '- dist/',
    '',
    '# 自定义章节',
    '- 不应该丢失',
    ''
  ].join('\n')

  const draft = helper.parseProjectRuleDraft(content)
  assert(draft.prompt.includes('使用中文'), 'prompt section should parse')
  assert(draft.forbiddenPaths.includes('dist/'), 'forbidden paths section should parse')
  assert(draft.modelDispatch === '', 'missing model dispatch section should remain empty in draft')

  draft.modelDispatch = [
    '- 简单任务: premium/gpt-4o-mini',
    '- 复杂任务: provider=premium model=expensive-reasoner',
    '- 审查 / 复核任务: provider=premium model=gpt-4o-mini',
    '- 成本 / 速度 / 质量偏好: 成本优先'
  ].join('\n')
  draft.forbiddenPaths = ['- dist/', '- secrets/', '- .env'].join('\n')

  const merged = helper.mergeProjectRuleDraft(content, draft)
  assert(merged.includes('自定义前言必须保留'), 'merge should preserve preamble')
  assert(merged.includes('# 自定义章节'), 'merge should preserve unknown sections')
  assert(merged.includes('# 模型调度策略'), 'merge should append missing dispatch section')
  assert(merged.includes('provider=premium model=expensive-reasoner'), 'merge should write structured dispatch hints')
  assert(merged.includes('- secrets/'), 'merge should update forbidden paths')
  assert(merged.endsWith('\n'), 'merge should keep a trailing newline')

  const projectSettings = read('src/renderer/src/pages/ProjectSettings.tsx')
  assert(projectSettings.includes('PROJECT_RULE_SECTIONS'), 'ProjectSettings should render structured rule sections')
  assert(projectSettings.includes('mergeProjectRuleDraft'), 'ProjectSettings should merge structured rules into caogen.md content')
  assert(projectSettings.includes('parseProjectRuleDraft'), 'ProjectSettings should parse caogen.md into structured fields')
  assert(projectSettings.includes('同步并保存'), 'ProjectSettings should expose a structured save action')

  console.log('project rules ui smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function read(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8')
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
