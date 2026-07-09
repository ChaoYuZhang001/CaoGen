#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const strict = process.argv.includes('--strict')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'coding-standards-audit')
const reportDir = path.join(reportRoot, runId)

const hotspotFiles = [
  'src/renderer/src/store.ts',
  'src/main/sessionManager.ts',
  'src/main/ipc.ts',
  'src/shared/types.ts',
  'src/preload/index.ts'
]

const allowedAnyBoundaries = [
  {
    file: 'src/main/updater.ts',
    pattern: /.*/,
    note: 'electron-updater is loaded dynamically and has a narrow boundary type'
  }
]

mkdirSync(reportDir, { recursive: true })

const checks = [
  checkStandardsDocument(),
  checkPackageScript(),
  checkHotspotLineCounts(),
  checkAnyBoundaries(),
  checkIpcPreloadScale(),
  checkUntrackedSourceFiles()
]

const flattened = checks.flat()
const warningCount = flattened.filter((item) => item.status === 'warn').length
const failureCount = flattened.filter((item) => item.status === 'fail').length
const status = failureCount > 0 || (strict && warningCount > 0) ? 'fail' : 'pass'

const report = {
  runId,
  status,
  strict,
  repoRoot,
  generatedAt: new Date().toISOString(),
  checks: flattened,
  summary: {
    pass: flattened.filter((item) => item.status === 'pass').length,
    warn: warningCount,
    fail: failureCount
  }
}

writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportDir, 'report.md'), renderMarkdown(report), 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.md'), renderMarkdown(report), 'utf8')

console.log(renderConsole(report))
process.exitCode = status === 'pass' ? 0 : 1

function checkStandardsDocument() {
  const file = 'docs/CODING-STANDARDS.md'
  if (!existsSync(path.join(repoRoot, file))) {
    return [fail('standards-document', file, 'Coding standards document is missing')]
  }
  const standards = read(file)
  const contributing = read('CONTRIBUTING.md')
  const requiredSections = [
    '## Core Rules',
    '## Behavior Chain',
    '## Hotspot File Policy',
    '## TypeScript Rules',
    '## IPC And Preload Rules',
    '## 3D Office Rules',
    '## Testing Rules',
    '## Completion Checklist'
  ]
  const missing = requiredSections.filter((section) => !standards.includes(section))
  const out = []
  out.push(
    missing.length === 0
      ? pass('standards-sections', file, 'Required coding-standard sections are present')
      : fail('standards-sections', file, `Missing sections: ${missing.join(', ')}`)
  )
  out.push(
    contributing.includes('docs/CODING-STANDARDS.md')
      ? pass('standards-link', 'CONTRIBUTING.md', 'Contributing guide links to coding standards')
      : fail('standards-link', 'CONTRIBUTING.md', 'Contributing guide must link to docs/CODING-STANDARDS.md')
  )
  return out
}

function checkPackageScript() {
  const packageJson = JSON.parse(read('package.json'))
  const actual = packageJson.scripts?.['test:coding-standards']
  return [
    actual === 'node scripts/coding-standards-audit.mjs'
      ? pass('package-script', 'package.json', 'test:coding-standards is wired')
      : fail('package-script', 'package.json', 'Add "test:coding-standards": "node scripts/coding-standards-audit.mjs"')
  ]
}

function checkHotspotLineCounts() {
  return hotspotFiles.map((file) => {
    if (!existsSync(path.join(repoRoot, file))) return fail('hotspot-lines', file, 'Hotspot file is missing')
    const lines = countLines(file)
    if (lines > 2000) {
      return warn('hotspot-lines', file, `${lines} lines; structural debt, do not add broad new responsibilities`)
    }
    if (lines > 1200) {
      return warn('hotspot-lines', file, `${lines} lines; prefer extracting modules for new behavior`)
    }
    if (lines > 800) {
      return warn('hotspot-lines', file, `${lines} lines; explain why new logic belongs here`)
    }
    return pass('hotspot-lines', file, `${lines} lines`)
  })
}

function checkAnyBoundaries() {
  const matches = []
  for (const file of listSourceFiles(path.join(repoRoot, 'src'))) {
    const rel = path.relative(repoRoot, file)
    const lines = read(rel).split(/\r?\n/)
    lines.forEach((line, index) => {
      if (!/(:\s*any\b|as\s+any\b|<any>|\bRecord<string,\s*any>)/.test(line)) return
      const allowed = allowedAnyBoundaries.find((item) => item.file === rel && item.pattern.test(line))
      matches.push({
        file: rel,
        line: index + 1,
        text: line.trim(),
        allowed: Boolean(allowed),
        note: allowed?.note
      })
    })
  }

  const unexpected = matches.filter((item) => !item.allowed)
  if (unexpected.length > 0) {
    return [
      warn(
        'typescript-any-boundaries',
        unexpected[0].file,
        `${unexpected.length} unapproved any boundary/boundaries found`,
        { matches: unexpected.slice(0, 20) }
      )
    ]
  }
  return [
    pass(
      'typescript-any-boundaries',
      'src',
      matches.length === 0 ? 'No any boundaries found' : `${matches.length} approved any boundary/boundaries`,
      { matches }
    )
  ]
}

