#!/usr/bin/env node
import { listPackage } from '@electron/asar'
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const required = process.argv.includes('--required')
const targetArch = argValue('--arch') || 'x64'
const version = packageJson.version
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'macos-package-size-audit')
const reportDir = path.join(reportRoot, runId)
const appPath = path.join(repoRoot, targetArch === 'arm64' ? 'dist/mac-arm64/CaoGen.app' : 'dist/mac/CaoGen.app')
const dmgPath = path.join(repoRoot, targetArch === 'arm64' ? `dist/CaoGen-${version}-arm64.dmg` : `dist/CaoGen-${version}.dmg`)
const zipPath = path.join(repoRoot, targetArch === 'arm64' ? `dist/CaoGen-${version}-arm64-mac.zip` : `dist/CaoGen-${version}-mac.zip`)
const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar')
const unpackedRoot = `${asarPath}.unpacked`
const checks = []
const budgets = {
  appBytes: 650_000_000,
  asarBytes: 110_000_000,
  dmgBytes: 225_000_000,
  zipBytes: 225_000_000
}

check('target architecture is supported', targetArch === 'x64' || targetArch === 'arm64', targetArch)
check('packaged app exists', isDirectory(appPath), relative(appPath))
check('app.asar exists', isFile(asarPath), relative(asarPath))
check('DMG exists', isFile(dmgPath), relative(dmgPath))
check('ZIP exists', isFile(zipPath), relative(zipPath))

const sizes = {
  appBytes: isDirectory(appPath) ? directoryFileBytes(appPath) : null,
  asarBytes: isFile(asarPath) ? statSync(asarPath).size : null,
  dmgBytes: isFile(dmgPath) ? statSync(dmgPath).size : null,
  zipBytes: isFile(zipPath) ? statSync(zipPath).size : null
}
for (const [name, budget] of Object.entries(budgets)) {
  const size = sizes[name]
  check(`${name} stays within budget`, typeof size === 'number' && size <= budget, `${formatMb(size)} / ${formatMb(budget)}`)
}

const allowedLocales = new Set(['en', 'zh_CN', 'zh_TW'])
const locales = isDirectory(appPath) ? inspectLocales(appPath) : []
check('Electron locales are limited to English and Chinese', locales.length > 0 && locales.every((item) => allowedLocales.has(item)), locales.join(', '))
for (const locale of allowedLocales) check(`Electron locale ${locale} is present`, locales.includes(locale), locales.join(', '))

let asarEntries = []
try {
  asarEntries = isFile(asarPath) ? listPackage(asarPath) : []
} catch (error) {
  check('app.asar is readable', false, errorMessage(error))
}
if (asarEntries.length > 0) check('app.asar is readable', true, `${asarEntries.length} entries`)

const rendererOnlyPackages = [
  '@react-three/drei',
  '@react-three/fiber',
  '@react-three/postprocessing',
  'highlight.js',
  'postprocessing',
  'react',
  'react-dom',
  'react-markdown',
  'rehype-highlight',
  'remark-gfm',
  'three',
  'zustand'
]
for (const dependency of rendererOnlyPackages) {
  const prefix = `/node_modules/${dependency}/`
  check(`${dependency} is not duplicated in packaged node_modules`, !asarEntries.some((entry) => entry.startsWith(prefix)))
}

for (const dependency of [
  '@anthropic-ai/claude-agent-sdk',
  'node-gyp-build',
  'node-pty',
  'puppeteer-core',
  'sql.js',
  'tree-sitter',
  'tree-sitter-typescript'
]) {
  const prefix = `/node_modules/${dependency}/`
  check(`${dependency} runtime remains packaged`, asarEntries.some((entry) => entry.startsWith(prefix)))
}

const wrongArch = targetArch === 'x64' ? 'arm64' : 'x64'
const targetClaudePrefix = `/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${targetArch}/`
const wrongClaudePrefix = `/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${wrongArch}/`
check('target Claude CLI remains packaged', asarEntries.some((entry) => entry === `${targetClaudePrefix}claude`))
check('wrong-architecture Claude SDK is absent from ASAR header', !asarEntries.some((entry) => entry.startsWith(wrongClaudePrefix)))
check(
  'wrong-architecture Claude SDK is absent from unpacked files',
  !isDirectory(path.join(unpackedRoot, 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${wrongArch}`))
)

const forbiddenPrebuilds = asarEntries.filter((entry) => {
  const match = entry.match(/\/prebuilds\/([^/]+)\//)
  return match && match[1] !== `darwin-${targetArch}`
})
check('only target macOS native prebuilds remain', forbiddenPrebuilds.length === 0, forbiddenPrebuilds.slice(0, 8).join(', '))

const parserSources = asarEntries.filter((entry) => /\/node_modules\/tree-sitter(?:-[^/]+)?\/(?:[^/]+\/)*src\/parser\.c$/.test(entry))
check('generated tree-sitter parser sources are excluded', parserSources.length === 0, parserSources.slice(0, 8).join(', '))

const failures = checks.filter((item) => !item.passed)
const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  required,
  runId,
  targetArch,
  packageVersion: version,
  paths: { app: relative(appPath), asar: relative(asarPath), dmg: relative(dmgPath), zip: relative(zipPath) },
  sizes,
  budgets,
  locales,
  largestFiles: isDirectory(appPath) ? largestFiles(appPath, 20) : [],
  checks,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, `latest-${targetArch}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (failures.length > 0) process.exitCode = 1

function check(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail: detail || null })
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function inspectLocales(root) {
  const directories = [
    path.join(root, 'Contents', 'Resources'),
    path.join(root, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources')
  ]
  const result = new Set()
  for (const directory of directories) {
    if (!isDirectory(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.endsWith('.lproj')) result.add(entry.name.slice(0, -'.lproj'.length))
    }
  }
  return [...result].sort()
}

function directoryFileBytes(directory) {
  let total = 0
  walkFiles(directory, (filePath) => { total += statSync(filePath).size })
  return total
}

function largestFiles(directory, limit) {
  const files = []
  walkFiles(directory, (filePath) => files.push({ path: relative(filePath), size: statSync(filePath).size }))
  return files.sort((a, b) => b.size - a.size).slice(0, limit)
}

function walkFiles(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) walkFiles(filePath, visit)
    else if (stat.isFile()) visit(filePath)
  }
}

function isFile(filePath) {
  try { return lstatSync(filePath).isFile() } catch { return false }
}

function isDirectory(filePath) {
  try { return lstatSync(filePath).isDirectory() } catch { return false }
}

function relative(filePath) {
  return path.relative(repoRoot, filePath)
}

function formatMb(value) {
  return typeof value === 'number' ? `${(value / 1_000_000).toFixed(1)} MB` : 'missing'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
