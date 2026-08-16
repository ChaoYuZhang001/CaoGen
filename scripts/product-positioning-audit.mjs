#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  derivePublicStatus,
  publicStatusParagraph
} from './lib/public-status-projection.mjs'

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

const i18nPublicKeySources = {
  welcomeSub: 'src/renderer/src/i18n.ts',
  welcomeAsk: 'src/renderer/src/i18n.ts',
  welcomeInputPlaceholder: 'src/renderer/src/i18n.ts',
  welcomeToolRequiresSession: 'src/renderer/src/i18n.ts',
  welcomePickProject: 'src/renderer/src/i18n.ts',
  deskToolDrawer: 'src/renderer/src/i18n/chatTranslations.ts',
  deskReview: 'src/renderer/src/i18n/chatTranslations.ts',
  deskTerminal: 'src/renderer/src/i18n/chatTranslations.ts',
  deskBrowser: 'src/renderer/src/i18n/chatTranslations.ts',
  deskFiles: 'src/renderer/src/i18n/chatTranslations.ts',
  deskSideChat: 'src/renderer/src/i18n/chatTranslations.ts'
}
const i18nPublicKeys = Object.keys(i18nPublicKeySources)

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
  i18nPublicKeySources,
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
  const sourceCache = new Map()
  for (const [key, relativePath] of Object.entries(i18nPublicKeySources)) {
    let entry = sourceCache.get(relativePath)
    if (entry === undefined) {
      const absolutePath = path.join(repoRoot, relativePath)
      if (!existsSync(absolutePath)) {
        failures.push(`i18n file is missing: ${relativePath}`)
        sourceCache.set(relativePath, null)
        continue
      }
      const source = readFileSync(absolutePath, 'utf8')
      const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      )
      entry = { source, sourceFile }
      sourceCache.set(relativePath, entry)
      scannedFiles.push(`${relativePath}#public-positioning`)
    }
    if (!entry) continue
    const snippet = extractI18nEntry(entry.sourceFile, entry.source, key)
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
  const statusPath = path.join(repoRoot, 'STATUS.md')
  const publicStatusPath = path.join(repoRoot, 'docs', 'public-status.json')
  if (!existsSync(prdPath) || !existsSync(statusPath) || !existsSync(publicStatusPath)) {
    failures.push('cannot derive public status: PRD, STATUS.md, or docs/public-status.json is missing')
    return null
  }

  let snapshot
  let recorded
  try {
    snapshot = derivePublicStatus({
      productRequirements: readFileSync(prdPath, 'utf8'),
      statusDocument: readFileSync(statusPath, 'utf8')
    })
    recorded = JSON.parse(readFileSync(publicStatusPath, 'utf8'))
  } catch (error) {
    failures.push(`cannot derive public status: ${error.message}`)
    return null
  }

  if (JSON.stringify(recorded) !== JSON.stringify(snapshot)) {
    failures.push('docs/public-status.json is stale; run npm run update:public-status')
  }

  requireText('README.md', publicStatusParagraph(snapshot, 'zh-CN'), 'README must match docs/public-status.json')
  requireText('README.en.md', publicStatusParagraph(snapshot, 'en'), 'English README must match docs/public-status.json')
  return snapshot
}

function validateBrandAssets() {
  const brandModule = readRequiredText('src/renderer/src/brand.ts')
  const sidebar = readRequiredText('src/renderer/src/components/Sidebar.tsx')
  const welcome = readRequiredText('src/renderer/src/components/WelcomeView.tsx')
  const app = readRequiredText('src/renderer/src/App.tsx')

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

function extractI18nEntry(sourceFile, source, key) {
  let snippet = ''
  const visit = (node) => {
    if (snippet) return
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === key) {
      snippet = source.slice(node.getStart(sourceFile), node.getEnd())
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return snippet
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text
  return ''
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
