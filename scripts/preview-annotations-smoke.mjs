#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-preview-annotations-'))
const outDir = path.join(tempRoot, 'compiled')
const storeRoot = path.join(tempRoot, 'store')

try {
  mkdirSync(storeRoot, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/previewAnnotations.ts',
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
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const annotations = await import(pathToFileURL(findCompiledModule(outDir)).href)

  const first = await annotations.savePreviewAnnotation(storeRoot, 'sess-1', {
    id: 'ann-1',
    path: 'reports/table.csv',
    type: 'csv',
    mime: 'text/csv',
    note: 'Row 2 total is wrong',
    locator: { row: 2, column: 3, quote: 'wrong total' },
    createdAt: '2026-07-07T00:00:00.000Z'
  })
  assertEqual(first.id, 'ann-1')
  assertEqual(first.path, 'reports/table.csv')
  assertEqual(first.locator.row, 2)
  assert(existsSync(path.join(storeRoot, 'sess-1', 'ann-1.json')), 'annotation JSON should be persisted')

  await annotations.savePreviewAnnotation(storeRoot, 'sess-1', {
    id: 'ann-2',
    path: 'reports/other.pdf',
    type: 'pdf',
    mime: 'application/pdf',
    note: 'Page 1 needs review',
    locator: { page: 1 },
    createdAt: '2026-07-07T00:01:00.000Z'
  })

  await annotations.savePreviewAnnotation(storeRoot, 'sess-1', {
    id: 'ann-3',
    path: 'reports/brief.docx',
    type: 'office',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    note: 'Second paragraph needs review',
    locator: { quote: 'Office preview works' },
    createdAt: '2026-07-07T00:02:00.000Z'
  })

  const all = await annotations.listPreviewAnnotations(storeRoot, 'sess-1')
  assertEqual(all.length, 3)
  assertEqual(all[0].id, 'ann-3')

  const filtered = await annotations.listPreviewAnnotations(storeRoot, 'sess-1', 'reports/table.csv')
  assertEqual(filtered.length, 1)
  assertEqual(filtered[0].id, 'ann-1')

  await assertRejects(
    () =>
      annotations.savePreviewAnnotation(storeRoot, 'sess-1', {
        path: '../secret.txt',
        note: 'bad path'
      }),
    'parent traversal should be rejected'
  )
  await assertRejects(
    () =>
      annotations.savePreviewAnnotation(storeRoot, '../bad', {
        path: 'safe.txt',
        note: 'bad session'
      }),
    'unsafe session id should be rejected'
  )
  await assertRejects(
    () =>
      annotations.savePreviewAnnotation(storeRoot, 'sess-1', {
        path: 'safe.txt',
        type: 'exe',
        note: 'bad type'
      }),
    'invalid preview type should be rejected'
  )

  const raw = JSON.parse(readFileSync(path.join(storeRoot, 'sess-1', 'ann-1.json'), 'utf8'))
  assertEqual(raw.note, 'Row 2 total is wrong')
  console.log('previewAnnotations smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

async function assertRejects(fn, message) {
  try {
    await fn()
  } catch {
    return
  }
  throw new Error(message)
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function findCompiledModule(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.name === 'previewAnnotations.js') {
      return fullPath
    }
  }
  throw new Error(`compiled previewAnnotations.js not found under ${dir}`)
}
