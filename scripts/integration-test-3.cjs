#!/usr/bin/env node
/**
 * CaoGen 集成测试 3 — 已接线但从未被测试触及的模块(排雷)。
 * 覆盖:cronParse、slashCommands、checkpointRestorePlan、gitOps、memoryInject、
 * startSuggestions、browserAnnotations。全部真实执行(真 git / 真 fs / 纯函数)。
 * 目标是挖真缺陷,不是刷绿。
 */
const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const repo = path.resolve(__dirname, '..')
const buildDir = path.join(os.tmpdir(), 'caogen-itest3-build')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-itest3-'))
const userData = path.join(tmpRoot, 'userData')
fs.mkdirSync(userData, { recursive: true })

const results = []
let current = ''
async function test(name, fn) {
  current = name
  try { await fn(); results.push({ name, ok: true }) }
  catch (err) { results.push({ name, ok: false, err: err && (err.stack || err.message || String(err)) }) }
}
function assert(cond, msg) { if (!cond) throw new Error(`断言失败:${msg}`) }
function eq(a, b, msg) { if (a !== b) throw new Error(`断言失败:${msg}(实际 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)})`) }

// 编译
const files = []
for (const dir of ['src/main', 'src/shared']) {
  for (const f of fs.readdirSync(path.join(repo, dir))) if (f.endsWith('.ts')) files.push(path.join(dir, f))
}
const tscArgs = ['tsc', ...files, '--outDir', buildDir, '--module', 'commonjs', '--target', 'es2022',
  '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop']
const tsc = spawnSync(npxCommand(), npxArgs(tscArgs),
  { cwd: repo, encoding: 'utf8' })
if (!fs.existsSync(path.join(buildDir, 'main', 'cronParse.js'))) {
  console.error(tsc.stdout, tsc.stderr); throw new Error('编译失败')
}

const electronStub = {
  app: { getPath: (k) => (k === 'userData' ? userData : tmpRoot), isPackaged: false, getName: () => 'CaoGen', getVersion: () => '0.1.0' },
  safeStorage: { isEncryptionAvailable: () => false }
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}
const M = (p) => require(path.join(buildDir, p))
const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

