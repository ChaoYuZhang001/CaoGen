#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const args = new Set(process.argv.slice(2))
const strict = args.has('--strict')
const required = args.has('--required')
const writeBaseline = args.has('--write-baseline')
const acceptCurrentDebt = args.has('--accept-current-debt')
const mode = strict ? 'strict' : required ? 'required' : 'report'
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'coding-standards-audit')
const reportDir = path.join(reportRoot, runId)
const baselineFile = 'scripts/coding-standards-baseline.json'
const baselinePath = path.join(repoRoot, baselineFile)

const thresholds = {
  product: { targetLines: 500, hardLines: 800 },
  automation: { targetLines: 800, hardLines: 1200 },
  functions: {
    targetLines: 50,
    reviewLines: 80,
    hardLines: 120,
    targetComplexity: 10,
    hardComplexity: 15
  },
  ipc: {
    handlerFileHardCount: 100,
    handlerTotalHardCount: 160,
    preloadInvokeFileHardCount: 80,
    preloadInvokeTotalHardCount: 160,
    preloadListenerFileHardCount: 12,
    preloadListenerTotalHardCount: 20
  }
}

const codeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.kt', '.kts', '.py'])
const typescriptExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs'])
const excludedCodePrefixes = ['src/renderer/public/draco/']
const allowedAnyBoundaries = [
  {
    file: 'src/main/updater.ts',
    pattern: /.*/,
    note: 'electron-updater is loaded dynamically and has a narrow boundary type'
  }
]

mkdirSync(reportDir, { recursive: true })

const codeMetrics = listCodeFiles().map(analyzeCodeFile)
const repositoryMetrics = analyzeRepositoryMetrics()

if (writeBaseline) {
  const commentDebt = codeMetrics.reduce((sum, item) => sum + commentIssueCount(item), 0)
  if (commentDebt > 0) {
    console.error(`refusing to baseline ${commentDebt} prohibited or unreasoned comment directive(s)`)
    process.exit(1)
  }
  const existingBaseline = loadBaseline()
  if (!acceptCurrentDebt) {
    const contractErrors = validateBaseline(existingBaseline)
    if (contractErrors.length > 0 || JSON.stringify(existingBaseline?.thresholds) !== JSON.stringify(thresholds)) {
      console.error('refusing to update an absent, incompatible, or invalid baseline')
      console.error('use --accept-current-debt only for a reviewed baseline bootstrap or policy migration')
      process.exit(1)
    }
    const regressionChecks = checkBaselineRegressions(codeMetrics, repositoryMetrics, existingBaseline)
    const regressions = regressionChecks.filter((item) => item.id === 'baseline-regression')
    const unexpectedAny = checkAnyBoundaries().find(
      (item) => item.id === 'typescript-any-boundaries' && item.status !== 'pass'
    )
    if (regressions.length > 0 || unexpectedAny) {
      console.error('refusing to widen the coding standards baseline')
      for (const item of regressions) console.error(`- ${item.file}: ${item.message}`)
      if (unexpectedAny) console.error(`- ${unexpectedAny.file}: ${unexpectedAny.message}`)
      process.exit(1)
    }
  }
  writeBaselineSnapshot(codeMetrics, repositoryMetrics)
  console.log(`coding standards baseline written: ${baselinePath}`)
  console.log(`files=${codeMetrics.length} mode=${acceptCurrentDebt ? 'accept-current-debt' : 'ratchet-refresh'}`)
  process.exit(0)
}

const baseline = loadBaseline()
const checks = [
  checkStandardsDocument(),
  checkPackageScripts(),
  checkBaselineContract(baseline),
  checkFileMetrics(codeMetrics),
  checkFunctionMetrics(codeMetrics),
  checkCommentDiscipline(codeMetrics),
  checkBaselineRegressions(codeMetrics, repositoryMetrics, baseline),
  checkAnyBoundaries(),
  checkIpcPreloadScale(repositoryMetrics),
  checkUntrackedSourceFiles()
]

const flattened = checks.flat()
const warningCount = flattened.filter((item) => item.status === 'warn').length
const failureCount = flattened.filter((item) => item.status === 'fail').length
const status = failureCount > 0 || (strict && warningCount > 0) ? 'fail' : 'pass'
const metricsSummary = summarizeMetrics(codeMetrics, repositoryMetrics, baseline)

