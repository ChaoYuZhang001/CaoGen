import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-file-ops-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')

try {
  mkdirSync(projectDir)

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/fileOps.ts',
      '--outDir',
      outDir,
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

  const fileOps = await import(pathToFileURL(path.join(outDir, 'fileOps.js')).href)

  const writeResult = await fileOps.writeTextFile(projectDir, 'src/hello.txt', 'hello CaoGen\n')
  assertOk(writeResult, 'writeTextFile should write inside project')
  assertEqual(readFileSync(path.join(projectDir, 'src/hello.txt'), 'utf8'), 'hello CaoGen\n')

  const readResult = await fileOps.readTextFile(projectDir, 'src/hello.txt')
  assertOk(readResult, 'readTextFile should read inside project')
  assertEqual(readResult.content, 'hello CaoGen\n')

  const listResult = await fileOps.listProjectFiles(projectDir)
  assertOk(listResult, 'listProjectFiles should list project files')
  assert(listResult.entries.some((entry) => entry.path === 'src/hello.txt' && entry.kind === 'file'))

  const outsideRead = await fileOps.readTextFile(projectDir, '../outside.txt')
  assert(!outsideRead.ok, 'readTextFile should reject parent traversal')

  const outsideWrite = await fileOps.writeTextFile(projectDir, '../outside.txt', 'nope')
  assert(!outsideWrite.ok, 'writeTextFile should reject parent traversal')

  const symlinkCase = createEscapingLink(tempRoot, projectDir)
  if (symlinkCase) {
    const symlinkRead = await fileOps.readTextFile(projectDir, symlinkCase.relativePath)
    assert(!symlinkRead.ok, 'readTextFile should reject symlinks escaping project root')
  }

  console.log('fileOps smoke ok')
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
  if (!condition) {
    throw new Error(message)
  }
}

function createEscapingLink(tempRoot, projectDir) {
  const outsideFile = path.join(tempRoot, 'outside-real.txt')
  writeFileSync(outsideFile, 'secret')
  try {
    symlinkSync(outsideFile, path.join(projectDir, 'leak.txt'))
    return { relativePath: 'leak.txt' }
  } catch (err) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(err?.code)) throw err
  }

  const outsideDir = path.join(tempRoot, 'outside-dir')
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret')
  try {
    symlinkSync(outsideDir, path.join(projectDir, 'leak-dir'), 'junction')
    return { relativePath: 'leak-dir/secret.txt' }
  } catch (err) {
    if (!['EPERM', 'EACCES'].includes(err?.code)) throw err
    console.warn('fileOps smoke: skip symlink escape check because this Windows process cannot create symlinks/junctions')
    return null
  }
}
