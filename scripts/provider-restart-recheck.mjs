import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const outMain = path.join(repoRoot, 'out', 'main', 'index.js')
if (!existsSync(outMain)) {
  throw new Error('缺少 out/main/index.js;请先运行 npm run build')
}

const electron = process.platform === 'win32' ? 'npx.cmd' : 'npx'
execFileSync(electron, ['electron', path.join(repoRoot, 'scripts', 'provider-restart-recheck-electron.cjs')], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env
})