const report = {
  runId,
  status,
  mode,
  strict,
  required,
  repoRoot,
  baselineFile,
  generatedAt: new Date().toISOString(),
  checks: flattened,
  metrics: metricsSummary,
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
  const projectRules = read('caogen.md')
  const requiredSections = [
    '## Core Rules',
    '## Behavior Chain',
    '## Size And Complexity Rules',
    '## Hotspot File Policy',
    '## TypeScript Rules',
    '## Comment Rules',
    '## Architecture And Design Pattern Rules',
    '## Exception Rules',
    '## IPC And Preload Rules',
    '## 3D Office Rules',
    '## Testing Rules',
    '## Completion Checklist'
  ]
  const missing = requiredSections.filter((section) => !standards.includes(section))
  return [
    missing.length === 0
      ? pass('standards-sections', file, 'Required coding-standard sections are present')
      : fail('standards-sections', file, `Missing sections: ${missing.join(', ')}`),
    contributing.includes('docs/CODING-STANDARDS.md')
      ? pass('standards-link', 'CONTRIBUTING.md', 'Contributing guide links to coding standards')
      : fail('standards-link', 'CONTRIBUTING.md', 'Contributing guide must link to docs/CODING-STANDARDS.md'),
    projectRules.includes('docs/CODING-STANDARDS.md') && projectRules.includes('test:coding-standards:required')
      ? pass('project-rules-link', 'caogen.md', 'Project Agent rules link the standard and required gate')
      : fail('project-rules-link', 'caogen.md', 'Project Agent rules must link the standard and required gate')
  ]
}

function checkPackageScripts() {
  const packageJson = JSON.parse(read('package.json'))
  const expected = {
    'test:coding-standards': 'node scripts/coding-standards-audit.mjs',
    'test:coding-standards:required': 'node scripts/coding-standards-audit.mjs --required',
    'test:coding-standards:strict': 'node scripts/coding-standards-audit.mjs --strict',
    'test:coding-standards:baseline': 'node scripts/coding-standards-audit.mjs --write-baseline'
  }
  return Object.entries(expected).map(([name, command]) =>
    packageJson.scripts?.[name] === command
      ? pass('package-script', 'package.json', `${name} is wired`)
      : fail('package-script', 'package.json', `Add "${name}": "${command}"`)
  )
}

function checkBaselineContract(baseline) {
  if (!baseline) {
    return [
      mode === 'report'
        ? warn('standards-baseline', baselineFile, 'Baseline is missing; required mode cannot enforce the debt ratchet')
        : fail('standards-baseline', baselineFile, 'Baseline is missing; run --write-baseline only after deliberate review')
    ]
  }
  const validationErrors = validateBaseline(baseline)
  if (validationErrors.length > 0) {
    return [fail('standards-baseline-schema', baselineFile, `${validationErrors.length} validation error(s)`, { errors: validationErrors })]
  }
  if (JSON.stringify(baseline.thresholds) !== JSON.stringify(thresholds)) {
    return [
      mode === 'report'
        ? warn('standards-baseline-thresholds', baselineFile, 'Baseline thresholds differ from the active standard')
        : fail('standards-baseline-thresholds', baselineFile, 'Baseline thresholds differ; review policy before refreshing')
    ]
  }
  return [pass('standards-baseline', baselineFile, `${Object.keys(baseline.files ?? {}).length} file metrics loaded`)]
}

function checkFileMetrics(metrics) {
  const overTarget = metrics
    .filter((item) => item.lines > thresholds[item.profile].targetLines)
    .sort((a, b) => b.lines - a.lines)
    .map((item) => ({
      file: item.file,
      profile: item.profile,
      lines: item.lines,
      targetLines: thresholds[item.profile].targetLines,
      hardLines: thresholds[item.profile].hardLines
    }))
  const overHard = overTarget.filter((item) => item.lines > item.hardLines)
  return [
    pass('file-size-summary', '.', `${metrics.length - overTarget.length}/${metrics.length} code files are within target`),
    overTarget.length === 0
      ? pass('file-size-debt', '.', 'No code files exceed their target')
      : warn(
          'file-size-debt',
          '.',
          `${overTarget.length} file(s) exceed target; ${overHard.length} exceed a hard limit and are baseline debt`,
          { files: overTarget }
        )
  ]
}

function checkFunctionMetrics(metrics) {
  const analyzed = metrics.filter((item) => item.typescriptAnalyzed)
  const analyzedFunctions = analyzed.reduce((sum, item) => sum + item.functionCount, 0)
  const longFunctionFiles = analyzed
    .filter((item) => item.reviewLongFunctions.length > 0)
    .sort((a, b) => b.maxFunctionLines - a.maxFunctionLines)
    .map((item) => ({
      file: item.file,
      reviewCount: item.reviewLongFunctions.length,
      hardCount: item.oversizedFunctionCount,
      maxLines: item.maxFunctionLines,
      functions: item.reviewLongFunctions.slice(0, 10)
    }))
  const complexFunctionFiles = analyzed
    .filter((item) => item.reviewComplexFunctions.length > 0)
    .sort((a, b) => b.maxComplexity - a.maxComplexity)
    .map((item) => ({
      file: item.file,
      reviewCount: item.reviewComplexFunctions.length,
      hardCount: item.complexFunctionCount,
      maxComplexity: item.maxComplexity,
      functions: item.reviewComplexFunctions.slice(0, 10)
    }))
  const longCount = analyzed.reduce((sum, item) => sum + item.reviewLongFunctions.length, 0)
  const oversizedCount = analyzed.reduce((sum, item) => sum + item.oversizedFunctionCount, 0)
  const complexCount = analyzed.reduce((sum, item) => sum + item.reviewComplexFunctions.length, 0)
  const hardComplexCount = analyzed.reduce((sum, item) => sum + item.complexFunctionCount, 0)
  return [
    pass(
      'function-analysis-summary',
      '.',
      `${analyzedFunctions} functions analyzed across ${analyzed.length} TypeScript/JavaScript files`
    ),
    longCount === 0
      ? pass('function-size-debt', '.', 'No functions exceed the review threshold')
      : warn(
          'function-size-debt',
          '.',
          `${longCount} function(s) exceed ${thresholds.functions.reviewLines} lines; ${oversizedCount} exceed hard limit ${thresholds.functions.hardLines}`,
          { files: longFunctionFiles }
        ),
    complexCount === 0
      ? pass('function-complexity-debt', '.', 'No functions exceed the complexity target')
      : warn(
          'function-complexity-debt',
          '.',
          `${complexCount} function(s) exceed complexity ${thresholds.functions.targetComplexity}; ${hardComplexCount} exceed hard limit ${thresholds.functions.hardComplexity}`,
          { files: complexFunctionFiles }
        )
  ]
}

