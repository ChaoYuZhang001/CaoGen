import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-desk-browser-annotations-'))
const outDir = path.join(tempRoot, 'compiled')
const annotationsRoot = path.join(tempRoot, 'annotations')

try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/main/browserAnnotations.ts',
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

  const browserAnnotations = await import(pathToFileURL(path.join(outDir, 'browserAnnotations.js')).href)

  const sessionId = 'session_browser_m11'
  const consoleErrors = Array.from({ length: 250 }, (_, index) => `console error ${index}`)
  const saved = await browserAnnotations.saveAnnotation(annotationsRoot, {
    sessionId,
    url: 'https://example.com/docs?tab=browser#annotations',
    title: 'Browser annotations',
    selector: '#main',
    boundingBox: { x: 12, y: -4, width: 320, height: 120 },
    screenshotPath: '/tmp/screenshot.png',
    note: 'Investigate this rendered state.',
    consoleErrors,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 }
  })

  assert(saved.id, 'saveAnnotation should assign an id')
  assert(/^[A-Za-z0-9_-]{1,128}$/.test(saved.id), 'saveAnnotation should assign a path-safe id')
  assertEqual(saved.sessionId, sessionId)
  assertEqual(saved.url, 'https://example.com/docs?tab=browser#annotations')
  assertEqual(saved.note, 'Investigate this rendered state.')
  assertEqual(saved.consoleErrors.length, 200)
  assertEqual(saved.consoleErrors[0], 'console error 50')
  assertEqual(saved.consoleErrors[199], 'console error 249')
  assertEqual(saved.boundingBox.y, -4)
  assertEqual(saved.viewport.deviceScaleFactor, 2)

  const expectedFile = path.join(annotationsRoot, sessionId, `${saved.id}.json`)
  assert(existsSync(expectedFile), 'saveAnnotation should persist a JSON file under root/sessionId')
  const raw = JSON.parse(readFileSync(expectedFile, 'utf8'))
  assertEqual(raw.id, saved.id)
  assertEqual(raw.consoleErrors.length, 200)

  const read = await browserAnnotations.readAnnotation(annotationsRoot, sessionId, saved.id)
  assertDeepEqual(read, saved, 'readAnnotation should return the saved annotation')
  assertEqual(await browserAnnotations.readAnnotation(annotationsRoot, sessionId, 'missing_id'), null)

  const listed = await browserAnnotations.listAnnotations(annotationsRoot, sessionId)
  assertEqual(listed.length, 1)
  assertDeepEqual(listed[0], saved, 'listAnnotations should include saved annotations')

  await assertRejects(
    () =>
      browserAnnotations.saveAnnotation(annotationsRoot, {
        sessionId,
        url: 'not a url',
        note: 'bad url'
      }),
    'saveAnnotation should reject invalid urls'
  )

  await assertRejects(
    () =>
      browserAnnotations.saveAnnotation(annotationsRoot, {
        sessionId,
        url: 'https://example.com/',
        note: '   '
      }),
    'saveAnnotation should reject empty notes'
  )

  await assertRejects(
    () =>
      browserAnnotations.saveAnnotation(annotationsRoot, {
        sessionId: '../escape',
        url: 'https://example.com/',
        note: 'unsafe session'
      }),
    'saveAnnotation should reject path-unsafe session ids'
  )
  await assertRejects(
    () => browserAnnotations.listAnnotations(annotationsRoot, '../escape'),
    'listAnnotations should reject path-unsafe session ids'
  )
  await assertRejects(
    () => browserAnnotations.readAnnotation(annotationsRoot, '../escape', saved.id),
    'readAnnotation should reject path-unsafe session ids'
  )

  console.log('browserAnnotations smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertDeepEqual(actual, expected, message = 'values should be deeply equal') {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  assert(actualJson === expectedJson, `${message}: expected ${expectedJson}, got ${actualJson}`)
}

async function assertRejects(fn, message) {
  let rejected = false
  try {
    await fn()
  } catch {
    rejected = true
  }
  assert(rejected, message)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}
