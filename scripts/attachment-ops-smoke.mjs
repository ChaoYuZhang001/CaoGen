import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-attachment-ops-'))
const outDir = path.join(tempRoot, 'compiled')
const inputDir = path.join(tempRoot, 'input')
const attachmentsRoot = path.join(tempRoot, 'userData', 'attachments')
const bytesAttachmentsRoot = path.join(tempRoot, 'userData', 'byte-attachments')
const rawBase64AttachmentsRoot = path.join(tempRoot, 'userData', 'raw-base64-attachments')
const dataUrlAttachmentsRoot = path.join(tempRoot, 'userData', 'data-url-attachments')

const minPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)

try {
  mkdirSync(inputDir, { recursive: true })

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/attachmentOps.ts',
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

  const attachmentOps = await import(pathToFileURL(path.join(outDir, 'attachmentOps.js')).href)
  assert(typeof attachmentOps.saveImageAttachmentBytes === 'function', 'saveImageAttachmentBytes should be exported')

  const pngSource = path.join(inputDir, 'pixel.png')
  writeFileSync(pngSource, minPng)

  const copied = await attachmentOps.copyImageAttachment(pngSource, attachmentsRoot)
  assertOk(copied, 'copyImageAttachment should copy a valid PNG')

  const expectedHash = createHash('sha256').update(minPng).digest('hex')
  const expectedPath = path.join(realpathSync(attachmentsRoot), `${expectedHash}.png`)
  assertEqual(copied.id, expectedHash)
  assertEqual(copied.hash, expectedHash)
  assertEqual(copied.path, expectedPath)
  assertEqual(copied.mime, 'image/png')
  assertEqual(copied.bytes, minPng.byteLength)
  assert(typeof copied.createdAt === 'string' && copied.createdAt.length > 0, 'createdAt should be present')
  assert(existsSync(expectedPath), 'copied file should exist at content-hash path')
  assert(readFileSync(expectedPath).equals(minPng), 'copied bytes should match source')

  const block = await attachmentOps.imageToContentBlock(copied.path)
  assertImageContentBlock(block, minPng, 'image/png')
  assertImageContentBlock(
    attachmentOps.imageAttachmentRefToContentBlock(copied, attachmentsRoot),
    minPng,
    'image/png'
  )
  assertThrows(
    () => attachmentOps.imageAttachmentRefToContentBlock({ ...copied, hash: undefined }, attachmentsRoot),
    /SHA-256/,
    'legacy references without a digest must fail closed'
  )
  assertThrows(
    () => attachmentOps.imageAttachmentRefToContentBlock({ ...copied, bytes: copied.bytes + 1 }, attachmentsRoot),
    /大小/,
    'reference byte mismatches must fail closed'
  )

  const absentUserData = path.join(tempRoot, 'absent-user-data')
  assertEqual(
    attachmentOps.sessionImageAttachmentsRoot(absentUserData, 'session-safe'),
    path.join(absentUserData, 'attachments', 'session-safe')
  )
  assertThrows(
    () => attachmentOps.sessionImageAttachmentsRoot(absentUserData, '../escape'),
    /标识无效/,
    'session ids must not escape the attachment base'
  )
  const symlinkRoot = path.join(tempRoot, 'symlink-attachments')
  symlinkSync(realpathSync(attachmentsRoot), symlinkRoot)
  assertThrows(
    () => attachmentOps.imageAttachmentRefToContentBlock(copied, symlinkRoot),
    /普通目录/,
    'a symlinked session attachment root must fail closed'
  )

  const savedBytes = await attachmentOps.saveImageAttachmentBytes(new Uint8Array(minPng), bytesAttachmentsRoot, {
    mime: 'image/png'
  })
  assertOk(savedBytes, 'saveImageAttachmentBytes should save Uint8Array PNG bytes')
  assertImageAttachment(savedBytes, minPng, bytesAttachmentsRoot, 'png', 'image/png')
  assertImageContentBlock(await attachmentOps.imageToContentBlock(savedBytes.path), minPng, 'image/png')

  const savedRawBase64 = await attachmentOps.saveImageAttachmentBytes(minPng.toString('base64'), rawBase64AttachmentsRoot)
  assertOk(savedRawBase64, 'saveImageAttachmentBytes should save raw base64 PNG')
  assertImageAttachment(savedRawBase64, minPng, rawBase64AttachmentsRoot, 'png', 'image/png')

  const savedDataUrl = await attachmentOps.saveImageAttachmentBytes(
    `data:image/png;base64,${minPng.toString('base64')}`,
    dataUrlAttachmentsRoot
  )
  assertOk(savedDataUrl, 'saveImageAttachmentBytes should save data URL PNG')
  assertImageAttachment(savedDataUrl, minPng, dataUrlAttachmentsRoot, 'png', 'image/png')

  const textSource = path.join(inputDir, 'note.txt')
  writeFileSync(textSource, 'not an image')
  const nonImage = await attachmentOps.copyImageAttachment(textSource, attachmentsRoot)
  assert(!nonImage.ok, 'copyImageAttachment should reject non-image extensions')

  const directorySource = path.join(inputDir, 'folder.png')
  mkdirSync(directorySource)
  const directoryResult = await attachmentOps.copyImageAttachment(directorySource, attachmentsRoot)
  assert(!directoryResult.ok, 'copyImageAttachment should reject directories')

  const tooLargeSource = path.join(inputDir, 'too-large.png')
  writeFileSync(tooLargeSource, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]))
  const tooLarge = await attachmentOps.copyImageAttachment(tooLargeSource, attachmentsRoot)
  assert(!tooLarge.ok, 'copyImageAttachment should reject images over the default 5MB limit')

  const tooLargeBytes = await attachmentOps.saveImageAttachmentBytes(readFileSync(tooLargeSource), attachmentsRoot)
  assert(!tooLargeBytes.ok, 'saveImageAttachmentBytes should reject images over the default 5MB limit')

  const wrongMime = await attachmentOps.saveImageAttachmentBytes(minPng, attachmentsRoot, { mime: 'image/jpeg' })
  assert(!wrongMime.ok, 'saveImageAttachmentBytes should reject mismatched MIME and bytes')

  console.log('attachmentOps smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertOk(result, message) {
  assert(result.ok, `${message}: ${result.error ?? 'unknown error'}`)
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertImageAttachment(result, bytes, root, extension, mime) {
  const expectedHash = createHash('sha256').update(bytes).digest('hex')
  const expectedPath = path.join(realpathSync(root), `${expectedHash}.${extension}`)
  assertEqual(result.id, expectedHash)
  assertEqual(result.hash, expectedHash)
  assertEqual(result.path, expectedPath)
  assertEqual(result.mime, mime)
  assertEqual(result.bytes, bytes.byteLength)
  assert(typeof result.createdAt === 'string' && result.createdAt.length > 0, 'createdAt should be present')
  assert(existsSync(expectedPath), 'saved file should exist at content-hash path')
  assert(readFileSync(expectedPath).equals(bytes), 'saved bytes should match input')
}

function assertImageContentBlock(block, bytes, mime) {
  assertEqual(block.type, 'image')
  assert(block.source && typeof block.source === 'object', 'image block should include source')
  assertEqual(block.source.type, 'base64')
  assertEqual(block.source.media_type, mime)
  assertEqual(block.source.data, bytes.toString('base64'))
}

function assert(condition, message = 'assertion failed') {
  if (!condition) {
    throw new Error(message)
  }
}

function assertThrows(operation, expected, message) {
  try {
    operation()
  } catch (error) {
    assert(expected.test(String(error?.message ?? error)), `${message}: unexpected error ${error}`)
    return
  }
  throw new Error(`${message}: operation did not throw`)
}
