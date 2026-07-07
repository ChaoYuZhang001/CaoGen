/**
 * pluginInstall 冒烟:独立编译 + 临时目录真实安装/覆盖/卸载/路径牢笼断言。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-plugininstall-build-'))
execFileSync(process.execPath, [path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'), 'src/main/pluginInstall.ts', '--outDir', buildDir, '--target', 'ES2022', '--module', 'commonjs', '--esModuleInterop', '--skipLibCheck'], { cwd: repoRoot, stdio: 'inherit' })
const { installLocalPlugin, uninstallPlugin } = await import(pathToFileURL(path.join(buildDir, 'pluginInstall.js')).href)

function assert(cond, msg) { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1) } }

const root = mkdtempSync(path.join(tmpdir(), 'caogen-plugins-root-'))
const src = mkdtempSync(path.join(tmpdir(), 'caogen-plugin-src-'))
writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ name: 'demo-plugin', version: '1.2.3', permissions: ['bash'] }))
writeFileSync(path.join(src, 'index.md'), '# demo')

// 1. 正常安装
let r = installLocalPlugin(src, root)
assert(r.ok && r.name === 'demo-plugin', `install ok: ${JSON.stringify(r)}`)
assert(existsSync(path.join(root, 'demo-plugin', 'plugin.json')), 'copied manifest exists')

// 2. 重复安装被拒
r = installLocalPlugin(src, root)
assert(!r.ok && /已存在/.test(r.error), `duplicate rejected: ${JSON.stringify(r)}`)

// 3. 覆盖安装(旧版进回收站)
r = installLocalPlugin(src, root, { overwrite: true })
assert(r.ok, `overwrite ok: ${JSON.stringify(r)}`)
assert(readdirSync(path.join(root, '.trash')).length === 1, 'old version trashed')

// 4. 卸载 → 回收站
r = uninstallPlugin(path.join(root, 'demo-plugin'), root)
assert(r.ok && r.trashedTo.includes('.trash'), `uninstall trashed: ${JSON.stringify(r)}`)
assert(!existsSync(path.join(root, 'demo-plugin')), 'plugin dir gone')
assert(readdirSync(path.join(root, '.trash')).length === 2, 'trash has both')

// 5. 路径牢笼:越界卸载被拒
r = uninstallPlugin(path.join(root, '..', 'evil'), root)
assert(!r.ok, 'jail escape rejected')
r = uninstallPlugin(root, root)
assert(!r.ok, 'root itself rejected')

// 6. 非插件目录被拒
const empty = mkdtempSync(path.join(tmpdir(), 'caogen-empty-'))
r = installLocalPlugin(empty, root)
assert(!r.ok && /不像插件/.test(r.error), `non-plugin rejected: ${JSON.stringify(r)}`)

// 7. manifest 名清洗(路径注入)
const evil = mkdtempSync(path.join(tmpdir(), 'caogen-evil-'))
writeFileSync(path.join(evil, 'plugin.json'), JSON.stringify({ name: '../../escape' }))
r = installLocalPlugin(evil, root)
assert(r.ok && !r.installedPath.includes('..'), `name sanitized: ${JSON.stringify(r)}`)
assert(existsSync(path.join(root, r.name)), 'sanitized target inside root')

rmSync(root, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true })
rmSync(empty, { recursive: true, force: true }); rmSync(evil, { recursive: true, force: true })
rmSync(buildDir, { recursive: true, force: true })
console.log('pluginInstall smoke ok')
