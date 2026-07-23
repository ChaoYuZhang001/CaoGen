/**
 * CaoGen 深度冒烟测试:在真 Electron 主进程 runtime 里启动应用后端,
 * 通过真 ipcMain.handle 调用核心 IPC 通道,验证:
 *   - app 能 whenReady、模块能在真 Electron 下加载(不是 tsc stub)
 *   - sessionManager.init() + registerIpc() 真实执行不崩
 *   - 关键 IPC 通道真实可调用并返回合理结构
 * 用 xvfb 提供虚拟显示;headless(不建可见窗口)。
 *
 * 运行: xvfb-run -a electron scripts/electron-smoke.cjs
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-smoke-'))
const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-smoke-project-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData
const finderLaunchCwd = path.parse(repoOut).root
process.chdir(finderLaunchCwd)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
}

async function invoke(channel, ...args) {
  // 直接调用 ipcMain 注册的 handler(绕过渲染进程),模拟渲染进程 invoke
  const handlers = ipcMain._invokeHandlers || ipcMain._handlers
  // Electron 未公开 handler map;改用发消息不可行,故用 ipcMain.emit 无法拿返回。
  // 用内部 map(Electron 40 为 _invokeHandlers)。
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  const handler = map.get(channel)
  return handler({}, ...args)
}

async function invokeTrusted(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`通道未注册: ${channel}`)
  const window = await waitForTrustedWindow()
  const sender = window.webContents
  return map.get(channel)({
    sender,
    senderFrame: sender.mainFrame
  }, ...args)
}

async function run() {
  // 1. 加载真实主进程模块(编译产物),验证在真 Electron 下 require 不崩
  try {
    require(path.join(repoOut, 'index.js'))
    check('主进程 index.js 在真 Electron 下加载', true)
    check('Finder/Dock 根目录 cwd 启动', process.cwd() === finderLaunchCwd, `cwd=${process.cwd()}`)
  } catch (err) {
    check('主进程 index.js 加载', false, String(err && err.message))
    // index.js 会自己 app.whenReady + createWindow,失败则直接汇总
    return finish()
  }

  // init() performs recovery/migration before registerIpc(); wait for the
  // actual registration instead of relying on a timing-sensitive fixed delay.
  await waitForHandler('sessions:list')

  // 2. 核心 IPC 通道可调用
  try {
    const sessions = await invoke('sessions:list')
    check('IPC sessions:list 可调用', Array.isArray(sessions), `返回 ${JSON.stringify(sessions).slice(0, 40)}`)
  } catch (e) { check('IPC sessions:list', false, String(e.message)) }

  try {
    const settings = await invoke('settings:get')
    check('IPC settings:get 返回设置对象', settings && typeof settings === 'object' && 'schedulerStrategy' in settings, JSON.stringify(settings).slice(0, 60))
  } catch (e) { check('IPC settings:get', false, String(e.message)) }

  try {
    const engines = await invoke('engines:list')
    check('IPC engines:list 含 claude 引擎', Array.isArray(engines) && engines.some((x) => x.kind === 'claude'), JSON.stringify(engines).slice(0, 80))
  } catch (e) { check('IPC engines:list', false, String(e.message)) }

  try {
    const providers = await invoke('providers:list')
    check('IPC providers:list 可调用', Array.isArray(providers))
  } catch (e) { check('IPC providers:list', false, String(e.message)) }

  try {
    const health = await invoke('providers:health')
    check('IPC providers:health 可调用', Array.isArray(health))
  } catch (e) { check('IPC providers:health', false, String(e.message)) }

  await exerciseNativeDomainIpc()

  // 3. 创建真会话(会 spawn SDK 子进程;无 Key/网络会失败,但不应让主进程崩)
  try {
    prepareGitProject(tmpProject)
    const provider = await invoke('providers:create', {
      name: 'Smoke OpenAI',
      baseUrl: 'http://127.0.0.1:9',
      token: 'smoke-key',
      models: ['smoke-model'],
      openaiProtocol: 'responses'
    })
    const meta = await invoke('sessions:create', {
      cwd: tmpProject,
      engine: 'openai',
      providerId: provider.id,
      model: 'smoke-model',
      isolated: false
    })
    check('IPC sessions:create 返回会话 meta', meta && typeof meta.id === 'string', `id=${meta && meta.id}`)
    if (meta && meta.id) {
      await new Promise((r) => setTimeout(r, 300))
      const list = await invoke('sessions:list')
      check('新建会话进入列表', list.some((s) => s.id === meta.id))
      const mutation = await exerciseRendererMutations(meta.id)
      recordRendererMutationChecks(mutation)
      await invoke('sessions:close', meta.id)
      check('IPC sessions:close 可调用', true)
    }
  } catch (e) { check('IPC sessions:create/close', false, String(e.message)) }

  finish()
}

async function exerciseNativeDomainIpc() {
  try {
    const workspace = await invokeTrusted('projectWorkspace:invoke', 'create', {
      id: 'electron-smoke-workspace',
      name: 'Electron smoke workspace',
      kind: 'software'
    })
    const workspaces = await invokeTrusted('projectWorkspace:invoke', 'list')
    check(
      'IPC ProjectWorkspace 创建和读取',
      workspace?.id === 'electron-smoke-workspace' && workspaces.some((item) => item.id === workspace.id)
    )
  } catch (error) {
    check('IPC ProjectWorkspace 创建和读取', false, String(error.message))
  }

  try {
    const role = await invokeTrusted('digitalWorker:invoke', {
      action: 'createDigitalWorkerRoleTemplate',
      payload: { input: {
        id: 'electron-smoke-role',
        name: 'Developer',
        purpose: 'Exercise the trusted DigitalWorker IPC boundary'
      } }
    })
    const worker = await invokeTrusted('digitalWorker:invoke', {
      action: 'createDigitalWorker',
      payload: { input: {
        id: 'electron-smoke-worker',
        projectId: 'electron-smoke-workspace',
        roleTemplateId: role.id,
        displayName: 'Smoke Worker'
      } }
    })
    const workers = await invokeTrusted('digitalWorker:invoke', {
      action: 'listDigitalWorkers',
      payload: { options: { projectId: 'electron-smoke-workspace' } }
    })
    check(
      'IPC DigitalWorker 创建和读取',
      worker?.id === 'electron-smoke-worker' && workers.some((item) => item.id === worker.id)
    )
  } catch (error) {
    check('IPC DigitalWorker 创建和读取', false, String(error.message))
  }
}

async function waitForHandler(channel, timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const map = ipcMain._invokeHandlers
    if (map && map.has(channel)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待 IPC 通道注册超时: ${channel}`)
}

async function waitForTrustedWindow(timeoutMs = 10000) {
  const expectedUrl = pathToFileURL(path.join(repoOut, '../renderer/index.html')).href
  const startedAt = Date.now()
  let actualUrl = ''
  while (Date.now() - startedAt < timeoutMs) {
    const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    if (window) {
      const sender = window.webContents
      actualUrl = sender.mainFrame.url
      if (!sender.isLoadingMainFrame() && actualUrl === expectedUrl) return window
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待可信 CaoGen renderer 超时: expected=${expectedUrl} actual=${actualUrl || 'none'}`)
}

function prepareGitProject(projectDir) {
  git(projectDir, ['init', '-b', 'main'])
  git(projectDir, ['config', 'user.email', 'electron-smoke@example.test'])
  git(projectDir, ['config', 'user.name', 'Electron Smoke'])
  fs.writeFileSync(path.join(projectDir, 'base.txt'), 'base\n', 'utf8')
  fs.writeFileSync(path.join(projectDir, 'hunk.txt'), 'hunk base\n', 'utf8')
  fs.writeFileSync(path.join(projectDir, 'discard.txt'), 'discard base\n', 'utf8')
  git(projectDir, ['add', 'base.txt', 'hunk.txt', 'discard.txt'])
  git(projectDir, ['commit', '-m', 'base'])
  const hook = path.join(projectDir, '.git', 'hooks', 'pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 9\n', 'utf8')
  fs.chmodSync(hook, 0o755)
}

async function exerciseRendererMutations(sessionId) {
  const saved = await invoke('files:write', sessionId, 'renderer.txt', 'renderer\n')
  const contentMatches = fs.readFileSync(path.join(tmpProject, 'renderer.txt'), 'utf8') === 'renderer\n'
  const gitIndex = await exerciseRendererGitIndexMutations(sessionId)
  const committed = await invoke('git:commit', sessionId, 'renderer gateway commit')
  return {
    saved: saved.ok === true && contentMatches,
    saveDetail: JSON.stringify(saved).slice(0, 100),
    gitIndex,
    indexHookStayedInert: gitIndex.hookStayedInert,
    committed: committed.ok === true,
    commitDetail: JSON.stringify(committed).slice(0, 100)
  }
}

function recordRendererMutationChecks(mutation) {
  check('IPC files:write 经过 Effect Gateway', mutation.saved, mutation.saveDetail)
  check('IPC git:stage 经过 Git index Effect Gateway', mutation.gitIndex.staged, mutation.gitIndex.stageDetail)
  check('IPC git:unstage 经过 Git index Effect Gateway', mutation.gitIndex.unstaged, mutation.gitIndex.unstageDetail)
  check('IPC git:stageAll 经过 Git index Effect Gateway', mutation.gitIndex.stagedAll, mutation.gitIndex.stageAllDetail)
  check('IPC workspace:applyHunk 经过 Git index Effect Gateway', mutation.gitIndex.appliedHunk, mutation.gitIndex.hunkDetail)
  check('IPC workspace:discardHunk 经过文件 Effect Gateway', mutation.gitIndex.discardedHunk, mutation.gitIndex.discardDetail)
  check('Git index operation 快照完成后无残留', mutation.gitIndex.snapshotsCleared, mutation.gitIndex.snapshotDetail)
  check('Git index operation 不执行仓库 post-index-change hook', mutation.indexHookStayedInert, mutation.gitIndex.hookDetail)
  check('IPC git:commit 经过 Gateway 且禁用 hooks', mutation.committed, mutation.commitDetail)
}

async function exerciseRendererGitIndexMutations(sessionId) {
  installPostIndexChangeHook(tmpProject)
  const basePath = path.join(tmpProject, 'base.txt')
  fs.writeFileSync(basePath, 'base\nstage-selected\n', 'utf8')
  const stageProbe = await invokeWithoutPostIndexHook('git:stage', sessionId, ['base.txt'])
  const stage = stageProbe.result
  const stageCached = gitDiff(['--cached', '--', 'base.txt'])
  const stageWorktree = gitDiff(['--', 'base.txt'])

  fs.appendFileSync(basePath, 'worktree-only\n', 'utf8')
  const unstageProbe = await invokeWithoutPostIndexHook('git:unstage', sessionId, ['base.txt'])
  const unstage = unstageProbe.result
  const unstageCached = gitDiff(['--cached', '--', 'base.txt'])
  const unstageWorktree = gitDiff(['--', 'base.txt'])

  fs.writeFileSync(path.join(tmpProject, 'stage-all.txt'), 'stage all\n', 'utf8')
  const stageAllProbe = await invokeWithoutPostIndexHook('git:stageAll', sessionId)
  const stageAll = stageAllProbe.result
  const stageAllCached = gitDiff(['--cached', '--', 'base.txt', 'renderer.txt', 'stage-all.txt'])
  const stageAllWorktree = gitDiff(['--', 'base.txt', 'renderer.txt', 'stage-all.txt'])

  const hunkPath = path.join(tmpProject, 'hunk.txt')
  fs.writeFileSync(hunkPath, 'hunk base\nhunk staged\n', 'utf8')
  const hunkPatch = gitDiff(['--binary', '--', 'hunk.txt'])
  const hunkProbe = await invokeWithoutPostIndexHook('workspace:applyHunk', sessionId, 'hunk.txt', hunkPatch)
  const applyHunk = hunkProbe.result
  const hunkCached = gitDiff(['--cached', '--', 'hunk.txt'])
  const hunkWorktree = gitDiff(['--', 'hunk.txt'])

  const discardPath = path.join(tmpProject, 'discard.txt')
  fs.writeFileSync(discardPath, 'discard base\ndiscard must remain\n', 'utf8')
  const discardPatch = gitDiff(['--binary', '--', 'discard.txt'])
  const discardBefore = captureFileDiffState('discard.txt')
  const discardProbe = await invokeWithoutPostIndexHook('workspace:discardHunk', sessionId, 'discard.txt', discardPatch)
  const discard = discardProbe.result
  const discardAfter = captureFileDiffState('discard.txt')
  const snapshots = await invoke('taskSnapshots:list')
  const operationSnapshots = snapshots.filter((snapshot) => snapshot.run?.operation)

  return {
    staged: confirmedOperation(stage) && stageCached.includes('stage-selected') && stageWorktree === '',
    stageDetail: operationDetail(stage, stageCached, stageWorktree),
    unstaged: confirmedOperation(unstage) && unstageCached === '' &&
      unstageWorktree.includes('stage-selected') && unstageWorktree.includes('worktree-only'),
    unstageDetail: operationDetail(unstage, unstageCached, unstageWorktree),
    stagedAll: confirmedOperation(stageAll) &&
      ['stage-selected', 'worktree-only', 'renderer', 'stage all'].every((text) => stageAllCached.includes(text)) &&
      stageAllWorktree === '',
    stageAllDetail: operationDetail(stageAll, stageAllCached, stageAllWorktree),
    appliedHunk: confirmedOperation(applyHunk) && hunkCached.includes('hunk staged') && hunkWorktree === '',
    hunkDetail: operationDetail(applyHunk, hunkCached, hunkWorktree),
    discardedHunk: confirmedOperation(discard) && discardAfter.content === 'discard base\n' &&
      discardAfter.cached === discardBefore.cached && discardAfter.worktree === '',
    discardDetail: `${JSON.stringify(discard).slice(0, 120)} before=${JSON.stringify(discardBefore)} after=${JSON.stringify(discardAfter)}`,
    snapshotsCleared: operationSnapshots.length === 0,
    snapshotDetail: `operationSnapshots=${operationSnapshots.map((snapshot) => snapshot.id).join(',') || 'none'}`,
    hookStayedInert: [stageProbe, unstageProbe, stageAllProbe, hunkProbe, discardProbe].every((probe) => !probe.hookRan),
    hookDetail: [stageProbe, unstageProbe, stageAllProbe, hunkProbe, discardProbe]
      .map((probe) => `${probe.channel}=${probe.hookRan ? 'ran' : 'inert'}`)
      .join(',')
  }
}

async function invokeWithoutPostIndexHook(channel, ...args) {
  fs.rmSync(postIndexHookMarker(tmpProject), { force: true })
  const result = await invoke(channel, ...args)
  const hookRan = fs.existsSync(postIndexHookMarker(tmpProject))
  fs.rmSync(postIndexHookMarker(tmpProject), { force: true })
  return { channel, result, hookRan }
}

function confirmedOperation(result) {
  return result?.ok === true && result.effectStatus === 'confirmed' &&
    typeof result.operationId === 'string' && result.operationId.length > 0
}

function operationDetail(result, cachedDiff, worktreeDiff) {
  return `${JSON.stringify(result).slice(0, 100)} cached=${cachedDiff.length} worktree=${worktreeDiff.length}`
}

function captureFileDiffState(file) {
  return {
    content: fs.readFileSync(path.join(tmpProject, file), 'utf8'),
    cached: gitDiff(['--cached', '--', file]),
    worktree: gitDiff(['--', file])
  }
}

function postIndexHookMarker(projectDir) {
  return path.join(projectDir, '.git', 'post-index-change-ran')
}

function installPostIndexChangeHook(projectDir) {
  const hook = path.join(projectDir, '.git', 'hooks', 'post-index-change')
  fs.rmSync(postIndexHookMarker(projectDir), { force: true })
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nprintf ran > ${JSON.stringify(postIndexHookMarker(projectDir))}\n`,
    'utf8'
  )
  fs.chmodSync(hook, 0o755)
}

function gitDiff(args) {
  return git(tmpProject, ['diff', '--no-ext-diff', '--no-textconv', ...args]).trim()
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  })
}

function finish() {
  const pass = results.filter((r) => r.ok).length
  console.log('\n===== CaoGen 真 Electron 深度冒烟 =====')
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`)
  }
  console.log(`--------------------------------------\n${pass}/${results.length} 通过`)
  app.exit(pass === results.length ? 0 : 1)
}

app.whenReady().then(run).catch((e) => {
  console.error('smoke 崩溃:', e)
  app.exit(1)
})
