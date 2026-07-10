#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-preview-prompt-'))
const outDir = path.join(tempRoot, 'compiled')
const reportRoot = path.join(repoRoot, 'test-results', 'preview-prompt')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(reportRoot, runId)
const promptMatrix = []
let finalStatus = 'fail'
let finalError = null

try {
  mkdirSync(runDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/renderer/src/components/workbench/previewUtils.ts',
      'src/renderer/src/components/workbench/previewPrompt.ts',
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

  const prompt = await import(pathToFileURL(findCompiledModule(outDir, 'previewPrompt.js')).href)

  const officePrompt = prompt.buildPreviewAgentPrompt(
    'assets/brief.docx',
    {
      ok: true,
      path: 'assets/brief.docx',
      type: 'office',
      mode: 'text',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: 512,
      content: '# Word Document\n\nHello CaoGen\n\nOffice preview works',
      visual: {
        source: 'quick-look',
        fidelity: 'first-page-thumbnail',
        dataUrl: 'data:image/png;base64,OFFICE_VISUAL_SHOULD_NOT_LEAK'
      }
    },
    [
      {
        note: 'Second paragraph needs review',
        createdAt: '2026-07-07T00:02:00.000Z',
        path: 'assets/brief.docx',
        locator: { quote: 'Office preview works' }
      }
    ]
  )
  assert(officePrompt.includes('类型: office'), 'office prompt should include preview type')
  assert(officePrompt.includes('模式: text'), 'office prompt should include preview mode')
  assert(officePrompt.includes('内容字符:'), 'office prompt should include source content length')
  assert(officePrompt.includes('已发送字符:'), 'office prompt should include sent content length')
  assert(officePrompt.includes('内容截断: 否'), 'office prompt should mark untruncated content')
  assert(officePrompt.includes('批注数量: 1/1'), 'office prompt should include annotation count')
  assert(officePrompt.includes('Hello CaoGen'), 'office prompt should include extracted content')
  assert(officePrompt.includes('结构化批注'), 'office prompt should include annotation section')
  assert(officePrompt.includes('locator={"quote":"Office preview works"}'), 'office prompt should include locator')
  assert(!officePrompt.includes('OFFICE_VISUAL_SHOULD_NOT_LEAK'), 'office prompt must not include visual thumbnail base64')
  recordPrompt('office docx with annotation', officePrompt, ['类型: office', 'Hello CaoGen', '结构化批注'])

  const currentUnitPrompt = prompt.buildPreviewAgentPrompt(
    'assets/report.xlsx',
    {
      ok: true,
      path: 'assets/report.xlsx',
      type: 'office',
      mode: 'text',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: '# Excel Workbook\n\n## Summary\nName\tScore\nCaoGen\t9\n\n## Budget\nItem\tCost\nModel\t3.2'
    },
    [{ note: 'Budget value needs review', locator: { page: 2, quote: 'Model 3.2' } }],
    {
      currentUnit: {
        index: 1,
        position: 2,
        total: 2,
        kind: 'sheet',
        title: 'Budget',
        body: 'Item\tCost\nModel\t3.2',
        rows: [
          ['Item', 'Cost'],
          ['Model', '3.2']
        ],
        content: '# Excel Workbook\n\n## Budget\n\nItem\tCost\nModel\t3.2',
        quote: 'Item Cost Model 3.2'
      }
    }
  )
  assert(currentUnitPrompt.includes('发送范围: 当前结构单元'), 'current-unit prompt should identify its scope')
  assert(currentUnitPrompt.includes('当前单元: Budget'), 'current-unit prompt should include the selected title')
  assert(currentUnitPrompt.includes('当前序号: 2/2'), 'current-unit prompt should include position and total')
  assert(currentUnitPrompt.includes('单元类型: sheet'), 'current-unit prompt should include the unit kind')
  assert(currentUnitPrompt.includes('Model\t3.2'), 'current-unit prompt should include selected sheet content')
  assert(!currentUnitPrompt.includes('CaoGen\t9'), 'current-unit prompt should exclude other sheet bodies')
  recordPrompt('office current sheet', currentUnitPrompt, ['当前单元: Budget', '当前序号: 2/2', 'Model\t3.2'], ['CaoGen\t9'])

  const htmlPrompt = prompt.buildPreviewAgentPrompt(
    'src/index.html',
    {
      ok: true,
      path: 'src/index.html',
      type: 'html',
      mode: 'text',
      mime: 'text/html',
      bytes: 32,
      content: '<main><h1>CaoGen HTML Preview</h1></main>'
    },
    []
  )
  assert(htmlPrompt.includes('类型: html'), 'html prompt should include preview type')
  assert(htmlPrompt.includes('CaoGen HTML Preview'), 'html prompt should include HTML text')
  recordPrompt('html', htmlPrompt, ['类型: html', 'CaoGen HTML Preview'])

  const jsonPrompt = prompt.buildPreviewAgentPrompt(
    'src/data.json',
    {
      ok: true,
      path: 'src/data.json',
      type: 'json',
      mode: 'text',
      mime: 'application/json',
      bytes: 28,
      content: '{"status":"ready","items":[1,2]}'
    },
    []
  )
  assert(jsonPrompt.includes('类型: json'), 'json prompt should include preview type')
  assert(jsonPrompt.includes('"status":"ready"'), 'json prompt should include JSON content')
  recordPrompt('json', jsonPrompt, ['类型: json', '"status":"ready"'])

  const csvPrompt = prompt.buildPreviewAgentPrompt(
    'src/table.csv',
    {
      ok: true,
      path: 'src/table.csv',
      type: 'csv',
      mode: 'text',
      mime: 'text/csv',
      bytes: 18,
      content: 'name,score\nCaoGen,9\n'
    },
    []
  )
  assert(csvPrompt.includes('类型: csv'), 'csv prompt should include preview type')
  assert(csvPrompt.includes('name,score'), 'csv prompt should include table header')
  assert(csvPrompt.includes('CaoGen,9'), 'csv prompt should include table row')
  recordPrompt('csv', csvPrompt, ['类型: csv', 'name,score', 'CaoGen,9'])

  const truncatedPrompt = prompt.buildPreviewAgentPrompt(
    'src/large.md',
    {
      ok: true,
      path: 'src/large.md',
      type: 'markdown',
      mode: 'text',
      mime: 'text/markdown',
      bytes: 32,
      content: '0123456789abcdef'
    },
    [
      { note: 'first note' },
      { note: 'second note' },
      { note: 'third note' }
    ],
    { maxContentChars: 8, maxAnnotations: 2 }
  )
  assert(truncatedPrompt.includes('内容字符: 16'), 'truncated prompt should include original content length')
  assert(truncatedPrompt.includes('已发送字符: 8'), 'truncated prompt should include sent content length')
  assert(truncatedPrompt.includes('内容截断: 是'), 'truncated prompt should mark truncated content')
  assert(truncatedPrompt.includes('[truncated 8 characters]'), 'truncated prompt should include truncation suffix')
  assert(truncatedPrompt.includes('批注数量: 2/3 (已截断)'), 'truncated prompt should mark truncated annotations')
  assert(truncatedPrompt.includes('first note') && truncatedPrompt.includes('second note'), 'truncated prompt should include visible annotations')
  assert(!truncatedPrompt.includes('third note'), 'truncated prompt should omit annotations past the cap')
  recordPrompt('markdown truncated with annotations', truncatedPrompt, ['类型: markdown', '内容截断: 是', '批注数量: 2/3'])

  const assetPrompt = prompt.buildPreviewAgentPrompt(
    'assets/report.pdf',
    {
      ok: true,
      path: 'assets/report.pdf',
      type: 'pdf',
      mode: 'asset',
      mime: 'application/pdf',
      bytes: 128,
      dataUrl: 'data:application/pdf;base64,SHOULD_NOT_LEAK'
    },
    []
  )
  assert(assetPrompt.includes('此预览没有可发送的文本内容'), 'asset prompt should explain missing text content')
  assert(!assetPrompt.includes('SHOULD_NOT_LEAK'), 'asset prompt must not include base64 asset data')
  recordPrompt('pdf asset metadata without text', assetPrompt, ['类型: pdf', '此预览没有可发送的文本内容'], ['SHOULD_NOT_LEAK'])

  const pdfTextPrompt = prompt.buildPreviewAgentPrompt(
    'assets/report.pdf',
    {
      ok: true,
      path: 'assets/report.pdf',
      type: 'pdf',
      mode: 'asset',
      mime: 'application/pdf',
      bytes: 256,
      dataUrl: 'data:application/pdf;base64,SHOULD_NOT_LEAK',
      content: '# PDF Document\n\nHello PDF\nAgent can quote this'
    },
    []
  )
  assert(pdfTextPrompt.includes('Hello PDF'), 'pdf prompt should include extracted text content')
  assert(pdfTextPrompt.includes('Agent can quote this'), 'pdf prompt should include later extracted text')
  assert(!pdfTextPrompt.includes('SHOULD_NOT_LEAK'), 'pdf prompt must not include base64 asset data')
  recordPrompt('pdf extracted text', pdfTextPrompt, ['Hello PDF', 'Agent can quote this'], ['SHOULD_NOT_LEAK'])

  const imagePrompt = prompt.buildPreviewAgentPrompt(
    'assets/logo.png',
    {
      ok: true,
      path: 'assets/logo.png',
      type: 'image',
      mode: 'asset',
      mime: 'image/png',
      bytes: 96,
      dataUrl: 'data:image/png;base64,SHOULD_NOT_LEAK'
    },
    []
  )
  assert(imagePrompt.includes('类型: image'), 'image prompt should include preview type')
  assert(imagePrompt.includes('MIME: image/png'), 'image prompt should include image MIME')
  assert(imagePrompt.includes('此预览没有可发送的文本内容'), 'image prompt should explain missing text content')
  assert(!imagePrompt.includes('SHOULD_NOT_LEAK'), 'image prompt must not include base64 image data')
  recordPrompt('image metadata without base64', imagePrompt, ['类型: image', 'MIME: image/png'], ['SHOULD_NOT_LEAK'])

  const failedPrompt = prompt.buildPreviewAgentPrompt(
    'assets/bad.docx',
    {
      ok: false,
      path: 'assets/bad.docx',
      type: 'office',
      mode: 'text',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      error: 'Office 文档无法解析:缺少 word/document.xml'
    },
    []
  )
  assert(failedPrompt.includes('预览错误: Office 文档无法解析'), 'failed prompt should include preview error')
  recordPrompt('failed office preview', failedPrompt, ['预览错误: Office 文档无法解析'])

  const failedSource = prompt.getPreviewAgentPromptSource(
    'assets/bad.docx',
    {
      ok: false,
      path: 'assets/bad.docx',
      type: 'office',
      mode: 'text',
      error: 'Office 文档无法解析:缺少 word/document.xml'
    },
    undefined
  )
  assert(failedSource, 'failed preview source should still be sendable')
  assert(failedSource.ok === false, 'failed preview source should preserve failed state')

  const fallbackErrorSource = prompt.getPreviewAgentPromptSource(
    'assets/unreadable.pdf',
    null,
    'IPC preview failed'
  )
  assert(fallbackErrorSource, 'preview error without preview object should still be sendable')
  const fallbackPrompt = prompt.buildPreviewAgentPrompt('assets/unreadable.pdf', fallbackErrorSource, [])
  assert(fallbackPrompt.includes('文件: assets/unreadable.pdf'), 'fallback prompt should keep preview path')
  assert(fallbackPrompt.includes('预览错误: IPC preview failed'), 'fallback prompt should include UI preview error')

  const emptySource = prompt.getPreviewAgentPromptSource(undefined, null, '')
  assert(emptySource === null, 'missing preview and missing error should not be sendable')

  const label = prompt.previewAnnotationLabel('x '.repeat(80))
  assert(label.endsWith('...'), 'annotation labels should be compacted')

  const panelSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/workbench/PreviewPanel.tsx'), 'utf8')
  assert(panelSource.includes('data-preview-agent-sendable'), 'PreviewPanel should expose sendable state for UI smoke')
  assert(panelSource.includes('data-preview-agent-source-type'), 'PreviewPanel should expose preview source type')
  assert(panelSource.includes('data-preview-agent-source-mode'), 'PreviewPanel should expose preview source mode')
  assert(panelSource.includes('data-preview-annotations'), 'PreviewPanel should expose annotation count')
  assert(panelSource.includes('data-preview-current-unit'), 'PreviewPanel should expose the current Office unit')
  assert(panelSource.includes('data-preview-send-current-unit'), 'PreviewPanel should expose a current-unit send command')
  assert(panelSource.includes('selector: `office:'), 'PreviewPanel should build a locator for the current Office unit')
  assert(panelSource.includes('data-preview-send-state'), 'PreviewPanel should expose send state')
  assert(panelSource.includes("t('previewSentToAgent')"), 'PreviewPanel should show successful send state')
  assert(panelSource.includes("t('previewSendFailed')"), 'PreviewPanel should show failed send state')
  const storeSource = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
  assert(storeSource.includes('locator: locator ?? null'), 'Preview annotations should persist the current unit locator')

  finalStatus = 'pass'
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  mkdirSync(runDir, { recursive: true })
  const report = {
    runId,
    status: finalStatus,
    promptMatrix,
    error: finalError,
    generatedAt: new Date().toISOString()
  }
  writeFileSync(path.join(runDir, 'preview-prompt-smoke.json'), JSON.stringify(report, null, 2))
  writeFileSync(path.join(reportRoot, 'latest.json'), JSON.stringify(report, null, 2))
  rmSync(tempRoot, { recursive: true, force: true })
}

if (finalStatus === 'pass') {
  console.log(`previewPrompt smoke ok: ${runDir}`)
} else {
  console.error(`previewPrompt smoke failed: ${finalError}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function recordPrompt(label, promptText, contains = [], excludes = []) {
  promptMatrix.push({
    label,
    length: promptText.length,
    contains,
    excludes,
    hasAllExpected: contains.every((needle) => promptText.includes(needle)),
    avoidsAllExcluded: excludes.every((needle) => !promptText.includes(needle))
  })
}

function findCompiledModule(dir, fileName) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath, fileName)
      if (found) return found
    } else if (entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found under ${dir}`)
}
