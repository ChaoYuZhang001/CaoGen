#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'external-product-code-boundary.mjs')
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'caogen-external-product-boundary-'))

try {
  writeJson('package.json', {
    name: 'caogen',
    productName: 'CaoGen',
    version: '1.0.0',
    scripts: {
      build: 'true',
      typecheck: 'true',
      'test:deep': 'true',
      'workos:release-doctor': 'true'
    }
  })
  writeJson('package-lock.json', {
    name: 'caogen',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'caogen', version: '1.0.0' }
    }
  })
  writeText('caogen-website/compare/workbuddy/index.html', '<title>CaoGen vs WorkBuddy</title>')
  writeText('src/provider-labels.ts', "export const allowedVendorLabels = ['Feishu', 'Hunyuan']\n")

  const clean = runBoundary()
  assert.equal(clean.status, 0, clean.output)
  assert.equal(JSON.parse(clean.stdout).status, 'passed')

  writeText('src/runtime-compatibility.ts', "export const roots = ['.claude/plugins', '.codex/plugins/cache']\n")
  const compatibilityAllowed = runBoundary()
  assert.equal(compatibilityAllowed.status, 0, compatibilityAllowed.output)
  rmSync(path.join(fixtureRoot, 'src', 'runtime-compatibility.ts'))

  writeText('src/main/migration.ts', "export const source = '.claude/skills'\n")
  const migrationSourceAllowed = runBoundary()
  assert.equal(migrationSourceAllowed.status, 0, migrationSourceAllowed.output)
  rmSync(path.join(fixtureRoot, 'src', 'main'), { recursive: true })

  writeText('src/main/notification/notification-connector-store.ts', "export const retiredChannel = 'wecom'\n")
  writeText('scripts/notification-effect-required.mjs', "export const retiredMigrationFixture = 'WeCom'\n")
  const retiredMigrationAllowed = runBoundary()
  assert.equal(retiredMigrationAllowed.status, 0, retiredMigrationAllowed.output)
  rmSync(path.join(fixtureRoot, 'src', 'main'), { recursive: true })
  rmSync(path.join(fixtureRoot, 'scripts'), { recursive: true })

  writeText('src/retired-notification.ts', "export const webhook = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture'\n")
  const retiredEndpointFailure = runBoundary()
  assert.equal(retiredEndpointFailure.status, 1, retiredEndpointFailure.output)
  assert.match(retiredEndpointFailure.stdout, /src\/retired-notification\.ts: forbidden retired-wecom-notification-surface/)
  rmSync(path.join(fixtureRoot, 'src', 'retired-notification.ts'))

  writeText('src/integrations/wecom/client.ts', 'export const retiredNotificationClient = true\n')
  const retiredPathFailure = runBoundary()
  assert.equal(retiredPathFailure.status, 1, retiredPathFailure.output)
  assert.match(retiredPathFailure.stdout, /src\/integrations\/wecom\/client\.ts: forbidden external-product path/)
  rmSync(path.join(fixtureRoot, 'src', 'integrations'), { recursive: true })

  writeJson('packages/copied-runtime/package.json', {
    name: 'copied-runtime',
    version: '1.0.0',
    dependencies: { '@tencentcloud/cvm': '4.0.0' }
  })
  const manifestFailure = runBoundary()
  assert.equal(manifestFailure.status, 1, manifestFailure.output)
  assert.match(manifestFailure.stdout, /packages\/copied-runtime\/package\.json\.dependencies contains forbidden/)
  rmSync(path.join(fixtureRoot, 'packages'), { recursive: true })

  writeJson('packages/aliased-runtime/package.json', {
    name: 'aliased-runtime',
    version: '1.0.0',
    dependencies: { 'innocent-name': 'npm:@tencentcloud/cvm@4.0.0' }
  })
  const aliasFailure = runBoundary()
  assert.equal(aliasFailure.status, 1, aliasFailure.output)
  assert.match(aliasFailure.stdout, /@tencentcloud\/cvm/)
  rmSync(path.join(fixtureRoot, 'packages'), { recursive: true })

  writeJson('packages/non-scoped-runtime/package.json', {
    name: 'non-scoped-runtime',
    version: '1.0.0',
    dependencies: { 'tencent-coding-client': '1.0.0', 'wx-server-sdk': '3.0.0' }
  })
  const nonScopedFailure = runBoundary()
  assert.equal(nonScopedFailure.status, 1, nonScopedFailure.output)
  assert.match(nonScopedFailure.stdout, /tencent-coding-client/)
  assert.match(nonScopedFailure.stdout, /wx-server-sdk/)
  rmSync(path.join(fixtureRoot, 'packages'), { recursive: true })

  writeJson('packages/spec-runtime/package.json', {
    name: 'spec-runtime',
    version: '1.0.0',
    dependencies: {
      'git-alias': 'git+https://github.com/tencentcloud/tencentcloud-sdk-nodejs.git#main',
      'file-alias': 'file:vendor/workbuddy'
    }
  })
  const specFailure = runBoundary()
  assert.equal(specFailure.status, 1, specFailure.output)
  assert.match(specFailure.stdout, /github\.com\/tencentcloud\/tencentcloud-sdk-nodejs/)
  assert.match(specFailure.stdout, /file:vendor\/workbuddy/)
  rmSync(path.join(fixtureRoot, 'packages'), { recursive: true })

  writeJson('tools/copied-lock/package.json', { name: 'copied-lock', version: '1.0.0' })
  writeJson('tools/copied-lock/package-lock.json', {
    name: 'copied-lock',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'copied-lock', version: '1.0.0' },
      'node_modules/cos-js-sdk-v5': { version: '1.4.22' }
    }
  })
  const lockFailure = runBoundary()
  assert.equal(lockFailure.status, 1, lockFailure.output)
  assert.match(lockFailure.stdout, /cos-js-sdk-v5/)
  rmSync(path.join(fixtureRoot, 'tools'), { recursive: true })

  writeJson('tools/resolved-lock/package.json', { name: 'resolved-lock', version: '1.0.0' })
  writeJson('tools/resolved-lock/package-lock.json', {
    name: 'resolved-lock',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'resolved-lock', version: '1.0.0' },
      'node_modules/innocent-lock-name': {
        name: 'workbuddy-runtime',
        version: '1.0.0',
        resolved: 'https://example.test/vendor/tencentcloud-sdk-nodejs.tgz'
      }
    }
  })
  const resolvedLockFailure = runBoundary()
  assert.equal(resolvedLockFailure.status, 1, resolvedLockFailure.output)
  assert.match(resolvedLockFailure.stdout, /workbuddy-runtime/)
  assert.match(resolvedLockFailure.stdout, /tencentcloud-sdk-nodejs\.tgz/)
  rmSync(path.join(fixtureRoot, 'tools'), { recursive: true })

  writeJson('node_modules/innocent-installed/package.json', {
    name: '@tencentcloud/cvm',
    version: '4.0.0'
  })
  const installedFailure = runBoundary()
  assert.equal(installedFailure.status, 1, installedFailure.output)
  assert.match(installedFailure.stdout, /node_modules\/innocent-installed\/package\.json\.name/)
  rmSync(path.join(fixtureRoot, 'node_modules'), { recursive: true })

  writeJson('linked-target/package.json', { name: 'linked-target', version: '1.0.0' })
  mkdirSync(path.join(fixtureRoot, 'node_modules'), { recursive: true })
  symlinkSync(
    path.join(fixtureRoot, 'linked-target'),
    path.join(fixtureRoot, 'node_modules', 'linked-installed'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const installedSymlinkFailure = runBoundary()
  assert.equal(installedSymlinkFailure.status, 1, installedSymlinkFailure.output)
  assert.match(installedSymlinkFailure.stdout, /installed dependency symlink cannot be verified/)
  rmSync(path.join(fixtureRoot, 'node_modules'), { recursive: true })
  rmSync(path.join(fixtureRoot, 'linked-target'), { recursive: true })

  writeText('src/copied-surface.ts', "export const product = 'WorkBuddy'\n")
  const sourceFailure = runBoundary()
  assert.equal(sourceFailure.status, 1, sourceFailure.output)
  assert.match(sourceFailure.stdout, /src\/copied-surface\.ts: forbidden copied-product-name/)
  rmSync(path.join(fixtureRoot, 'src', 'copied-surface.ts'))

  writeText('scripts/competitive-parity-contract.mjs', 'export const copiedComparisonRuntime = true\n')
  const comparativeCodePathFailure = runBoundary()
  assert.equal(comparativeCodePathFailure.status, 1, comparativeCodePathFailure.output)
  assert.match(comparativeCodePathFailure.stdout, /scripts\/competitive-parity-contract\.mjs: forbidden external-product path/)
  rmSync(path.join(fixtureRoot, 'scripts'), { recursive: true })

  const forbiddenImportFixture = ['import ', "'@tencentcloud/cvm'", '\n'].join('')
  writeText('scripts/external-product-code-boundary.mjs', forbiddenImportFixture)
  const exemptImportFailure = runBoundary()
  assert.equal(exemptImportFailure.status, 1, exemptImportFailure.output)
  assert.match(exemptImportFailure.stdout, /forbidden runtime dependency import: @tencentcloud\/cvm/)
  rmSync(path.join(fixtureRoot, 'scripts'), { recursive: true })

  writeText('plugins/vscode/out/copied.js', "export const product = 'WorkBuddy'\n")
  const pluginOutputFailure = runBoundary()
  assert.equal(pluginOutputFailure.status, 1, pluginOutputFailure.output)
  assert.match(pluginOutputFailure.stdout, /plugins\/vscode\/out\/copied\.js: forbidden copied-product-name/)
  rmSync(path.join(fixtureRoot, 'plugins'), { recursive: true })

  writeText('tools/website-demo-video/scripts/copied.mjs', "export const product = 'WorkBuddy'\n")
  const toolScriptFailure = runBoundary()
  assert.equal(toolScriptFailure.status, 1, toolScriptFailure.output)
  assert.match(toolScriptFailure.stdout, /tools\/website-demo-video\/scripts\/copied\.mjs: forbidden copied-product-name/)
  rmSync(path.join(fixtureRoot, 'tools'), { recursive: true })

  writeText('src/oversized.js', `// guarded source\n${' '.repeat(4 * 1024 * 1024)}`)
  const oversizedFailure = runBoundary()
  assert.equal(oversizedFailure.status, 1, oversizedFailure.output)
  assert.match(oversizedFailure.stdout, /src\/oversized\.js: guarded text file exceeds 4194304 bytes/)
  rmSync(path.join(fixtureRoot, 'src', 'oversized.js'))

  writeText('.caogen/skills/tencent-coding-devops/SKILL.md', '# Retired integration\n')
  const retiredSkillFailure = runBoundary()
  assert.equal(retiredSkillFailure.status, 1, retiredSkillFailure.output)
  assert.match(retiredSkillFailure.stdout, /\.caogen\/skills\/tencent-coding-devops\/SKILL\.md: forbidden external-product path/)

  console.log('external product code boundary smoke: ok')
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}

function runBoundary() {
  const result = spawnSync(process.execPath, [scriptPath, '--root', fixtureRoot], {
    cwd: fixtureRoot,
    encoding: 'utf8'
  })
  return {
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`
  }
}

function writeJson(relativePath, value) {
  writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(relativePath, value) {
  const absolutePath = path.join(fixtureRoot, relativePath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, value)
}
