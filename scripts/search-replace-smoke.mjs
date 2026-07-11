import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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

  let dryRunWrites = 0
  const dryRunBackups = backupFiles(projectDir)
  const dryRun = await searchReplace.runSearchReplace(
    projectDir,
    {
      file_path: target,
      replacements: [{ old_str: oldStr, new_str: newStr }],
      dry_run: true
    },
    {
      writeTextFile: async () => {
        dryRunWrites++
      }
    }
  )
  assertOk(dryRun, 'dry_run should succeed')
  assert(dryRun.diff.includes('-  return `hello ${normalized}`'), 'dry_run should include removed diff line')
  assert(dryRun.diff.includes('+  return `HELLO ${normalized}`'), 'dry_run should include added diff line')
  assertEqual(readFileSync(target, 'utf8'), original)
  assertEqual(dryRunWrites, 0, 'dry_run must not invoke the file writer')
  assertEqual(JSON.stringify(backupFiles(projectDir)), JSON.stringify(dryRunBackups), 'dry_run must not create a backup')

  const noOpTarget = path.join(projectDir, 'src/no-op.ts')
  const noOpContent = [
    'export function unchanged() {',
    '  const value = 1',
    '  return value',
    '}',
    ''
  ].join('\n')
  const noOpOld = [
    'export function unchanged() {',
    '  const value = 1',
    '  return value',
    '}'
  ].join('\n')
  writeFileSync(noOpTarget, noOpContent, 'utf8')
  let noOpWrites = 0
  const noOpBackups = backupFiles(projectDir)
  const noOp = await searchReplace.runSearchReplace(
    projectDir,
    {
      file_path: noOpTarget,
      replacements: [{ old_str: noOpOld, new_str: noOpOld }]
    },
    {
      writeTextFile: async () => {
        noOpWrites++
      }
    }
  )
  assertOk(noOp, 'no-op search_replace should succeed')
  assertEqual(noOp.diff, '', 'no-op search_replace should report an empty diff')
  assertEqual(noOpWrites, 0, 'no-op search_replace must not invoke the file writer')
  assertEqual(readFileSync(noOpTarget, 'utf8'), noOpContent, 'no-op search_replace must preserve file content')
  assertEqual(JSON.stringify(backupFiles(projectDir)), JSON.stringify(noOpBackups), 'no-op search_replace must not create a backup')

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

  const bomTarget = path.join(projectDir, 'src/bom.ts')
  const bomBefore = 'alpha\nbeta\ngamma\n'
  const bomAfter = 'alpha\nBETA\ngamma\n'
  writeFileSync(bomTarget, Buffer.from(`\uFEFF${bomBefore}`, 'utf8'))
  const bomEdit = await searchReplace.runSearchReplace(projectDir, {
    file_path: bomTarget,
    replacements: [{ old_str: 'alpha\nbeta\ngamma', new_str: 'alpha\nBETA\ngamma' }]
  })
  assertOk(bomEdit, 'search_replace should edit UTF-8 BOM files')
  const bomObserved = readFileSync(bomTarget)
  assert(
    bomObserved[0] === 0xef && bomObserved[1] === 0xbb && bomObserved[2] === 0xbf,
    'search_replace must preserve the UTF-8 BOM'
  )
  assertEqual(bomObserved.toString('utf8'), `\uFEFF${bomAfter}`)

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

  const exactTarget = path.join(projectDir, 'src/exact-edit.txt')
  writeFileSync(exactTarget, 'alpha beta alpha beta\n', 'utf8')
  const exactEdit = await tools.executeCodingTool(
    'edit_file',
    { path: exactTarget, old_string: 'alpha', new_string: 'omega', replace_all: true },
    projectDir
  )
  assert(exactEdit.ok, `edit_file replace_all should succeed: ${exactEdit.output}`)
  assertEqual(readFileSync(exactTarget, 'utf8'), 'omega beta omega beta\n')

  const identicalEdit = await tools.executeCodingTool(
    'edit_file',
    { path: exactTarget, old_string: 'omega', new_string: 'omega', replace_all: true },
    projectDir
  )
  assert(!identicalEdit.ok, 'edit_file must reject identical old_string/new_string inputs')
  assertEqual(readFileSync(exactTarget, 'utf8'), 'omega beta omega beta\n')

  const malformedEditBefore = readFileSync(exactTarget, 'utf8')
  const malformedEdit = await tools.executeCodingTool(
    'edit_file',
    { path: exactTarget, old_string: 42, new_string: 'invalid' },
    projectDir
  )
  assert(!malformedEdit.ok, 'edit_file must reject non-string replacement parameters')
  assertEqual(readFileSync(exactTarget, 'utf8'), malformedEditBefore)

  const malformedSearch = await tools.executeCodingTool(
    'search_replace',
    { file_path: exactTarget, replacements: [{ old_str: 'omega', new_str: 42 }] },
    projectDir
  )
  assert(!malformedSearch.ok, 'search_replace must reject non-string replacement parameters')
  assertEqual(readFileSync(exactTarget, 'utf8'), malformedEditBefore)

  const guardedSearchTarget = path.join(projectDir, 'src/guarded-search.ts')
  const guardedSearchOriginal = [
    'export function guarded() {',
    '  const value = 1',
    '  return value',
    '}',
    '',
    'export const tail = "v1"',
    ''
  ].join('\n')
  const guardedSearchOld = [
    'export function guarded() {',
    '  const value = 1',
    '  return value',
    '}'
  ].join('\n')
  const guardedSearchNew = [
    'export function guarded() {',
    '  const value = 2',
    '  return value',
    '}'
  ].join('\n')
  const guardedSearchInput = {
    file_path: guardedSearchTarget,
    replacements: [{ old_str: guardedSearchOld, new_str: guardedSearchNew }]
  }
  writeFileSync(guardedSearchTarget, guardedSearchOriginal, 'utf8')
  const guardedSearchPlan = await searchReplace.planSearchReplace(projectDir, guardedSearchInput)
  assertOk(guardedSearchPlan, 'guarded search_replace plan should succeed')
  const guardedSearchEffect = fileEffectTarget(guardedSearchPlan)
  const guardedSearchDrift = guardedSearchOriginal.replace('tail = "v1"', 'tail = "v2"')
  writeFileSync(guardedSearchTarget, guardedSearchDrift, 'utf8')
  const guardedSearchBackups = backupFiles(projectDir)
  const guardedSearch = await tools.executeCodingTool(
    'search_replace',
    guardedSearchInput,
    projectDir,
    { effectTarget: guardedSearchEffect }
  )
  assert(!guardedSearch.ok, 'search_replace must reject a target that drifted after Effect approval')
  assert(guardedSearch.output.includes('Effect'), 'search_replace drift error should identify the frozen Effect target')
  assertEqual(readFileSync(guardedSearchTarget, 'utf8'), guardedSearchDrift)
  assertEqual(
    JSON.stringify(backupFiles(projectDir)),
    JSON.stringify(guardedSearchBackups),
    'search_replace target drift must be rejected before backup creation'
  )

  const guardedEditTarget = path.join(projectDir, 'src/guarded-edit.ts')
  const guardedEditOriginal = 'const value = "old"\nconst tail = "v1"\n'
  const guardedEditInput = {
    file_path: guardedEditTarget,
    old_string: '"old"',
    new_string: '"new"',
    replace_all: false
  }
  writeFileSync(guardedEditTarget, guardedEditOriginal, 'utf8')
  const guardedEditPlan = await searchReplace.planExactFileEdit(projectDir, guardedEditInput)
  assertOk(guardedEditPlan, 'guarded edit_file plan should succeed')
  const guardedEditEffect = fileEffectTarget(guardedEditPlan)
  const guardedEditDrift = guardedEditOriginal.replace('tail = "v1"', 'tail = "v2"')
  writeFileSync(guardedEditTarget, guardedEditDrift, 'utf8')
  const guardedEditBackups = backupFiles(projectDir)
  const guardedEdit = await tools.executeCodingTool(
    'edit_file',
    {
      path: guardedEditTarget,
      old_string: guardedEditInput.old_string,
      new_string: guardedEditInput.new_string,
      replace_all: false
    },
    projectDir,
    { effectTarget: guardedEditEffect }
  )
  assert(!guardedEdit.ok, 'edit_file must reject a target that drifted after Effect approval')
  assert(guardedEdit.output.includes('Effect'), 'edit_file drift error should identify the frozen Effect target')
  assertEqual(readFileSync(guardedEditTarget, 'utf8'), guardedEditDrift)
  assertEqual(
    JSON.stringify(backupFiles(projectDir)),
    JSON.stringify(guardedEditBackups),
    'edit_file target drift must be rejected before backup creation'
  )

  const guardedWriteTarget = path.join(projectDir, 'src/guarded-write-existing.txt')
  const guardedWriteBefore = Buffer.from('same-content-before\n', 'utf8')
  const guardedWriteAfter = 'approved-after\n'
  writeFileSync(guardedWriteTarget, guardedWriteBefore)
  const guardedWriteEffect = fileWriteEffectTarget(
    projectDir,
    guardedWriteTarget,
    guardedWriteBefore,
    guardedWriteAfter
  )
  const guardedWriteOriginalInode = guardedWriteEffect.preFileIdentity.inode
  const guardedWriteReplacement = path.join(projectDir, 'src/guarded-write-replacement.txt')
  writeFileSync(guardedWriteReplacement, guardedWriteBefore)
  rmSync(guardedWriteTarget)
  renameSync(guardedWriteReplacement, guardedWriteTarget)
  assert(
    statSync(guardedWriteTarget, { bigint: true }).ino.toString() !== guardedWriteOriginalInode,
    'write_file replacement fixture must use a new inode'
  )
  const guardedWrite = await tools.executeCodingTool(
    'write_file',
    { path: guardedWriteTarget, content: guardedWriteAfter },
    projectDir,
    { effectTarget: guardedWriteEffect }
  )
  assert(!guardedWrite.ok, 'write_file must reject same-content replacement after Effect approval')
  assertEqual(readFileSync(guardedWriteTarget, 'utf8'), guardedWriteBefore.toString('utf8'))

  const absentWriteTarget = path.join(projectDir, 'src/guarded-write-absent.txt')
  const absentWriteContent = 'created-from-approved-absent-effect\n'
  const absentWriteEffect = absentFileWriteEffectTarget(projectDir, absentWriteTarget, absentWriteContent)
  writeFileSync(absentWriteTarget, 'concurrent-creator\n', 'utf8')
  const concurrentAbsentWrite = await tools.executeCodingTool(
    'write_file',
    { path: absentWriteTarget, content: absentWriteContent },
    projectDir,
    { effectTarget: absentWriteEffect }
  )
  assert(!concurrentAbsentWrite.ok, 'write_file absent Effect must reject a concurrently-created target')
  assertEqual(readFileSync(absentWriteTarget, 'utf8'), 'concurrent-creator\n')
  rmSync(absentWriteTarget)
  const atomicAbsentWrite = await tools.executeCodingTool(
    'write_file',
    { path: absentWriteTarget, content: absentWriteContent },
    projectDir,
    { effectTarget: absentWriteEffect }
  )
  assert(atomicAbsentWrite.ok, `write_file absent Effect should create atomically: ${atomicAbsentWrite.output}`)
  assertEqual(readFileSync(absentWriteTarget, 'utf8'), absentWriteContent)
  assert(
    !readdirSync(path.dirname(absentWriteTarget)).some((name) => name.includes('.caogen-write.tmp')),
    'atomic absent create must clean its temporary inode link'
  )

  const defaultWriterTarget = path.join(projectDir, 'src/default-writer-rename.ts')
  const defaultWriterMoved = path.join(projectDir, 'src/default-writer-open-inode.ts')
  const defaultWriterReplacement = path.join(projectDir, 'src/default-writer-replacement.ts')
  const defaultWriterBefore = [
    'export function defaultWriter() {',
    '  const value = 1',
    '  return value',
    '}',
    ''
  ].join('\n')
  const defaultWriterAfter = defaultWriterBefore.replace('value = 1', 'value = 2')
  writeFileSync(defaultWriterTarget, defaultWriterBefore, 'utf8')
  const defaultWriterResult = await searchReplace.runSearchReplace(
    projectDir,
    {
      file_path: defaultWriterTarget,
      replacements: [{ old_str: defaultWriterBefore.trimEnd(), new_str: defaultWriterAfter.trimEnd() }]
    },
    {
      beforeWriteCommit: () => {
        renameSync(defaultWriterTarget, defaultWriterMoved)
        writeFileSync(defaultWriterReplacement, defaultWriterBefore, 'utf8')
        renameSync(defaultWriterReplacement, defaultWriterTarget)
      }
    }
  )
  assert(!defaultWriterResult.ok, 'default guarded writer must reject target-path replacement after open')
  assertEqual(readFileSync(defaultWriterTarget, 'utf8'), defaultWriterBefore)
  assertEqual(readFileSync(defaultWriterMoved, 'utf8'), defaultWriterBefore)

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

