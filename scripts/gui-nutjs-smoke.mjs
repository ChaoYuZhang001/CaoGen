#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const checks = []

function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (err) {
    checks.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function source(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

const pkg = JSON.parse(source('package.json'))
const lock = JSON.parse(source('package-lock.json'))

check('nut.js fork is declared as optional dependency', () => {
  const version = pkg.optionalDependencies?.['@nut-tree-fork/nut-js']
  assert(typeof version === 'string' && version.startsWith('^4.'), 'missing optional @nut-tree-fork/nut-js dependency')
})

check('package lock records nut.js as optional', () => {
  const rootOptional = lock.packages?.['']?.optionalDependencies?.['@nut-tree-fork/nut-js']
  const packageEntry = lock.packages?.['node_modules/@nut-tree-fork/nut-js']
  assert(rootOptional, 'root package lock missing optional nut.js dependency')
  assert(packageEntry?.optional === true, 'nut.js package lock entry must be optional')
})

check('nut adapter loads fork before legacy package', () => {
  const text = source('src/main/gui/nutjs-adapter.ts')
  const fork = text.indexOf("'@nut-tree-fork/nut-js'")
  const legacy = text.indexOf("'@nut-tree/nut-js'")
  assert(fork !== -1, 'adapter must try @nut-tree-fork/nut-js')
  assert(legacy !== -1, 'adapter should keep legacy fallback probe')
  assert(fork < legacy, 'fork package should be tried before legacy package')
})

check('nut adapter exposes optional scroll fallback', () => {
  const text = source('src/main/gui/nutjs-adapter.ts')
  for (const marker of ['export async function nutScroll', 'scrollDown', 'scrollUp', 'scrollLeft', 'scrollRight']) {
    assert(text.includes(marker), `missing ${marker}`)
  }
})

check('gui controller uses native platform paths before nut fallback', () => {
  const text = source('src/main/gui/gui-controller.ts')
  assert(text.indexOf('windowsClick(input)') < text.indexOf('nutClick(input.x, input.y, input.button)'), 'Windows path must precede nut click fallback')
  assert(text.indexOf('macosClick(input)') < text.indexOf('nutClick(input.x, input.y, input.button)'), 'macOS path must precede nut click fallback')
  assert(text.includes('nutScroll(input.deltaX, input.deltaY, input.x, input.y)'), 'GUI scroll must fall back to nutScroll')
  assert(text.includes('ocrImage(outPath)'), 'screenshot OCR fallback must remain wired')
})

const failed = checks.filter((item) => !item.ok)
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.ok ? '' : `: ${item.error}`}`)
}

if (failed.length > 0) {
  process.exitCode = 1
}
