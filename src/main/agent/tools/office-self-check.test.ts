import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Document, Packer, Paragraph, HeadingLevel } from 'docx'
import ExcelJS from 'exceljs'
import { isEffectTarget } from '../../task/effect-target-validation'
import { runOfficeSelfCheck } from './office-self-check'

// OOXML media types — kept inline so the test stays decoupled from office-artifact.ts's
// heavier main-module import graph (safe-project-path / effect-reconciliation-result / tool-idempotency).
const DOCX_MEDIA = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'office-self-check-'))
}

async function writeDocx(dir: string, name = 'doc.docx'): Promise<string> {
  const doc = new Document({
    sections: [{ children: [new Paragraph({ text: '标题', heading: HeadingLevel.HEADING_1 }), new Paragraph({ text: '正文段落' })] }]
  })
  const buf = await Packer.toBuffer(doc)
  const path = join(dir, name)
  await writeFile(path, buf)
  return path
}

async function writeXlsx(dir: string, name = 'sheet.xlsx'): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  ws.addRow(['a', 'b', 'c'])
  ws.addRow([1, 2, 3])
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  const path = join(dir, name)
  await writeFile(path, buf)
  return path
}

function sha256File(hex: string): string {
  return `sha256:${hex}`
}

test('isEffectTarget: 有效 office_artifact 返回 true', () => {
  const target = {
    kind: 'office_artifact',
    artifactKind: 'document',
    rootPath: '/p',
    rootIdentity: { device: '1', inode: '2' },
    relativePath: 'd.docx',
    workspacePath: '/p/d.docx',
    specDigest: 'sha256:abc',
    mediaType: DOCX_MEDIA,
    sourceRefs: ['/p/src.md'],
    title: '会议纪要'
  }
  assert.equal(isEffectTarget(target), true)
})

test('isEffectTarget: office_artifact 字段非法应被拒', () => {
  const base = {
    kind: 'office_artifact',
    artifactKind: 'document',
    rootPath: '/p',
    rootIdentity: { device: '1', inode: '2' },
    relativePath: 'x.docx',
    workspacePath: '/p/x.docx',
    specDigest: 'sha256:a',
    mediaType: DOCX_MEDIA,
    sourceRefs: ['y'],
    title: 't'
  }
  assert.equal(
    isEffectTarget({ ...base, artifactKind: 'archive' }),
    false
  )
  assert.equal(
    isEffectTarget({ ...base, rootIdentity: { device: '1' } }),
    false
  )
  assert.equal(
    isEffectTarget({ ...base, sourceRefs: 'not-array' }),
    false
  )
})

test('isEffectTarget: 既有 EffectTarget 不受回归影响', () => {
  assert.equal(isEffectTarget({ kind: 'file_content', rootPath: '/r', relativePath: 'f', preState: 'absent', expectedSha256: 'sha256:a', expectedBytes: 1 }), true)
  assert.equal(isEffectTarget({ kind: 'unsupported' }), false)
  assert.equal(isEffectTarget({ kind: 'unsupported', toolName: 'x' }), true)
})

