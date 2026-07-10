#!/usr/bin/env node
/**
 * CaoGen 集成测试(无 GUI、无需 API Key,macOS / Linux 通用)
 *
 * 原则:能真实执行的一律真实执行 ——
 *   真 git 仓库、真文件系统、真 HTTP 服务器、真编译后的核心模块;
 *   仅 electron(GUI 宿主)与 Agent SDK(需外部子进程/API)以受控替身注入,
 *   从而可以主动注入 429/崩溃 等故障,验证故障切换等状态机的真实行为。
 *
 * 用法:node scripts/integration-test.cjs
 */
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const Module = require('node:module')

const repo = path.resolve(__dirname, '..')
process.env.NODE_PATH = [path.join(repo, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
Module._initPaths()
const buildDir = path.join(os.tmpdir(), 'caogen-itest-build')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-itest-'))
const userData = path.join(tmpRoot, 'userData')
fs.mkdirSync(userData, { recursive: true })
const fakeWindows = []
const ipcHandlers = new Map()
let fakeBrowserSelection = null
let fakeBrowserScreenshot = null

// ---------------------------------------------------------------- 断言与汇总
const results = []
let current = ''
function test(name, fn) {
  current = name
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((err) => results.push({ name, ok: false, err: err && (err.stack || err.message || String(err)) }))
}
function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败:${msg}`)
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`断言失败:${msg}(实际 ${JSON.stringify(a)} ≠ 期望 ${JSON.stringify(b)})`)
}
function waitFor(pred, ms = 3000, tag = '') {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (pred()) return resolve(undefined)
      } catch (e) {
        return reject(e)
      }
      if (Date.now() - start > ms) return reject(new Error(`waitFor 超时:${tag || current}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

// ---------------------------------------------------------------- 1. 编译
console.log('[itest] 编译 src/main + src/shared + store …')
const files = []
for (const dir of ['src/main', 'src/shared']) {
  for (const f of fs.readdirSync(path.join(repo, dir))) {
    if (f.endsWith('.ts')) files.push(path.join(dir, f))
  }
}
files.push('src/renderer/src/store.ts')
files.push('src/renderer/src/components/office/model.ts')
const tscArgs = ['tsc', ...files, '--outDir', buildDir, '--module', 'commonjs', '--target', 'es2022',
  '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop']
const tsc = spawnSync(
  npxCommand(),
  npxArgs(tscArgs),
  { cwd: repo, encoding: 'utf8' }
)
if (!fs.existsSync(path.join(buildDir, 'main', 'agentSession.js'))) {
  console.error(tsc.stdout, tsc.stderr)
  throw new Error('tsc 编译失败,无产物')
}

// ---------------------------------------------------------------- 2. 替身注入
const notifications = []
const powerBlockerState = { next: 0, starts: 0, stops: 0, active: new Set() }
const electronStub = {
  app: {
    getPath: (k) => (k === 'userData' ? userData : tmpRoot),
    isPackaged: false,
    setName() {},
    setPath() {},
    getName: () => 'CaoGen-iTest'
  },
  safeStorage: { isEncryptionAvailable: () => false },
  powerSaveBlocker: {
    start() {
      const id = ++powerBlockerState.next
      powerBlockerState.starts += 1
      powerBlockerState.active.add(id)
      return id
    },
    stop(id) {
      if (powerBlockerState.active.delete(id)) powerBlockerState.stops += 1
    },
    isStarted: (id) => powerBlockerState.active.has(id)
  },
  Notification: class {
    constructor(opts) { this.opts = opts }
    on() {}
    once() {}
    show() { notifications.push(this.opts) }
    static isSupported() { return true }
  },
  BrowserWindow: {
    getAllWindows: () => fakeWindows,
    fromWebContents: (sender) => sender && sender.__owner ? sender.__owner : null
  },
  WebContentsView: class {
    constructor() {
      this._bounds = { x: 0, y: 0, width: 0, height: 0 }
      this.webContents = {
        setWindowOpenHandler() {},
        on() {},
        loadURL: async (url) => { this._url = url },
        getURL: () => this._url || 'about:blank',
        getTitle: () => 'Mock page',
        isLoading: () => false,
        isDestroyed: () => false,
        close() {},
        reload() {},
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
        executeJavaScript: async () => fakeBrowserSelection ?? {},
        capturePage: async () => fakeBrowserScreenshot ?? mockNativeImage(false)
      }
    }
    setBounds(bounds) { this._bounds = { ...bounds } }
    getBounds() { return { ...this._bounds } }
  },
  ipcMain: { handle(name, fn) { ipcHandlers.set(name, fn) } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder() {}, openExternal: async () => {} }
}

function mockNativeImage(empty) {
  return {
    isEmpty: () => empty,
    toPNG: () => Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  }
}

// mock SDK:行为由 env.ANTHROPIC_BASE_URL 控制
//   含 always429 → 每轮返回 429 错误 result
//   含 slow429  → 延迟 80ms 后返回 429(给 interrupt 留时序窗口)
//   含 crashmid → 第一轮消息后流抛异常(模拟进程崩溃)
//   其余(含未设置 BASE_URL)→ 正常成功轮
const sdkLog = []
function mockQuery({ prompt, options }) {
  const base = (options && options.env && options.env.ANTHROPIC_BASE_URL) || ''
  const sessionId = 'mock-' + Math.random().toString(36).slice(2, 10)
  let closed = false
  sdkLog.push({
    create: base,
    model: options && options.model,
    resume: options && options.resume,
    resumeSessionAt: options && options.resumeSessionAt,
    agents: options && options.agents ? Object.keys(options.agents) : []
  })
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: sessionId, model: (options && options.model) || 'mock-default', tools: ['Bash'] }
      for await (const user of prompt) {
        if (closed) return
        const blocks = (user && user.message && user.message.content) || []
        const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
        sdkLog.push({ promptText: text, sessionId })
        yield { type: 'user', uuid: 'u-' + Math.random().toString(36).slice(2, 10), message: { content: blocks } }
        if (base.includes('slow429')) await new Promise((r) => setTimeout(r, 80))
        if (text.includes('force-failover-after-restore')) {
          yield {
            type: 'result', subtype: 'error_during_execution', is_error: true,
            result: 'API Error: 429 Too Many Requests after checkpoint restore',
            total_cost_usd: 0, usage: {}, duration_ms: 5, num_turns: 1, session_id: sessionId
          }
          continue
        }
        if (base.includes('always429') || base.includes('slow429')) {
          yield {
            type: 'result', subtype: 'error_during_execution', is_error: true,
            result: 'API Error: 429 Too Many Requests {"type":"rate_limit_error"}',
            total_cost_usd: 0, usage: {}, duration_ms: 5, num_turns: 1, session_id: sessionId
          }
          continue
        }
        if (base.includes('crashmid')) {
          throw new Error('fetch failed ECONNRESET: mock stream crash')
        }
        yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '收到:' } } }
        yield { type: 'stream_event', session_id: sessionId, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(0, 10) } } }
        yield { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: `已处理:${text.slice(0, 20)}` }] } }
        yield {
          type: 'result', subtype: 'success', is_error: false, result: 'done',
          total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 20 },
          duration_ms: 30, num_turns: 1, session_id: sessionId
        }
      }
    },
    async setModel(m) { sdkLog.push({ setModel: m }) },
    async interrupt() { sdkLog.push({ interrupt: true }) },
    async setPermissionMode() {},
    async close() { closed = true; if (prompt && prompt.end) prompt.end() },
    async rewindFiles(id, opts) { sdkLog.push({ rewindFiles: id, dryRun: opts && opts.dryRun }); return { canRewind: true, filesChanged: ['a.txt'], insertions: 1, deletions: 0 } },
    async supportedCommands() { return [] },
    async supportedAgents() {
      return Object.entries((options && options.agents) || {}).map(([name, definition]) => ({
        name,
        description: definition.description,
        model: definition.model
      }))
    },
    async backgroundTasks() { return false }
  }
}
const sdkStub = { query: mockQuery }

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  if (request === '@anthropic-ai/claude-agent-sdk') return sdkStub
  if (request === './terminal' || request.endsWith('/terminal')) {
    return {
      terminalManager: {
        subscribe: () => () => {},
        list: () => [],
        start: async () => ({ id: 'terminal-mock', cwd: tmpRoot, shell: '/bin/sh', backend: 'pipe', cols: 80, rows: 24, startedAt: Date.now() }),
        write() {},
        resize() {},
        close() {}
      }
    }
  }
  if (request === 'zustand') {
    const createImpl = (initializer) => {
      let state
      const listeners = new Set()
      const setState = (partial) => {
        const next = typeof partial === 'function' ? partial(state) : partial
        state = { ...state, ...next }
        listeners.forEach((l) => l(state))
      }
      const getState = () => state
      const api = { setState, getState, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } }
      state = initializer(setState, getState, api)
      const hook = (sel) => (sel ? sel(state) : state)
      return Object.assign(hook, api)
    }
    return { create: (f) => (f === undefined ? (g) => createImpl(g) : createImpl(f)) }
  }
  return origLoad.apply(this, arguments)
}

const M = (p) => require(path.join(buildDir, p))

