/**
 * electron-builder afterPack:验证平台过滤发生在 ASAR 创建之前。
 * 这里不再删除文件,避免 app.asar 头继续引用已经被移除的 unpacked 条目。
 */
const fs = require('node:fs')
const path = require('node:path')

const ARCH_NAME = { 1: 'x64', 3: 'arm64' } // electron-builder Arch 枚举:ia32=0,x64=1,armv7l=2,arm64=3

module.exports = async function afterPack(context) {
  const arch = ARCH_NAME[context.arch]
  if (!arch) return
  const wrong = arch === 'x64' ? 'arm64' : 'x64'
  const anthropicRoot = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai'
  )
  const expected = path.join(anthropicRoot, `claude-agent-sdk-darwin-${arch}`, 'claude')
  const forbidden = path.join(anthropicRoot, `claude-agent-sdk-darwin-${wrong}`)
  if (!fs.existsSync(expected)) {
    throw new Error(`afterPack: missing target Claude CLI: ${expected}`)
  }
  if (fs.existsSync(forbidden)) {
    throw new Error(`afterPack: wrong-architecture Claude SDK survived packaging: ${forbidden}`)
  }
  console.log(`  • afterPack 架构过滤已验证  claude-agent-sdk-darwin-${arch}`)
}
