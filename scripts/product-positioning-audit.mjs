#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseRequirements } from './lib/product-acceptance-map.mjs'

const repoRoot = process.cwd()
const required = process.argv.includes('--required') || process.env.CAOGEN_PRODUCT_POSITIONING_REQUIRED === '1'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'product-positioning-audit')
const reportDir = path.join(reportRoot, runId)
const failures = []
const warnings = []

const publicFiles = [
  'README.md',
  'docs/CAOGEN-OPTIMIZATION-PLAN.md',
  'docs/RELEASE-NOTES-DRAFT.md',
  'docs/RELEASE-NOTES-FINAL.md',
  'docs/RELEASE-GATE-DRAFT.md',
  'src/renderer/src/components/WelcomeView.tsx'
]

const i18nPublicKeys = [
  'welcomeSub',
  'welcomeAsk',
  'welcomeInputPlaceholder',
  'welcomeToolRequiresSession',
  'welcomePickProject',
  'deskToolDrawer',
  'deskReview',
  'deskTerminal',
  'deskBrowser',
  'deskFiles',
  'deskSideChat'
]

const previouslyForcedVersion = ['0', '2', '0'].join('.')
const escapedPreviouslyForcedVersion = escapeRegExp(previouslyForcedVersion)
const forbiddenFutureVersion = [
  { name: 'fixed-v-future-target', regex: new RegExp(`\\bv${escapedPreviouslyForcedVersion}\\b`, 'g') },
  { name: 'fixed-future-target', regex: new RegExp(`(?<![0-9.])${escapedPreviouslyForcedVersion}(?![0-9.])`, 'g') }
]

const forbiddenCompetitorNames = [
  { name: 'Codex', regex: /\bCodex\b/g },
  { name: 'Claude', regex: /\bClaude(?:\s+Code)?\b/g },
  { name: 'Hermes', regex: /\bHermes\b/g },
  { name: 'OpenClaw', regex: /\bOpenClaw\b/g },
  { name: 'CCswitch', regex: /\bCCswitch\b/g },
  { name: 'tutti', regex: /\bTutti\b|\btutti\b/g }
]

const forbiddenComparisonInfo = [
  { name: 'external-product-comparison-zh', regex: /竞品|对标|同类产品|同类工具/g },
  { name: 'external-product-comparison-en', regex: /\bcompetitor(?:s)?\b|\bcompeting products?\b|\bversus\b/gi },
  { name: 'comparison-vs-marker', regex: /(^|[\s([])vs\.?(?=$|[\s)\]])/g },
  { name: 'comparison-table-limits', regex: /常见限制|单厂商产品|闭源\s*SaaS|国际产品/g },
  { name: 'wrapper-or-cli-comparison', regex: /简单套壳|聊天套壳|CLI\s*强但不可视/g }
]

const overclaimPatterns = [
  { name: 'developer-only-positioning', regex: /CaoGen\s+(?:is|是).{0,20}(?:developer|开发者)(?:\s+only|专用|工具)/gi },
  { name: 'complete-office-layout-claim', regex: /(?:完整|complete|full).{0,18}(?:Office|Word|Excel|PowerPoint).{0,18}(?:版式|layout).{0,18}(?:已完成|complete|ready|supported)/gi },
  { name: 'relay-already-live-claim', regex: /(?:gpt\.zhangrui\.xyz|CaoGen.{0,8}中转站).{0,24}(?:已上线|开箱即用|already live|ready to use)/gi }
]

const scannedFiles = []

for (const relativePath of publicFiles) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    failures.push(`public positioning file is missing: ${relativePath}`)
    continue
  }
  const text = readFileSync(absolutePath, 'utf8')
  scannedFiles.push(relativePath)
  scanText(relativePath, text)
}

scanWelcomeI18n()
validateCorePositioning()
const formalStatus = validateFormalStatusConsistency()
validateBrandAssets()