function fileEffectTarget(plan) {
  const expected = Buffer.from(plan.writeContent, 'utf8')
  return {
    kind: 'file_content',
    rootPath: plan.rootPath,
    rootIdentity: plan.rootIdentity,
    relativePath: plan.relativePath,
    preState: 'file',
    preFileIdentity: plan.fileIdentity,
    preSha256: plan.originalSha256,
    preBytes: plan.originalBytes,
    expectedSha256: sha256(expected),
    expectedBytes: expected.byteLength
  }
}

function fileWriteEffectTarget(root, target, before, expectedContent) {
  const normalizedRoot = realpathSync(root)
  const rootInfo = statSync(normalizedRoot, { bigint: true })
  const targetInfo = statSync(target, { bigint: true })
  const expected = Buffer.from(expectedContent, 'utf8')
  return {
    kind: 'file_content',
    rootPath: normalizedRoot,
    rootIdentity: { device: rootInfo.dev.toString(), inode: rootInfo.ino.toString() },
    relativePath: path.relative(root, target).split(path.sep).join('/'),
    preState: 'file',
    preFileIdentity: { device: targetInfo.dev.toString(), inode: targetInfo.ino.toString() },
    preSha256: sha256(before),
    preBytes: before.byteLength,
    expectedSha256: sha256(expected),
    expectedBytes: expected.byteLength
  }
}

function absentFileWriteEffectTarget(root, target, expectedContent) {
  const normalizedRoot = realpathSync(root)
  const rootInfo = statSync(normalizedRoot, { bigint: true })
  const expected = Buffer.from(expectedContent, 'utf8')
  return {
    kind: 'file_content',
    rootPath: normalizedRoot,
    rootIdentity: { device: rootInfo.dev.toString(), inode: rootInfo.ino.toString() },
    relativePath: path.relative(root, target).split(path.sep).join('/'),
    preState: 'absent',
    expectedSha256: sha256(expected),
    expectedBytes: expected.byteLength
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function backupFiles(root) {
  const backupDir = path.join(root, '.caogen', 'tmp', 'backup')
  return existsSync(backupDir) ? readdirSync(backupDir).sort() : []
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