test('runOfficeSelfCheck: 有效 docx + 来源可追溯 → ok', async () => {
  const dir = await makeDir()
  try {
    const src = join(dir, 'src.md')
    await writeFile(src, '# 来源材料')
    const docx = await writeDocx(dir)
    const { createHash } = await import('node:crypto')
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(docx)
    const sha = `sha256:${createHash('sha256').update(buf).digest('hex')}`
    const result = await runOfficeSelfCheck({
      workspacePath: docx,
      expectedSha256: sha,
      artifactKind: 'document',
      mediaType: DOCX_MEDIA,
      sourceRefs: [src],
      runtimeTraceable: true
    })
    assert.equal(result.ok, true)
    assert.equal(result.digestMatch, true)
    assert.equal(result.sourceTraceable, true)
    assert.equal(result.kind, 'document')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runOfficeSelfCheck: 有效 xlsx + 来源可追溯 → ok', async () => {
  const dir = await makeDir()
  try {
    const src = join(dir, 'data.csv')
    await writeFile(src, 'a,b')
    const xlsx = await writeXlsx(dir)
    const { createHash } = await import('node:crypto')
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(xlsx)
    const sha = `sha256:${createHash('sha256').update(buf).digest('hex')}`
    const result = await runOfficeSelfCheck({
      workspacePath: xlsx,
      expectedSha256: sha,
      artifactKind: 'spreadsheet',
      mediaType: XLSX_MEDIA,
      sourceRefs: [src],
      runtimeTraceable: true
    })
    assert.equal(result.ok, true)
    assert.equal(result.digestMatch, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runOfficeSelfCheck: 损坏文件 → not ok（打开性/解析失败）', async () => {
  const dir = await makeDir()
  try {
    const src = join(dir, 'src.md')
    await writeFile(src, 'src')
    const corrupt = join(dir, 'bad.docx')
    await writeFile(corrupt, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]))
    const result = await runOfficeSelfCheck({
      workspacePath: corrupt,
      artifactKind: 'document',
      mediaType: DOCX_MEDIA,
      sourceRefs: [src],
      runtimeTraceable: true
    })
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /打开|解析|ZIP|OOXML/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runOfficeSelfCheck: 无来源（sourceRefs 空且无 Run/Effect 来源链） → not ok', async () => {
  const dir = await makeDir()
  try {
    const docx = await writeDocx(dir)
    const { createHash } = await import('node:crypto')
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(docx)
    const sha = `sha256:${createHash('sha256').update(buf).digest('hex')}`
    const result = await runOfficeSelfCheck({
      workspacePath: docx,
      expectedSha256: sha,
      artifactKind: 'document',
      mediaType: DOCX_MEDIA,
      sourceRefs: []
    })
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /来源/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runOfficeSelfCheck: sourceRefs 空 + runtimeTraceable → 由 Run/Effect 来源链认定为可追溯', async () => {
  const dir = await makeDir()
  try {
    const docx = await writeDocx(dir)
    const { createHash } = await import('node:crypto')
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(docx)
    const sha = `sha256:${createHash('sha256').update(buf).digest('hex')}`
    const result = await runOfficeSelfCheck({
      workspacePath: docx,
      expectedSha256: sha,
      artifactKind: 'document',
      mediaType: DOCX_MEDIA,
      sourceRefs: [],
      runtimeTraceable: true
    })
    assert.equal(result.ok, true)
    assert.equal(result.digestMatch, true)
    assert.equal(result.sourceTraceable, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runOfficeSelfCheck: 字节 digest 不一致 → not ok（来源不可验证）', async () => {
  const dir = await makeDir()
  try {
    const src = join(dir, 'src.md')
    await writeFile(src, 'src')
    const docx = await writeDocx(dir)
    const result = await runOfficeSelfCheck({
      workspacePath: docx,
      expectedSha256: sha256File('0'.repeat(64)),
      artifactKind: 'document',
      mediaType: DOCX_MEDIA,
      sourceRefs: [src],
      runtimeTraceable: true
    })
    assert.equal(result.ok, false)
    assert.equal(result.digestMatch, false)
    assert.match(result.reason ?? '', /sha256|不一致/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runOfficeSelfCheck: mediaType 与 artifactKind 不匹配 → not ok', async () => {
  const dir = await makeDir()
  try {
    const src = join(dir, 'src.md')
    await writeFile(src, 'src')
    const docx = await writeDocx(dir)
    const { createHash } = await import('node:crypto')
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(docx)
    const sha = `sha256:${createHash('sha256').update(buf).digest('hex')}`
    const result = await runOfficeSelfCheck({
      workspacePath: docx,
      expectedSha256: sha,
      artifactKind: 'document',
      mediaType: XLSX_MEDIA, // 错误 mediaType
      sourceRefs: [src],
      runtimeTraceable: true
    })
    assert.equal(result.ok, false)
    assert.match(result.reason ?? '', /mediaType/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
