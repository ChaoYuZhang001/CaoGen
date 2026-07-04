#!/usr/bin/env node
/**
 * CaoGen 扩充集成测试 — 覆盖并行开发新增、尚未被 integration-test.cjs 覆盖的模块:
 * fileOps(编辑器读写+越界防护)、attachmentOps(图片输入)、memoryStore(记忆)、
 * routineStore(本地 Routines)、previewOps(产物预览)、pluginRegistry(生态扫描)、
 * desktopNotify(通知)。目标是找真实缺陷,不是刷绿。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const repo = path.resolve(__dirname, '..')
const buildDir = path.join(os.tmpdir(), 'caogen-itest2-build')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-itest2-'))
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
const tsc = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsc', ...files, '--outDir', buildDir, '--module', 'commonjs', '--target', 'es2022',
    '--moduleResolution', 'node', '--skipLibCheck', '--esModuleInterop'],
  { cwd: repo, encoding: 'utf8' })
if (!fs.existsSync(path.join(buildDir, 'main', 'fileOps.js'))) {
  console.error(tsc.stdout, tsc.stderr); throw new Error('编译失败')
}

const notifications = []
const electronStub = {
  app: { getPath: (k) => (k === 'userData' ? userData : tmpRoot), isPackaged: false, getName: () => 'CaoGen', getVersion: () => '0.1.0' },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class { constructor(o) { this.o = o } on() {} once() {} show() { notifications.push(this.o) } static isSupported() { return true } },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false, resize: () => ({ toDataURL: () => 'data:image/png;base64,AAAA' }), toDataURL: () => 'data:image/png;base64,AAAA' }) }
}
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}
const M = (p) => require(path.join(buildDir, p))

async function main() {
  // ---- F1 fileOps 读写 + 越界/符号链接/二进制防护 ----
  await test('F1 fileOps:读写往返 + 越界/二进制/符号链接防护', async () => {
    const fo = M('main/fileOps.js')
    const proj = path.join(tmpRoot, 'foproj'); fs.mkdirSync(path.join(proj, 'sub'), { recursive: true })
    // 写 → 读往返
    const w = await fo.writeTextFile(proj, 'sub/note.md', '# 你好\nCaoGen')
    assert(w.ok, `写失败:${w.error || ''}`)
    const r = await fo.readTextFile(proj, 'sub/note.md')
    assert(r.ok && r.content.includes('CaoGen'), '读回内容不符')
    // 越界写(../)必须拒绝
    const esc = await fo.writeTextFile(proj, '../escape.md', 'x')
    assert(!esc.ok, '越界写未被拒绝')
    // 越界读
    fs.writeFileSync(path.join(tmpRoot, 'secret.txt'), 'TOP SECRET')
    const escR = await fo.readTextFile(proj, '../secret.txt')
    assert(!escR.ok, '越界读未被拒绝')
    // 绝对路径拒绝
    const abs = await fo.readTextFile(proj, '/etc/hostname')
    assert(!abs.ok, '绝对路径未被拒绝')
    // 二进制拒绝
    fs.writeFileSync(path.join(proj, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const binR = await fo.readTextFile(proj, 'bin.dat')
    assert(!binR.ok, '二进制文件未被拒绝')
    // 列目录跳过 node_modules
    fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(proj, 'node_modules', 'x', 'a.js'), '1')
    const list = await fo.listProjectFiles(proj)
    assert(list.ok && !list.entries.some((e) => e.path.includes('node_modules')), 'node_modules 未被忽略')
  })

  // ---- F2 attachmentOps 图片输入 ----
  await test('F2 attachmentOps:图片落盘 + 非图片拒绝', async () => {
    const ao = M('main/attachmentOps.js')
    assert(typeof ao.copyImageAttachment === 'function', `缺 copyImageAttachment(实际:${Object.keys(ao).join(',')})`)
    const attachRoot = path.join(userData, 'attachments')
    const png = path.join(tmpRoot, 'shot.png')
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]))
    const res = await ao.copyImageAttachment(png, attachRoot, { sessionId: 's1' })
    assert(res && res.ok, `图片保存失败:${res && res.error}`)
    assert(res.path && fs.existsSync(res.path), '附件未落盘')
    const txt = path.join(tmpRoot, 'x.txt'); fs.writeFileSync(txt, 'hi')
    const bad = await ao.copyImageAttachment(txt, attachRoot, { sessionId: 's1' })
    assert(bad && !bad.ok, '非图片未被拒绝')
    // 图片转 content block(SDK 多模态消息体)
    if (typeof ao.imageToContentBlock === 'function') {
      const block = await ao.imageToContentBlock(res.path)
      assert(block && (block.type === 'image'), `content block 形状异常:${JSON.stringify(block).slice(0, 120)}`)
    }
  })

  // ---- F3 memoryStore 记忆读写(确认制) ----
  await test('F3 memoryStore:草稿提议/确认/持久化', async () => {
    const ms = M('main/memoryStore.js')
    const proj = path.join(tmpRoot, 'memproj'); fs.mkdirSync(proj, { recursive: true })
    const memRoot = path.join(userData, 'memory')
    const draft = await ms.proposeMemoryDraft(proj, memRoot, {
      kind: 'command', title: '构建命令', body: '本项目用 pnpm 构建', source: 'itest', reason: '用户纠正'
    })
    assert(draft && draft.id, `提议无 id:${JSON.stringify(draft)}`)
    let read = await ms.readProjectMemory(proj, memRoot)
    assert((read.drafts || []).some((d) => d.id === draft.id), `未见草稿:${JSON.stringify(read).slice(0, 160)}`)
    // 确认制:草稿必须显式接受才成为正式记忆(避免记错毒化)
    await ms.acceptMemoryDraft(proj, memRoot, draft.id)
    read = await ms.readProjectMemory(proj, memRoot)
    assert(JSON.stringify(read.entries || []).includes('pnpm'), '确认后记忆未持久化')
  })

  // ---- F4 routineStore 本地 Routines CRUD ----
  await test('F4 routineStore:创建/列出/更新/标记运行/删除', async () => {
    const rs = M('main/routineStore.js')
    const root = path.join(userData, 'rt')
    const created = await rs.createRoutine(root, {
      name: '每日依赖审计', prompt: '检查过时依赖', projectCwd: tmpRoot, schedule: '0 9 * * *'
    })
    assert(created && created.id, `创建无 id:${JSON.stringify(created)}`)
    const all = await rs.listRoutines(root)
    assert(Array.isArray(all) && all.some((x) => x.name === '每日依赖审计'), 'Routine 未持久化')
    const upd = await rs.updateRoutine(root, created.id, { name: '每日依赖审计(改)' })
    assert(upd && upd.name === '每日依赖审计(改)', '更新失败')
    await rs.markRun(root, created.id, { status: 'success' })
    const del = await rs.deleteRoutine(root, created.id)
    assert(del === true, '删除失败')
    assert((await rs.listRoutines(root)).length === 0, '删除后仍存在')
  })

  // ---- F5 previewOps 产物类型探测 ----
  await test('F5 previewOps:PDF/表格/HTML/文本类型探测', async () => {
    const po = M('main/previewOps.js')
    const proj = tmpRoot
    for (const [name, bytes] of [
      ['a.pdf', '%PDF-1.4\n'], ['a.html', '<!doctype html>'], ['a.csv', 'x,y\n1,2'], ['a.md', '# hi']
    ]) fs.writeFileSync(path.join(proj, name), bytes)
    const pdf = await po.detectPreview(proj, 'a.pdf')
    assert(pdf && !pdf.error, `PDF 探测报错:${JSON.stringify(pdf)}`)
    const csv = await po.detectPreview(proj, 'a.csv')
    assert(csv && !csv.error, `CSV 探测报错:${JSON.stringify(csv)}`)
    const html = await po.detectPreview(proj, 'a.html')
    assert(html && !html.error, `HTML 探测报错:${JSON.stringify(html)}`)
  })

  // ---- F6 pluginRegistry 扫描(真 .claude 目录结构) ----
  await test('F6 pluginRegistry:扫描 skills', async () => {
    const pr = M('main/pluginRegistry.js')
    assert(typeof pr.scanPluginRegistry === 'function', `缺 scanPluginRegistry:${Object.keys(pr).join(',')}`)
    const claudeDir = path.join(tmpRoot, 'fake-claude')
    fs.mkdirSync(path.join(claudeDir, 'skills', 'my-skill'), { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: 测试技能\n---\n内容')
    const res = pr.scanPluginRegistry([claudeDir])
    assert(JSON.stringify(res).includes('my-skill'), `未扫到 skill:${JSON.stringify(res).slice(0, 200)}`)
  })

  // ---- F7 desktopNotify(mock Notification) ----
  await test('F7 desktopNotify:发出通知不抛错', async () => {
    const dn = M('main/desktopNotify.js')
    dn.showDesktopNotification({ title: '任务完成', body: '本轮结束', sessionId: 's1' })
    assert(notifications.length > 0, '通知未发出')
    eq(notifications[notifications.length - 1].title, '任务完成', '通知标题')
  })

  const pass = results.filter((r) => r.ok).length
  console.log('\n===== CaoGen 扩充集成测试(新模块)=====')
  for (const r of results) {
    console.log(`${r.ok ? '✅ PASS' : '❌ FAIL'}  ${r.name}`)
    if (!r.ok) console.log('    ' + String(r.err).split('\n').slice(0, 3).join('\n    '))
  }
  console.log(`--------------------------------------\n${pass}/${results.length} 通过`)
  process.exitCode = pass === results.length ? 0 : 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
