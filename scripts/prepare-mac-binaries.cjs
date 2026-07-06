/**
 * 打包前置:确保 x64 与 arm64 两个 claude SDK 平台二进制包都在 node_modules
 * (npm 默认按宿主平台过滤,交叉打包需手动补齐另一架构)。
 */
const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const version = JSON.parse(
  readFileSync(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')
).version

for (const arch of ['x64', 'arm64']) {
  const pkgDir = join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`)
  if (existsSync(join(pkgDir, 'claude'))) {
    console.log(`✓ claude-agent-sdk-darwin-${arch}@${version} 已就位`)
    continue
  }
  console.log(`… 安装 claude-agent-sdk-darwin-${arch}@${version}`)
  execFileSync(
    'npm',
    ['install', '--no-save', '--force', '--cpu', arch, '--os', 'darwin', `@anthropic-ai/claude-agent-sdk-darwin-${arch}@${version}`],
    { cwd: root, stdio: 'inherit' }
  )
}