const report = {
  status: failures.length === 0 ? 'passed' : required ? 'failed' : 'failed',
  required,
  runId,
  reportDir,
  scannedFiles,
  i18nPublicKeys,
  policy: {
    version: 'Public positioning must not force a fixed future version target; release version is chosen by the owner.',
    externalProducts: 'Public product copy must describe CaoGen-owned capabilities without external product names or comparison framing.',
    scope: 'CaoGen is positioned as a multi-vendor AI work desktop, not a coding-only or developer-only tool.',
    claims: 'Relay and complete Office layout rendering stay conditional until proved by live evidence.',
    brand: 'Public UI brand marks must use the official CaoGen app icon, not temporary diamond placeholders.'
  },
  formalStatus,
  warnings,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(JSON.stringify(report, null, 2))
if (required && report.status !== 'passed') process.exitCode = 1
if (!required && report.status !== 'passed') process.exitCode = 1

function scanWelcomeI18n() {
  const relativePath = 'src/renderer/src/i18n.ts'
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    failures.push(`i18n file is missing: ${relativePath}`)
    return
  }
  const source = readFileSync(absolutePath, 'utf8')
  scannedFiles.push(`${relativePath}#welcome`)
  for (const key of i18nPublicKeys) {
    const snippet = extractI18nEntry(source, key)
    if (!snippet) {
      failures.push(`missing public welcome i18n key: ${key}`)
      continue
    }
    scanText(`${relativePath}:${key}`, snippet)
  }
}

function validateCorePositioning() {
  requireText('README.md', '多厂商 AI 工作桌面', 'README first screen must say CaoGen is a multi-vendor AI work desktop')
  requireText('README.md', '多模型、多项目、多文件、多任务、多工具', 'README must state the multi-model/project/file/task/tool unification')
  requireText('README.md', '用户', 'README positioning must be broader than developers-only')
  requireText('docs/CAOGEN-OPTIMIZATION-PLAN.md', 'multi-vendor AI work desktop', 'optimization plan must keep the English product definition')
  requireText('docs/CAOGEN-OPTIMIZATION-PLAN.md', 'Project-level working rules', 'optimization plan must include project-level working rules')
  requireText('docs/RELEASE-NOTES-DRAFT.md', 'multi-vendor AI work desktop', 'release notes must use the product definition')
  requireText('docs/RELEASE-GATE-DRAFT.md', 'multi-vendor AI work desktop', 'release gate must enforce the product definition')
}

function validateFormalStatusConsistency() {
  const prdPath = path.join(repoRoot, 'docs', 'PRODUCT-REQUIREMENTS.md')
  if (!existsSync(prdPath)) {
    failures.push('cannot derive public status: docs/PRODUCT-REQUIREMENTS.md is missing')
    return null
  }

  const p0 = parseRequirements(readFileSync(prdPath, 'utf8'))
    .filter((requirement) => requirement.priority === 'P0')
  const snapshot = {
    total: p0.length,
    verified: p0.filter((requirement) => requirement.status === '当前已验证').length,
    partial: p0.filter((requirement) => requirement.status.startsWith('部分完成')).length,
    targets: p0.filter((requirement) => requirement.status === '立项目标').length,
    foundation: p0.filter((requirement) => requirement.status === '当前已验证（基础）').length
  }
  const classified = snapshot.verified + snapshot.partial + snapshot.targets + snapshot.foundation
  if (classified !== snapshot.total) {
    failures.push(`public status classifier covers ${classified}/${snapshot.total} P0 requirements`)
  }

  const chineseSnapshot = `PRD ${snapshot.total} 个 P0 = ${snapshot.verified} 个已验证 + ${snapshot.partial} 个部分完成 + ${snapshot.targets} 个立项目标 + ${snapshot.foundation} 个仅达到基础`
  const englishSnapshot = `PRD has ${snapshot.total} P0s: ${snapshot.verified} verified, ${snapshot.partial} partially complete, ${snapshot.targets} project targets, and ${snapshot.foundation} foundation only`
  requireText('README.md', chineseSnapshot, 'README must match the PRD-derived four-state P0 snapshot')
  requireText('STATUS.md', chineseSnapshot, 'STATUS must match the PRD-derived four-state P0 snapshot')
  requireText('README.en.md', englishSnapshot, 'English README must match the PRD-derived four-state P0 snapshot')
  return snapshot
}

