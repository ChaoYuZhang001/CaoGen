import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-auto-skill-review-'))
const outDir = path.join(tempRoot, 'compiled')
const learningRoot = path.join(tempRoot, 'user-data', 'learning')
process.env.CAOGEN_USER_DATA_DIR = path.join(tempRoot, 'user-data')

try {
  mkdirSync(outDir, { recursive: true })
  compile(
    [
      'src/main/skill/skill-loader.ts',
      'src/main/skill/skill-tester.ts',
      'src/main/skill/skill-learner.ts',
      'src/main/skill/auto-skill-review.ts'
    ],
    outDir
  )

  const modulePath = findCompiled(outDir, 'auto-skill-review.js')
  const { runAutoSkillReview } = await import(pathToFileURL(modulePath).href)
  const lifecycle = await import(pathToFileURL(findCompiled(outDir, 'learning-lifecycle.js')).href)

  const projectRoot = path.join(tempRoot, 'project')
  const skillRoot = path.join(projectRoot, '.caogen', 'skills')
  mkdirSync(projectRoot, { recursive: true })

  const input = {
    meta: {
      id: 'session-auto-skill',
      title: '自动 Skill 沉淀闭环',
      cwd: projectRoot,
      model: '',
      providerId: '',
      permissionMode: 'default',
      status: 'idle',
      costUsd: 0,
      usage: { input: 10, output: 8, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 18,
      createdAt: Date.now()
    },
    transcript: [
      {
        seq: 1,
        event: {
          kind: 'user-message',
          text: [
            '实现任务完成后自动触发复盘、测试、存库。',
            '要求默认关闭，生成 Skill 先验证再写入本地库，失败不影响原任务。'
          ].join('\n')
        }
      },
      {
        seq: 2,
        event: {
          kind: 'assistant-message',
          blocks: [
            {
              type: 'text',
              text: [
                '已新增后台自动沉淀流程。',
                '- 读取会话完成事件和转录。',
                '- 生成 SKILL.md 草案。',
                '- 运行 SkillTester 静态校验。',
                '- 通过后原子写入项目 .caogen/skills。'
              ].join('\n')
            }
          ]
        }
      },
      {
        seq: 3,
        event: {
          kind: 'tool-result',
          toolUseId: 'verify',
          content: 'node scripts/auto-skill-review-smoke.mjs PASS',
          isError: false
        }
      }
    ],
    event: {
      kind: 'turn-result',
      subtype: 'success',
      isError: false,
      resultText: 'DONE: smoke 通过，自动 Skill 已验证后写入。',
      durationMs: 1200
    }
  }

  const disabled = await runAutoSkillReview(input, { enabled: false })
  assert(disabled.status === 'disabled', 'disabled mode should skip work')
  assert(!existsSync(skillRoot), 'disabled mode should not create skill root')

  const drafted = await runAutoSkillReview(input, { enabled: true })
  assert(drafted.status === 'drafted', `enabled mode should create a draft: ${JSON.stringify(drafted)}`)
  assert(drafted.path?.startsWith(skillRoot), 'planned materialization path should stay under project skill root')
  assert(!existsSync(drafted.path), 'unapproved auto Skill draft must not create SKILL.md')
  const snapshot = await lifecycle.listLearningProject(projectRoot, learningRoot)
  const record = snapshot.drafts.find((item) => item.id === drafted.draftId)
  assert(record?.kind === 'skill' && record.payload.type === 'skill', 'auto review Skill draft must be persisted')
  const markdown = record.payload.markdown
  assert(markdown.includes('---\n#'), 'draft skill frontmatter must be separated from body')
  assert(markdown.includes('name: 自动 Skill 沉淀闭环'), 'draft skill should include title')
  assert(markdown.includes('## 验证'), 'draft skill should include verification section')

  let escaped = false
  try {
    await runAutoSkillReview(input, { enabled: true, skillRoot: path.join(projectRoot, '..', 'escape') })
  } catch {
    escaped = true
  }
  assert(escaped, 'skillRoot outside .caogen/skills should be rejected')

  const tooSmall = await runAutoSkillReview(
    { ...input, transcript: [], event: { ...input.event, resultText: '' } },
    { enabled: true }
  )
  assert(tooSmall.status === 'skipped', 'insufficient transcript should not write a skill')

  assertRuntimeWiring()

  console.log('autoSkillReview smoke ok')
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
  const found = findCompiledOptional(root, fileName)
  if (found) return found
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertRuntimeWiring() {
  const sessionManager = read('src/main/sessionManager.ts')
  assert(sessionManager.includes("import { scheduleAutoSkillReview } from './skill/auto-skill-review'"), 'session manager must import auto skill scheduler')
  assert(sessionManager.includes('this.handleAutoSkillReview(sessionId, event)'), 'session manager must call auto skill hook for events')
  assert(sessionManager.includes('private handleAutoSkillReview'), 'session manager auto skill hook missing')
  assert(sessionManager.includes("event.kind !== 'turn-result' || event.isError"), 'auto skill hook must ignore failed/non-turn events')
  assert(sessionManager.includes('session.getTranscript()'), 'auto skill hook must pass full transcript')
  assert(sessionManager.includes('getSettings().autoSkillLearningEnabled'), 'auto skill hook must honor default-off setting')
  assert(sessionManager.includes('session.meta.parentSessionId || session.meta.childRole'), 'auto skill hook must skip child review/arbitration sessions')

  const agentSession = read('src/main/agentSession.ts')
  assert(agentSession.includes('prepareClaudeUserMessage'), 'Claude/session path must use the shared message preparation boundary')

  const claudeUserMessage = read('src/main/claude-user-message.ts')
  assert(claudeUserMessage.includes('buildSkillInvocationPrompt'), 'Claude/session path must inject learned skills')
  assert(claudeUserMessage.includes('autoSkillLearningEnabled'), 'Claude/session path must honor skill invocation setting')

  const openaiEngine = read('src/main/openaiEngine.ts')
  assert(openaiEngine.includes('buildSkillInvocationPrompt'), 'OpenAI path must inject learned skills')
  assert(openaiEngine.includes('autoSkillLearningEnabled'), 'OpenAI path must honor skill invocation setting')

  const settings = read('src/main/settings.ts')
  assert(settings.includes('autoSkillLearningEnabled: false'), 'auto skill learning must default off')
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}
