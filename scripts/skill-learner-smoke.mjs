import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-skill-learner-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  mkdirSync(outDir, { recursive: true })
  compile(
    [
      'src/main/skill/skill-loader.ts',
      'src/main/skill/skill-tester.ts',
      'src/main/skill/skill-learner.ts'
    ],
    outDir
  )

  const learnerModule = await import(pathToFileURL(findCompiled(outDir, 'skill-learner.js')).href)
  const testerModule = await import(pathToFileURL(findCompiled(outDir, 'skill-tester.js')).href)
  const { SkillLearner } = learnerModule
  const { SkillTester, testSkillMarkdown } = testerModule

  const learner = new SkillLearner({ defaultTags: ['p2', 'auto-skill'] })
  const draft = learner.draft({
    title: '自动 Skill 沉淀',
    taskSummary: [
      '从任务摘要生成 SKILL.md 草案。',
      '- 读取任务摘要和验证证据。',
      '- 输出可复用执行步骤。',
      '- 通过 smoke 与 TypeScript 严格检查。'
    ].join('\n'),
    tags: ['typescript', 'skill'],
    verification: ['node scripts/skill-learner-smoke.mjs']
  })

  assert(draft.ok, `generated draft should pass: ${JSON.stringify(draft.diagnostics)}`)
  assert(draft.markdown.includes('name: 自动 Skill 沉淀'), 'draft should include frontmatter name')
  assert(draft.markdown.includes('## 执行步骤'), 'draft should include steps section')
  assert(draft.markdown.includes('node scripts/skill-learner-smoke.mjs'), 'draft should include explicit verification')

  const tester = new SkillTester({ requireTrigger: true })
  const safeResult = tester.test(draft.markdown)
  assert(safeResult.ok, 'safe draft should pass tester')
  assert(safeResult.skill?.steps.length >= 2, 'parsed skill should expose steps')

  const unsafe = testSkillMarkdown([
    '---',
    'name: Unsafe',
    'description: Unsafe test',
    '---',
    '',
    '## 执行步骤',
    '- rm -rf /',
    '',
    '## 验证',
    '- echo done'
  ].join('\n'))
  assert(!unsafe.ok, 'dangerous command should fail static validation')
  assert(unsafe.diagnostics.some((item) => item.code === 'dangerous_command'), 'dangerous diagnostic should be reported')

  console.log('skillLearner smoke ok')
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
      '--esModuleInterop',
      '--strict'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiled(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled file not found: ${fileName}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
