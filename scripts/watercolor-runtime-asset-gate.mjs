#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const sourceArg = process.argv.find((value) => value.startsWith('--source='))
const registrationArg = process.argv.find((value) => value.startsWith('--registration='))
const sourceDir = path.resolve(repoRoot, sourceArg?.slice('--source='.length) || 'src/renderer/src/assets/watercolor-characters')
const reportPath = path.join(repoRoot, 'test-results', 'watercolor-runtime-assets', 'latest.json')
const registrationPath = path.resolve(
  repoRoot,
  registrationArg?.slice('--registration='.length) || 'src/renderer/src/components/office/watercolor-character-assets.ts'
)

const roles = ['researcher', 'planner', 'writer', 'designer', 'developer', 'review-test', 'operations']
const states = ['idle', 'thinking', 'tool-running', 'awaiting-approval', 'blocked', 'repairing', 'delivering']
const expected = roles.flatMap((role) => states.map((state) => `role-${role}-state-${state}-v01.png`))
const expectedSet = new Set(expected)
const registered = readRegisteredFiles(registrationPath)
const actual = existsSync(sourceDir)
  ? readdirSync(sourceDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png')).map((entry) => entry.name).sort()
  : []

const files = []
for (const filename of actual) {
  const filePath = path.join(sourceDir, filename)
  try {
    const bytes = readFileSync(filePath)
    const image = decodeRgbaPng(bytes)
    const metrics = alphaMetrics(image)
    const violations = validateRuntimeAsset(filename, bytes.length, image, metrics)
    files.push({
      filename,
      ok: violations.length === 0,
      width: image.width,
      height: image.height,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      metrics,
      violations
    })
  } catch (error) {
    files.push({ filename, ok: false, violations: [error instanceof Error ? error.message : String(error)] })
  }
}

const passed = files.filter((file) => file.ok).map((file) => file.filename)
const invalid = files.filter((file) => !file.ok).map((file) => file.filename)
const missing = expected.filter((filename) => !actual.includes(filename))
const unexpected = actual.filter((filename) => !expectedSet.has(filename))
const registrationMissing = passed.filter((filename) => !registered.includes(filename))
const registrationInvalid = registered.filter((filename) => !passed.includes(filename))
const complete = missing.length === 0 && invalid.length === 0 && unexpected.length === 0 &&
  registrationMissing.length === 0 && registrationInvalid.length === 0 && registered.length === expected.length
const structurallySafe = invalid.length === 0 && unexpected.length === 0 && registrationInvalid.length === 0
const status = complete ? 'pass' : structurallySafe ? 'incomplete' : 'fail'
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  required,
  status,
  sourceDir,
  contract: {
    roles,
    states,
    expectedCount: expected.length,
    width: 1024,
    height: 1536,
    format: 'PNG RGBA 8-bit, non-interlaced'
  },
  counts: {
    expected: expected.length,
    present: actual.length,
    passed: passed.length,
    invalid: invalid.length,
    missing: missing.length,
    unexpected: unexpected.length,
    registered: registered.length
  },
  missing,
  unexpected,
  registrationMissing,
  registrationInvalid,
  verifiedFiles: passed,
  files
}

mkdirSync(path.dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`watercolor runtime asset gate: ${status} (${passed.length}/${expected.length} verified, ${registered.length} registered)`)
console.log(`watercolor runtime asset report: ${reportPath}`)
if (!structurallySafe || (required && !complete)) process.exitCode = 1

function readRegisteredFiles(filePath) {
  const source = readFileSync(filePath, 'utf8')
  const match = source.match(/VERIFIED_WATERCOLOR_CHARACTER_FILES:\s*readonly string\[\]\s*=\s*\[([\s\S]*?)\]/u)
  if (!match) throw new Error('cannot read VERIFIED_WATERCOLOR_CHARACTER_FILES')
  return [...match[1].matchAll(/['"]([^'"]+\.png)['"]/gu)].map((item) => item[1]).sort()
}

