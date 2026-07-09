import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-search-replace-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')

try {
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/openaiTools.ts',
      '--outDir',
      outDir,
      '--rootDir',
      'src',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const searchReplace = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/search-replace.js')).href)
  const view = await import(pathToFileURL(path.join(outDir, 'main/agent/tools/view.js')).href)
  const tools = await import(pathToFileURL(path.join(outDir, 'main/openaiTools.js')).href)

  assert(
    tools.OPENAI_CODING_TOOLS.some((item) => item.function?.name === 'search_replace'),
    'search_replace schema should be registered'
  )
  assert(tools.OPENAI_CODING_TOOLS.some((item) => item.function?.name === 'view'), 'view schema should be registered')
  assert(tools.READONLY_TOOLS.has('view'), 'view should be readonly')
  assert(tools.EDIT_TOOLS.has('search_replace'), 'search_replace should be an edit tool')

  const target = path.join(projectDir, 'src/example.ts')
  const original = [
    'export function greet(name: string) {',
    '  const normalized = name.trim()',
    '  return `hello ${normalized}`',
    '}',
    '',
    'export function bye(name: string) {',
    '  return `bye ${name}`',
    '}',
    ''
  ].join('\n')
  writeFileSync(target, original, 'utf8')

  const oldStr = [
    'export function greet(name: string) {',
    '  const normalized = name.trim()',
    '  return `hello ${normalized}`',
    '}'
  ].join('\n')
  const newStr = [
    'export function greet(name: string) {',
    '  const normalized = name.trim()',
    '  return `HELLO ${normalized}`',
    '}'
  ].join('\n')

  const dryRun = await searchReplace.runSearchReplace(projectDir, {
    file_path: target,
    replacements: [{ old_str: oldStr, new_str: newStr }],
    dry_run: true
  })
  assertOk(dryRun, 'dry_run should succeed')
  assert(dryRun.diff.includes('-  return `hello ${normalized}`'), 'dry_run should include removed diff line')
  assert(dryRun.diff.includes('+  return `HELLO ${normalized}`'), 'dry_run should include added diff line')
  assertEqual(readFileSync(target, 'utf8'), original)

  const readOnlyTarget = path.join(projectDir, 'src/readonly.ts')
  writeFileSync(readOnlyTarget, original, 'utf8')
  try {
    chmodSync(readOnlyTarget, 0o444)
    const readOnlyDryRun = await searchReplace.runSearchReplace(projectDir, {
      file_path: readOnlyTarget,
      replacements: [{ old_str: oldStr, new_str: newStr }],
      dry_run: true
    })
    assertOk(readOnlyDryRun, 'dry_run should preview read-only files without requiring write access')
    assertEqual(readFileSync(readOnlyTarget, 'utf8'), original)
  } finally {
    chmodSync(readOnlyTarget, 0o666)
  }

  const actual = await searchReplace.runSearchReplace(projectDir, {
    file_path: target,
    replacements: [{ old_str: oldStr, new_str: newStr }]
  })
  assertOk(actual, 'search_replace should write')
  assert(actual.backupPath && existsSync(actual.backupPath), 'backup file should exist')
  assert(actual.backupPath.includes(path.join('.caogen', 'tmp', 'backup')), 'backup should be under .caogen/tmp/backup')
  assertEqual(readFileSync(actual.backupPath, 'utf8'), original)
  assert(readFileSync(target, 'utf8').includes('return `HELLO ${normalized}`'), 'target should be edited')
  assert(actual.replacements[0].ranges[0].startLine === 1, 'line range should record start line')

  const driftTarget = path.join(projectDir, 'src/whitespace-drift.ts')
  writeFileSync(
    driftTarget,
    [
      'export function total(a: number, b: number) {',
      '    const sum =',
      '      a + b',
      '    return sum',
      '}',
      ''
    ].join('\n'),
    'utf8'
  )
  const driftOld = [
    'export function total(a: number, b: number) {',
    '  const sum = a + b',
    '  return sum',
    '}'
  ].join('\n')
  const driftNew = [
    'export function total(a: number, b: number) {',
    '  const sum = a + b',
    '  return sum * 2',
    '}'
  ].join('\n')
  const driftResult = await searchReplace.runSearchReplace(projectDir, {
    file_path: driftTarget,
    replacements: [{ old_str: driftOld, new_str: driftNew }]
  })
  assertOk(driftResult, 'search_replace should tolerate whitespace and line-break drift')
  assert(driftResult.replacements[0].matchType === 'whitespace', 'whitespace tolerant match type should be reported')
  assert(driftResult.replacements[0].confidence >= 0.95, 'whitespace tolerant match should be auto-apply confidence')
  assert(readFileSync(driftTarget, 'utf8').includes('return sum * 2'), 'whitespace tolerant replacement should write')

  const narrow = await searchReplace.runSearchReplace(projectDir, {
    file_path: target,
    replacements: [{ old_str: '  return `HELLO ${normalized}`', new_str: '  return `hello ${normalized}`' }]
  })
  assert(!narrow.ok, 'single-line old_str should fail context validation')
  assert(narrow.error.includes('上下文不足'), 'narrow old_str error should explain missing context')

  const missing = await searchReplace.runSearchReplace(projectDir, {
    file_path: target,
    replacements: [
      {
        old_str: [
          'export function greet(name: string) {',
          '  const normalized = name.toLowerCase()',
          '  return `HELLO ${normalized}`'
        ].join('\n'),
        new_str: [
          'export function greet(name: string) {',
          '  const normalized = name.trim()',
          '  return `HELLO ${normalized}`'
        ].join('\n')
      }
    ]
  })
  assert(!missing.ok, 'missing old_str should fail')
  assert(missing.similarSnippets?.length > 0, 'missing old_str should include similar snippets')

  const duplicate = path.join(projectDir, 'src/duplicate.txt')
  writeFileSync(duplicate, 'alpha\nsame\nomega\n\nalpha\nsame\nomega\n', 'utf8')
  const duplicateFail = await searchReplace.runSearchReplace(projectDir, {
    file_path: duplicate,
    replacements: [{ old_str: 'alpha\nsame\nomega', new_str: 'changed' }]
  })
  assert(!duplicateFail.ok, 'duplicate old_str should fail without replace_all')

  const duplicateAll = await searchReplace.runSearchReplace(projectDir, {
    file_path: duplicate,
    replacements: [{ old_str: 'alpha\nsame\nomega', new_str: 'changed', replace_all: true }]
  })
  assertOk(duplicateAll, 'replace_all should replace duplicates')
  assertEqual(readFileSync(duplicate, 'utf8'), 'changed\n\nchanged\n')

  const viewed = await view.runView(projectDir, { file_path: target, start_line: 1, end_line: 4 })
  assertOk(viewed, 'view should read text range')
  assert(viewed.content.includes('1 | export function greet'), 'view should include line numbers')
  assert(!viewed.content.includes('export function bye'), 'view should respect end_line')

  writeFileSync(path.join(projectDir, 'package-lock.json'), '{}', 'utf8')
  const skipped = await view.runView(projectDir, { file_path: 'package-lock.json' })
  assert(!skipped.ok, 'view should skip generated lock files')

  const toolView = await tools.executeCodingTool('view', { file_path: target, start_line: 1, end_line: 1 }, projectDir)
  assert(toolView.ok && toolView.output.includes('1 | export function greet'), 'executeCodingTool should run view')

  const escape = await tools.executeCodingTool('view', { file_path: path.join(tempRoot, 'outside.txt') }, projectDir)
  assert(!escape.ok, 'view should reject paths outside cwd')

  console.log('search_replace/view smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertOk(result, message) {
  assert(result.ok, `${message}: ${result.error ?? 'unknown error'}`)
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
