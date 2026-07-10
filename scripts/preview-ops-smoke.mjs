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
import { deflateSync } from 'node:zlib'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-preview-ops-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')
const reportRoot = path.join(repoRoot, 'test-results', 'preview-ops')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(reportRoot, runId)
const previewMatrix = []
let finalStatus = 'fail'
let finalError = null

try {
  mkdirSync(runDir, { recursive: true })
  mkdirSync(projectDir)
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  mkdirSync(path.join(projectDir, 'assets'), { recursive: true })

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
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
  recordPreview('plain text', textPreview, ['hello CaoGen'])

  writeFileSync(path.join(projectDir, 'src/index.html'), '<h1>CaoGen</h1>\n', 'utf8')
  const htmlPreview = await previewOps.preparePreview(projectDir, 'src/index.html')
  assertOk(htmlPreview, 'preparePreview should read html inside project')
  assertEqual(htmlPreview.type, 'html')
  assertEqual(htmlPreview.mime, 'text/html')
  assertEqual(htmlPreview.content, '<h1>CaoGen</h1>\n')
  recordPreview('html', htmlPreview, ['<h1>CaoGen</h1>'])

  writeFileSync(path.join(projectDir, 'src/brief.md'), '# CaoGen Brief\n\n- Preview markdown for Agent.\n', 'utf8')
  const markdownPreview = await previewOps.preparePreview(projectDir, 'src/brief.md')
  assertOk(markdownPreview, 'preparePreview should read markdown inside project')
  assertEqual(markdownPreview.type, 'markdown')
  assertEqual(markdownPreview.mime, 'text/markdown')
  assert(markdownPreview.content.includes('Preview markdown for Agent'), 'markdown preview should include content')
  recordPreview('markdown', markdownPreview, ['CaoGen Brief', 'Preview markdown for Agent'])

  writeFileSync(path.join(projectDir, 'src/data.json'), '{"ok":true}\n', 'utf8')
  const jsonPreview = await previewOps.preparePreview(projectDir, 'src/data.json')
  assertOk(jsonPreview, 'preparePreview should read json inside project')
  assertEqual(jsonPreview.type, 'json')
  assertEqual(jsonPreview.mime, 'application/json')
  assertEqual(jsonPreview.content, '{"ok":true}\n')
  recordPreview('json', jsonPreview, ['"ok":true'])

  writeFileSync(path.join(projectDir, 'src/table.csv'), 'name,score\ncao,8\n', 'utf8')
  const csvPreview = await previewOps.preparePreview(projectDir, 'src/table.csv')
  assertOk(csvPreview, 'preparePreview should read comma-separated table text')
  assertEqual(csvPreview.type, 'csv')
  assertEqual(csvPreview.mode, 'text')
  assertEqual(csvPreview.mime, 'text/csv')
  assertEqual(csvPreview.content, 'name,score\ncao,8\n')
  recordPreview('csv', csvPreview, ['name,score', 'cao,8'])

  writeFileSync(path.join(projectDir, 'src/table.tsv'), 'name\tscore\ncao\t8\n', 'utf8')
  const tsvPreview = await previewOps.preparePreview(projectDir, 'src/table.tsv')
  assertOk(tsvPreview, 'preparePreview should read tab-separated table text')
  assertEqual(tsvPreview.type, 'csv')
  assertEqual(tsvPreview.mode, 'text')
  assertEqual(tsvPreview.mime, 'text/tab-separated-values')
  assertEqual(tsvPreview.content, 'name\tscore\ncao\t8\n')
  recordPreview('tsv', tsvPreview, ['name\tscore', 'cao\t8'])

  const pdfPlaceholder = createTextPdf('BT /F1 12 Tf 72 720 Td (Hello PDF) Tj T* (Agent can quote this) Tj ET')
  writeFileSync(path.join(projectDir, 'assets/report.pdf'), pdfPlaceholder)
  const pdfPreview = await previewOps.preparePreview(projectDir, 'assets/report.pdf')
  assertOk(pdfPreview, 'preparePreview should return pdf metadata')
  assertEqual(pdfPreview.type, 'pdf')
  assertEqual(pdfPreview.mode, 'asset')
  assertEqual(pdfPreview.mime, 'application/pdf')
  assertEqual(pdfPreview.bytes, pdfPlaceholder.byteLength)
  assertEqual(pdfPreview.dataUrl, `data:application/pdf;base64,${pdfPlaceholder.toString('base64')}`)
  assert(pdfPreview.content.includes('# PDF Document'), 'pdf preview should label extracted text')
  assert(pdfPreview.content.includes('Hello PDF'), 'pdf preview should extract literal text strings')
  assert(pdfPreview.content.includes('Agent can quote this'), 'pdf preview should expose text to Agent prompts')
  recordPreview('pdf', pdfPreview, ['Hello PDF', 'Agent can quote this'])
  const tooLargePdf = await previewOps.preparePreview(projectDir, 'assets/report.pdf', { maxAssetBytes: 4 })
  assert(!tooLargePdf.ok, 'preparePreview should reject assets above maxAssetBytes')
  recordPreview('oversized pdf failure', tooLargePdf)

  const compressedPdf = createTextPdf('BT /F1 12 Tf 72 720 Td (Compressed PDF text) Tj ET', { compressed: true })
  writeFileSync(path.join(projectDir, 'assets/compressed.pdf'), compressedPdf)
  const compressedPdfPreview = await previewOps.preparePreview(projectDir, 'assets/compressed.pdf')
  assertOk(compressedPdfPreview, 'preparePreview should return compressed pdf metadata')
  assert(compressedPdfPreview.content.includes('Compressed PDF text'), 'pdf preview should extract Flate text streams')
  recordPreview('compressed pdf', compressedPdfPreview, ['Compressed PDF text'])

  writeFileSync(
    path.join(projectDir, 'assets/brief.docx'),
    createZip({
      '[Content_Types].xml': '<Types></Types>',
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Hello CaoGen</w:t></w:r></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Office preview works</w:t></w:r></w:p></w:body></w:document>'
    })
  )
  const docxPreview = await previewOps.preparePreview(projectDir, 'assets/brief.docx')
  assertOk(docxPreview, 'preparePreview should extract docx text')
  assertEqual(docxPreview.type, 'office')
  assertEqual(docxPreview.mode, 'text')
  assert(docxPreview.content.includes('## Page 1'), 'docx explicit page break should create the first structural page')
  assert(docxPreview.content.includes('## Page 2'), 'docx explicit page break should create the second structural page')
  assert(docxPreview.content.includes('Hello CaoGen'), 'docx preview should include document text')
  assert(docxPreview.content.includes('Office preview works'), 'docx preview should include later paragraphs')
  recordPreview('docx', docxPreview, ['Hello CaoGen', 'Office preview works'])

  writeFileSync(
    path.join(projectDir, 'assets/report.xlsx'),
    createZip({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml':
        '<sst><si><t>Name</t></si><si><t>CaoGen</t></si><si><t>Score</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>9</v></c></row></sheetData></worksheet>'
    })
  )
  const xlsxPreview = await previewOps.preparePreview(projectDir, 'assets/report.xlsx')
  assertOk(xlsxPreview, 'preparePreview should extract xlsx worksheet text')
  assertEqual(xlsxPreview.type, 'office')
  assertEqual(xlsxPreview.mode, 'text')
  assertEqual(xlsxPreview.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert(xlsxPreview.content.includes('## Summary'), 'xlsx preview should include sheet name')
  assert(xlsxPreview.content.includes('Name\tScore'), 'xlsx preview should include header row')
  assert(xlsxPreview.content.includes('CaoGen\t9'), 'xlsx preview should include shared string row')
  recordPreview('xlsx', xlsxPreview, ['Summary', 'Name\tScore', 'CaoGen\t9'])

  writeFileSync(
    path.join(projectDir, 'assets/slides.pptx'),
    createZip({
      'ppt/slides/slide1.xml':
        '<p:sld><p:cSld><p:spTree><a:t>First slide</a:t><a:t>Delivery plan</a:t></p:spTree></p:cSld></p:sld>',
      'ppt/slides/slide2.xml':
        '<p:sld><p:cSld><p:spTree><a:t>Second slide</a:t></p:spTree></p:cSld></p:sld>'
    })
  )
  const pptxDetect = await previewOps.detectPreview(projectDir, 'assets/slides.pptx')
  assertOk(pptxDetect, 'detectPreview should return pptx metadata')
  assertEqual(pptxDetect.type, 'office')
  assertEqual(pptxDetect.mode, 'text')
  assertEqual(pptxDetect.mime, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  const pptxPreview = await previewOps.preparePreview(projectDir, 'assets/slides.pptx')
  assertOk(pptxPreview, 'preparePreview should extract pptx slide text')
  assert(pptxPreview.content.includes('## Slide 1'), 'pptx preview should include slide heading')
  assert(pptxPreview.content.includes('First slide'), 'pptx preview should include slide text')
  assert(pptxPreview.content.includes('Delivery plan'), 'pptx preview should include multiple text blocks')
  assert(pptxPreview.content.includes('Second slide'), 'pptx preview should include later slide text')
  recordPreview('pptx', pptxPreview, ['First slide', 'Delivery plan', 'Second slide'])

  const xlsPlaceholder = Buffer.from('d0cf11e0a1b11ae1', 'hex')
  writeFileSync(path.join(projectDir, 'assets/legacy.xls'), xlsPlaceholder)
  const xlsPreview = await previewOps.preparePreview(projectDir, 'assets/legacy.xls')
  assertOk(xlsPreview, 'preparePreview should return legacy xls metadata')
  assertEqual(xlsPreview.type, 'unknown')
  assertEqual(xlsPreview.mode, 'unsupported')
  recordPreview('legacy xls unsupported metadata', xlsPreview)

  const pngPlaceholder = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  )
  writeFileSync(path.join(projectDir, 'assets/logo.png'), pngPlaceholder)
  const imagePreview = await previewOps.preparePreview(projectDir, 'assets/logo.png')
  assertOk(imagePreview, 'preparePreview should return image metadata')
  assertEqual(imagePreview.type, 'image')
  assertEqual(imagePreview.mode, 'asset')
  assertEqual(imagePreview.mime, 'image/png')
  assertEqual(imagePreview.bytes, pngPlaceholder.byteLength)
  assertEqual(imagePreview.dataUrl, `data:image/png;base64,${pngPlaceholder.toString('base64')}`)
  assert(!('content' in imagePreview), 'image preview should not include content')
  recordPreview('image', imagePreview)

  const imageDetect = await previewOps.detectPreview(projectDir, 'assets/logo.png')
  assertOk(imageDetect, 'detectPreview should return image metadata')
  assertEqual(imageDetect.type, 'image')
  assertEqual(imageDetect.path, 'assets/logo.png')

  writeFileSync(path.join(tempRoot, 'outside.txt'), 'outside', 'utf8')
  const outsideTraversal = await previewOps.preparePreview(projectDir, '../outside.txt')
  assert(!outsideTraversal.ok, 'preparePreview should reject parent traversal')
  recordPreview('parent traversal failure', outsideTraversal)

  const absolutePath = await previewOps.preparePreview(projectDir, path.join(projectDir, 'src/plain.txt'))
  assert(!absolutePath.ok, 'preparePreview should reject absolute paths')
  recordPreview('absolute path failure', absolutePath)

  writeFileSync(path.join(tempRoot, 'outside-real.txt'), 'secret', 'utf8')
  let symlinkCreated = false
  try {
    symlinkSync(path.join(tempRoot, 'outside-real.txt'), path.join(projectDir, 'leak.txt'))
    symlinkCreated = true
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    // Windows 未开启开发者模式或缺少权限时不能创建文件符号链接,该环境只跳过此子断言。
    console.warn('previewOps symlink escape check skipped: current Windows account cannot create symlink')
  }
  if (symlinkCreated) {
    const symlinkEscape = await previewOps.preparePreview(projectDir, 'leak.txt')
    assert(!symlinkEscape.ok, 'preparePreview should reject symlinks escaping project root')
    recordPreview('symlink escape failure', symlinkEscape)
  }

  writeFileSync(path.join(projectDir, 'src/big.txt'), '0123456789abcdef', 'utf8')
  const tooLargeText = await previewOps.preparePreview(projectDir, 'src/big.txt', { maxTextBytes: 8 })
  assert(!tooLargeText.ok, 'preparePreview should reject text above maxTextBytes')
  recordPreview('oversized text failure', tooLargeText)

  mkdirSync(path.join(projectDir, 'src/folder'), { recursive: true })
  const directoryPreview = await previewOps.preparePreview(projectDir, 'src/folder')
  assert(!directoryPreview.ok, 'preparePreview should reject directories')
  recordPreview('directory failure', directoryPreview)

  assertEqual(readFileSync(path.join(projectDir, 'src/plain.txt'), 'utf8'), 'hello CaoGen\n')
  finalStatus = 'pass'
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  const report = {
    runId,
    status: finalStatus,
    previewMatrix,
    error: finalError,
    generatedAt: new Date().toISOString()
  }
  if (existsDir(reportRoot)) {
    writeFileSync(path.join(runDir, 'preview-ops-smoke.json'), JSON.stringify(report, null, 2))
    writeFileSync(path.join(reportRoot, 'latest.json'), JSON.stringify(report, null, 2))
  }
  rmSync(tempRoot, { recursive: true, force: true })
}

if (finalStatus === 'pass') {
  console.log(`previewOps smoke ok: ${runDir}`)
} else {
  console.error(`previewOps smoke failed: ${finalError}`)
}

function createZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt32LE(offset, 42)

    localParts.push(local, nameBuffer, data)
    centralParts.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

function createTextPdf(textStream, options = {}) {
  const rawStream = Buffer.from(textStream, 'latin1')
  const stream = options.compressed ? deflateSync(rawStream) : rawStream
  const filter = options.compressed ? '/Filter /FlateDecode ' : ''
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} ${filter}>>\nstream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')
  ])
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

function recordPreview(label, result, contentNeedles = []) {
  previewMatrix.push({
    label,
    ok: Boolean(result?.ok),
    type: result?.type ?? null,
    mode: result?.mode ?? null,
    mime: result?.mime ?? null,
    bytes: result?.bytes ?? null,
    hasTextContent: typeof result?.content === 'string' && result.content.length > 0,
    hasDataUrl: typeof result?.dataUrl === 'string' && result.dataUrl.length > 0,
    contentNeedles,
    error: result?.ok === false ? result.error : undefined
  })
}

function existsDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}
