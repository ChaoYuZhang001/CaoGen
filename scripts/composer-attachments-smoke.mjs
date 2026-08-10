#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-composer-attachments-'))
const outDir = path.join(tempRoot, 'compiled')
const checks = []

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2022,DOM',
    '--skipLibCheck',
    'src/main/attachmentOps.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
  const runtime = await import(pathToFileURL(findCompiled(outDir, 'attachmentOps.js')).href)
  const workspace = path.join(tempRoot, 'workspace')
  const attachments = path.join(tempRoot, 'attachments')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(path.join(workspace, 'notes.md'), '# Notes\nATTACHMENT-CONTENT-CANARY\n', 'utf8')
  writeFileSync(path.join(workspace, '.env'), 'API_TOKEN=LOCAL-ONLY-CANARY\n', 'utf8')
  writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(path.join(workspace, 'large.txt'), 'x'.repeat(runtime.DEFAULT_MAX_DOCUMENT_BYTES + 1), 'utf8')
  writeFileSync(path.join(tempRoot, 'outside.txt'), 'OUTSIDE-CANARY', 'utf8')

  const prepared = await runtime.prepareDocumentAttachmentFile(path.join(workspace, 'notes.md'), workspace)
  equal(prepared.name, 'notes.md', 'workspace selection returns only a relative display path')
  equal(prepared.dataClass, 'S2', 'ordinary workspace text is classified S2')
  const persisted = await runtime.persistPreparedDocumentAttachment(prepared, attachments)
  check('document snapshot is persisted by content hash', persisted.ok && persisted.path.endsWith(`${path.sep}S2${path.sep}${prepared.hash}.txt`))
  const prompt = runtime.documentAttachmentsToPrompt([persisted], attachments)
  check('Provider prompt contains the frozen document content', prompt.includes('ATTACHMENT-CONTENT-CANARY'))
  check('Provider prompt contains no absolute workspace path', !prompt.includes(workspace))

  const sensitive = await runtime.prepareDocumentAttachmentFile(path.join(workspace, '.env'), workspace)
  equal(sensitive.dataClass, 'S3', 'credential-like files are classified S3')
  const sensitivePersisted = await runtime.persistPreparedDocumentAttachment(sensitive, attachments)
  check('S3 classification is bound into the durable path', sensitivePersisted.ok && sensitivePersisted.path.includes(`${path.sep}S3${path.sep}`))

  await rejects(
    () => runtime.prepareDocumentAttachmentFile(path.join(tempRoot, 'outside.txt'), workspace),
    'selection outside the workspace is rejected'
  )
  await rejects(
    () => runtime.prepareDocumentAttachmentFile(path.join(workspace, 'binary.bin'), workspace),
    'binary files are rejected'
  )
  await rejects(
    () => runtime.prepareDocumentAttachmentFile(path.join(workspace, 'large.txt'), workspace),
    'documents over the size limit are rejected'
  )
  assert.throws(
    () => runtime.documentAttachmentsToPrompt([{ ...persisted, hash: '0'.repeat(64), id: '0'.repeat(64) }], attachments),
    /路径与分类或摘要不匹配|内容与已冻结摘要不匹配/
  )
  checks.push('tampered document references fail closed')
  assert.throws(
    () => runtime.documentAttachmentsToPrompt([{ ...persisted, name: path.join(tempRoot, 'private.txt') }], attachments),
    /安全相对路径/
  )
  checks.push('absolute document labels fail closed before Provider prompt construction')

  const composer = readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
  const preview = readFileSync('src/renderer/src/components/OutboundContextPreview.tsx', 'utf8')
  const policy = readFileSync('src/main/project-workspace/outbound-context-policy.ts', 'utf8')
  const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
  check('Composer exposes a visible attachment button', composer.includes('<Paperclip') && composer.includes("t('addAttachment')"))
  check('click, drop, paste, and mention selection share attachment handling',
    composer.includes('fileInputRef.current?.click()') && composer.includes('onDrop={onDrop}') &&
      composer.includes('onPaste={onPaste}') && composer.includes('attachSuggestedFile(path)'))
  check('unsent image and document attachments are keyed by session',
    composer.includes('attachmentsBySession') && composer.includes('documentsBySession'))
  check('outbound preview receives document metadata', preview.includes('documents: input.documents'))
  check('outbound policy inventories document attachments', policy.includes("kind: 'document_attachment'"))
  check('attachment controls have stable responsive dimensions',
    styles.includes('.composer-attach {') && styles.includes('flex: 0 0 34px') && styles.includes('.document-attachment-tray {'))

  console.log(`composer attachments smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* keep searching */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  checks.push(message)
}

function check(message, condition) {
  assert.equal(Boolean(condition), true, message)
  checks.push(message)
}

async function rejects(run, message) {
  await assert.rejects(run)
  checks.push(message)
}