// ---------------------------------------------------------------- 3. 测试组
async function main() {
  const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const mkRepo = (name) => {
    const dir = path.join(tmpRoot, name)
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    sh(dir, 'git', ['init', '-q', '-b', 'main'])
    sh(dir, 'git', ['config', 'user.email', 't@t'])
    sh(dir, 'git', ['config', 'user.name', 't'])
    fs.writeFileSync(path.join(dir, 'README.md'), '# t\n')
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1\n')
    sh(dir, 'git', ['add', '-A'])
    sh(dir, 'git', ['commit', '-qm', 'init'])
    return dir
  }

  // ---- T1 worktree 全生命周期(真 git) ----
  await test('T1 worktree:隔离创建/主仓干净/统计/导出patch/移除', async () => {
    const wt = M('main/worktrees.js')
    const repoDir = mkRepo('repo1')
    const prep = wt.prepareWorktree({ sessionId: 'sess-wt-1', cwd: repoDir, isolated: true })
    assert(prep.ok && prep.isolated, `prepareWorktree 失败:${prep.ok ? '' : prep.error}`)
    assert(fs.existsSync(prep.record.worktreePath), 'worktree 目录不存在')
    const branch = sh(prep.record.worktreePath, 'git', ['branch', '--show-current']).trim()
    eq(branch, 'caogen/sess-wt-1', '分支名')
    // 在 worktree 里改文件 → 主仓必须干净
    fs.writeFileSync(path.join(prep.record.worktreePath, 'src', 'app.ts'), 'export const a = 42\n')
    sh(prep.record.worktreePath, 'git', ['add', '-A'])
    sh(prep.record.worktreePath, 'git', ['commit', '-qm', 'change in wt'])
    eq(sh(repoDir, 'git', ['status', '--porcelain']).trim(), '', '主工作区被污染')
    // 统计
    const sum = wt.getManagedWorktreeSummary('sess-wt-1')
    assert(sum.ok && sum.changedFiles === 1 && sum.dirty, `summary 异常:${JSON.stringify(sum)}`)
    // 导出 patch 且可回放到主仓
    const patch = wt.exportManagedWorktreePatch('sess-wt-1')
    assert(patch.ok && fs.existsSync(patch.path), `patch 导出失败:${patch.error || ''}`)
    sh(repoDir, 'git', ['apply', '--check', patch.path]) // 抛错即失败
    // 幂等:同 session 再次 prepare 复用
    const again = wt.prepareWorktree({ sessionId: 'sess-wt-1', cwd: repoDir, isolated: true })
    eq(again.record.worktreePath, prep.record.worktreePath, '重复 prepare 未复用')
    // 移除(worktree 内有已提交更改,需 force=false 应能移除;分支保留)
    const rm = wt.removeManagedWorktreeView('sess-wt-1', { force: true })
    assert(rm.ok, `移除失败:${rm.error || ''}`)
    assert(!fs.existsSync(prep.record.worktreePath), '移除后目录仍在')
    // 非 git 目录自动降级
    const plain = path.join(tmpRoot, 'plain'); fs.mkdirSync(plain, { recursive: true })
    const p2 = wt.prepareWorktree({ sessionId: 'sess-wt-2', cwd: plain })
    assert(p2.ok && !p2.isolated, '非 git 目录应降级为直跑')
    const p3 = wt.prepareWorktree({ sessionId: 'sess-wt-3', cwd: plain, isolated: true })
    assert(!p3.ok, '非 git 强制隔离应报错')
  })

  // ---- T2 工作区 diff(真 git) ----
  await test('T2 gitDiff:修改/新增/删除分类与 hunk', async () => {
    const gd = M('main/gitDiff.js')
    const repoDir = mkRepo('repo2')
    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const a = 2\nexport const b = 3\n')
    fs.writeFileSync(path.join(repoDir, 'new.txt'), 'hello\n')
    fs.rmSync(path.join(repoDir, 'README.md'))
    const diff = gd.getWorkspaceDiff(repoDir)
    assert(diff.ok, `diff 失败:${diff.error || ''}`)
    // unified diff 语义:deleted 的 newPath 是 /dev/null,应按 status 取 oldPath
    const byPath = Object.fromEntries(
      diff.files.map((f) => [f.status === 'deleted' ? f.oldPath : f.newPath || f.oldPath, f.status])
    )
    eq(byPath['src/app.ts'], 'modified', 'app.ts 状态')
    eq(byPath['new.txt'], 'added', 'new.txt 状态')
    eq(byPath['README.md'], 'deleted', 'README 状态')
    const app = diff.files.find((f) => (f.newPath || f.oldPath) === 'src/app.ts')
    assert(app.hunks.length > 0 && app.hunks[0].lines.some((l) => l.type === 'add'), 'hunk 无新增行')
  })

  // ---- T3 @文件:模糊搜索 + 引用注入 ----
  await test('T3 fileSuggest:搜索与 @引用读取', async () => {
    const fsg = M('main/fileSuggest.js')
    const repoDir = mkRepo('repo3')
    const hits = fsg.suggestFiles(repoDir, 'app')
    assert(Array.isArray(hits) && hits.some((h) => String(h).includes('app.ts')), `未找到 app.ts:${JSON.stringify(hits)}`)
    if (typeof fsg.readReferencedFiles === 'function') {
      const inject = fsg.readReferencedFiles(repoDir, ['src/app.ts', '../etc/passwd'])
      assert(String(inject).includes('export const a'), '@引用未注入文件内容')
      assert(!String(inject).includes('root:'), '目录穿越防护失效')
    }
  })

  // ---- T4 检查点锚点:解析真实格式 CLI transcript ----
  await test('T4 checkpoints:latestUserTextUuid 解析', async () => {
    const cp = M('main/checkpoints.js')
    const projDir = path.join(os.homedir(), '.claude', 'projects', '-itest-proj')
    fs.mkdirSync(projDir, { recursive: true })
    const sid = 'itest-' + Date.now()
    const lines = [
      { type: 'user', uuid: 'u-1', message: { content: [{ type: 'text', text: '第一轮' }] } },
      { type: 'assistant', uuid: 'a-1', message: { content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', uuid: 'u-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
      { type: 'user', uuid: 'u-2', message: { content: [{ type: 'text', text: '第二轮' }] } }
    ]
    fs.writeFileSync(path.join(projDir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
    const all = cp.userTextMessageUuids(sid)
    eq(JSON.stringify(all), JSON.stringify(['u-1', 'u-2']), '应只取用户文本消息(排除 tool_result)')
    eq(cp.latestUserTextUuid(sid), 'u-2', '最新锚点')
    eq(cp.latestUserTextUuid('no-such-session'), null, '不存在会话应返回 null')
  })

  // ---- T5 转录:缓冲/绑定/fork 复制/seq 单调 ----
  await test('T5 transcript:buffer→bind→fork 复制', async () => {
    const tr = M('main/transcript.js')
    const w = new tr.TranscriptWriter()
    w.next({ kind: 'user-message', text: 'hi' })         // 未绑定,缓冲
    w.next({ kind: 'text-delta', text: 'x' })            // 瞬态,不落盘
    w.next({ kind: 'init', sdkSessionId: 'sdk-A' })      // 绑定,flush
    w.next({ kind: 'assistant-message', blocks: [{ type: 'text', text: 'ok' }] })
    const read1 = w.read()
    eq(read1.length, 2, '耐久事件数(user+assistant)')
    assert(read1.every((e, i) => i === 0 || e.seq > read1[i - 1].seq), 'seq 不单调')
    // fork:新 init 复制旧文件
    w.next({ kind: 'init', sdkSessionId: 'sdk-B' })
    w.next({ kind: 'user-message', text: '第二段' })
    const read2 = w.read()
    eq(read2.length, 3, 'fork 后应含旧转录 + 新事件')
    assert(fs.existsSync(path.join(userData, 'transcripts', 'sdk-B.jsonl')), 'fork 文件不存在')
  })

  // ---- T6 AgentSession × mock SDK:正常轮全事件链 ----
  const AS = M('main/agentSession.js')
  const settingsMod = M('main/settings.js')
  // 写入两个 Provider(A 恒 429,B 正常)
  fs.writeFileSync(path.join(userData, 'providers.json'), JSON.stringify([
    { id: 'prov-a', name: '甲网关', baseUrl: 'http://always429.mock', encryptedToken: 'b64:' + Buffer.from('k1').toString('base64'), models: ['m-a'], createdAt: 1 },
    { id: 'prov-b', name: '乙网关', baseUrl: 'http://ok.mock', encryptedToken: 'b64:' + Buffer.from('k2').toString('base64'), models: ['m-b'], createdAt: 2 },
    { id: 'prov-slow', name: '慢网关', baseUrl: 'http://slow429.mock', encryptedToken: 'b64:' + Buffer.from('k3').toString('base64'), models: ['m-s'], createdAt: 3 },
    { id: 'prov-crash', name: '崩网关', baseUrl: 'http://crashmid.mock', encryptedToken: 'b64:' + Buffer.from('k4').toString('base64'), models: ['m-c'], createdAt: 4 }
  ], null, 2))

  function newSession(providerId, model) {
    const meta = AS.newSessionMeta({ cwd: tmpRoot, engine: 'claude', model, providerId, permissionMode: 'default', title: 'itest' })
    const events = []
    const s = new AS.AgentSession(meta, (event, seq) => events.push({ seq, event }))
    return { meta, events, s, kinds: () => events.map((e) => e.event.kind) }
  }

  function fakeWindow(bucket = []) {
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => bucket.push({ channel, payload }) },
      contentView: { addChildView() {}, removeChildView() {} },
      once() {}
    }
    win.webContents.__owner = win
    return win
  }

  function storeSession(meta) {
    return {
      meta,
      items: [],
      streamText: '',
      streamThinking: '',
      toolResults: {},
      runningTools: {},
      pendingPermissions: [],
      childResults: {},
      lastSeq: 0
    }
  }

  await test('T6 AgentSession:正常轮事件链与费用', async () => {
    const { events, s, meta } = newSession('prov-b', 'm-b')
    await s.start()
    await waitFor(() => events.some((e) => e.event.kind === 'init'), 3000, '等待 init')
    s.send('你好世界')
    await waitFor(() => events.some((e) => e.event.kind === 'turn-result'), 3000, '等待 turn-result')
    const kinds = events.map((e) => e.event.kind)
    for (const k of ['init', 'user-message', 'status', 'text-delta', 'assistant-message', 'turn-result']) {
      assert(kinds.includes(k), `缺事件 ${k}(实际:${kinds.join(',')})`)
    }
    const tr = events.find((e) => e.event.kind === 'turn-result').event
    assert(!tr.isError, '本应成功')
    assert(Math.abs(meta.costUsd - 0.0123) < 1e-9, `费用未入 meta:${meta.costUsd}`)
    eq(meta.status, 'idle', '轮后状态')
    s.dispose()
  })

  await test('P0 TaskRun:同会话排队消息形成独立步骤并在末轮完成后收口', async () => {
    const sm = M('main/sessionManager.js').sessionManager
    const taskStore = M('main/task/task-snapshot.js')
    await sm.init()
    const events = []
    const unsubscribe = sm.subscribe((payload) => events.push(payload))
    const meta = sm.create({
      cwd: tmpRoot,
      isolated: false,
      engine: 'claude',
      providerId: 'prov-b',
      model: 'm-b',
      title: 'queued TaskRun integration'
    })
    try {
      await waitFor(() => sm.get(meta.id)?.meta.sdkSessionId, 3000, '等待 TaskRun session init')
      sm.send(meta.id, '第一条排队任务')
      sm.send(meta.id, '第二条排队任务')
      await waitFor(
        () => events.filter((payload) => payload.sessionId === meta.id && payload.event.kind === 'turn-result').length >= 2,
        5000,
        '等待两条排队任务完成'
      )
      const sessionEvents = events.filter((payload) => payload.sessionId === meta.id)
      assert(sessionEvents.every((payload) => payload.eventId), 'SessionManager events must expose eventId')
      eq(new Set(sessionEvents.map((payload) => payload.eventId)).size, sessionEvents.length, 'eventId 不应重复')
      await taskStore.flushTaskSnapshotMutations(userData)
      const runs = await taskStore.listTaskRuns(meta.id, userData)
      const latest = runs[0]
      assert(latest, 'TaskRun history missing')
      eq(latest.status, 'completed', '两条排队任务完成后 TaskRun 应收口')
      eq(latest.steps.length, 2, '每条用户请求应形成独立 TaskStep')
      assert(latest.steps.every((step) => step.status === 'completed'), '排队 TaskStep 应全部完成')
      eq((await taskStore.listTaskSnapshots(userData)).some((snapshot) => snapshot.sessionId === meta.id), false, '末轮成功后 recovery snapshot 应删除')

      const taskRun = M('main/task/task-run.js')
      const runtime = M('main/task/task-runtime-registry.js').taskRuntimeRegistry
      const idempotency = M('main/task/tool-idempotency.js')
      const oldRun = taskRun.createTaskRun({
        id: 'persisted-unknown-run',
        sessionId: meta.id,
        taskId: 'persisted-unknown-task'
      })
      const retryInput = { path: 'persisted-retry.txt', content: 'done' }
      const retryKey = idempotency.buildToolIdempotencyKey({
        scopeId: meta.id,
        cwd: meta.cwd,
        toolName: 'write_file',
        toolInput: retryInput
      })
      const oldExecutionId = `${oldRun.id}:tool:old-unknown`
      const oldRunWithUnknown = {
        ...oldRun,
        status: 'failed',
        revision: oldRun.revision + 1,
        updatedAt: Date.now(),
        finishedAt: Date.now(),
        error: 'interrupted',
        toolExecutions: [{
          id: oldExecutionId,
          runId: oldRun.id,
          sessionId: meta.id,
          toolUseId: 'old-unknown',
          toolName: 'write_file',
          status: 'unknown_outcome',
          idempotencyKey: retryKey,
          createdAt: 1,
          updatedAt: 1
        }]
      }
      await taskStore.deleteTaskSnapshot('__seed-persisted-unknown__', userData, oldRunWithUnknown)
      runtime.set(meta.id, oldRunWithUnknown)
      runtime.set(meta.id, taskRun.createTaskRun({ id: 'persisted-retry-run', sessionId: meta.id, taskId: 'persisted-retry-task' }))
      const retryToolUseId = 'confirmed-persisted-retry'
      const retryExecutionId = `persisted-retry-run:tool:${retryToolUseId}`
      sm.dispatch(meta.id, { kind: 'user-message', messageId: 'persisted-retry-message', text: '确认后重试' }, 9001)
      sm.dispatch(meta.id, {
        kind: 'permission-request',
        request: {
          requestId: 'persisted-retry-permission',
          toolName: 'write_file',
          toolUseId: retryToolUseId,
          input: retryInput,
          duplicateExecutionId: oldExecutionId
        }
      }, 9002)
      sm.dispatch(meta.id, { kind: 'permission-resolved', requestId: 'persisted-retry-permission', behavior: 'allow' }, 9003)
      sm.dispatch(meta.id, { kind: 'tool-result', toolUseId: retryToolUseId, content: 'retry ok', isError: false }, 9004)
      await taskStore.flushTaskSnapshotMutations(userData)
      const persistedAfterRetry = await taskStore.listTaskRuns(meta.id, userData)
      const superseded = persistedAfterRetry
        .flatMap((run) => run.toolExecutions ?? [])
        .find((execution) => execution.id === oldExecutionId)
      eq(superseded.status, 'superseded', '跨 run 成功重试应持久化 superseded')
      eq(superseded.supersededByExecutionId, retryExecutionId, '旧记录应指向成功重试执行')
      const persistedRetry = persistedAfterRetry
        .flatMap((run) => run.toolExecutions ?? [])
        .find((execution) => execution.id === retryExecutionId)
      eq(persistedRetry.duplicateOfExecutionId, oldExecutionId, '成功重试应保留旧执行关联')
    } finally {
      unsubscribe()
      sm.close(meta.id)
    }
  })

  await test('P0 recovery cursor:转录尾部成功轮次收敛旧快照', async () => {
    const sm = M('main/sessionManager.js').sessionManager
    const taskStore = M('main/task/task-snapshot.js')
    const taskRun = M('main/task/task-run.js')
    const taskExecution = M('main/task/task-execution.js')
    const { TranscriptWriter } = M('main/transcript.js')
    const tailMeta = AS.newSessionMeta({
      cwd: tmpRoot,
      model: 'm-b',
      providerId: 'prov-b',
      permissionMode: 'default',
      title: 'tail reconciliation'
    })
    tailMeta.id = 'tail-reconciliation-session'
    tailMeta.status = 'running'
    tailMeta.sdkSessionId = 'sdk-tail-reconciliation'
    const writer = new TranscriptWriter()
    writer.next({ kind: 'init', sdkSessionId: tailMeta.sdkSessionId })
    const userEvent = { kind: 'user-message', messageId: 'tail-user', text: '已经完成但快照尚未删除' }
    const userEntry = writer.nextEntry(userEvent)
    let run = taskRun.createTaskRun({
      id: 'tail-reconciliation-run',
      sessionId: tailMeta.id,
      taskId: tailMeta.id,
      now: userEntry.occurredAt
    })
    run = taskExecution.reduceTaskExecutionEvent(
      run,
      userEvent,
      tailMeta.cwd,
      userEntry.occurredAt,
      userEntry
    )
    run = taskRun.reduceTaskRunEvent(run, userEvent, userEntry.occurredAt)
    run = taskRun.recordTaskRunEvent(run, userEntry)
    await taskStore.saveTaskSnapshot(
      taskStore.buildTaskSnapshot({
        meta: tailMeta,
        transcript: writer.read(),
        lastSeq: userEntry.seq,
        lastEventId: userEntry.eventId,
        lastEventKind: userEvent.kind,
        eventCount: 2,
        reason: 'important-event',
        run,
        now: userEntry.occurredAt
      }),
      userData
    )
    const terminalEntry = writer.nextEntry({
      kind: 'turn-result',
      subtype: 'success',
      isError: false,
      resultText: 'done'
    })
    const recoverable = await sm.listTaskSnapshots()
    assert(
      !recoverable.some((snapshot) => snapshot.sessionId === tailMeta.id),
      '已落盘的成功 turn-result 必须收敛旧恢复入口'
    )
    const terminalRuns = await taskStore.listTaskRuns(tailMeta.id, userData)
    eq(terminalRuns[0].status, 'completed', '转录尾部应将 TaskRun 收敛为 completed')
    eq(terminalRuns[0].lastAppliedEventId, terminalEntry.eventId, '终态 run 应记录最后事件身份')
    eq(terminalRuns[0].lastAppliedEventSeq, terminalEntry.seq, '终态 run 应记录恢复游标')
  })

  await test('P0 idempotency:Claude bypass 模式仍需确认未知结果操作', async () => {
    const taskRun = M('main/task/task-run.js')
    const runtime = M('main/task/task-runtime-registry.js').taskRuntimeRegistry
    const idempotency = M('main/task/tool-idempotency.js')
    const { events, s, meta } = newSession('prov-b', 'm-b')
    meta.permissionMode = 'bypassPermissions'
    const run = taskRun.createTaskRun({ id: 'claude-idempotency-run', sessionId: meta.id, taskId: meta.id })
    const input = { command: 'npm test' }
    const key = idempotency.buildToolIdempotencyKey({ scopeId: run.sessionId, cwd: meta.cwd, toolName: 'Bash', toolInput: input })
    runtime.set(meta.id, {
      ...run,
      toolExecutions: [{
        id: `${run.id}:tool:old-bash`,
        runId: run.id,
        sessionId: meta.id,
        toolUseId: 'old-bash',
        toolName: 'bash',
        status: 'unknown_outcome',
        idempotencyKey: key,
        createdAt: 1,
        updatedAt: 1
      }]
    })
    try {
      const decisionPromise = s.requestPermission('Bash', input, { toolUseID: 'retry-bash' })
      await waitFor(() => events.some((entry) => entry.event.kind === 'permission-request'), 2000, '等待 Claude 幂等审批')
      const request = events.find((entry) => entry.event.kind === 'permission-request').event.request
      assert(request.decisionReason.includes('结果未知'), `Claude 幂等审批原因错误:${request.decisionReason}`)
      eq(request.duplicateExecutionId, `${run.id}:tool:old-bash`, 'Claude 幂等审批应携带旧执行关联')
      s.respondPermission(request.requestId, true)
      const decision = await decisionPromise
      eq(decision.behavior, 'allow', '用户确认后 Claude 操作应继续')
      meta.permissionMode = 'plan'
      const beforePlanRequests = events.filter((entry) => entry.event.kind === 'permission-request').length
      const planDecision = await s.requestPermission('Bash', input, { toolUseID: 'plan-retry-bash' })
      eq(planDecision.behavior, 'deny', 'Claude plan 模式必须优先于幂等确认')
      eq(
        events.filter((entry) => entry.event.kind === 'permission-request').length,
        beforePlanRequests,
        'Claude plan 模式不应弹出可突破硬拒绝的审批'
      )
    } finally {
      runtime.delete(meta.id)
      s.dispose()
    }
  })

  await test('P0 SDK agents:默认关闭,显式开启后注入 .claude/agents 并可查询 supportedAgents', async () => {
    const agentsDir = path.join(tmpRoot, '.claude', 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentsDir, 'reviewer.md'),
      ['---', 'name: reviewer', 'description: Review patches', 'tools: [Read, Grep]', '---', '你负责审查补丁。'].join('\n'),
      'utf8'
    )

    settingsMod.updateSettings({ sdkAgentsEnabled: false })
    const beforeDisabled = sdkLog.length
    const disabled = newSession('prov-b', 'm-b')
    await disabled.s.start()
    await waitFor(() => disabled.events.some((e) => e.event.kind === 'init'), 3000, '等待 disabled sdk agents init')
    const disabledCreate = sdkLog.slice(beforeDisabled).find((entry) => Array.isArray(entry.agents))
    assert(disabledCreate && disabledCreate.agents.length === 0, `默认关闭时不应注入 agents:${JSON.stringify(disabledCreate)}`)
    disabled.s.dispose()

    settingsMod.updateSettings({ sdkAgentsEnabled: true })
    const beforeEnabled = sdkLog.length
    const enabled = newSession('prov-b', 'm-b')
    await enabled.s.start()
    await waitFor(() => enabled.events.some((e) => e.event.kind === 'init'), 3000, '等待 enabled sdk agents init')
    const enabledCreate = sdkLog.slice(beforeEnabled).find((entry) => Array.isArray(entry.agents))
    assert(enabledCreate && enabledCreate.agents.includes('reviewer'), `开启后未注入 reviewer:${JSON.stringify(enabledCreate)}`)
    const supported = await enabled.s.supportedAgents()
    assert(supported.some((agent) => agent.name === 'reviewer' && agent.description === 'Review patches'), 'supportedAgents 未返回 reviewer')
    enabled.s.dispose()
    settingsMod.updateSettings({ sdkAgentsEnabled: false })
  })

  // ---- T7 故障切换:429 → 自动换厂商 → 重发成功 ----
  await test('T7 故障切换:429 触发换厂商且任务不中断', async () => {
    settingsMod.updateSettings({ failoverEnabled: true })
    const { events, s, meta } = newSession('prov-a', 'm-a')
    await s.start()
    await waitFor(() => events.some((e) => e.event.kind === 'init'), 3000)
    s.send('这条会先撞 429')
    await waitFor(() => events.some((e) => e.event.kind === 'turn-result' && !e.event.isError), 5000, '等待切换后成功')
    const fo = events.find((e) => e.event.kind === 'failover')
    assert(fo, '缺 failover 事件')
    eq(fo.event.fromProviderId, 'prov-a', '来源厂商')
    assert(fo.event.toProviderId !== 'prov-a', '目标厂商不能是自己')
    assert(String(fo.event.reason).includes('限流'), `原因分类应为限流:${fo.event.reason}`)
    assert(meta.providerId !== 'prov-a', 'meta.providerId 未切换')
    // user-message 事件只应出现一次(重发不重复记录)
    eq(events.filter((e) => e.event.kind === 'user-message').length, 1, 'user-message 重复')
    s.dispose()
  })

  // ---- T8 故障切换:流崩溃路径 ----
  await test('T8 故障切换:流崩溃(网络错误)也能接管', async () => {
    const { events, s } = newSession('prov-crash', 'm-c')
    await s.start()
    await waitFor(() => events.some((e) => e.event.kind === 'init'), 3000)
    s.send('这条会遇到流崩溃')
    await waitFor(() => events.some((e) => e.event.kind === 'turn-result' && !e.event.isError), 5000, '等崩溃切换成功')
    assert(events.some((e) => e.event.kind === 'failover'), '缺 failover 事件')
    s.dispose()
  })

  // ---- T9 用户中断不触发切换 ----
  await test('T9 中断:用户中断产生的错误不切换厂商', async () => {
    const { events, s } = newSession('prov-slow', 'm-s')
    await s.start()
    await waitFor(() => events.some((e) => e.event.kind === 'init'), 3000)
    s.send('这条会被中断')
    await new Promise((r) => setTimeout(r, 10))
    await s.interrupt() // interrupting=true;80ms 后 429 到达
    await waitFor(() => events.some((e) => e.event.kind === 'turn-result'), 5000)
    assert(!events.some((e) => e.event.kind === 'failover'), '中断后不应 failover')
    s.dispose()
  })

  // ---- T10 开关:failoverEnabled=false 不切换 ----
  await test('T10 开关:关闭故障切换后按错误收尾', async () => {
    settingsMod.updateSettings({ failoverEnabled: false })
    const { events, s } = newSession('prov-a', 'm-a')
    await s.start()
    await waitFor(() => events.some((e) => e.event.kind === 'init'), 3000)
    s.send('关掉开关后的 429')
    await waitFor(() => events.some((e) => e.event.kind === 'turn-result'), 5000)
    const tr = events.find((e) => e.event.kind === 'turn-result').event
    assert(tr.isError, '应以错误收尾')
    assert(!events.some((e) => e.event.kind === 'failover'), '关闭后不应 failover')
    settingsMod.updateSettings({ failoverEnabled: true })
    s.dispose()
  })

  // ---- T11 store reducer:事件序列 + seq 去重 + stash/drain ----
  await test('T11 store:事件溯源、去重与迟注册补投', async () => {
    global.window = {
      // store 的流式节流在无 requestAnimationFrame 时降级到 window.setTimeout
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      agentDesk: {
        onSessionEvent: () => () => {},
        listSessions: async () => [],
        listHistory: async () => [],
        getSettings: async () => settingsMod.getSettings(),
        listProviders: async () => [],
        listProjects: async () => [],
        listPendingPermissions: async () => [],
        getTranscript: async () => [],
        createSession: async (opts) => AS.newSessionMeta({ cwd: opts.cwd, engine: 'claude', model: 'm-b', providerId: 'prov-b', permissionMode: 'default', title: 't' })
      }
    }
    const store = M('renderer/src/store.js')
    const st = store.useStore
    // 先广播(会话尚未注册)→ stash
    const metaP = global.window.agentDesk.createSession({ cwd: tmpRoot })
    const meta = await metaP
    global.window.agentDesk.createSession = async () => meta // 让 store.createSession 拿到同一 meta
    st.getState().handleEvent(meta.id, { kind: 'user-message', text: '早到的事件' }, 1)
    st.getState().handleEvent(meta.id, { kind: 'text-delta', text: 'abc' }, 2)
    await st.getState().createSession({ cwd: tmpRoot }) // 注册 → drain
    let sess = st.getState().sessions[meta.id]
    assert(sess, '会话未注册')
    eq(sess.items.filter((i) => i.kind === 'user').length, 1, 'stash 的 user-message 应补投')
    eq(sess.streamText, 'abc', 'stash 的 delta 应补投')
    // 实时事件 + 去重
    st.getState().handleEvent(meta.id, { kind: 'assistant-message', blocks: [{ type: 'text', text: 'ok' }] }, 3)
    st.getState().handleEvent(meta.id, { kind: 'turn-result', subtype: 'success', isError: false, costUsd: 0.5 }, 4)
    st.getState().handleEvent(meta.id, { kind: 'turn-result', subtype: 'success', isError: false, costUsd: 9.9 }, 4) // 重复 seq
    sess = st.getState().sessions[meta.id]
    eq(sess.items.filter((i) => i.kind === 'turn-result').length, 1, 'seq 去重失败')
    eq(sess.meta.costUsd, 0.5, '重复事件覆盖了费用')
    eq(sess.streamText, '', 'assistant 后应清空流式缓冲')
    // failover 事件清理运行态
    st.getState().handleEvent(meta.id, { kind: 'text-delta', text: 'zzz' }, 5)
    st.getState().handleEvent(meta.id, { kind: 'failover', fromProviderId: 'a', toProviderId: '', fromName: '甲', toName: '未选择 Provider', reason: '限流/过载' }, 6)
    sess = st.getState().sessions[meta.id]
    eq(sess.streamText, '', 'failover 应清空流式缓冲')
    assert(sess.items.some((i) => i.kind === 'failover'), 'failover 未入聊天流')
  })

  // ---- P0 task snapshot:renderer store 恢复/删除入口 ----
  await test('P0 task snapshot:store 加载、恢复并删除可恢复任务', async () => {
    const store = M('renderer/src/store.js').useStore
    const meta = AS.newSessionMeta({
      cwd: tmpRoot,
      model: 'm-b',
      providerId: 'prov-b',
      permissionMode: 'default',
      title: 'snapshot task'
    })
    const snapshot = {
      id: meta.id,
      taskId: meta.id,
      sessionId: meta.id,
      title: meta.title,
      projectPath: meta.cwd,
      engine: meta.engine,
      model: meta.model,
      providerId: meta.providerId,
      createdAt: 1,
      updatedAt: 2,
      eventCount: 2,
      reason: 'shutdown',
      meta,
      execution: {
        status: 'running',
        lastSeq: 2,
        lastEventAt: 2,
        sdkSessionId: 'sdk-snapshot'
      },
      worktree: undefined,
      transcript: [],
      subtasks: [],
      dagExecutions: []
    }
    const transcript = [
      { seq: 1, event: { kind: 'user-message', text: '继续未完成任务' } },
      { seq: 2, event: { kind: 'assistant-message', blocks: [{ type: 'text', text: '收到' }] } }
    ]
    let snapshots = [snapshot]
    global.window = {
      ...(global.window || {}),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      agentDesk: {
        ...(global.window && global.window.agentDesk ? global.window.agentDesk : {}),
        listTaskSnapshots: async () => snapshots,
        recoverTaskSnapshot: async (id) => {
          eq(id, snapshot.id, '恢复快照 id')
          return { ...meta, status: 'starting', sdkSessionId: 'sdk-snapshot' }
        },
        deleteTaskSnapshot: async (id) => {
          eq(id, snapshot.id, '删除快照 id')
          snapshots = snapshots.filter((item) => item.id !== id)
          return true
        },
        getTranscript: async (id) => {
          eq(id, meta.id, '恢复后转录 session id')
          return transcript
        },
        closeBrowser: async () => {}
      }
    }
    store.setState({
      sessions: {},
      order: [],
      activeId: null,
      taskSnapshots: [],
      taskSnapshotsLoading: false,
      taskSnapshotsError: undefined
    })

    await store.getState().refreshTaskSnapshots()
    eq(store.getState().taskSnapshots.length, 1, '快照列表未加载')
    await store.getState().recoverTaskSnapshot(snapshot.id)
    const recovered = store.getState().sessions[meta.id]
    assert(recovered, '快照恢复后未注册会话')
    eq(store.getState().activeId, meta.id, '恢复后未激活会话')
    assert(store.getState().order.includes(meta.id), '恢复后未加入侧栏顺序')
    assert(recovered.items.some((item) => item.kind === 'user'), '恢复后未回放转录')
    await store.getState().deleteTaskSnapshot(snapshot.id)
    eq(store.getState().taskSnapshots.length, 0, '快照删除后仍留在 store')
  })

  // ---- T12 真子代理编排:父会话派出真实 child sessions + 独立 worktree ----
  await test('T12 subagents:父会话派出真实子会话并独立 worktree', async () => {
    const sm = M('main/sessionManager.js').sessionManager
    sm.init()
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    const createdIds = []
    const eventsFor = (id) => bucket
      .filter((entry) => entry.channel === 'session:event' && entry.payload.sessionId === id)
      .map((entry) => entry.payload.event)
    const repoDir = mkRepo('subagents-repo')
    try {
      const parent = sm.create({ cwd: repoDir, title: 'parent', isolated: true, engine: 'claude', providerId: 'prov-b', model: 'm-b' })
      createdIds.push(parent.id)
      await waitFor(() => sm.get(parent.id)?.meta.sdkSessionId, 3000, '等待 parent init')
      const result = sm.dispatchSubagents(parent.id, {
        tasks: [
          { id: 'front', role: 'frontend', prompt: '实现前端面板' },
          { id: 'api', role: 'backend', prompt: '实现后端 API' },
          { id: 'test', role: 'tester', prompt: '补充测试验证' }
        ]
      })
      createdIds.push(...result.children.map((child) => child.meta.id))
      eq(result.children.length, 3, '子代理数量')
      eq(new Set(result.children.map((child) => child.meta.id)).size, 3, '子会话 id 应唯一')
      eq(new Set(result.children.map((child) => child.meta.worktreePath)).size, 3, '子会话 worktree 应唯一')
      for (const child of result.children) {
        const session = sm.get(child.meta.id)
        assert(session, `缺子会话 ${child.meta.id}`)
        eq(child.meta.parentSessionId, parent.id, '父会话关联')
        eq(child.meta.orchestrationId, result.orchestrationId, '编排批次')
        assert(child.meta.isolated && child.meta.worktreePath, '子代理必须独立 worktree')
        assert(child.meta.sourceCwd === repoDir, '子代理 sourceCwd 应指向原仓库')
        assert(child.meta.cwd !== repoDir, '子代理 cwd 不能污染主仓')
        await waitFor(() => eventsFor(child.meta.id).some((event) => event.kind === 'turn-result'), 5000, `等待 ${child.taskId} 完成`)
        assert(
          eventsFor(child.meta.id).some((event) => event.kind === 'user-message' && event.text === child.prompt),
          `子代理 ${child.taskId} 未收到自己的 prompt`
        )
      }

      const batch33 = Array.from({ length: 33 }, (_, i) => ({ id: `b${i}`, prompt: `noop ${i}` }))
      const result33 = sm.dispatchSubagents(parent.id, { tasks: batch33, isolated: false })
      createdIds.push(...result33.children.map((child) => child.meta.id))
      eq(result33.children.length, 33, '应允许一次派发 33 个子代理')
      let overLimit = false
      try {
        sm.dispatchSubagents(parent.id, { tasks: [...batch33, { id: 'too-many', prompt: 'x' }] })
      } catch (err) {
        overLimit = /33/.test(String(err.message))
      }
      assert(overLimit, '超过 33 个子代理应拒绝')
    } finally {
      for (const id of createdIds.reverse()) sm.close(id)
      fakeWindows.splice(fakeWindows.indexOf(win), 1)
    }
  })

  // ---- PLAN T3 子代理结果回传 + 3D 真实任务流 ----
  await test('PLAN T3 subagents:结果回父会话/store 聚合/3D 跨工位 packet', async () => {
    const sm = M('main/sessionManager.js').sessionManager
    const store = M('renderer/src/store.js').useStore
    const office = M('renderer/src/components/office/model.js')
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    try {
      const repoDir = mkRepo('plan-t3-subagents')
      const parent = sm.create({ cwd: repoDir, title: 'plan parent', isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b' })
      await waitFor(() => sm.get(parent.id)?.meta.sdkSessionId, 3000, '等待 parent init')
      const result = sm.dispatchSubagents(parent.id, {
        tasks: [{ id: 'api', role: 'backend', prompt: '实现接口并返回结果' }]
      })
      const child = result.children[0].meta
      await waitFor(
        () => bucket.some((entry) => entry.channel === 'session:event' && entry.payload.sessionId === parent.id && entry.payload.event.kind === 'subagent-result'),
        5000,
        '等待父会话 subagent-result'
      )
      const payload = bucket.find((entry) => entry.channel === 'session:event' && entry.payload.sessionId === parent.id && entry.payload.event.kind === 'subagent-result').payload
      eq(payload.event.childTaskId, 'api', '父事件 childTaskId')
      eq(payload.event.status, 'done', '父事件状态')

      store.setState({ sessions: { [parent.id]: storeSession(parent) }, order: [parent.id], activeId: parent.id })
      store.getState().handleEvent(parent.id, payload.event, payload.seq)
      const parentState = store.getState().sessions[parent.id]
      assert(parentState.childResults.api, 'store 未聚合 childResults.api')
      eq(parentState.childResults.api.childSessionId, child.id, 'store child session id')

      const model = office.buildOfficeModel([parent.id, child.id], {
        [parent.id]: storeSession(parent),
        [child.id]: storeSession(child)
      })
      assert(model.packets.some((packet) => packet.kind === 'subtask' && packet.from === 0 && packet.to === 1), '3D office 未生成父子跨工位 packet')
      sm.close(child.id)
      sm.close(parent.id)
    } finally {
      fakeWindows.splice(fakeWindows.indexOf(win), 1)
    }
  })

  // ---- PLAN T4 开工建议接线 ----
  await test('PLAN T4 start suggestions:IPC 汇入 memory/history/routine/package 并支持本地忽略', async () => {
    M('main/ipc.js').registerIpc()
    const sm = M('main/sessionManager.js').sessionManager
    const ms = M('main/memoryStore.js')
    const rs = M('main/routineStore.js')
    const hist = M('main/history.js')
    const store = M('renderer/src/store.js').useStore
    const projectDir = mkRepo('plan-t4-suggestions')
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'plan-t4', scripts: { typecheck: 'tsc --noEmit' } }, null, 2))
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# plan t4\n\nTODO: failed validation branch\n')
    const draft = await ms.proposeMemoryDraft(projectDir, path.join(userData, 'memory'), {
      kind: 'failure', title: 'Last run failed', body: 'blocked by runtime error', source: 'itest', reason: 'failure smoke'
    })
    await ms.acceptMemoryDraft(projectDir, path.join(userData, 'memory'), draft.id)
    hist.upsertHistory({
      id: 'hist-plan-t4', title: 'Continue unfinished sidebar work', cwd: projectDir, model: 'm-b', providerId: 'prov-b', permissionMode: 'default', sdkSessionId: 'hist-sdk-plan-t4', createdAt: 1, updatedAt: Date.now(), costUsd: 0
    })
    await rs.createRoutine(path.join(userData, 'routines'), {
      id: 'routine-plan-t4', name: 'Failed nightly routine', prompt: 'failed validation needs repair', projectCwd: projectDir, schedule: '@daily', enabled: true
    })
    const meta = sm.create({ cwd: projectDir, title: 'suggestions parent', isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b' })
    await waitFor(() => sm.get(meta.id)?.meta.sdkSessionId, 3000)
    const suggestions = await ipcHandlers.get('startSuggestions:get')({}, meta.id)
    const ids = new Set(suggestions.map((item) => item.id))
    assert(ids.has('memory-failure'), `缺 memory-failure:${suggestions.map((s) => s.id).join(',')}`)
    assert(ids.has('routine-failure'), `缺 routine-failure:${suggestions.map((s) => s.id).join(',')}`)
    assert(ids.has('history-continue'), `缺 history-continue:${suggestions.map((s) => s.id).join(',')}`)
    assert(ids.has('package-verify') || ids.has('readme-todo'), '缺 package/readme 建议')

    global.window.agentDesk = { ...(global.window.agentDesk || {}), getStartSuggestions: async () => suggestions, sendMessage: async () => {}, closeBrowser: async () => {} }
    store.setState({ activeId: meta.id, workbench: { ...store.getState().workbench, startSuggestions: [], ignoredStartSuggestions: {}, laterStartSuggestions: {} } })
    await store.getState().refreshStartSuggestions()
    assert(store.getState().visibleStartSuggestions().length > 0, 'store 未加载 start suggestions')
    const first = store.getState().visibleStartSuggestions()[0]
    store.getState().ignoreStartSuggestion(first.id)
    assert(!store.getState().visibleStartSuggestions().some((item) => item.id === first.id), 'ignore 未隐藏建议')
    sm.close(meta.id)
  })

  // ---- PLAN T5 记忆自动提议 ----
  await test('PLAN T5 memory suggestion:send 触发提示,接受只预填不落盘', async () => {
    M('main/ipc.js').registerIpc()
    const sm = M('main/sessionManager.js').sessionManager
    const store = M('renderer/src/store.js').useStore
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    try {
      const meta = sm.create({ cwd: tmpRoot, title: 'memory suggestion', isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b' })
      await waitFor(() => sm.get(meta.id)?.meta.sdkSessionId, 3000)
      await ipcHandlers.get('sessions:send')({}, meta.id, { text: '请记住以后默认使用 pnpm' })
      await waitFor(() => bucket.some((entry) => entry.channel === 'memory:suggestion'), 2000, '等待 memory:suggestion')
      await ipcHandlers.get('sessions:send')({}, meta.id, { text: '请记住以后默认使用 pnpm' })
      eq(
        bucket.filter((entry) => entry.channel === 'memory:suggestion').length,
        1,
        '同会话同文本 memory suggestion 应节流去重'
      )
      const event = bucket.find((entry) => entry.channel === 'memory:suggestion').payload
      eq(event.sessionId, meta.id, 'memory suggestion session')
      store.setState({ activeId: meta.id, workbench: { ...store.getState().workbench, memorySuggestion: undefined, memoryOpen: false, memoryInitialForm: undefined } })
      global.window.agentDesk = { ...(global.window.agentDesk || {}), closeBrowser: async () => {} }
      store.getState().handleMemorySuggestion(event)
      store.getState().acceptMemorySuggestion()
      assert(store.getState().workbench.memoryOpen, '接受记忆提示后未打开 MemoryPanel')
      eq(store.getState().workbench.memoryInitialForm.body, event.text, '记忆 draft 预填内容')
      assert(!fs.existsSync(path.join(userData, 'memory', 'drafts')), '接受提示不应自动写入全局 draft')
      sm.close(meta.id)
    } finally {
      fakeWindows.splice(fakeWindows.indexOf(win), 1)
    }
  })

  // ---- PLAN T6 浏览器批注截图 ----
  await test('PLAN T6 browser annotation:可见时写 PNG,隐藏 bounds 时不写空白截图', async () => {
    const bv = M('main/browserView.js').browserViewManager
    const owner = fakeWindow([])
    fakeBrowserSelection = { url: 'https://example.test/page', title: 'Example', text: 'selected', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }
    fakeBrowserScreenshot = mockNativeImage(false)
    await bv.open(owner, 'browser-plan-t6', 'about:blank')
    bv.setBounds('browser-plan-t6', { x: 0, y: 0, width: 640, height: 360 })
    const annotation = await bv.captureAnnotation('browser-plan-t6', 'visible note')
    assert(annotation.screenshotPath && fs.existsSync(annotation.screenshotPath), '可见批注未写入 screenshotPath/PNG')
    bv.setBounds('browser-plan-t6', { x: 0, y: 0, width: 0, height: 0 })
    const hidden = await bv.captureAnnotation('browser-plan-t6', 'hidden note')
    assert(!hidden.screenshotPath, '隐藏 browser view 不应保存空白截图')
    bv.close('browser-plan-t6')
  })

  // ---- PLAN T7 Routine 首帧 nextRunAt ----
  await test('PLAN T7 routine:enabled 且未传 nextRunAt 时立即 seed', async () => {
    const rs = M('main/routineStore.js')
    const root = path.join(userData, 'routine-plan-t7')
    const enabled = await rs.createRoutine(root, { id: 'rt-plan-t7', name: 'Seed next', prompt: 'run', projectCwd: tmpRoot, schedule: '@hourly', enabled: true })
    assert(typeof enabled.nextRunAt === 'number' && enabled.nextRunAt > Date.now(), `enabled routine 未 seed nextRunAt:${JSON.stringify(enabled)}`)
    const disabled = await rs.createRoutine(root, { id: 'rt-plan-t7-disabled', name: 'No seed', prompt: 'run', projectCwd: tmpRoot, schedule: '@hourly', enabled: false })
    assert(!Object.prototype.hasOwnProperty.call(disabled, 'nextRunAt'), 'disabled routine 不应自动 seed nextRunAt')
  })

  await test('PLAN T7 routine:scheduler 到 executor 到 run history 闭环', async () => {
    const rs = M('main/routineStore.js')
    const scheduler = M('main/routineScheduler.js')
    const executor = M('main/routines/routine-executor.js')
    const runner = M('main/routines/routine-runner.js')
    const sm = M('main/sessionManager.js').sessionManager
    const root = path.join(userData, 'routine-plan-t7-scheduler')
    const projectDir = mkRepo('routine-scheduler-project')
    const now = Date.now()
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    await sm.init()
    try {
      await rs.createRoutine(root, {
        id: 'rt-plan-t7-scheduler',
        name: 'Scheduled run',
        prompt: 'routine scheduler prompt',
        projectCwd: projectDir,
        schedule: 'every 1h',
        providerId: 'prov-b',
        model: 'm-b',
        engine: 'claude',
        permissionMode: 'default',
        budgetUsd: 1,
        enabled: true,
        nextRunAt: now - 1000
      })
      scheduler.startRoutineScheduler({
        rootDir: root,
        intervalMs: 60_000,
        now: () => now,
        onTrigger: (routine, nextRunAt) => executor.executeRoutine(root, routine, { nextRunAt, sendDelayMs: 0 })
      })

      await waitFor(() => sm.list().some((meta) => meta.title === 'Routine: Scheduled run'), 3000, '等待 routine 创建会话')
      const meta = sm.list().find((item) => item.title === 'Routine: Scheduled run')
      assert(meta, 'scheduler 未创建 routine 会话')
      eq(meta.engine, 'claude', 'routine engine 未传入会话')
      await waitFor(() => bucket.some((entry) =>
        entry.channel === 'session:event' &&
        entry.payload.sessionId === meta.id &&
        entry.payload.event.kind === 'user-message' &&
        entry.payload.event.text === 'routine scheduler prompt'
      ), 3000, '等待 routine prompt 发送')

      const runs = await runner.listRoutineRuns(root, 'rt-plan-t7-scheduler')
      eq(runs.length, 1, 'routine run history 数量')
      eq(runs[0].status, 'succeeded', 'routine run history 状态')
      eq(runs[0].sessionId, meta.id, 'routine run history sessionId')
      const [stored] = await rs.listRoutines(root)
      assert(stored.lastRunAt && stored.lastRunAt <= Date.now(), 'routine 未写 lastRunAt')
      assert(stored.nextRunAt && stored.nextRunAt > now, `routine 未推进 nextRunAt:${JSON.stringify(stored)}`)
      sm.close(meta.id)
    } finally {
      scheduler.stopRoutineScheduler()
      const index = fakeWindows.indexOf(win)
      if (index !== -1) fakeWindows.splice(index, 1)
    }
  })

  // ---- PLAN T8 预算闸门 ----
  await test('PLAN T8 budget:session > provider > global,0 表示不限,send 前拦截', async () => {
    const providersMod = M('main/providers.js')
    const sm = M('main/sessionManager.js').sessionManager
    sm.init()
    settingsMod.updateSettings({ failoverEnabled: true, budgetUsdPerSession: 0.5 })
    providersMod.updateProvider('prov-b', { budgetUsd: 0.01 })
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    const createdIds = []
    const eventsFor = (id) => bucket
      .filter((entry) => entry.channel === 'session:event' && entry.payload.sessionId === id)
      .map((entry) => entry.payload.event)
    try {
      const blocked = sm.create({ cwd: tmpRoot, isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b', title: 'budget-provider' })
      createdIds.push(blocked.id)
      const blockedSession = sm.get(blocked.id)
      blockedSession.meta.costUsd = 0.02
      await waitFor(() => blockedSession.meta.sdkSessionId, 3000)
      const beforeBlockedUsers = eventsFor(blocked.id).filter((e) => e.kind === 'user-message').length
      sm.send(blocked.id, 'provider budget should block')
      await waitFor(() => eventsFor(blocked.id).some((e) => e.kind === 'status' && e.status === 'error'), 2000)
      assert(String(blockedSession.meta.lastError).includes('预算上限 $0.01'), `provider budget 错误不明确:${blockedSession.meta.lastError}`)
      eq(eventsFor(blocked.id).filter((e) => e.kind === 'user-message').length, beforeBlockedUsers, '预算拦截必须发生在 user-message/send 前')

      blockedSession.meta.budgetUsd = 1
      sm.send(blocked.id, 'session budget allows after raise')
      await waitFor(() => eventsFor(blocked.id).some((e) => e.kind === 'user-message' && e.text === 'session budget allows after raise'), 3000)
      await waitFor(() => eventsFor(blocked.id).some((e) => e.kind === 'turn-result' && !e.isError), 3000)

      providersMod.updateProvider('prov-b', { budgetUsd: 0 })
      const globalBlocks = sm.create({ cwd: tmpRoot, isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b', title: 'budget-global' })
      createdIds.push(globalBlocks.id)
      const globalSession = sm.get(globalBlocks.id)
      globalSession.meta.costUsd = 0.6
      await waitFor(() => globalSession.meta.sdkSessionId, 3000)
      sm.send(globalBlocks.id, 'global budget should block')
      await waitFor(() => eventsFor(globalBlocks.id).some((e) => e.kind === 'status' && e.status === 'error'), 2000)
      assert(String(globalSession.meta.lastError).includes('预算上限 $0.50'), `global budget 错误不明确:${globalSession.meta.lastError}`)

      settingsMod.updateSettings({ budgetUsdPerSession: 0, preventDisplaySleep: true })
      const noBudget = sm.create({ cwd: tmpRoot, isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b', title: 'budget-off' })
      createdIds.push(noBudget.id)
      const noBudgetSession = sm.get(noBudget.id)
      noBudgetSession.meta.costUsd = 999
      await waitFor(() => noBudgetSession.meta.sdkSessionId, 3000)
      sm.send(noBudget.id, 'budget zero should allow')
      await waitFor(() => eventsFor(noBudget.id).some((e) => e.kind === 'turn-result' && !e.isError), 3000)

      let openAiRequests = 0
      const server = http.createServer((req, res) => {
        openAiRequests++
        req.resume()
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        res.write('event: response.output_text.delta\n')
        res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n')
        res.write('event: response.completed\n')
        res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":1000,"input_tokens_details":{"cached_tokens":0}}}}\n\n')
        res.end('data: [DONE]\n\n')
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      process.env.OPENAI_API_KEY = 'test-openai-key'
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}`
      try {
        const openaiProvider = providersMod.createProvider({
          name: 'OpenAI mock',
          baseUrl: process.env.OPENAI_BASE_URL,
          token: process.env.OPENAI_API_KEY,
          models: ['gpt-4.1-mini'],
          openaiProtocol: 'responses'
        })
        const openai = sm.create({ cwd: tmpRoot, isolated: false, providerId: openaiProvider.id, engine: 'openai', model: 'gpt-4.1-mini', title: 'budget-openai' })
        createdIds.push(openai.id)
        const openaiSession = sm.get(openai.id)
        await waitFor(() => openaiSession.meta.sdkSessionId, 3000)
        const openAiPowerStarts = powerBlockerState.starts
        const openAiPowerStops = powerBlockerState.stops
        sm.send(openai.id, 'openai budget turn')
        await waitFor(() => powerBlockerState.starts > openAiPowerStarts, 2000, 'OpenAI running should start prevent-display-sleep')
        await waitFor(() => eventsFor(openai.id).some((e) => e.kind === 'turn-result' && typeof e.costUsd === 'number' && e.costUsd > 0), 3000)
        await waitFor(() => powerBlockerState.stops > openAiPowerStops, 2000, 'OpenAI idle should release prevent-display-sleep')
        const cost = openaiSession.meta.costUsd
        assert(cost > 0, `OpenAI usage 未在公共层累计费用:${cost}`)
        settingsMod.updateSettings({ preventDisplaySleep: false })
        const disabledPowerStarts = powerBlockerState.starts
        const openaiNoSleep = sm.create({ cwd: tmpRoot, isolated: false, providerId: openaiProvider.id, engine: 'openai', model: 'gpt-4.1-mini', title: 'budget-openai-no-sleep' })
        createdIds.push(openaiNoSleep.id)
        await waitFor(() => sm.get(openaiNoSleep.id)?.meta.sdkSessionId, 3000)
        sm.send(openaiNoSleep.id, 'openai should not start sleep blocker')
        await waitFor(() => eventsFor(openaiNoSleep.id).some((e) => e.kind === 'turn-result'), 3000)
        eq(powerBlockerState.starts, disabledPowerStarts, 'preventDisplaySleep=false should not start prevent-display-sleep')
        settingsMod.updateSettings({ preventDisplaySleep: true })
        openaiSession.meta.budgetUsd = cost / 2
        const beforeSecondRequest = openAiRequests
        sm.send(openai.id, 'openai should block before fetch')
        await waitFor(() => eventsFor(openai.id).some((e) => e.kind === 'status' && e.status === 'error' && String(e.error).includes('预算上限')), 2000)
        eq(openAiRequests, beforeSecondRequest, 'OpenAI 超预算后不应再发起请求')
      } finally {
        await new Promise((resolve) => server.close(resolve))
        delete process.env.OPENAI_API_KEY
        delete process.env.OPENAI_BASE_URL
      }
    } finally {
      for (const id of createdIds) sm.close(id)
      fakeWindows.splice(fakeWindows.indexOf(win), 1)
      providersMod.updateProvider('prov-b', { budgetUsd: 0 })
      settingsMod.updateSettings({ budgetUsdPerSession: 0, preventDisplaySleep: true })
    }
  })

  // ---- PLAN T9 检查点 chat/both SDK 上下文回退 ----
  await test('PLAN T9 checkpoint:chat restore 后下一次 start 注入 resumeSessionAt,both 先验 chat', async () => {
    settingsMod.updateSettings({ failoverEnabled: true, budgetUsdPerSession: 0 })
    const sm = M('main/sessionManager.js').sessionManager
    const hist = M('main/history.js')
    sm.init()
    fs.writeFileSync(path.join(userData, 'providers.json'), JSON.stringify([
      { id: 'prov-a', name: '甲网关', baseUrl: 'http://always429.mock', encryptedToken: 'b64:' + Buffer.from('k1').toString('base64'), models: ['m-a'], createdAt: 1 },
      { id: 'prov-b', name: '乙网关', baseUrl: 'http://ok.mock', encryptedToken: 'b64:' + Buffer.from('k2').toString('base64'), models: ['m-b'], createdAt: 2 }
    ], null, 2))
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    const eventsFor = (id) => bucket
      .filter((entry) => entry.channel === 'session:event' && entry.payload.sessionId === id)
      .map((entry) => entry.payload.event)
    const createdIds = []
    try {
      const meta = sm.create({ cwd: tmpRoot, isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b', title: 'checkpoint-history' })
      createdIds.push(meta.id)
      const session = sm.get(meta.id)
      await waitFor(() => session.meta.sdkSessionId, 3000)
      sm.send(meta.id, 'first checkpoint turn')
      await waitFor(() => eventsFor(meta.id).filter((e) => e.kind === 'turn-result').length >= 1, 3000)
      const firstCheckpoint = eventsFor(meta.id).find((e) => e.kind === 'checkpoint')?.messageId
      assert(firstCheckpoint, '第一轮未产生 checkpoint')
      sm.send(meta.id, 'second checkpoint turn')
      await waitFor(() => eventsFor(meta.id).filter((e) => e.kind === 'turn-result').length >= 2, 3000)
      const beforeBoth = sdkLog.filter((item) => item.rewindFiles === 'missing-checkpoint').length
      const badBoth = await session.restoreCheckpoint('missing-checkpoint', 'both', false)
      assert(!badBoth.canRewind && badBoth.chat && !badBoth.chat.ok, 'both 模式应先失败在 chat 校验')
      eq(sdkLog.filter((item) => item.rewindFiles === 'missing-checkpoint').length, beforeBoth, 'chat 校验失败时不应执行文件回退')

      const restored = await session.restoreCheckpoint(firstCheckpoint, 'chat', false)
      assert(restored.applied && restored.transcript, `chat restore 未应用:${JSON.stringify(restored)}`)
      const sdkSessionId = session.meta.sdkSessionId
      assert(sdkSessionId, '缺 sdkSessionId')
      await waitFor(() => hist.listHistory().some((entry) => entry.sdkSessionId === sdkSessionId && entry.resumeSessionAt === firstCheckpoint), 2000, '等待 history resumeSessionAt 持久化')
      const persistedHistory = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'))
      assert(persistedHistory.some((entry) => entry.sdkSessionId === sdkSessionId && entry.resumeSessionAt === firstCheckpoint), 'resumeSessionAt 未写入 sessions.json')

      sm.close(meta.id)
      const beforeResumeCreates = sdkLog.length
      const resumed = sm.create({ cwd: tmpRoot, isolated: false, engine: 'claude', providerId: 'prov-b', model: 'm-b', resumeSdkSessionId: sdkSessionId, title: 'checkpoint-resumed' })
      createdIds.push(resumed.id)
      await waitFor(
        () => sdkLog.slice(beforeResumeCreates).some((entry) => entry.resume === sdkSessionId && entry.resumeSessionAt === firstCheckpoint),
        5000,
        '等待 history 恢复后注入 resumeSessionAt'
      )
    } finally {
      for (const id of createdIds) sm.close(id)
      fakeWindows.splice(fakeWindows.indexOf(win), 1)
    }
  })

  // ---- T13 OpenAI 原生引擎:Responses API SSE → CaoGen 事件 ----
  await test('T13 openai engine:原生 Responses API 流式事件', async () => {
    const { openAIEngineFactory } = M('main/openaiEngine.js')
    eq(openAIEngineFactory.kind, 'openai', 'OpenAI 引擎 kind')
    assert(openAIEngineFactory.available(), 'OpenAI 引擎应在引擎列表中可选')

    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        eq(parsed.model, 'gpt-4.1-mini', 'OpenAI 请求模型')
        eq(req.headers.authorization, 'Bearer test-openai-key', 'OpenAI 鉴权头')
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        res.write('event: response.output_text.delta\n')
        res.write('data: {"type":"response.output_text.delta","delta":"你好"}\n\n')
        res.write('event: response.output_text.delta\n')
        res.write('data: {"type":"response.output_text.delta","delta":" OpenAI"}\n\n')
        res.write('event: response.completed\n')
        res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":7,"input_tokens_details":{"cached_tokens":3}}}}\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	    const baseUrl = `http://127.0.0.1:${server.address().port}`
	    const providersMod = M('main/providers.js')
	    const openaiProvider = providersMod.createProvider({
	      name: 'OpenAI direct engine mock',
	      baseUrl,
	      token: 'test-openai-key',
	      models: ['gpt-4.1-mini'],
	      openaiProtocol: 'responses'
	    })
	    try {
	      const events = []
	      const meta = AS.newSessionMeta({
	        cwd: tmpRoot,
	        model: 'gpt-4.1-mini',
	        providerId: openaiProvider.id,
	        engine: 'openai',
	        permissionMode: 'default',
	        title: 'openai-itest'
      })
      const engine = openAIEngineFactory.create(meta, (event, seq) => events.push({ event, seq }))
      await engine.start()
      eq(meta.status, 'idle', 'OpenAI start 后应 idle')
      engine.send('测试 OpenAI')
      await waitFor(() => events.some((entry) => entry.event.kind === 'turn-result'), 3000, '等待 OpenAI turn-result')
      assert(events.some((entry) => entry.event.kind === 'text-delta' && entry.event.text === '你好'), '缺 OpenAI delta')
      assert(events.some((entry) => entry.event.kind === 'assistant-message'), '缺 OpenAI assistant-message')
      const result = events.find((entry) => entry.event.kind === 'turn-result').event
      assert(!result.isError, 'OpenAI turn 不应失败')
      eq(result.usage.input, 11, 'OpenAI input usage')
      eq(result.usage.output, 7, 'OpenAI output usage')
      eq(result.usage.cacheRead, 3, 'OpenAI cached usage')
      eq(meta.contextTokens, 14, 'OpenAI context tokens')
      engine.dispose()
	    } finally {
	      await new Promise((resolve) => server.close(resolve))
	    }
	  })

  await test('P0 idempotency:OpenAI bypass 模式仍需确认未知结果操作', async () => {
    const { openAIEngineFactory } = M('main/openaiEngine.js')
    const taskRun = M('main/task/task-run.js')
    const runtime = M('main/task/task-runtime-registry.js').taskRuntimeRegistry
    const idempotency = M('main/task/tool-idempotency.js')
    const meta = AS.newSessionMeta({
      cwd: tmpRoot,
      model: 'm-b',
      providerId: 'prov-b',
      engine: 'openai',
      permissionMode: 'bypassPermissions',
      title: 'openai idempotency'
    })
    const events = []
    const engine = openAIEngineFactory.create(meta, (event, seq) => events.push({ event, seq }))
    const run = taskRun.createTaskRun({ id: 'openai-idempotency-run', sessionId: meta.id, taskId: meta.id })
    const input = { branch: 'main' }
    const key = idempotency.buildToolIdempotencyKey({ scopeId: run.sessionId, cwd: meta.cwd, toolName: 'git_push', toolInput: input })
    runtime.set(meta.id, {
      ...run,
      toolExecutions: [{
        id: `${run.id}:tool:old-push`,
        runId: run.id,
        sessionId: meta.id,
        toolUseId: 'old-push',
        toolName: 'git_push',
        status: 'unknown_outcome',
        idempotencyKey: key,
        createdAt: 1,
        updatedAt: 1
      }]
    })
    try {
      const decisionPromise = engine.gateTool('git_push', input, 'retry-push')
      await waitFor(() => events.some((entry) => entry.event.kind === 'permission-request'), 2000, '等待 OpenAI 幂等审批')
      const request = events.find((entry) => entry.event.kind === 'permission-request').event.request
      assert(request.decisionReason.includes('结果未知'), `OpenAI 幂等审批原因错误:${request.decisionReason}`)
      eq(request.duplicateExecutionId, `${run.id}:tool:old-push`, 'OpenAI 幂等审批应携带旧执行关联')
      engine.respondPermission(request.requestId, true)
      const decision = await decisionPromise
      assert(decision.allow, '用户确认后 OpenAI 操作应继续')
      meta.permissionMode = 'plan'
      const beforePlanRequests = events.filter((entry) => entry.event.kind === 'permission-request').length
      const planDecision = await engine.gateTool('git_push', input, 'plan-retry-push')
      assert(!planDecision.allow, 'OpenAI plan 模式必须优先于幂等确认')
      eq(
        events.filter((entry) => entry.event.kind === 'permission-request').length,
        beforePlanRequests,
        'OpenAI plan 模式不应弹出可突破硬拒绝的审批'
      )
    } finally {
      runtime.delete(meta.id)
      engine.dispose()
    }
	  })

  // ---- T14 fetchModels × 真 HTTP:鉴权/形状兼容/错误路径 ----
  await test('T14 fetchModels:真 HTTP 端点(两种响应形状 + 401)', async () => {
    const providers = M('main/providers.js')
    const server = http.createServer((req, res) => {
      const auth = req.headers['x-api-key'] || String(req.headers['authorization'] || '').replace('Bearer ', '')
      if (req.url === '/v1/models') {
        if (auth !== 'good-key') { res.writeHead(401); return res.end('{}') }
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ data: [{ id: 'model-x' }, { id: 'model-y' }, { id: 'model-x' }] }))
      }
      if (req.url === '/bare/v1/models') {
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify(['bare-1', 'bare-2']))
      }
      res.writeHead(404); res.end()
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const base = `http://127.0.0.1:${port}`
    const ids = await providers.fetchModels({ baseUrl: base, token: 'good-key' })
    assert(ids.ok, `fetchModels data 形状失败:${JSON.stringify(ids)}`)
    eq(JSON.stringify(ids.models), JSON.stringify(['model-x', 'model-y']), 'data 形状 + 去重')
    const bare = await providers.fetchModels({ baseUrl: `${base}/bare`, token: 'good-key' })
    assert(bare.ok, `fetchModels 裸数组失败:${JSON.stringify(bare)}`)
    eq(JSON.stringify(bare.models), JSON.stringify(['bare-1', 'bare-2']), '裸数组形状')
    const authFail = await providers.fetchModels({ baseUrl: base, token: 'bad-key' })
    assert(!authFail.ok && authFail.error?.kind === 'auth' && authFail.error?.status === 401, `401 未按结构化 auth 报错:${JSON.stringify(authFail)}`)
    eq(JSON.stringify(authFail.models), JSON.stringify([]), '失败时不得返回陈旧模型列表')
    server.close()
  })

  // ---- T15 迁移向导回归(真文件) ----
  await test('T15 迁移向导:扫描/导入/幂等回归', async () => {
    const mig = M('main/migration.js')
    const proj = path.join(tmpRoot, 'migproj')
    fs.mkdirSync(path.join(proj, '.cursor', 'rules'), { recursive: true })
    fs.writeFileSync(path.join(proj, '.cursorrules'), 'use pnpm')
    fs.writeFileSync(path.join(proj, '.cursor', 'rules', 'x.mdc'), 'rule x')
    fs.writeFileSync(path.join(proj, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { figma: { command: 'npx' } } }))
    const scan = mig.scanMigration(proj)
    assert(scan.assets.length >= 3, `扫描数量:${scan.assets.length}`)
    mig.importAssets(proj, scan.assets.map((a) => a.path))
    const claudeMd = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8')
    assert(claudeMd.includes('use pnpm') && claudeMd.includes('caogen:imported-begin'), 'CLAUDE.md 注入失败')
    const mcp = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'))
    assert(mcp.mcpServers.figma, '.mcp.json 合并失败')
    const second = mig.importAssets(proj, scan.assets.map((a) => a.path))
    assert(/跳过/.test(second), '幂等防护失效')

    // 新覆盖:Roo Code / Continue / Cline MCP / Aider CONVENTIONS.md
    const proj2 = path.join(tmpRoot, 'migproj2')
    fs.mkdirSync(path.join(proj2, '.roo', 'rules'), { recursive: true })
    fs.mkdirSync(path.join(proj2, '.continue', 'rules'), { recursive: true })
    fs.mkdirSync(path.join(proj2, '.cline'), { recursive: true })
    fs.writeFileSync(path.join(proj2, '.roorules'), 'roo 单文件规则')
    fs.writeFileSync(path.join(proj2, '.roo', 'rules', 'a.md'), 'roo 目录规则')
    fs.writeFileSync(path.join(proj2, '.continue', 'rules', 'c.md'), 'continue 规则')
    fs.writeFileSync(path.join(proj2, 'CONVENTIONS.md'), 'aider 约定')
    fs.writeFileSync(path.join(proj2, '.cline', 'mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'node' } } }))
    const scan2 = mig.scanMigration(proj2)
    const agents = new Set(scan2.assets.map((a) => a.agent))
    assert(agents.has('Roo Code'), 'Roo Code 未扫描到')
    assert(agents.has('Continue'), 'Continue 未扫描到')
    assert(agents.has('Aider'), 'Aider CONVENTIONS.md 未扫描到')
    assert(scan2.assets.some((a) => a.agent === 'Cline' && a.kind === 'mcp'), 'Cline MCP 未扫描到')
    mig.importAssets(proj2, scan2.assets.map((a) => a.path))
    const cm2 = fs.readFileSync(path.join(proj2, 'CLAUDE.md'), 'utf8')
    assert(cm2.includes('roo 单文件规则') && cm2.includes('continue 规则') && cm2.includes('aider 约定'), '新来源注入失败')
    const mcp2 = JSON.parse(fs.readFileSync(path.join(proj2, '.mcp.json'), 'utf8'))
    assert(mcp2.mcpServers.db, 'Cline MCP 合并失败')
  })

  // ---- T16 调度器回归 ----
  await test('T16 调度器:分类/能力表/故障目标回归', async () => {
    const s = M('main/scheduler.js')
    assert(s.classifyFailure('Insufficient credit balance').switchable, '余额分类')
    assert(!s.classifyFailure('error_max_turns').switchable, 'max_turns 不切换')
    const d = s.pickModel(['glm-4.5-air', 'kimi-k2-0711-preview'], '重构整个项目的架构', 'quality')
    eq(d.model, 'kimi-k2-0711-preview', '国产档位:复杂任务应选 k2(q3)')
    const fast = s.pickModel(['opus', 'haiku'], '重构整个项目的架构', 'speed')
    eq(fast.model, 'haiku', '速度优先应独立选择速度档最高的模型')
    assert(fast.reason.includes('速度优先'), '速度优先决策应说明策略')
  })

  // ---- T17 路由自学习:同档模型按实测可靠性打平改判 ----
  await test('T17 路由自学习:可靠性降权同档失败模型', async () => {
    const stats = M('main/modelStats.js')
    const s = M('main/scheduler.js')
    const os = require('node:os'), fs = require('node:fs'), path = require('node:path')
    stats.configureModelStatsDir(fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-t17-')))
    // deepseek-chat 与 glm-4.5 同为 quality 档;让 glm 连续失败、deepseek 连续成功
    for (let i = 0; i < 8; i++) { stats.recordModelSuccess('deepseek-chat', 800); stats.recordModelFailure('glm-4.5') }
    // 会话当前在 A(glm);均衡策略下,自学习应让位给可靠的 deepseek(跨厂商)
    const d = s.pickModelAcrossProviders({
      candidates: [{ id: 'a', name: 'A', models: ['glm-4.5'] }, { id: 'b', name: 'B', models: ['deepseek-chat'] }],
      text: '写个函数', strategy: 'balanced', currentProviderId: 'a'
    })
    eq(d.model, 'deepseek-chat', '自学习:可靠模型胜出(即便当前厂商是失败的 glm)')
  })

  // ---------------------------------------------------------------- 汇总
  await test('T18 P2 cross-validation: routing event creates review and arbitration child sessions', async () => {
    const sm = M('main/sessionManager.js').sessionManager
    const engineMod = M('main/engine.js')
    const previousSettings = { ...settingsMod.getSettings() }
    const sentInputs = []
    class CrossValidationMockEngine {
      constructor(meta, emit) {
        this.meta = meta
        this.emit = emit
        this.seq = 0
        this.transcript = []
      }
      async start() {
        this.meta.status = 'idle'
        this.meta.sdkSessionId = `p2-cross-${this.meta.id}`
        this.emit({ kind: 'init', sdkSessionId: this.meta.sdkSessionId, model: this.meta.model, tools: [] }, ++this.seq)
        this.emit({ kind: 'status', status: 'idle' }, ++this.seq)
      }
      send(input) {
        const text = typeof input === 'string' ? input : input.text
        sentInputs.push({ sessionId: this.meta.id, childRole: this.meta.childRole, text })
        const userEvent = { kind: 'user-message', text }
        this.transcript.push({ seq: ++this.seq, event: userEvent })
        this.emit(userEvent, this.seq)
        if (this.meta.childRole === 'model-review') {
          this.finish('Conclusion: ARBITRATION_REQUIRED. Primary output needs third-model arbitration.')
          return
        }
        if (this.meta.childRole === 'model-arbitration') {
          this.finish('Conclusion: FINAL. Arbitration finished.')
          return
        }
        this.emit({
          kind: 'routing',
          model: this.meta.model,
          providerId: this.meta.providerId,
	          reason: 'behavior smoke route plan',
	          crossValidationPlan: {
	            enabled: true,
	            primary: { providerId: 'prov-b', providerName: 'Primary', model: 'primary-model' },
	            validators: [
	              { providerId: 'prov-a', providerName: 'Reviewer', model: 'review-model' },
	              { providerId: 'prov-slow', providerName: 'Arbitrator', model: 'arb-model' }
	            ],
	            policy: 'review-primary',
	            reason: 'critical behavior smoke'
          }
        }, ++this.seq)
        this.finish('Primary implementation done.')
      }
      finish(resultText) {
        const event = { kind: 'turn-result', subtype: 'success', isError: false, resultText, durationMs: 1 }
        this.transcript.push({ seq: ++this.seq, event })
        this.emit(event, this.seq)
      }
      rejectSend(message) { this.finish(message) }
      async interrupt() {}
      respondPermission() {}
      pendingPermissions() { return [] }
      getTranscript() { return [...this.transcript] }
      async setPermissionMode(mode) { this.meta.permissionMode = mode }
      async setModel(model) { this.meta.model = model }
      rename(title) { this.meta.title = title }
      dispose() { this.meta.status = 'closed' }
    }
    engineMod.registerEngine({
      kind: 'p2-cross-validation-mock',
      label: 'P2 cross-validation mock',
      available: () => true,
      create: (meta, emit) => new CrossValidationMockEngine(meta, emit)
    })
    settingsMod.updateSettings({
      smartModelRoutingEnabled: true,
      modelCrossValidationAutoRunEnabled: true,
      autoSkillLearningEnabled: false,
      budgetUsdPerSession: 0
    })
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    const createdIds = []
    const eventsFor = (id) => bucket
      .filter((entry) => entry.channel === 'session:event' && entry.payload.sessionId === id)
      .map((entry) => entry.payload.event)
	    try {
	      const meta = sm.create({
	        cwd: tmpRoot,
	        isolated: false,
	        providerId: 'prov-b',
	        model: 'primary-model',
	        engine: 'p2-cross-validation-mock',
	        title: 'p2 cross validation behavior'
	      })
      createdIds.push(meta.id)
      await waitFor(() => sm.get(meta.id)?.meta.sdkSessionId, 3000, 'wait cross-validation parent init')
      sm.send(meta.id, 'implement critical migration')
      await waitFor(() => sm.list().some((item) => item.parentSessionId === meta.id && item.childRole === 'model-review'), 3000, 'wait model-review child')
      await waitFor(() => sm.list().some((item) => item.parentSessionId === meta.id && item.childRole === 'model-arbitration'), 3000, 'wait model-arbitration child')
      const review = sm.list().find((item) => item.parentSessionId === meta.id && item.childRole === 'model-review')
      const arbitration = sm.list().find((item) => item.parentSessionId === meta.id && item.childRole === 'model-arbitration')
      assert(review, 'model-review child missing')
      assert(arbitration, 'model-arbitration child missing')
      createdIds.push(review.id, arbitration.id)
      eq(review.permissionMode, 'plan', 'model-review child must be plan-only')
      eq(arbitration.permissionMode, 'plan', 'model-arbitration child must be plan-only')
	      eq(review.providerId, 'prov-a', 'review provider')
	      eq(review.model, 'review-model', 'review model')
	      eq(arbitration.providerId, 'prov-slow', 'arbitration provider')
	      eq(arbitration.model, 'arb-model', 'arbitration model')
      assert(eventsFor(meta.id).some((event) => event.kind === 'hook-event' && event.event === 'model-cross-validation'), 'parent missing model-cross-validation hook event')
      assert(eventsFor(meta.id).some((event) => event.kind === 'hook-event' && event.event === 'model-cross-validation-arbitration'), 'parent missing arbitration hook event')
      const reviewPrompt = sentInputs.find((item) => item.childRole === 'model-review')?.text || ''
      const arbitrationPrompt = sentInputs.find((item) => item.childRole === 'model-arbitration')?.text || ''
      assert(reviewPrompt.includes('Primary implementation done.'), 'review prompt missing primary result')
      assert(arbitrationPrompt.includes('ARBITRATION_REQUIRED'), 'arbitration prompt missing review disagreement')
    } finally {
      for (const id of createdIds.reverse()) sm.close(id)
      const index = fakeWindows.indexOf(win)
      if (index !== -1) fakeWindows.splice(index, 1)
      settingsMod.updateSettings({
        smartModelRoutingEnabled: previousSettings.smartModelRoutingEnabled,
        modelCrossValidationAutoRunEnabled: previousSettings.modelCrossValidationAutoRunEnabled,
        autoSkillLearningEnabled: previousSettings.autoSkillLearningEnabled,
        budgetUsdPerSession: previousSettings.budgetUsdPerSession
      })
    }
  })

  await test('T19 P2 auto skill loop: completed turn stores skill and next similar turn injects it', async () => {
    const sm = M('main/sessionManager.js').sessionManager
    const previousSettings = { ...settingsMod.getSettings() }
    settingsMod.updateSettings({
      autoSkillLearningEnabled: true,
      failoverEnabled: false,
      budgetUsdPerSession: 0
    })
    const projectDir = mkRepo('p2-auto-skill-loop')
    const bucket = []
    const win = fakeWindow(bucket)
    fakeWindows.push(win)
    const createdIds = []
    const skillFiles = () => {
      const root = path.join(projectDir, '.caogen', 'skills')
      const out = []
      const stack = fs.existsSync(root) ? [root] : []
      while (stack.length > 0) {
        const current = stack.pop()
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name)
          if (entry.isDirectory()) stack.push(full)
          else if (entry.isFile() && entry.name === 'SKILL.md') out.push(full)
        }
      }
      return out
	    }
	    try {
	      const meta = sm.create({
	        cwd: projectDir,
	        isolated: false,
	        engine: 'claude',
	        providerId: 'prov-b',
	        model: 'm-b',
	        title: 'Tailwind Config Learning Loop'
      })
      createdIds.push(meta.id)
      await waitFor(() => sm.get(meta.id)?.meta.sdkSessionId, 3000, 'wait auto skill session init')
      sm.send(
        meta.id,
        [
          'Add Tailwind configuration to a TypeScript frontend project.',
          'Reusable workflow: inspect package.json, create tailwind.config.ts, create postcss.config.js, run npm.cmd run typecheck, then run npm.cmd run build.',
          'Persist this as a reusable Tailwind configuration workflow after the task succeeds.'
        ].join('\n')
      )
      await waitFor(() => skillFiles().length > 0, 5000, 'wait auto skill file')
      const skillPath = skillFiles()[0]
      const skillText = fs.readFileSync(skillPath, 'utf8')
      assert(skillText.includes('Tailwind Config Learning Loop'), 'stored skill should keep task title')
      assert(skillPath.startsWith(path.join(projectDir, '.caogen', 'skills')), 'stored skill must stay under project skill root')

      const beforeSecond = sdkLog.length
      sm.send(meta.id, 'Please add Tailwind config to another frontend project and reuse the local workflow.')
      await waitFor(() => sdkLog.slice(beforeSecond).some((entry) => typeof entry.promptText === 'string'), 3000, 'wait second prompt')
      const secondPrompt = sdkLog
        .slice(beforeSecond)
        .filter((entry) => typeof entry.promptText === 'string')
        .map((entry) => entry.promptText)
        .join('\n')
      assert(secondPrompt.includes('Tailwind Config Learning Loop'), 'next similar turn should inject generated skill')
      assert(secondPrompt.includes('## Current User Request'), 'injected skill prompt should preserve user request boundary')
    } finally {
      for (const id of createdIds.reverse()) sm.close(id)
      const index = fakeWindows.indexOf(win)
      if (index !== -1) fakeWindows.splice(index, 1)
      settingsMod.updateSettings({
        autoSkillLearningEnabled: previousSettings.autoSkillLearningEnabled,
        failoverEnabled: previousSettings.failoverEnabled,
        budgetUsdPerSession: previousSettings.budgetUsdPerSession
      })
    }
  })

  const pass = results.filter((r) => r.ok).length
  console.log('\n========== CaoGen 集成测试结果 ==========')
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`)
    if (!r.ok) console.log('    ' + String(r.err).split('\n').slice(0, 4).join('\n    '))
  }
  console.log(`----------------------------------------\n${pass}/${results.length} 通过`)
  process.exitCode = pass === results.length ? 0 : 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })

function npxCommand() {
  return process.platform === 'win32' ? 'cmd' : 'npx'
}

function npxArgs(args) {
  return process.platform === 'win32' ? ['/c', 'npx', ...args] : args
}
