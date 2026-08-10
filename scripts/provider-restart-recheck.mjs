import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(outMain)) {
  throw new Error('缺少 out/main/index.js;请先运行 npm run build')
}

const electron = process.platform === 'win32'
  ? path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(repoRoot, 'node_modules', '.bin', 'electron')
if (!existsSync(electron)) throw new Error('缺少 Electron 可执行文件;请先运行 npm install')
execFileSync(electron, [path.join(repoRoot, 'scripts', 'provider-restart-recheck-electron.cjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env
})