function checkCommentDiscipline(metrics) {
  const issueFiles = metrics
    .filter((item) => commentIssueCount(item) > 0)
    .map((item) => ({
      file: item.file,
      forbiddenSuppressionCount: item.forbiddenSuppressionCount,
      unreasonedSuppressionCount: item.unreasonedSuppressionCount,
      malformedDebtMarkerCount: item.malformedDebtMarkerCount,
      comments: item.commentIssues.slice(0, 20)
    }))
  const issueCount = issueFiles.reduce(
    (sum, item) =>
      sum + item.forbiddenSuppressionCount + item.unreasonedSuppressionCount + item.malformedDebtMarkerCount,
    0
  )
  return [
    issueCount === 0
      ? pass('comment-discipline', '.', 'No prohibited or unreasoned comment directives found')
      : mode === 'report'
        ? warn(
            'comment-discipline',
            '.',
            `${issueCount} prohibited or unreasoned directive(s) across ${issueFiles.length} file(s)`,
            { files: issueFiles }
          )
        : fail(
            'comment-discipline',
            '.',
            `${issueCount} prohibited or unreasoned directive(s) across ${issueFiles.length} file(s)`,
            { files: issueFiles }
          )
  ]
}

function checkBaselineRegressions(metrics, repository, baseline) {
  if (!baseline || baseline.version !== 2) return []
  const baselineFiles = baseline.files ?? {}
  const { regressions, refreshes, currentFiles } = collectFileBaselineFindings(metrics, baselineFiles)
  collectRepositoryBaselineFindings(regressions, refreshes, repository, baseline.repository)
  for (const file of Object.keys(baselineFiles)) {
    if (!currentFiles.has(file)) refreshes.push({ file, reasons: ['baseline debt file was removed'] })
  }
  const out = [
    ...renderBaselineFindings('baseline-regression', regressions),
    ...renderBaselineFindings('baseline-refresh-required', refreshes)
  ]
  if (out.length === 0) {
    out.push(pass('baseline-ratchet', baselineFile, 'No file, function, complexity, comment, or IPC debt regressed'))
  }
  return out
}

function collectFileBaselineFindings(metrics, baselineFiles) {
  const regressions = []
  const refreshes = []
  const currentFiles = new Set()
  for (const item of metrics) {
    currentFiles.add(item.file)
    const previous = baselineFiles[item.file]
    const policy = thresholds[item.profile]
    const reasons = []
    const refreshReasons = []
    const allowedLines = previous?.lines > policy.hardLines ? previous.lines : policy.hardLines
    if (item.lines > allowedLines) reasons.push(`lines ${item.lines} > allowed ${allowedLines}`)
    if (previous?.lines > policy.hardLines && item.lines < previous.lines) {
      refreshReasons.push(`file lines improved ${previous.lines} -> ${item.lines}`)
    }
    compareFunctionDebt(reasons, refreshReasons, item.hardFunctionDebt, previous?.functionDebt)
    if (previous?.contentHash && item.contentHash !== previous.contentHash && reasons.length === 0 && refreshReasons.length === 0) {
      refreshReasons.push('accepted-debt file content changed; refresh baseline after reviewing the diff')
    }
    if (reasons.length > 0) regressions.push({ file: item.file, reasons })
    if (refreshReasons.length > 0) refreshes.push({ file: item.file, reasons: refreshReasons })
  }
  return { regressions, refreshes, currentFiles }
}