function checkIpcPreloadScale() {
  const ipc = read('src/main/ipc.ts')
  const preload = read('src/preload/index.ts')
  const handlerCount = countMatches(ipc, /\bipcMain\.(handle|on)\(/g)
  const invokeCount = countMatches(preload, /\bipcRenderer\.invoke\(/g)
  const listenerCount = countMatches(preload, /\bipcRenderer\.on\(/g)
  return [
    handlerCount > 100
      ? warn('ipc-scale', 'src/main/ipc.ts', `${handlerCount} ipcMain handlers/listeners; split registration by domain`)
      : pass('ipc-scale', 'src/main/ipc.ts', `${handlerCount} ipcMain handlers/listeners`),
    invokeCount > 80
      ? warn('preload-scale', 'src/preload/index.ts', `${invokeCount} ipcRenderer.invoke calls; keep shared contract aligned`)
      : pass('preload-scale', 'src/preload/index.ts', `${invokeCount} ipcRenderer.invoke calls`),
    listenerCount > 12
      ? warn('preload-listeners', 'src/preload/index.ts', `${listenerCount} ipcRenderer.on listeners; ensure unsubscribe paths stay paired`)
      : pass('preload-listeners', 'src/preload/index.ts', `${listenerCount} ipcRenderer.on listeners`)
  ]
}

function checkUntrackedSourceFiles() {
  let output = ''
  try {
    output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })
  } catch {
    return [warn('untracked-source', '.', 'Could not inspect untracked files with git')]
  }
  const files = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => /^(src|scripts|docs|plugins|resources)\//.test(file) || file === 'package.json')
    .filter((file) => !file.startsWith('test-results/'))
  if (files.length === 0) return [pass('untracked-source', '.', 'No untracked source or standards files')]
  return [
    warn(
      'untracked-source',
      files[0],
      `${files.length} untracked source/standards file(s); include them deliberately or remove them`,
      { files }
    )
  ]
}

function listSourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  const entries = execFileSync('find', [dir, '-type', 'f', '(', '-name', '*.ts', '-o', '-name', '*.tsx', ')'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
    .split(/\r?\n/)
    .filter(Boolean)
  return entries.map((file) => path.resolve(file))
}

function read(file) {
  return readFileSync(path.join(repoRoot, file), 'utf8')
}

function countLines(file) {
  const text = read(file)
  if (!text) return 0
  return text.split(/\r?\n/).length
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length
}

function pass(id, file, message, details) {
  return { id, status: 'pass', file, message, ...(details ? { details } : {}) }
}

function warn(id, file, message, details) {
  return { id, status: 'warn', file, message, ...(details ? { details } : {}) }
}

function fail(id, file, message, details) {
  return { id, status: 'fail', file, message, ...(details ? { details } : {}) }
}

function renderConsole(report) {
  const lines = [
    `coding standards audit: ${report.status}`,
    `pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`,
    `report: ${path.join(reportRoot, 'latest.md')}`
  ]
  for (const item of report.checks) {
    const label = item.status.toUpperCase().padEnd(4)
    lines.push(`[${label}] ${item.id} ${item.file}: ${item.message}`)
  }
  if (strict && report.summary.warn > 0) {
    lines.push('strict mode treats warnings as failures')
  }
  return lines.join('\n')
}

function renderMarkdown(report) {
  const lines = [
    `# Coding Standards Audit ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Strict: ${report.strict ? 'yes' : 'no'}`,
    `- Generated: ${report.generatedAt}`,
    `- Repo: ${report.repoRoot}`,
    '',
    '| Check | Status | File | Message |',
    '|---|---|---|---|'
  ]
  for (const item of report.checks) {
    lines.push(
      `| ${escapePipe(item.id)} | ${item.status} | ${escapePipe(item.file)} | ${escapePipe(item.message)} |`
    )
  }
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Pass: ${report.summary.pass}`)
  lines.push(`- Warn: ${report.summary.warn}`)
  lines.push(`- Fail: ${report.summary.fail}`)
  lines.push('')
  return lines.join('\n')
}

function escapePipe(value) {
  return String(value).replace(/\|/g, '\\|')
}