function validateRuntimeAsset(filename, byteLength, image, metrics) {
  const violations = []
  if (!expectedSet.has(filename)) violations.push('filename is outside the 7x7 runtime contract')
  if (image.width !== 1024 || image.height !== 1536) violations.push(`dimensions must be 1024x1536, got ${image.width}x${image.height}`)
  if (byteLength > 12 * 1024 * 1024) violations.push(`file exceeds 12 MiB runtime limit: ${byteLength} bytes`)
  if (metrics.cornerTransparentRatio < 0.98) violations.push(`transparent corner ratio below 0.98: ${metrics.cornerTransparentRatio}`)
  if (metrics.borderTransparentRatio < 0.96) violations.push(`transparent border ratio below 0.96: ${metrics.borderTransparentRatio}`)
  if (metrics.visibleRatio < 0.08 || metrics.visibleRatio > 0.72) violations.push(`visible subject ratio outside 0.08..0.72: ${metrics.visibleRatio}`)
  if (metrics.transparentRatio < 0.25) violations.push(`transparent pixel ratio below 0.25: ${metrics.transparentRatio}`)
  if (metrics.opaqueRatio < 0.01) violations.push(`opaque subject core ratio below 0.01: ${metrics.opaqueRatio}`)
  if (metrics.partialAlphaRatio < 0.0005) violations.push(`partial-alpha edge ratio below 0.0005: ${metrics.partialAlphaRatio}`)
  if (metrics.minimumMarginPx < 12) violations.push(`subject safety margin below 12px: ${metrics.minimumMarginPx}`)
  if (filename.includes('-state-awaiting-approval-')) {
    const rejectedMark = findFilledRedApprovalMark(image)
    if (rejectedMark) {
      violations.push(
        `awaiting-approval asset contains a filled red circular mark on light paper at ` +
        `${rejectedMark.x},${rejectedMark.y} ${rejectedMark.width}x${rejectedMark.height}`
      )
    }
  }
  return violations
}

function findFilledRedApprovalMark({ width, height, pixels }) {
  const redMask = new Uint8Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    if (isCinnabarPixel(pixels, index * 4)) redMask[index] = 1
  }

  for (let start = 0; start < redMask.length; start += 1) {
    if (redMask[start] === 0) continue
    redMask[start] = 0
    const stack = [start]
    let count = 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    while (stack.length > 0) {
      const index = stack.pop()
      const x = index % width
      const y = Math.floor(index / width)
      count += 1
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(height - 1, y + 1); neighborY += 1) {
        for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(width - 1, x + 1); neighborX += 1) {
          const neighbor = neighborY * width + neighborX
          if (redMask[neighbor] === 0) continue
          redMask[neighbor] = 0
          stack.push(neighbor)
        }
      }
    }

    const componentWidth = maxX - minX + 1
    const componentHeight = maxY - minY + 1
    const aspectRatio = componentWidth / componentHeight
    if (
      count < 100 || componentWidth < 8 || componentWidth > 80 ||
      componentHeight < 8 || componentHeight > 80 || aspectRatio < 0.6 || aspectRatio > 1.6
    ) continue

    const centerInsetX = Math.floor(componentWidth / 4)
    const centerInsetY = Math.floor(componentHeight / 4)
    let centerRed = 0
    let centerTotal = 0
    for (let y = minY + centerInsetY; y <= maxY - centerInsetY; y += 1) {
      for (let x = minX + centerInsetX; x <= maxX - centerInsetX; x += 1) {
        centerTotal += 1
        if (isCinnabarPixel(pixels, (y * width + x) * 4)) centerRed += 1
      }
    }

    const padding = Math.max(5, Math.floor(Math.max(componentWidth, componentHeight) / 2))
    let paperPixels = 0
    let haloPixels = 0
    for (let y = Math.max(0, minY - padding); y <= Math.min(height - 1, maxY + padding); y += 1) {
      for (let x = Math.max(0, minX - padding); x <= Math.min(width - 1, maxX + padding); x += 1) {
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue
        const offset = (y * width + x) * 4
        if (pixels[offset + 3] <= 32) continue
        haloPixels += 1
        const red = pixels[offset]
        const green = pixels[offset + 1]
        const blue = pixels[offset + 2]
        if (Math.min(red, green, blue) >= 155 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 55) {
          paperPixels += 1
        }
      }
    }

    const centerDensity = centerTotal > 0 ? centerRed / centerTotal : 0
    const paperHaloRatio = haloPixels > 0 ? paperPixels / haloPixels : 0
    if (centerDensity >= 0.85 && paperHaloRatio >= 0.85) {
      return { x: minX, y: minY, width: componentWidth, height: componentHeight }
    }
  }
  return null
}

function isCinnabarPixel(pixels, offset) {
  const red = pixels[offset]
  const green = pixels[offset + 1]
  const blue = pixels[offset + 2]
  const alpha = pixels[offset + 3]
  return alpha > 96 && red >= 125 && red - green >= 30 && red - blue >= 25
}

function decodeRgbaPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) throw new Error('invalid PNG signature')
  let offset = 8
  let ihdr
  const idat = []
  let sawEnd = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const typeStart = offset + 4
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const crcEnd = dataEnd + 4
    if (crcEnd > bytes.length) throw new Error('truncated PNG chunk')
    const typeBytes = bytes.subarray(typeStart, dataStart)
    const type = typeBytes.toString('ascii')
    const data = bytes.subarray(dataStart, dataEnd)
    const expectedCrc = bytes.readUInt32BE(dataEnd)
    const actualCrc = crc32(Buffer.concat([typeBytes, data]))
    if (actualCrc !== expectedCrc) throw new Error(`PNG CRC mismatch in ${type}`)
    if (type === 'IHDR') ihdr = parseHeader(data)
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') { sawEnd = true; break }
    offset = crcEnd
  }
  if (!ihdr || idat.length === 0 || !sawEnd) throw new Error('PNG is missing IHDR, IDAT, or IEND')
  if (ihdr.bitDepth !== 8 || ihdr.colorType !== 6 || ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace !== 0) {
    throw new Error(`PNG must be non-interlaced 8-bit RGBA; observed bitDepth=${ihdr.bitDepth}, colorType=${ihdr.colorType}, interlace=${ihdr.interlace}`)
  }
  const stride = ihdr.width * 4
  const inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * ihdr.height })
  if (inflated.length !== (stride + 1) * ihdr.height) throw new Error('unexpected PNG scanline length')
  const pixels = Buffer.alloc(stride * ihdr.height)
  for (let y = 0; y < ihdr.height; y += 1) {
    const sourceOffset = y * (stride + 1)
    const filter = inflated[sourceOffset]
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + 1 + x]
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upperLeft = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0
      pixels[y * stride + x] = unfilter(filter, raw, left, up, upperLeft)
    }
  }
  return { ...ihdr, pixels }
}

function parseHeader(data) {
  if (data.length !== 13) throw new Error('invalid IHDR length')
  const width = data.readUInt32BE(0)
  const height = data.readUInt32BE(4)
  if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error(`invalid PNG dimensions ${width}x${height}`)
  return {
    width,
    height,
    bitDepth: data[8],
    colorType: data[9],
    compression: data[10],
    filter: data[11],
    interlace: data[12]
  }
}

function unfilter(filter, raw, left, up, upperLeft) {
  if (filter === 0) return raw
  if (filter === 1) return (raw + left) & 0xff
  if (filter === 2) return (raw + up) & 0xff
  if (filter === 3) return (raw + Math.floor((left + up) / 2)) & 0xff
  if (filter === 4) return (raw + paeth(left, up, upperLeft)) & 0xff
  throw new Error(`unsupported PNG filter ${filter}`)
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonalDistance = Math.abs(estimate - upperLeft)
  return leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upperLeft
}

function alphaMetrics({ width, height, pixels }) {
  const total = width * height
  let transparent = 0
  let partial = 0
  let opaque = 0
  let visible = 0
  let borderTransparent = 0
  let borderTotal = 0
  let cornerTransparent = 0
  let cornerTotal = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  const cornerSize = 32
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3]
      if (alpha <= 8) transparent += 1
      else if (alpha >= 245) opaque += 1
      else partial += 1
      if (alpha > 16) {
        visible += 1
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
      const inBorder = x < 2 || y < 2 || x >= width - 2 || y >= height - 2
      if (inBorder) {
        borderTotal += 1
        if (alpha <= 8) borderTransparent += 1
      }
      const inCorner = (x < cornerSize || x >= width - cornerSize) && (y < cornerSize || y >= height - cornerSize)
      if (inCorner) {
        cornerTotal += 1
        if (alpha <= 8) cornerTransparent += 1
      }
    }
  }
  const minimumMarginPx = visible === 0 ? 0 : Math.min(minX, minY, width - 1 - maxX, height - 1 - maxY)
  return {
    transparentRatio: ratio(transparent, total),
    partialAlphaRatio: ratio(partial, total),
    opaqueRatio: ratio(opaque, total),
    visibleRatio: ratio(visible, total),
    borderTransparentRatio: ratio(borderTransparent, borderTotal),
    cornerTransparentRatio: ratio(cornerTransparent, cornerTotal),
    minimumMarginPx
  }
}

function ratio(numerator, denominator) {
  return Number((numerator / denominator).toFixed(6))
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
