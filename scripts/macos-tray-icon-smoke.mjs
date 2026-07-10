import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const reportRoot = path.join(repoRoot, 'test-results', 'macos-tray-icon')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(reportRoot, runId)
const checks = []
let finalStatus = 'failed'
let finalError = null
let electronResult = null

try {
  const mainSource = readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8')
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const oneX = readPngHeader(path.join(repoRoot, 'resources/trayTemplate.png'))
  const twoX = readPngHeader(path.join(repoRoot, 'resources/trayTemplate@2x.png'))

  check('template assets use macOS menu-bar dimensions and alpha', () => {
    assert(oneX.width === 18 && oneX.height === 18, `1x tray icon must be 18x18: ${oneX.width}x${oneX.height}`)
    assert(twoX.width === 36 && twoX.height === 36, `2x tray icon must be 36x36: ${twoX.width}x${twoX.height}`)
    assert(oneX.hasAlpha && twoX.hasAlpha, 'tray icon assets must include alpha transparency')
  })

  check('main process uses a dedicated macOS template image', () => {
    assert(mainSource.includes("resourcePath(['trayTemplate.png'])"), 'main process should load the dedicated macOS tray asset')
    assert(mainSource.includes('image.setTemplateImage(true)'), 'main process should enable macOS template-image mode')
    assert(mainSource.includes("process.platform === 'darwin'"), 'template-image behavior should stay scoped to macOS')
  })

  check('packaging includes both tray icon scale factors', () => {
    const resources = packageJson.build?.extraResources ?? []
    const fromPaths = new Set(resources.map((item) => item.from))
    assert(fromPaths.has('resources/trayTemplate.png'), 'packaging should include the 1x tray icon')
    assert(fromPaths.has('resources/trayTemplate@2x.png'), 'packaging should include the 2x tray icon')
  })

  if (process.platform === 'darwin') {
    check('Electron loads the icon and accepts template mode', () => {
      const electronBin = path.join(repoRoot, 'node_modules', '.bin', 'electron')
      const output = execFileSync(electronBin, ['scripts/macos-tray-icon-electron.cjs'], {
        cwd: repoRoot,
        encoding: 'utf8'
      }).trim()
      electronResult = JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1))
      assert(electronResult.ok && electronResult.template, 'Electron tray icon probe should pass in template mode')
      assert(
        electronResult.scaleFactors?.includes(1) && electronResult.scaleFactors?.includes(2),
        'Electron should load both 1x and 2x tray representations'
      )
      assert(electronResult.bounds?.height > 0 && electronResult.bounds.height <= 30, 'Electron should place the icon within macOS menu-bar bounds')
    })
  }

  finalStatus = 'passed'
  console.log(`macOS tray icon smoke ok: ${reportDir}`)
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  mkdirSync(reportDir, { recursive: true })
  const report = {
    runId,
    status: finalStatus,
    checks,
    electronResult,
    error: finalError,
    generatedAt: new Date().toISOString()
  }
  writeFileSync(path.join(reportDir, 'macos-tray-icon-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
}

function readPngHeader(filePath) {
  const buffer = readFileSync(filePath)
  const signature = buffer.subarray(0, 8).toString('hex')
  assert(signature === '89504e470d0a1a0a', `invalid PNG signature: ${filePath}`)
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const colorType = buffer[25]
  return { width, height, colorType, hasAlpha: colorType === 4 || colorType === 6 }
}

function check(name, fn) {
  const startedAt = Date.now()
  try {
    fn()
    checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