function collectRepositoryBaselineFindings(regressions, refreshes, repository, previous) {
  compareRepositoryMetric(
    regressions,
    refreshes,
    repository,
    previous,
    'ipcHandlerCount',
    'src/main/ipc.ts',
    'central IPC handlers/listeners',
    thresholds.ipc.handlerFileHardCount
  )
  compareRepositoryMetric(
    regressions,
    refreshes,
    repository,
    previous,
    'ipcHandlerTotal',
    'src/main',
    'total IPC handlers/listeners',
    thresholds.ipc.handlerTotalHardCount
  )
  compareRepositoryMetric(
    regressions,
    refreshes,
    repository,
    previous,
    'preloadInvokeCount',
    'src/preload/index.ts',
    'central preload invoke calls',
    thresholds.ipc.preloadInvokeFileHardCount
  )
  compareRepositoryMetric(
    regressions,
    refreshes,
    repository,
    previous,
    'preloadInvokeTotal',
    'src/preload',
    'total preload invoke calls',
    thresholds.ipc.preloadInvokeTotalHardCount
  )
  compareRepositoryMetric(
    regressions,
    refreshes,
    repository,
    previous,
    'preloadListenerCount',
    'src/preload/index.ts',
    'central preload listeners',
    thresholds.ipc.preloadListenerFileHardCount
  )
  compareRepositoryMetric(
    regressions,
    refreshes,
    repository,
    previous,
    'preloadListenerTotal',
    'src/preload',
    'total preload listeners',
    thresholds.ipc.preloadListenerTotalHardCount
  )

}

function renderBaselineFindings(id, findings) {
  return findings.map((item) => {
    const message = item.reasons.join('; ')
    return mode === 'report'
      ? warn(id, item.file, message, { reasons: item.reasons })
      : fail(id, item.file, message, { reasons: item.reasons })
  })
}

