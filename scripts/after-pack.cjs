/**
 * electron-builder afterPack:剔除与目标架构不符的 claude SDK 平台二进制。
 * 双架构构建时两个平台包都在 node_modules,若不剔除,每个安装包白带
 * 另一架构 ~50MB 的 claude 可执行文件。
 */
const fs = require('node:fs')
const path = require('node:path')

const ARCH_NAME = { 1: 'x64', 3: 'arm64' } // electron-builder Arch 枚举:ia32=0,x64=1,armv7l=2,arm64=3

module.exports = async function afterPack(context) {
  const arch = ARCH_NAME[context.arch]
  if (!arch) return
  const wrong = arch === 'x64' ? 'arm64' : 'x64'
  const unpacked = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai',
    `claude-agent-sdk-darwin-${wrong}`
  )
  if (fs.existsSync(unpacked)) {
    fs.rmSync(unpacked, { recursive: true, force: true })
    console.log(`  • afterPack 剔除异架构二进制  ${path.basename(unpacked)} (target=${arch})`)
  }
}
