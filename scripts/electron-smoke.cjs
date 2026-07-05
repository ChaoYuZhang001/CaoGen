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
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-smoke-'))
process.env.CAOGEN_USER_DATA_DIR = tmpUserData

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

async function run() {
  // 1. 加载真实主进程模块(编译产物),验证在真 Electron 下 require 不崩
  let ipcMod, smMod
  try {
    ipcMod = require(path.join(repoOut, 'index.js'))
    check('主进程 index.js 在真 Electron 下加载', true)
  } catch (err) {
    check('主进程 index.js 加载', false, String(err && err.message))
    // index.js 会自己 app.whenReady + createWindow,失败则直接汇总
    return finish()
  }

  // index.js 已在模块内注册好生命周期;等一拍让 whenReady 回调跑完
  await new Promise((r) => setTimeout(r, 800))

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

  // 3. 创建真会话(会 spawn SDK 子进程;无 Key/网络会失败,但不应让主进程崩)
  try {
    const meta = await invoke('sessions:create', { cwd: tmpUserData, model: '', providerId: '' })
    check('IPC sessions:create 返回会话 meta', meta && typeof meta.id === 'string', `id=${meta && meta.id}`)
    if (meta && meta.id) {
      await new Promise((r) => setTimeout(r, 300))
      const list = await invoke('sessions:list')
      check('新建会话进入列表', list.some((s) => s.id === meta.id))
      await invoke('sessions:close', meta.id)
      check('IPC sessions:close 可调用', true)
    }
  } catch (e) { check('IPC sessions:create/close', false, String(e.message)) }

  finish()
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