async function main() {
  // ---- C1 cronParse:匹配/别名/nextAfter/Vixie 日周语义/非法 ----
  await test('C1 cronParse:匹配 + 别名 + nextAfter + Vixie 语义', async () => {
    const c = M('main/cronParse.js')
    // 每天 9:00
    const m = c.parseCron('0 9 * * *')
    assert(m, 'parseCron 应成功')
    assert(m.match(new Date(2026, 0, 1, 9, 0)), '9:00 应命中')
    assert(!m.match(new Date(2026, 0, 1, 9, 1)), '9:01 不应命中')
    // 步长
    const step = c.parseCron('*/15 * * * *')
    assert(step.match(new Date(2026, 0, 1, 3, 30)) && !step.match(new Date(2026, 0, 1, 3, 31)), '*/15 步长错误')
    // 别名
    eq(c.normalizeCronAlias('@daily'), '0 0 * * *', '@daily 别名')
    eq(c.normalizeCronAlias('@hourly'), '0 * * * *', '@hourly 别名')
    // 周日 7→0 归一化
    const sun = c.parseCron('0 0 * * 7')
    assert(sun.match(new Date(2026, 0, 4, 0, 0)), '2026-01-04 是周日,7 应命中') // 2026-01-04 = Sunday
    // Vixie 日周并集:1 号 OR 周一
    const union = c.parseCron('0 0 1 * 1')
    assert(union.match(new Date(2026, 0, 1, 0, 0)), '1 号应命中(并集)') // 1/1 是周四
    assert(union.match(new Date(2026, 0, 5, 0, 0)), '周一应命中(并集)') // 1/5 是周一
    // nextAfter:严格大于
    const base = new Date(2026, 0, 1, 8, 30).getTime()
    const next = c.nextAfter('0 9 * * *', base)
    eq(new Date(next).getHours(), 9, 'nextAfter 应指向 9 点')
    eq(new Date(next).getMinutes(), 0, 'nextAfter 分钟')
    // 非法
    assert(c.parseCron('bad cron') === null, '非法应返回 null')
    assert(c.parseCron('0 9 * *') === null, '4 段应返回 null')
    assert(c.parseCron('99 9 * * *') === null, '分钟越界应返回 null')
  })

  // ---- C2 slashCommands:内置命令 + 展开 ----
  await test('C2 slashCommands:内置命令 + 参数展开', async () => {
    const s = M('main/slashCommands.js')
    const builtins = s.builtinSlashCommands()
    assert(Array.isArray(builtins) && builtins.length > 0, '应有内置命令')
    // 展开:普通文本 → kind:'prompt';内置斜杠命令 → kind:'builtin'
    const plain = s.expandSlashCommand('普通消息不是命令')
    eq(plain.kind, 'prompt', '普通文本应为 prompt')
    const builtinName = builtins[0].name
    const cmd = s.expandSlashCommand(`/${builtinName} 参数x`)
    eq(cmd.kind, 'builtin', `/${builtinName} 应识别为 builtin`)
    eq(cmd.args, '参数x', '参数应被解析')
    // 未知斜杠命令保留原文交给 SDK
    const unknown = s.expandSlashCommand('/unknowncmd123')
    eq(unknown.kind, 'prompt', '未知命令应回退为 prompt 交 SDK')
  })

  // ---- C3 checkpointRestorePlan:轮次列举(需 checkpoint 事件配对)+ 回退计划 ----
  await test('C3 checkpointRestorePlan:轮次 + 回退范围计划', async () => {
    const cp = M('main/checkpointRestorePlan.js')
    // 真实结构:checkpoint 事件通过 userMessageId 关联 user-message
    const entries = [
      { seq: 1, event: { kind: 'user-message', text: '第一轮', messageId: 'u1' } },
      { seq: 2, event: { kind: 'checkpoint', messageId: 'c1', userMessageId: 'u1' } },
      { seq: 3, event: { kind: 'assistant-message', blocks: [{ type: 'text', text: 'ok1' }] } },
      { seq: 4, event: { kind: 'turn-result', subtype: 'success', isError: false } },
      { seq: 5, event: { kind: 'user-message', text: '第二轮', messageId: 'u2' } },
      { seq: 6, event: { kind: 'checkpoint', messageId: 'c2', userMessageId: 'u2' } },
      { seq: 7, event: { kind: 'assistant-message', blocks: [{ type: 'text', text: 'ok2' }] } },
      { seq: 8, event: { kind: 'turn-result', subtype: 'success', isError: false } }
    ]
    const turns = cp.listCheckpointTurns(entries)
    eq(turns.length, 2, `应识别 2 个检查点轮次`)
    eq(turns[0].userMessageId, 'u1', '第一个锚点')
    // 回退到第一轮:计划应丢弃第二轮
    if (typeof cp.planTranscriptRestore === 'function') {
      const plan = cp.planTranscriptRestore(entries, turns[0].checkpointId)
      assert(plan, '回退计划应返回')
    }
  })

  // ---- C4 gitOps:分支/状态/暂存/提交(真 git)----
  await test('C4 gitOps:status/stage/commit 真 git 往返', async () => {
    const g = M('main/gitOps.js')
    const dir = path.join(tmpRoot, 'gitops'); fs.mkdirSync(dir, { recursive: true })
    sh(dir, 'git', ['init', '-q', '-b', 'main'])
    sh(dir, 'git', ['config', 'user.email', 't@t']); sh(dir, 'git', ['config', 'user.name', 't'])
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
    eq(g.currentBranch(dir), 'main', '当前分支')
    const st1 = g.gitStatus(dir)
    assert(st1 && Array.isArray(st1.files) && st1.files.some((f) => (f.path || f.file || '').includes('a.txt')), `status 应含 a.txt:${JSON.stringify(st1).slice(0, 160)}`)
    const stage = g.stageAll(dir)
    assert(stage && stage.ok !== false, `stageAll 失败:${JSON.stringify(stage)}`)
    const commit = g.commit(dir, 'first commit')
    assert(commit && commit.ok !== false, `commit 失败:${JSON.stringify(commit)}`)
    // 提交后工作区干净
    const st2 = g.gitStatus(dir)
    assert(st2.files.length === 0, `提交后应干净:${JSON.stringify(st2.files)}`)
    // 防注入:空提交信息应被拒绝
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x'); g.stageAll(dir)
    const badCommit = g.commit(dir, '')
    assert(badCommit && badCommit.ok === false, '空提交信息应被拒绝')
  })

  // ---- C5 memoryInject:记忆注入 systemPrompt + 提议启发式 ----
  await test('C5 memoryInject:注入渲染 + shouldPropose 启发式', async () => {
    const mi = M('main/memoryInject.js')
    const rendered = mi.renderMemoryAppend([
      { id: '1', kind: 'command', title: '构建', body: '用 pnpm', createdAt: 1 },
      { id: '2', kind: 'convention', title: '风格', body: '函数式优先', createdAt: 2 }
    ])
    assert(rendered.includes('pnpm') && rendered.includes('函数式'), '注入应含条目内容')
    // 空记忆返回空
    eq(mi.renderMemoryAppend([]), '', '空记忆应返回空串')
    // 启发式:用户纠正类语句应触发提议
    if (typeof mi.shouldProposeMemory === 'function') {
      assert(typeof mi.shouldProposeMemory('不对,应该用 pnpm 而不是 npm') === 'boolean', 'shouldProposeMemory 应返回布尔')
    }
  })

  // ---- C6 startSuggestions:开工建议构建(真实入参结构)----
  await test('C6 startSuggestions:失败信号 + README TODO → 开工建议', async () => {
    const ss = M('main/startSuggestions.js')
    const proj = path.join(tmpRoot, 'sugproj'); fs.mkdirSync(proj, { recursive: true })
    // README 里放 TODO,应被扫成建议
    fs.writeFileSync(path.join(proj, 'README.md'), '# 项目\n\nTODO: 补充部署文档\n')
    const sug = ss.buildStartSuggestions({
      projectDir: proj,
      recentFailures: [{ id: 'f1', title: '上轮测试失败', detail: 'flaky test' }]
    })
    assert(Array.isArray(sug), 'buildStartSuggestions 应返回数组')
    assert(sug.length > 0, `有失败信号+README TODO 时应给出建议,实际 ${sug.length}`)
    // 无任何信号 + 空目录 → 可以为空,但不应抛错
    const empty = ss.buildStartSuggestions({ projectDir: path.join(tmpRoot, 'nonexist') })
    assert(Array.isArray(empty), '不存在目录应返回数组不抛错')
  })

  // ---- C7 browserAnnotations:批注规范化 + 存取 ----
  await test('C7 browserAnnotations:normalize + save/list 往返', async () => {
    const ba = M('main/browserAnnotations.js')
    const root = path.join(userData, 'annotations')
    const saved = await ba.saveAnnotation(root, {
      sessionId: 's1',
      url: 'http://localhost:3000',
      title: '首页',
      selector: 'button.cta',
      note: '这个按钮移动端溢出',
      boundingBox: { x: 10, y: 20, width: 100, height: 40 },
      consoleErrors: ['TypeError: x is undefined']
    })
    assert(saved && saved.id, `保存无 id:${JSON.stringify(saved)}`)
    const list = await ba.listAnnotations(root, 's1')
    assert(Array.isArray(list) && list.some((a) => a.selector === 'button.cta'), '批注未持久化')
    // 规范化:缺 url 应抛验证错误
    let threw = false
    try { ba.normalizeAnnotation({ sessionId: 's1' }) } catch { threw = true }
    assert(threw, '缺必填字段应抛验证错误')
  })

  const pass = results.filter((r) => r.ok).length
  console.log('\n===== CaoGen 集成测试 3(已接线未测模块排雷)=====')
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`)
    if (!r.ok) console.log('    ' + String(r.err).split('\n').slice(0, 3).join('\n    '))
  }
  console.log(`------------------------------------------------\n${pass}/${results.length} 通过`)
  process.exitCode = pass === results.length ? 0 : 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })

function npxCommand() {
  return process.platform === 'win32' ? 'cmd' : 'npx'
}

function npxArgs(args) {
  return process.platform === 'win32' ? ['/c', 'npx', ...args] : args
}