function checkAnyBoundaries() {
  const matches = []
  for (const file of listCodeFiles().filter((item) => /\.tsx?$/.test(item))) {
    const text = read(file)
    const lines = text.split(/\r?\n/)
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        const sourceLine = lines[line - 1] ?? ''
        const allowed = allowedAnyBoundaries.find((item) => item.file === file && item.pattern.test(sourceLine))
        matches.push({
          file,
          line,
          text: sourceLine.trim(),
          allowed: Boolean(allowed),
          note: allowed?.note
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  const unexpected = matches.filter((item) => !item.allowed)
  if (unexpected.length > 0) {
    const result =
      mode === 'report'
        ? warn('typescript-any-boundaries', unexpected[0].file, `${unexpected.length} unapproved any boundaries found`, {
            matches: unexpected.slice(0, 20)
          })
        : fail('typescript-any-boundaries', unexpected[0].file, `${unexpected.length} unapproved any boundaries found`, {
            matches: unexpected.slice(0, 20)
          })
    return [result]
  }
  return [
    pass(
      'typescript-any-boundaries',
      'src',
      matches.length === 0 ? 'No any boundaries found' : `${matches.length} approved any boundaries`,
      { matches }
    )
  ]
}

function checkIpcPreloadScale(repository) {
  return [
    repository.ipcHandlerCount > thresholds.ipc.handlerFileHardCount
      ? warn(
          'ipc-scale',
          'src/main/ipc.ts',
          `${repository.ipcHandlerCount} direct handlers/listeners; hard target ${thresholds.ipc.handlerFileHardCount}`
        )
      : pass('ipc-scale', 'src/main/ipc.ts', `${repository.ipcHandlerCount} handlers/listeners`),
    repository.ipcHandlerTotal > thresholds.ipc.handlerTotalHardCount
      ? warn(
          'ipc-total-scale',
          'src/main',
          `${repository.ipcHandlerTotal} total handlers/listeners; hard target ${thresholds.ipc.handlerTotalHardCount}`
        )
      : pass('ipc-total-scale', 'src/main', `${repository.ipcHandlerTotal} total handlers/listeners`),
    repository.preloadInvokeCount > thresholds.ipc.preloadInvokeFileHardCount
      ? warn(
          'preload-scale',
          'src/preload/index.ts',
          `${repository.preloadInvokeCount} direct invoke calls; hard target ${thresholds.ipc.preloadInvokeFileHardCount}`
        )
      : pass('preload-scale', 'src/preload/index.ts', `${repository.preloadInvokeCount} invoke calls`),
    repository.preloadInvokeTotal > thresholds.ipc.preloadInvokeTotalHardCount
      ? warn(
          'preload-total-scale',
          'src/preload',
          `${repository.preloadInvokeTotal} total invoke calls; hard target ${thresholds.ipc.preloadInvokeTotalHardCount}`
        )
      : pass('preload-total-scale', 'src/preload', `${repository.preloadInvokeTotal} total invoke calls`),
    repository.preloadListenerCount > thresholds.ipc.preloadListenerFileHardCount
      ? warn(
          'preload-listeners',
          'src/preload/index.ts',
          `${repository.preloadListenerCount} direct listeners; hard target ${thresholds.ipc.preloadListenerFileHardCount}`
        )
      : pass('preload-listeners', 'src/preload/index.ts', `${repository.preloadListenerCount} listeners`),
    repository.preloadListenerTotal > thresholds.ipc.preloadListenerTotalHardCount
      ? warn(
          'preload-total-listeners',
          'src/preload',
          `${repository.preloadListenerTotal} total listeners; hard target ${thresholds.ipc.preloadListenerTotalHardCount}`
        )
      : pass('preload-total-listeners', 'src/preload', `${repository.preloadListenerTotal} total listeners`)
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
    warn('untracked-source', files[0], `${files.length} untracked source/standards file(s)`, {
      files: files.slice(0, 50)
    })
  ]
}

function analyzeCodeFile(file) {
  const text = read(file)
  const profile = classifyProfile(file)
  const metrics = {
    file,
    profile,
    lines: countPhysicalLines(text),
    contentHash: createHash('sha256').update(text).digest('hex'),
    typescriptAnalyzed: false,
    functionCount: 0,
    reviewLongFunctions: [],
    oversizedFunctionCount: 0,
    maxFunctionLines: 0,
    reviewComplexFunctions: [],
    complexFunctionCount: 0,
    maxComplexity: 0,
    hardFunctionDebt: [],
    forbiddenSuppressionCount: 0,
    unreasonedSuppressionCount: 0,
    malformedDebtMarkerCount: 0,
    commentIssues: []
  }

  if (!typescriptExtensions.has(path.extname(file))) return metrics

  metrics.typescriptAnalyzed = true
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
  const functions = collectFunctions(sourceFile)
  metrics.functionCount = functions.length
  metrics.reviewLongFunctions = functions
    .filter((item) => item.lines > thresholds.functions.reviewLines)
    .sort((a, b) => b.lines - a.lines)
  metrics.oversizedFunctionCount = functions.filter((item) => item.lines > thresholds.functions.hardLines).length
  metrics.maxFunctionLines = Math.max(0, ...functions.map((item) => item.lines))
  metrics.reviewComplexFunctions = functions
    .filter((item) => item.complexity > thresholds.functions.targetComplexity)
    .sort((a, b) => b.complexity - a.complexity)
  metrics.complexFunctionCount = functions.filter(
    (item) => item.complexity > thresholds.functions.hardComplexity
  ).length
  metrics.maxComplexity = Math.max(0, ...functions.map((item) => item.complexity))
  metrics.hardFunctionDebt = functions.filter(
    (item) => item.lines > thresholds.functions.hardLines || item.complexity > thresholds.functions.hardComplexity
  )

  const comments = scanComments(sourceFile, text)
  for (const comment of comments) {
    const normalized = normalizeComment(comment.text)
    if (/^@ts-(ignore|nocheck)\b/i.test(normalized)) {
      metrics.forbiddenSuppressionCount += 1
      metrics.commentIssues.push({ ...comment, kind: 'forbidden-typescript-suppression', text: normalized })
      continue
    }
    if (/^@ts-expect-error\b/i.test(normalized) && !hasInlineReason(normalized)) {
      metrics.unreasonedSuppressionCount += 1
      metrics.commentIssues.push({ ...comment, kind: 'unreasoned-ts-expect-error', text: normalized })
      continue
    }
    if (/^eslint-disable(?:-next-line|-line)?\b/i.test(normalized) && !hasInlineReason(normalized)) {
      metrics.unreasonedSuppressionCount += 1
      metrics.commentIssues.push({ ...comment, kind: 'unreasoned-eslint-disable', text: normalized })
      continue
    }
    if (/^prettier-ignore\b/i.test(normalized) && !hasInlineReason(normalized)) {
      metrics.unreasonedSuppressionCount += 1
      metrics.commentIssues.push({ ...comment, kind: 'unreasoned-prettier-ignore', text: normalized })
      continue
    }
    if (/^(TODO|FIXME)\b/i.test(normalized) && !isValidDebtMarker(normalized)) {
      metrics.malformedDebtMarkerCount += 1
      metrics.commentIssues.push({ ...comment, kind: 'malformed-debt-marker', text: normalized })
    }
  }
  return metrics
}

function collectFunctions(sourceFile) {
  const out = []
  const occurrences = new Map()
  const visit = (node) => {
    if (isFunctionLike(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      const name = functionName(node, sourceFile)
      const occurrence = (occurrences.get(name) ?? 0) + 1
      occurrences.set(name, occurrence)
      out.push({
        id: `${name}#${occurrence}`,
        name,
        line: start,
        lines: end - start + 1,
        complexity: functionComplexity(node)
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return out
}

function functionComplexity(root) {
  let complexity = 1
  const visit = (node) => {
    if (node !== root && isFunctionLike(node)) return
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node) ||
      ts.isCaseClause(node)
    ) {
      complexity += 1
    } else if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind
      )
    ) {
      complexity += 1
    }
    ts.forEachChild(node, visit)
  }
  if (root.body) visit(root.body)
  return complexity
}

function functionName(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile)
  const parent = node.parent
  if (ts.isVariableDeclaration(parent)) return parent.name.getText(sourceFile)
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText(sourceFile)
  if (ts.isCallExpression(parent)) {
    return `${parent.expression.getText(sourceFile).slice(0, 48)} callback`
  }
  return '<anonymous>'
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function scanComments(sourceFile, text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sourceFile.languageVariant, text)
  const comments = []
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const position = scanner.getTokenPos()
      comments.push({
        line: sourceFile.getLineAndCharacterOfPosition(position).line + 1,
        text: text.slice(position, scanner.getTextPos())
      })
    }
    token = scanner.scan()
  }
  return comments
}

function normalizeComment(comment) {
  return comment
    .replace(/^\/\//, '')
    .replace(/^\/\*/, '')
    .replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .join(' ')
    .trim()
}

function hasInlineReason(comment) {
  const match = comment.match(/(?:--|:)\s*(.+)$/)
  return Boolean(match && match[1].trim().length >= 10)
}

function isValidDebtMarker(comment) {
  return /^(TODO|FIXME)\([^)]+\):\s+.+;\s+remove when\s+.+$/i.test(comment)
}

function analyzeRepositoryMetrics() {
  const files = listCodeFiles()
  const mainFiles = files.filter((file) => file.startsWith('src/main/') && /\.tsx?$/.test(file))
  const preloadFiles = files.filter((file) => file.startsWith('src/preload/') && /\.tsx?$/.test(file))
  return {
    ipcHandlerCount: countMemberCalls(['src/main/ipc.ts'], 'ipcMain', ['handle', 'on']),
    ipcHandlerTotal: countMemberCalls(mainFiles, 'ipcMain', ['handle', 'on']),
    preloadInvokeCount: countMemberCalls(['src/preload/index.ts'], 'ipcRenderer', ['invoke']),
    preloadInvokeTotal: countMemberCalls(preloadFiles, 'ipcRenderer', ['invoke']),
    preloadListenerCount: countMemberCalls(['src/preload/index.ts'], 'ipcRenderer', ['on']),
    preloadListenerTotal: countMemberCalls(preloadFiles, 'ipcRenderer', ['on'])
  }
}

function countMemberCalls(files, receiver, methods) {
  let count = 0
  for (const file of files) {
    if (!existsSync(path.join(repoRoot, file))) continue
    const text = read(file)
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === receiver &&
        methods.includes(node.expression.name.text)
      ) {
        count += 1
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return count
}

function compareFunctionDebt(regressions, refreshes, currentDebt, previousDebt = {}) {
  const currentById = new Map(currentDebt.map((item) => [item.id, item]))
  for (const current of currentDebt) {
    const previous = previousDebt[current.id]
    if (!previous) {
      regressions.push(`new hard-limit function ${current.id} (${current.lines} lines, complexity ${current.complexity})`)
      continue
    }
    if (current.lines > Math.max(previous.lines, thresholds.functions.hardLines)) {
      regressions.push(`${current.id} lines ${current.lines} > allowed ${Math.max(previous.lines, thresholds.functions.hardLines)}`)
    } else if (previous.lines > thresholds.functions.hardLines && current.lines < previous.lines) {
      refreshes.push(`${current.id} lines improved ${previous.lines} -> ${current.lines}`)
    }
    if (current.complexity > Math.max(previous.complexity, thresholds.functions.hardComplexity)) {
      regressions.push(
        `${current.id} complexity ${current.complexity} > allowed ${Math.max(previous.complexity, thresholds.functions.hardComplexity)}`
      )
    } else if (previous.complexity > thresholds.functions.hardComplexity && current.complexity < previous.complexity) {
      refreshes.push(`${current.id} complexity improved ${previous.complexity} -> ${current.complexity}`)
    }
  }
  for (const id of Object.keys(previousDebt)) {
    if (!currentById.has(id)) refreshes.push(`${id} no longer exceeds a hard limit`)
  }
}

function compareRepositoryMetric(regressions, refreshes, current, previous, key, file, label, hardLimit) {
  const allowed = Math.max(previous?.[key] ?? 0, hardLimit)
  if (current[key] > allowed) addMetricFinding(regressions, file, `${label} ${current[key]} > allowed ${allowed}`)
  else if ((previous?.[key] ?? 0) > hardLimit && current[key] < previous[key]) {
    addMetricFinding(refreshes, file, `${label} improved ${previous[key]} -> ${current[key]}`)
  }
}

function addMetricFinding(collection, file, reason) {
  let entry = collection.find((item) => item.file === file)
  if (!entry) {
    entry = { file, reasons: [] }
    collection.push(entry)
  }
  entry.reasons.push(reason)
}

function listCodeFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts', 'plugins', 'electron.vite.config.ts'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  return [...new Set(output.split('\0').filter(Boolean).map(normalizePath))]
    .filter((file) => existsSync(path.join(repoRoot, file)))
    .filter((file) => codeExtensions.has(path.extname(file)))
    .filter((file) => !excludedCodePrefixes.some((prefix) => file.startsWith(prefix)))
    .sort()
}

function classifyProfile(file) {
  if (
    file.startsWith('scripts/') ||
    /(^|\/)(test|tests|__tests__)\//.test(file) ||
    /\.(test|spec)\.[^.]+$/.test(file) ||
    /(^|\/)(smoke|e2e)[.-]/.test(file)
  ) {
    return 'automation'
  }
  return 'product'
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.ts')) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function loadBaseline() {
  if (!existsSync(baselinePath)) return null
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch (error) {
    return { version: 'invalid', parseError: error instanceof Error ? error.message : String(error) }
  }
}

function validateBaseline(baseline) {
  const errors = []
  if (!baseline || typeof baseline !== 'object') return ['baseline must be an object']
  if (baseline.version !== 2) errors.push(`version must be 2, got ${baseline.version ?? 'missing'}`)
  errors.push(...validateRepositoryBaseline(baseline.repository))
  if (!baseline.files || typeof baseline.files !== 'object' || Array.isArray(baseline.files)) {
    errors.push('files must be an object')
    return errors
  }
  for (const [file, entry] of Object.entries(baseline.files)) {
    errors.push(...validateBaselineFile(file, entry))
  }
  return errors
}

function validateRepositoryBaseline(repository) {
  if (!repository || typeof repository !== 'object') return ['repository metrics are missing']
  return Object.entries(repository)
    .filter(([, value]) => !isNonNegativeInteger(value))
    .map(([key]) => `repository.${key} must be a non-negative integer`)
}

function validateBaselineFile(file, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${file} must contain an object metric entry`]
  }
  const errors = []
  if (!['product', 'automation'].includes(entry.profile)) errors.push(`${file}.profile is invalid`)
  for (const key of baselineIntegerFields()) {
    if (!isNonNegativeInteger(entry[key])) errors.push(`${file}.${key} must be a non-negative integer`)
  }
  if (!/^[a-f0-9]{64}$/.test(entry.contentHash ?? '')) errors.push(`${file}.contentHash must be sha256 hex`)
  errors.push(...validateFunctionDebtEntry(file, entry))
  const hardLines = thresholds[entry.profile]?.hardLines ?? Number.POSITIVE_INFINITY
  const functionDebtCount = Object.keys(entry.functionDebt ?? {}).length
  if (entry.lines <= hardLines && functionDebtCount === 0 && commentEntryDebt(entry) === 0) {
    errors.push(`${file} has no ratcheted debt and should not be in the baseline`)
  }
  return errors
}

function baselineIntegerFields() {
  return [
    'lines',
    'oversizedFunctionCount',
    'maxFunctionLines',
    'complexFunctionCount',
    'maxComplexity',
    'forbiddenSuppressionCount',
    'unreasonedSuppressionCount',
    'malformedDebtMarkerCount'
  ]
}

function validateFunctionDebtEntry(file, entry) {
  if (!entry.functionDebt || typeof entry.functionDebt !== 'object' || Array.isArray(entry.functionDebt)) {
    return [`${file}.functionDebt must be an object`]
  }
  const errors = []
  const debts = Object.values(entry.functionDebt).filter((debt) => debt && typeof debt === 'object')
  for (const [id, debt] of Object.entries(entry.functionDebt)) {
    if (!isNonNegativeInteger(debt?.lines) || !isNonNegativeInteger(debt?.complexity)) {
      errors.push(`${file}.functionDebt.${id} has invalid metrics`)
    } else if (debt.lines <= thresholds.functions.hardLines && debt.complexity <= thresholds.functions.hardComplexity) {
      errors.push(`${file}.functionDebt.${id} does not exceed a hard limit`)
    }
  }
  const oversized = debts.filter((debt) => debt.lines > thresholds.functions.hardLines)
  const complex = debts.filter((debt) => debt.complexity > thresholds.functions.hardComplexity)
  if (entry.oversizedFunctionCount !== oversized.length) errors.push(`${file}.oversizedFunctionCount is inconsistent`)
  if (entry.complexFunctionCount !== complex.length) errors.push(`${file}.complexFunctionCount is inconsistent`)
  if (entry.maxFunctionLines < Math.max(0, ...debts.map((debt) => debt.lines))) {
    errors.push(`${file}.maxFunctionLines is below recorded function debt`)
  }
  if (entry.maxComplexity < Math.max(0, ...debts.map((debt) => debt.complexity))) {
    errors.push(`${file}.maxComplexity is below recorded function debt`)
  }
  return errors
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0
}

function commentEntryDebt(entry) {
  return entry.forbiddenSuppressionCount + entry.unreasonedSuppressionCount + entry.malformedDebtMarkerCount
}

function writeBaselineSnapshot(metrics, repository) {
  const files = {}
  for (const item of metrics) {
    if (hasRatchetedDebt(item)) files[item.file] = baselineMetrics(item)
  }
  const baseline = {
    version: 2,
    description: 'Accepted CaoGen coding debt ceiling. Required mode rejects regressions above these metrics.',
    thresholds,
    repository,
    files
  }
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
}

function hasRatchetedDebt(item) {
  return (
    item.lines > thresholds[item.profile].hardLines ||
    item.oversizedFunctionCount > 0 ||
    item.complexFunctionCount > 0 ||
    item.forbiddenSuppressionCount > 0 ||
    item.unreasonedSuppressionCount > 0 ||
    item.malformedDebtMarkerCount > 0
  )
}

function baselineMetrics(item) {
  return {
    profile: item.profile,
    lines: item.lines,
    contentHash: item.contentHash,
    oversizedFunctionCount: item.oversizedFunctionCount,
    maxFunctionLines: item.maxFunctionLines,
    complexFunctionCount: item.complexFunctionCount,
    maxComplexity: item.maxComplexity,
    forbiddenSuppressionCount: item.forbiddenSuppressionCount,
    unreasonedSuppressionCount: item.unreasonedSuppressionCount,
    malformedDebtMarkerCount: item.malformedDebtMarkerCount,
    functionDebt: Object.fromEntries(
      item.hardFunctionDebt.map((entry) => [entry.id, { lines: entry.lines, complexity: entry.complexity }])
    )
  }
}

function commentIssueCount(item) {
  return item.forbiddenSuppressionCount + item.unreasonedSuppressionCount + item.malformedDebtMarkerCount
}

function summarizeMetrics(metrics, repository, baseline) {
  return {
    files: metrics.length,
    productFiles: metrics.filter((item) => item.profile === 'product').length,
    automationFiles: metrics.filter((item) => item.profile === 'automation').length,
    filesOverTarget: metrics.filter((item) => item.lines > thresholds[item.profile].targetLines).length,
    filesOverHardLimit: metrics.filter((item) => item.lines > thresholds[item.profile].hardLines).length,
    functionsAnalyzed: metrics.reduce((sum, item) => sum + item.functionCount, 0),
    functionsOverReviewLines: metrics.reduce((sum, item) => sum + item.reviewLongFunctions.length, 0),
    functionsOverHardLines: metrics.reduce((sum, item) => sum + item.oversizedFunctionCount, 0),
    functionsOverTargetComplexity: metrics.reduce((sum, item) => sum + item.reviewComplexFunctions.length, 0),
    functionsOverHardComplexity: metrics.reduce((sum, item) => sum + item.complexFunctionCount, 0),
    commentDirectiveDebt: metrics.reduce(
      (sum, item) =>
        sum + item.forbiddenSuppressionCount + item.unreasonedSuppressionCount + item.malformedDebtMarkerCount,
      0
    ),
    baselineFiles: Object.keys(baseline?.files ?? {}).length,
    ...repository
  }
}

function read(file) {
  return readFileSync(path.join(repoRoot, file), 'utf8')
}

function countPhysicalLines(text) {
  if (!text) return 0
  const lines = text.split(/\r?\n/)
  return lines.at(-1) === '' ? lines.length - 1 : lines.length
}

function normalizePath(file) {
  return file.split(path.sep).join('/')
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
    `mode=${report.mode} pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`,
    `files=${report.metrics.files} functions=${report.metrics.functionsAnalyzed} hard-file-debt=${report.metrics.filesOverHardLimit} hard-function-debt=${report.metrics.functionsOverHardLines} hard-complexity-debt=${report.metrics.functionsOverHardComplexity}`,
    `report: ${path.join(reportRoot, 'latest.md')}`
  ]
  for (const item of report.checks) {
    const label = item.status.toUpperCase().padEnd(4)
    lines.push(`[${label}] ${item.id} ${item.file}: ${item.message}`)
  }
  if (strict && report.summary.warn > 0) lines.push('strict mode treats warnings as failures')
  return lines.join('\n')
}

function renderMarkdown(report) {
  const lines = [
    `# Coding Standards Audit ${report.runId}`,
    '',
    `- Status: ${report.status}`,
    `- Mode: ${report.mode}`,
    `- Generated: ${report.generatedAt}`,
    `- Repo: ${report.repoRoot}`,
    `- Baseline: ${report.baselineFile}`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '|---|---:|'
  ]
  for (const [key, value] of Object.entries(report.metrics)) {
    lines.push(`| ${escapePipe(key)} | ${escapePipe(value)} |`)
  }
  lines.push('', '## Checks', '', '| Check | Status | File | Message |', '|---|---|---|---|')
  for (const item of report.checks) {
    lines.push(`| ${escapePipe(item.id)} | ${item.status} | ${escapePipe(item.file)} | ${escapePipe(item.message)} |`)
  }
  const detailed = report.checks.filter((item) => item.details)
  if (detailed.length > 0) {
    lines.push('', '## Details', '')
    for (const item of detailed) {
      lines.push(`### ${item.id}: ${item.file}`, '', '```json', JSON.stringify(item.details, null, 2), '```', '')
    }
  }
  lines.push('## Summary', '')
  lines.push(`- Pass: ${report.summary.pass}`)
  lines.push(`- Warn: ${report.summary.warn}`)
  lines.push(`- Fail: ${report.summary.fail}`)
  lines.push('')
  return lines.join('\n')
}

function escapePipe(value) {
  return String(value).replace(/\|/g, '\\|')
}
