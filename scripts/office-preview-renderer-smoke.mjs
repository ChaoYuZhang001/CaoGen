import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-office-preview-renderer-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/renderer/src/components/workbench/officePreviewUtils.ts',
      'src/renderer/src/components/workbench/previewUtils.ts',
      'src/renderer/src/components/workbench/PreviewRenderer.tsx',
      '--outDir',
      buildDir,
      '--target',
      'ES2022',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--jsx',
      'react-jsx',
      '--esModuleInterop',
      '--allowSyntheticDefaultImports',
      '--strict',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const utils = await import(pathToFileURL(findCompiled(buildDir, 'officePreviewUtils.js')).href)
  const excel = utils.parseOfficePreviewContent([
    '# Excel Workbook',
    '',
    '## Summary',
    'Name\tScore',
    'CaoGen\t9',
    '',
    '## Budget',
    'Item\tCost',
    'Model\t3.2'
  ].join('\n'))
  assert(excel.kind === 'excel', 'Excel workbook should parse as excel')
  assert(excel.sections.length === 2, 'Excel workbook should keep sheet sections')
  assert(excel.sections[0].rows[0][0] === 'Name', 'Excel first sheet should parse table header')
  assert(excel.sections[0].rows[1][1] === '9', 'Excel first sheet should parse table cell')
  assert(excel.sections[1].title === 'Budget', 'Excel second sheet title should be preserved')

  const ppt = utils.parseOfficePreviewContent([
    '# PowerPoint Presentation',
    '',
    '## Slide 1',
    'Launch plan',
    'Milestone A',
    '',
    '## Slide 2',
    'Delivery'
  ].join('\n'))
  assert(ppt.kind === 'powerpoint', 'PowerPoint should parse as powerpoint')
  assert(ppt.sections.length === 2, 'PowerPoint should keep slide sections')
  assert(ppt.sections[0].body.includes('Launch plan'), 'PowerPoint slide body should be preserved')

  const word = utils.parseOfficePreviewContent('# Word Document\n\nHello CaoGen\n\nOffice preview works')
  assert(word.kind === 'word', 'Word document should parse as word')
  assert(word.sections[0].body.includes('Hello CaoGen'), 'Word document body should be preserved')
  const pagedWord = utils.parseOfficePreviewContent(
    '# Word Document\n\n## Page 1\nFirst page\n\n## Page 2\nSecond page'
  )
  const secondWordPage = utils.officePreviewUnit(pagedWord, 1)
  assert(secondWordPage.kind === 'page', 'explicit Word page sections should become page units')
  assert(secondWordPage.position === 2 && secondWordPage.total === 2, 'Word page unit should expose position and total')
  assert(secondWordPage.content.includes('Second page'), 'Word page unit should expose only the selected page content')

  linkNodeModules()
  const rendererModule = await import(pathToFileURL(findCompiled(buildDir, 'PreviewRenderer.js')).href)
  const PreviewRenderer = rendererModule.default?.default ?? rendererModule.default ?? rendererModule.PreviewRenderer
  assert(typeof PreviewRenderer === 'function', 'PreviewRenderer default export should compile')

  const wordHtml = renderPreview(PreviewRenderer, {
    ok: true,
    path: 'brief.docx',
    type: 'office',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content: '# Word Document\n\nHello CaoGen\n\nOffice preview works'
  })
  assert(wordHtml.includes('Word Preview'), 'Word renderer should expose a Word-specific title')
  assert(wordHtml.includes('Hello CaoGen'), 'Word renderer should render extracted document text')

  const visualHtml = renderPreview(
    PreviewRenderer,
    {
      ok: true,
      path: 'brief.docx',
      type: 'office',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: '# Word Document\n\nHello CaoGen\n\nOffice preview works'
    },
    {
      officeVisual: {
        ok: true,
        path: 'brief.docx',
        previewUrl: 'data:text/html;base64,PGh0bWw+PC9odG1sPg==',
        width: 740,
        height: 1200,
        source: 'quick-look',
        fidelity: 'system-document-preview'
      }
    }
  )
  assert(visualHtml.includes('data-office-preview-mode="visual"'), 'ready visual preview should be the default mode')
  assert(visualHtml.includes('data-office-visual-state="ready"'), 'ready visual preview should expose machine-readable state')
  assert(visualHtml.includes('data-office-visual-format="document"'), 'full visual mode should identify document format')
  assert(visualHtml.includes('data:text/html;base64,PGh0bWw+PC9odG1sPg=='), 'visual mode should render the Quick Look HTML')
  assert(visualHtml.includes('sandbox="allow-scripts"'), 'system document iframe should stay sandboxed')
  assert(visualHtml.includes('layout may differ from the original'), 'visual mode should state its fidelity limit')

  const thumbnailHtml = renderPreview(
    PreviewRenderer,
    {
      ok: true,
      path: 'brief.docx',
      type: 'office',
      content: '# Word Document\n\nThumbnail fallback'
    },
    {
      officeVisual: {
        ok: true,
        path: 'brief.docx',
        dataUrl: 'data:image/png;base64,QUJD',
        source: 'quick-look',
        fidelity: 'first-page-thumbnail'
      }
    }
  )
  assert(thumbnailHtml.includes('data-office-visual-format="thumbnail"'), 'fallback visual should identify thumbnail format')
  assert(thumbnailHtml.includes('data:image/png;base64,QUJD'), 'thumbnail fallback should render the Quick Look PNG')
  assert(thumbnailHtml.includes('does not represent the complete document layout'), 'thumbnail should keep its narrower fidelity warning')

  const loadingHtml = renderPreview(
    PreviewRenderer,
    {
      ok: true,
      path: 'brief.docx',
      type: 'office',
      content: '# Word Document\n\nImmediate structure content'
    },
    { officeVisualLoading: true }
  )
  assert(loadingHtml.includes('data-office-preview-mode="structure"'), 'loading visual preview should keep structure visible')
  assert(loadingHtml.includes('data-office-visual-state="loading"'), 'loading state should be machine-readable')
  assert(loadingHtml.includes('Immediate structure content'), 'Quick Look loading must not hide extracted structure')

  const fallbackHtml = renderPreview(
    PreviewRenderer,
    {
      ok: true,
      path: 'brief.docx',
      type: 'office',
      content: '# Word Document\n\nFallback structure content'
    },
    { officeVisualError: 'Quick Look timed out' }
  )
  assert(fallbackHtml.includes('data-office-visual-state="error"'), 'visual error should be machine-readable')
  assert(fallbackHtml.includes('Fallback structure content'), 'visual errors should fall back to extracted structure')
  assert(fallbackHtml.includes('Quick Look timed out'), 'visual fallback should expose its concrete reason')

  const excelHtml = renderPreview(PreviewRenderer, {
    ok: true,
    path: 'report.xlsx',
    type: 'office',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: '# Excel Workbook\n\n## Summary\nName\tScore\nCaoGen\t9'
  })
  assert(excelHtml.includes('Excel Preview'), 'Excel renderer should expose an Excel-specific title')
  assert(excelHtml.includes('<table'), 'Excel renderer should render sheets as tables')
  assert(excelHtml.includes('CaoGen') && excelHtml.includes('9'), 'Excel renderer should render table cells')

  const pptHtml = renderPreview(PreviewRenderer, {
    ok: true,
    path: 'slides.pptx',
    type: 'office',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    content: '# PowerPoint Presentation\n\n## Slide 1\nLaunch plan\nMilestone A'
  })
  assert(pptHtml.includes('PowerPoint Preview'), 'PowerPoint renderer should expose a PowerPoint-specific title')
  assert(pptHtml.includes('Slide 1') && pptHtml.includes('Launch plan'), 'PowerPoint renderer should render slide sections')

  const multiPptHtml = renderPreview(PreviewRenderer, {
    ok: true,
    path: 'slides.pptx',
    type: 'office',
    content: '# PowerPoint Presentation\n\n## Slide 1\nFirst slide\n\n## Slide 2\nSecond slide'
  })
  assert(multiPptHtml.includes('data-office-unit-index="1"'), 'structure view should expose current unit index')
  assert(multiPptHtml.includes('data-office-unit-total="2"'), 'structure view should expose unit total')
  assert(multiPptHtml.includes('data-office-unit-navigation="1"'), 'structure view should render unit navigation')
  assert(multiPptHtml.includes('data-office-unit-selector="1"'), 'structure view should render a unit selector')
  assert(multiPptHtml.includes('First slide'), 'structure view should render the selected slide')
  assert(!multiPptHtml.includes('Second slide'), 'structure view should not render every slide body at once')

  const failedHtml = renderPreview(PreviewRenderer, {
    ok: false,
    path: 'bad.docx',
    type: 'office',
    error: 'Office 文档无法解析:缺少 word/document.xml'
  })
  assert(failedHtml.includes('Preview failed'), 'failed preview should render a failure shell')
  assert(failedHtml.includes('Office 文档无法解析'), 'failed preview should surface the concrete parse error')

  const rendererSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/workbench/PreviewRenderer.tsx'), 'utf8')
  assert(!/complete.{0,20}Office.{0,20}layout/i.test(rendererSource), 'renderer must not claim complete Office layout support')
  assert(rendererSource.includes("return 'Word Preview'"), 'renderer should keep Word-specific title logic')
  assert(rendererSource.includes("return 'Excel Preview'"), 'renderer should keep Excel-specific title logic')
  assert(rendererSource.includes("return 'PowerPoint Preview'"), 'renderer should keep PowerPoint-specific title logic')
  assert(rendererSource.includes('data-office-preview-mode'), 'renderer should expose the Office visual/structure mode')
  assert(rendererSource.includes('data-office-unit-navigation'), 'renderer should keep structural unit navigation')
  assert(rendererSource.includes('sandbox="allow-scripts"'), 'renderer should keep the system preview sandbox')
  assert(rendererSource.includes('system-document-preview') || rendererSource.includes('previewUrl'), 'renderer should support full system document previews')
  assert(rendererSource.includes('first-page thumbnail'), 'renderer should keep the visual fidelity disclaimer')

  console.log('office preview renderer smoke ok')
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function linkNodeModules() {
  const linkPath = path.join(buildDir, 'node_modules')
  if (existsSync(linkPath)) return
  symlinkSync(path.join(repoRoot, 'node_modules'), linkPath, 'dir')
}

function renderPreview(PreviewRenderer, preview, props = {}) {
  return renderToStaticMarkup(
    React.createElement(PreviewRenderer, {
      maxTextChars: 80_000,
      preview,
      ...props
    })
  )
}

function findCompiled(root, fileName) {
  const found = findCompiledMaybe(root, fileName)
  if (!found) throw new Error(`compiled file not found: ${fileName}`)
  return found
}

function findCompiledMaybe(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledMaybe(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}
