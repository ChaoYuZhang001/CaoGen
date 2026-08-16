import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

export function decodeRgbaPng(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('invalid PNG signature')
  }
  const { header, imageData } = readChunks(bytes)
  validateHeader(header)
  return { ...header, pixels: decodeScanlines(header, imageData) }
}

function readChunks(bytes) {
  let offset = PNG_SIGNATURE.length
  let header
  let sawEnd = false
  const imageData = []
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
    if (crc32(Buffer.concat([typeBytes, data])) !== bytes.readUInt32BE(dataEnd)) {
      throw new Error(`PNG CRC mismatch in ${type}`)
    }
    if (type === 'IHDR') header = parseHeader(data)
    else if (type === 'IDAT') imageData.push(data)
    else if (type === 'IEND') { sawEnd = true; break }
    offset = crcEnd
  }
  if (!header || imageData.length === 0 || !sawEnd) throw new Error('PNG is missing IHDR, IDAT, or IEND')
  return { header, imageData }
}

function validateHeader(header) {
  const supported = header.bitDepth === 8 && header.colorType === 6 && header.compression === 0 &&
    header.filter === 0 && header.interlace === 0
  if (!supported) {
    throw new Error(
      `PNG must be non-interlaced 8-bit RGBA; observed bitDepth=${header.bitDepth}, ` +
      `colorType=${header.colorType}, interlace=${header.interlace}`
    )
  }
}

function decodeScanlines(header, imageData) {
  const stride = header.width * 4
  const expectedLength = (stride + 1) * header.height
  const inflated = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedLength })
  if (inflated.length !== expectedLength) throw new Error('unexpected PNG scanline length')
  const pixels = Buffer.alloc(stride * header.height)
  for (let y = 0; y < header.height; y += 1) {
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
  return pixels
}

function parseHeader(data) {
  if (data.length !== 13) throw new Error('invalid IHDR length')
  const width = data.readUInt32BE(0)
  const height = data.readUInt32BE(4)
  if (width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw new Error(`invalid PNG dimensions ${width}x${height}`)
  }
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
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left
  return upDistance <= diagonalDistance ? up : upperLeft
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
