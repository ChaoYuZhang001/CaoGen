#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

const repoRoot = process.cwd()
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'caogen-watercolor-asset-gate-'))
const filename = 'role-developer-state-tool-running-v01.png'
const fixturePath = path.join(fixtureDir, filename)
const approvalFilename = 'role-developer-state-awaiting-approval-v01.png'
const approvalFixturePath = path.join(fixtureDir, approvalFilename)
const registrationPath = path.join(fixtureDir, 'watercolor-character-assets.ts')
const reportPath = path.join(repoRoot, 'test-results', 'watercolor-runtime-assets', 'latest.json')
const previousReport = existsSync(reportPath) ? readFileSync(reportPath) : undefined

try {
  const validPng = createFixturePng()
  writeFileSync(fixturePath, validPng)
  writeFileSync(
    registrationPath,
    `export const VERIFIED_WATERCOLOR_CHARACTER_FILES: readonly string[] = ['${filename}']\n`
  )

  const validRun = runGate()
  assert.equal(validRun.status, 0, validRun.stderr || validRun.stdout)
  const validReport = readReport()
  assert.equal(validReport.status, 'incomplete')
  assert.equal(validReport.counts.present, 1)
  assert.equal(validReport.counts.passed, 1)
  assert.equal(validReport.counts.invalid, 0)
  assert.deepEqual(validReport.files[0].violations, [])

  unlinkSync(fixturePath)
  writeFileSync(approvalFixturePath, createFixturePng({ filledRedApprovalMark: true }))
  writeFileSync(
    registrationPath,
    `export const VERIFIED_WATERCOLOR_CHARACTER_FILES: readonly string[] = ['${approvalFilename}']\n`
  )
  const rejectedApprovalRun = runGate()
  assert.equal(rejectedApprovalRun.status, 1, rejectedApprovalRun.stderr || rejectedApprovalRun.stdout)
  const rejectedApprovalReport = readReport()
  assert.equal(rejectedApprovalReport.counts.invalid, 1)
  assert.match(rejectedApprovalReport.files[0].violations.join('\n'), /filled red circular mark on light paper/u)

  unlinkSync(approvalFixturePath)
  writeFileSync(fixturePath, corruptIdatCrc(validPng))
  writeFileSync(
    registrationPath,
    `export const VERIFIED_WATERCOLOR_CHARACTER_FILES: readonly string[] = ['${filename}']\n`
  )
  const corruptRun = runGate()
  assert.equal(corruptRun.status, 1, corruptRun.stderr || corruptRun.stdout)
  const corruptReport = readReport()
  assert.equal(corruptReport.status, 'fail')
  assert.equal(corruptReport.counts.invalid, 1)
  assert.match(corruptReport.files[0].violations[0], /PNG CRC mismatch in IDAT/u)

  console.log('watercolor runtime asset gate smoke: pass (valid RGBA + rejected red disc + corrupt CRC)')
} finally {
  const resolvedTemp = path.resolve(os.tmpdir())
  const resolvedFixture = path.resolve(fixtureDir)
  if (!resolvedFixture.startsWith(`${resolvedTemp}${path.sep}`)) {
    throw new Error(`refusing to remove fixture outside temp directory: ${resolvedFixture}`)
  }
  rmSync(resolvedFixture, { recursive: true, force: true })
  if (previousReport) writeFileSync(reportPath, previousReport)
  else rmSync(reportPath, { force: true })
}

function runGate() {
  return spawnSync(
    process.execPath,
    [
      'scripts/watercolor-runtime-asset-gate.mjs',
      `--source=${fixtureDir}`,
      `--registration=${registrationPath}`
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
}

function readReport() {
  return JSON.parse(readFileSync(reportPath, 'utf8'))
}

function createFixturePng({ filledRedApprovalMark = false } = {}) {
  const width = 1024
  const height = 1536
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 150; y < 1386; y += 1) {
    const rowOffset = y * (stride + 1) + 1
    for (let x = 320; x < 704; x += 1) {
      const offset = rowOffset + x * 4
      const edge = x === 320 || x === 703 || y === 150 || y === 1385
      raw[offset] = 46
      raw[offset + 1] = 118
      raw[offset + 2] = 133
      raw[offset + 3] = edge ? 128 : 255
    }
  }
  if (filledRedApprovalMark) {
    for (let y = 400; y < 500; y += 1) {
      for (let x = 120; x < 250; x += 1) setPixel(raw, stride, x, y, [238, 232, 220, 255])
    }
    for (let y = 428; y <= 472; y += 1) {
      for (let x = 163; x <= 207; x += 1) {
        if ((x - 185) ** 2 + (y - 450) ** 2 <= 18 ** 2) {
          setPixel(raw, stride, x, y, [184, 54, 42, 255])
        }
      }
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function setPixel(raw, stride, x, y, [red, green, blue, alpha]) {
  const offset = y * (stride + 1) + 1 + x * 4
  raw[offset] = red
  raw[offset + 1] = green
  raw[offset + 2] = blue
  raw[offset + 3] = alpha
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8)
  return chunk
}

function corruptIdatCrc(png) {
  const corrupted = Buffer.from(png)
  const typeOffset = corrupted.indexOf(Buffer.from('IDAT', 'ascii'))
  assert.ok(typeOffset > 4, 'fixture must contain an IDAT chunk')
  const length = corrupted.readUInt32BE(typeOffset - 4)
  const crcOffset = typeOffset + 4 + length
  corrupted[crcOffset + 3] ^= 0xff
  return corrupted
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
