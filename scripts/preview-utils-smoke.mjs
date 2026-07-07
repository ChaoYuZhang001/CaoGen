#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-preview-utils-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/renderer/src/components/workbench/previewUtils.ts',
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

  const utils = await import(pathToFileURL(path.join(outDir, 'previewUtils.js')).href)

  const comma = utils.parseCsv('name,score\ncao,8\n')
  assertEqual(comma.rows[1][1], '8')

  const tab = utils.parseCsv('name\tscore\ncao\t8\n')
  assertEqual(tab.rows[0].length, 2)
  assertEqual(tab.rows[1][0], 'cao')

  const explicitTab = utils.parseCsv('name\tscore\n"cao\tgen"\t9\n', { delimiter: '\t' })
  assertEqual(explicitTab.rows[1][0], 'cao\tgen')
  assertEqual(explicitTab.rows[1][1], '9')

  const semicolon = utils.parseCsv('name;score\ncao;7\n')
  assertEqual(semicolon.rows[0][1], 'score')
  assertEqual(semicolon.rows[1][1], '7')

  const limited = utils.parseCsv('a,b\n1,2\n3,4\n', { maxRows: 2 })
  assertEqual(limited.rows.length, 2)
  assert(limited.truncated, 'maxRows should mark parsed data as truncated')

  console.log('previewUtils smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