function validateBrandAssets() {
  const brandModule = readRequiredText('src/renderer/src/brand.ts')
  const sidebar = readRequiredText('src/renderer/src/components/Sidebar.tsx')
  const welcome = readRequiredText('src/renderer/src/components/WelcomeView.tsx')
  const app = readRequiredText('src/renderer/src/App.tsx')
  const vscodeLogo = readRequiredText('plugins/vscode/media/caogen.svg')

  if (brandModule) {
    requireSnippet(brandModule, "resources/icon.png?url", 'brand module must import the official CaoGen app icon asset')
    requireSnippet(brandModule, 'APP_ICON_URL', 'brand module must export a reusable app icon URL')
    requireSnippet(brandModule, "APP_NAME = 'CaoGen'", 'brand module must export the CaoGen app name')
  }

  if (sidebar) {
    requireSnippet(sidebar, 'data-brand-logo="caogen-app-icon"', 'sidebar must expose a CaoGen app icon brand marker')
    requireSnippet(sidebar, '<img src={APP_ICON_URL}', 'sidebar brand marker must render the official app icon')
    rejectBrandPlaceholder('src/renderer/src/components/Sidebar.tsx', sidebar)
  }

  if (welcome) {
    requireSnippet(welcome, 'className="welcome-logo"', 'welcome screen must render the official CaoGen logo')
    requireSnippet(welcome, 'src={APP_ICON_URL}', 'welcome logo must use the official app icon URL')
    rejectBrandPlaceholder('src/renderer/src/components/WelcomeView.tsx', welcome)
  }

  if (app) {
    requireSnippet(app, 'className="app-fallback-logo"', 'fallback screen must render the official CaoGen logo')
    requireSnippet(app, 'src={APP_ICON_URL}', 'fallback logo must use the official app icon URL')
    rejectBrandPlaceholder('src/renderer/src/App.tsx', app)
  }

  if (vscodeLogo) {
    requireSnippet(vscodeLogo, 'data:image/png;base64,', 'VS Code extension logo must embed the official CaoGen app icon')
    rejectBrandPlaceholder('plugins/vscode/media/caogen.svg', vscodeLogo)
  }
}

function scanText(label, text) {
  for (const pattern of [...forbiddenFutureVersion, ...forbiddenCompetitorNames, ...forbiddenComparisonInfo, ...overclaimPatterns]) {
    pattern.regex.lastIndex = 0
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(lines[index])) failures.push(`${label}:${index + 1}: forbidden ${pattern.name}`)
    }
  }
}

function requireText(relativePath, value, message) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    failures.push(`cannot check ${relativePath}: missing file`)
    return
  }
  const text = readFileSync(absolutePath, 'utf8')
  if (!text.toLowerCase().includes(value.toLowerCase())) failures.push(message)
}

function readRequiredText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    failures.push(`cannot check ${relativePath}: missing file`)
    return ''
  }
  scannedFiles.push(relativePath)
  return readFileSync(absolutePath, 'utf8')
}

function requireSnippet(text, value, message) {
  if (!text.includes(value)) failures.push(message)
}

function rejectBrandPlaceholder(relativePath, text) {
  const placeholderPattern = /<polygon\b|rotate\(45|◇|◆|◈|welcome-mark|sidebar-empty-mark/i
  if (placeholderPattern.test(text)) failures.push(`${relativePath}: old diamond brand placeholder must not return`)
}

function extractI18nEntry(source, key) {
  const pattern = new RegExp(`\\n\\s*${escapeRegExp(key)}:\\s*\\{[^\\n]*\\}`, 'm')
  const match = source.match(pattern)
  if (match) return match[0]
  warnings.push(`i18n key ${key} is not a single-line entry; public positioning audit did not scan it`)
  return ''
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
