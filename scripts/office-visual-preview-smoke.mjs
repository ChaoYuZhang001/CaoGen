#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-office-visual-smoke-'))
const outDir = path.join(tempRoot, 'compiled')
const projectDir = path.join(tempRoot, 'project')
const reportRoot = path.join(repoRoot, 'test-results', 'office-visual-preview')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(reportRoot, runId)
const checks = []
let finalStatus = 'fail'
let finalError = null
let visualMetadata = null
let previewVisual = null

try {
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(runDir, { recursive: true })

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/previewOps.ts',
      'src/main/previewVisual.ts',
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

  previewVisual = await import(pathToFileURL(findCompiled(outDir, 'previewVisual.js')).href)

  await check('project boundary and Office extension validation', async () => {
    writeFileSync(path.join(projectDir, 'plain.txt'), 'not an Office document\n', 'utf8')
    const unsupported = await previewVisual.prepareOfficeVisualPreview(projectDir, 'plain.txt')
    assert(!unsupported.ok && unsupported.error.includes('DOCX'), 'non-Office files should be rejected')

    const traversal = await previewVisual.prepareOfficeVisualPreview(projectDir, '../outside.docx')
    assert(!traversal.ok && traversal.error.includes('项目目录边界'), 'parent traversal should be rejected')
  })

  if (process.platform === 'darwin') {
    await check('Quick Look bundle attachments are self-contained and network-blocked', async () => {
      const bundleDir = path.join(projectDir, 'fixture.qlpreview')
      mkdirSync(bundleDir, { recursive: true })
      writeFileSync(
        path.join(bundleDir, 'Preview.html'),
        '<html><head><link href="Attachment1.css" rel="stylesheet"><script src="Attachment2.js"></script></head><body><iframe src="Attachment3.html"></iframe><img src="cid:CID/image.png"><a href="https://example.invalid/leak">blocked</a></body></html>',
        'utf8'
      )
      writeFileSync(path.join(bundleDir, 'Attachment1.css'), "body{background-image:url('cid:CID/image.png')}", 'utf8')
      writeFileSync(path.join(bundleDir, 'Attachment2.js'), "document.body.dataset.quickLookReady='1'", 'utf8')
      writeFileSync(
        path.join(bundleDir, 'Attachment3.html'),
        '<html><head><link href="Attachment1.css" rel="stylesheet"></head><body>Nested sheet</body></html>',
        'utf8'
      )
      writeFileSync(
        path.join(bundleDir, 'Attachment4.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
          'base64'
        )
      )
      writeFileSync(
        path.join(bundleDir, 'PreviewProperties.plist'),
        quickLookFixturePlist(),
        'utf8'
      )

      const inlined = await previewVisual.inlineQuickLookPreviewBundle(bundleDir, 1_000_000, 10_000)
      const html = decodeDataUrl(inlined.previewUrl)
      assert(inlined.width === 640 && inlined.height === 480, 'bundle dimensions should come from plist metadata')
      assert(inlined.attachmentCount === 4, 'bundle attachment mapping should be preserved')
      assert(html.includes('Content-Security-Policy'), 'inlined document should inject a restrictive CSP')
      assert(html.includes('data-caogen-inline="Attachment1.css"'), 'linked CSS should be inlined')
      assert(html.includes('data-caogen-inline="Attachment2.js"'), 'linked JavaScript should be inlined')
      assert(html.includes('data:text/html;base64,'), 'nested HTML should become a data URL')
      assert(html.includes('data:image/png;base64,'), 'CID image should become a data URL')
      assert(!html.includes('cid:'), 'inlined document must not retain CID references')
      assert(!html.includes('Attachment3.html'), 'inlined document must not retain local attachment URLs')
      assert(!html.includes('https://example.invalid'), 'external navigation should be removed')
    })

    await check('real DOCX renders through macOS Quick Look', async () => {
      const docxPath = path.join(projectDir, 'brief.docx')
      execFileSync(
        '/usr/bin/textutil',
        ['-convert', 'docx', '-output', docxPath, path.join(repoRoot, 'resources', 'README.md')],
        { cwd: repoRoot, stdio: 'pipe' }
      )

      const startedAt = Date.now()
      const result = await previewVisual.prepareOfficeVisualPreview(projectDir, 'brief.docx', {
        timeoutMs: 45_000,
        maxDimension: 1_200
      })
      assert(result.ok, `Quick Look preview should succeed: ${result.error ?? 'unknown error'}`)
      assert(result.source === 'quick-look', 'visual source should be Quick Look')
      assert(result.fidelity === 'system-document-preview', 'visual fidelity should be a system document preview')
      assert(result.previewUrl.startsWith('data:text/html;base64,'), 'visual preview should return a self-contained HTML data URL')
      const previewHtml = decodeDataUrl(result.previewUrl)
      assert(previewHtml.includes('Content-Security-Policy'), 'real preview should include the injected CSP')
      assert(previewHtml.includes('caogen-preview'), 'real preview should include the CaoGen safety marker')
      assert(!/\b(?:src|href)=["']https?:/i.test(previewHtml), 'real preview should not retain network resource URLs')

      const cachedStartedAt = Date.now()
      const cached = await previewVisual.prepareOfficeVisualPreview(projectDir, 'brief.docx', {
        timeoutMs: 45_000,
        maxDimension: 1_200
      })
      assert(cached === result, 'unchanged path and mtime should reuse the bounded in-memory cache')

      visualMetadata = {
        path: result.path,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        source: result.source,
        fidelity: result.fidelity,
        renderDurationMs: Date.now() - startedAt,
        cachedDurationMs: Date.now() - cachedStartedAt,
        htmlSha256: createHash('sha256').update(previewHtml).digest('hex')
      }
    })
  } else {
    checks.push({
      name: 'real DOCX renders through macOS Quick Look',
      status: 'skipped',
      reason: `Quick Look is only available on macOS (current platform: ${process.platform})`
    })
  }

  finalStatus = 'pass'
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  previewVisual?.disposeOfficeVisualPreviews?.()
  const report = {
    runId,
    status: finalStatus,
    checks,
    visualMetadata,
    error: finalError,
    generatedAt: new Date().toISOString()
  }
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'office-visual-preview-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  rmSync(tempRoot, { recursive: true, force: true })
}

if (finalStatus === 'pass') {
  console.log(`office visual preview smoke ok: ${runDir}`)
} else {
  console.error(`office visual preview smoke failed: ${finalError}`)
}

async function check(name, fn) {
  const startedAt = Date.now()
  try {
    await fn()
    checks.push({ name, status: 'pass', durationMs: Date.now() - startedAt })
  } catch (error) {
    checks.push({
      name,
      status: 'fail',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

function findCompiled(root, fileName) {
  const entries = readFileTree(root)
  const found = entries.find((entry) => path.basename(entry) === fileName)
  if (!found) throw new Error(`compiled file not found: ${fileName}`)
  return found
}

function readFileTree(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...readFileTree(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function decodeDataUrl(dataUrl) {
  const encoded = dataUrl.split(',', 2)[1]
  if (!encoded) throw new Error('data URL payload missing')
  return Buffer.from(encoded, 'base64').toString('utf8')
}

function quickLookFixturePlist() {
  const entries = [
    ['CID/style.css', 'Attachment1.css', 'text/css'],
    ['CID/tabs.js', 'Attachment2.js', 'application/javascript'],
    ['CID/sheet.html', 'Attachment3.html', 'text/html'],
    ['CID/image.png', 'Attachment4.png', 'image/png']
  ]
    .map(
      ([contentId, fileName, mimeType]) => `
    <key>${contentId}</key>
    <dict>
      <key>DumpedAttachmentFileName</key><string>${fileName}</string>
      <key>MimeType</key><string>${mimeType}</string>
    </dict>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Width</key><integer>640</integer>
  <key>Height</key><integer>480</integer>
  <key>Attachments</key><dict>${entries}
  </dict>
</dict></plist>
`
}
