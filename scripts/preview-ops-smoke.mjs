import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-preview-ops-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')

try {
  mkdirSync(projectDir)
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  mkdirSync(path.join(projectDir, 'assets'), { recursive: true })

  execFileSync(
    'npx',
    [
      'tsc',
      'src/main/previewOps.ts',
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

  const previewOps = await import(pathToFileURL(path.join(outDir, 'previewOps.js')).href)

  writeFileSync(path.join(projectDir, 'src/plain.txt'), 'hello CaoGen\n', 'utf8')
  const textPreview = await previewOps.preparePreview(projectDir, 'src/plain.txt')
  assertOk(textPreview, 'preparePreview should read text inside project')
  assertEqual(textPreview.type, 'text')
  assertEqual(textPreview.mode, 'text')
  assertEqual(textPreview.content, 'hello CaoGen\n')
  assertEqual(textPreview.bytes, Buffer.byteLength('hello CaoGen\n'))

  writeFileSync(path.join(projectDir, 'src/index.html'), '<h1>CaoGen</h1>\n', 'utf8')
  const htmlPreview = await previewOps.preparePreview(projectDir, 'src/index.html')
  assertOk(htmlPreview, 'preparePreview should read html inside project')
  assertEqual(htmlPreview.type, 'html')
  assertEqual(htmlPreview.mime, 'text/html')
  assertEqual(htmlPreview.content, '<h1>CaoGen</h1>\n')

  writeFileSync(path.join(projectDir, 'src/data.json'), '{"ok":true}\n', 'utf8')
  const jsonPreview = await previewOps.preparePreview(projectDir, 'src/data.json')
  assertOk(jsonPreview, 'preparePreview should read json inside project')
  assertEqual(jsonPreview.type, 'json')
  assertEqual(jsonPreview.mime, 'application/json')
  assertEqual(jsonPreview.content, '{"ok":true}\n')

  writeFileSync(path.join(projectDir, 'src/table.tsv'), 'name\tscore\ncao\t8\n', 'utf8')
  const tsvPreview = await previewOps.preparePreview(projectDir, 'src/table.tsv')
  assertOk(tsvPreview, 'preparePreview should read tab-separated table text')
  assertEqual(tsvPreview.type, 'csv')
  assertEqual(tsvPreview.mode, 'text')
  assertEqual(tsvPreview.mime, 'text/tab-separated-values')
  assertEqual(tsvPreview.content, 'name\tscore\ncao\t8\n')

  const pdfPlaceholder = Buffer.from('%PDF-1.4\n', 'utf8')
  writeFileSync(path.join(projectDir, 'assets/report.pdf'), pdfPlaceholder)
  const pdfPreview = await previewOps.preparePreview(projectDir, 'assets/report.pdf')
  assertOk(pdfPreview, 'preparePreview should return pdf metadata')
  assertEqual(pdfPreview.type, 'pdf')
  assertEqual(pdfPreview.mode, 'asset')
  assertEqual(pdfPreview.mime, 'application/pdf')
  assertEqual(pdfPreview.bytes, pdfPlaceholder.byteLength)
  assert(!('content' in pdfPreview), 'pdf preview should not include content')

  const xlsxPlaceholder = Buffer.from('504b030414000000', 'hex')
  writeFileSync(path.join(projectDir, 'assets/report.xlsx'), xlsxPlaceholder)
  const xlsxPreview = await previewOps.preparePreview(projectDir, 'assets/report.xlsx')
  assertOk(xlsxPreview, 'preparePreview should return xlsx metadata')
  assertEqual(xlsxPreview.type, 'unknown')
  assertEqual(xlsxPreview.mode, 'unsupported')
  assertEqual(xlsxPreview.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assertEqual(xlsxPreview.bytes, xlsxPlaceholder.byteLength)
  assert(!('content' in xlsxPreview), 'xlsx preview should not include content')

  const pptxPlaceholder = Buffer.from('504b030414000000', 'hex')
  writeFileSync(path.join(projectDir, 'assets/slides.pptx'), pptxPlaceholder)
  const pptxDetect = await previewOps.detectPreview(projectDir, 'assets/slides.pptx')
  assertOk(pptxDetect, 'detectPreview should return pptx metadata')
  assertEqual(pptxDetect.type, 'unknown')
  assertEqual(pptxDetect.mode, 'unsupported')
  assertEqual(pptxDetect.mime, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')

  const pngPlaceholder = Buffer.from('89504e470d0a1a0a', 'hex')
  writeFileSync(path.join(projectDir, 'assets/logo.png'), pngPlaceholder)
  const imagePreview = await previewOps.preparePreview(projectDir, 'assets/logo.png')
  assertOk(imagePreview, 'preparePreview should return image metadata')
  assertEqual(imagePreview.type, 'image')
  assertEqual(imagePreview.mode, 'asset')
  assertEqual(imagePreview.mime, 'image/png')
  assertEqual(imagePreview.bytes, pngPlaceholder.byteLength)
  assert(!('content' in imagePreview), 'image preview should not include content')

  const imageDetect = await previewOps.detectPreview(projectDir, 'assets/logo.png')
  assertOk(imageDetect, 'detectPreview should return image metadata')
  assertEqual(imageDetect.type, 'image')
  assertEqual(imageDetect.path, 'assets/logo.png')

  writeFileSync(path.join(tempRoot, 'outside.txt'), 'outside', 'utf8')
  const outsideTraversal = await previewOps.preparePreview(projectDir, '../outside.txt')
  assert(!outsideTraversal.ok, 'preparePreview should reject parent traversal')

  const absolutePath = await previewOps.preparePreview(projectDir, path.join(projectDir, 'src/plain.txt'))
  assert(!absolutePath.ok, 'preparePreview should reject absolute paths')

  writeFileSync(path.join(tempRoot, 'outside-real.txt'), 'secret', 'utf8')
  symlinkSync(path.join(tempRoot, 'outside-real.txt'), path.join(projectDir, 'leak.txt'))
  const symlinkEscape = await previewOps.preparePreview(projectDir, 'leak.txt')
  assert(!symlinkEscape.ok, 'preparePreview should reject symlinks escaping project root')

  writeFileSync(path.join(projectDir, 'src/big.txt'), '0123456789abcdef', 'utf8')
  const tooLargeText = await previewOps.preparePreview(projectDir, 'src/big.txt', { maxTextBytes: 8 })
  assert(!tooLargeText.ok, 'preparePreview should reject text above maxTextBytes')

  mkdirSync(path.join(projectDir, 'src/folder'), { recursive: true })
  const directoryPreview = await previewOps.preparePreview(projectDir, 'src/folder')
  assert(!directoryPreview.ok, 'preparePreview should reject directories')

  assertEqual(readFileSync(path.join(projectDir, 'src/plain.txt'), 'utf8'), 'hello CaoGen\n')
  console.log('previewOps smoke ok')
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
