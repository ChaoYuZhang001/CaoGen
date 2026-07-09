import { useEffect, useMemo, useState } from 'react'
import { RoundedBox } from '@react-three/drei'
import { SRGBColorSpace, TextureLoader } from 'three'
import type { Texture } from 'three'
import type { ProviderLogoSpec } from './ProviderLogos'

export interface ProviderLogoBadgeProps {
  logo: ProviderLogoSpec
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
  width?: number
  height?: number
  depth?: number
  maxChars?: number
  compact?: boolean
}

const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11110', '00000', '00000', '00000']
}

function normalizeMark(value: string, maxChars: number): string {
  const clean = value
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, '')
    .slice(0, maxChars)
  return clean || 'AG'
}

function useLogoTexture(url?: string): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null)

  useEffect(() => {
    let alive = true
    let loadedTexture: Texture | null = null
    setTexture(null)
    if (!url) return undefined

    const loader = new TextureLoader()
    loader.load(
      url,
      (next) => {
        next.colorSpace = SRGBColorSpace
        next.needsUpdate = true
        loadedTexture = next
        if (alive) setTexture(next)
        else next.dispose()
      },
      undefined,
      () => {
        if (alive) setTexture(null)
      }
    )

    return () => {
      alive = false
      loadedTexture?.dispose()
    }
  }, [url])

  return texture
}

function ProviderLogoTexture({
  logo,
  width,
  height,
  depth,
  compact
}: {
  logo: ProviderLogoSpec
  width: number
  height: number
  depth: number
  compact: boolean
}): React.JSX.Element | null {
  const useWordmark = !compact && Boolean(logo.wordmarkAssetUrl)
  const textureUrl = useWordmark ? logo.wordmarkAssetUrl : logo.assetUrl
  const texture = useLogoTexture(textureUrl)
  if (!textureUrl || !texture) return null

  const markSize = compact ? height * 0.82 : height * 0.72
  const planeWidth = useWordmark ? width * 0.72 : markSize
  const planeHeight = useWordmark ? height * 0.56 : markSize
  const x = useWordmark ? 0.02 : compact ? 0 : -width * 0.31
  return (
    <group position={[x, -height * 0.02, depth / 2 + 0.011]}>
      <mesh position={[0, 0, -0.002]}>
        {useWordmark ? <planeGeometry args={[planeWidth * 1.06, planeHeight * 1.45]} /> : <circleGeometry args={[markSize * 0.58, 32]} />}
        <meshBasicMaterial color="#f8fbff" transparent opacity={compact ? 0.82 : 0.9} toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0, 0.002]}>
        <planeGeometry args={[planeWidth, planeHeight]} />
        <meshBasicMaterial map={texture} transparent toneMapped={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

export default function ProviderLogoBadge({
  logo,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  width = 0.34,
  height = 0.16,
  depth = 0.018,
  maxChars,
  compact = false
}: ProviderLogoBadgeProps): React.JSX.Element {
  const hasLogoAsset = Boolean(logo.assetUrl)
  const hasWordmarkAsset = Boolean(logo.wordmarkAssetUrl && !compact)
  const resolvedMaxChars = maxChars ?? (compact ? 4 : 10)
  const mark = useMemo(
    () => normalizeMark(compact ? logo.shortMark : logo.wordmark, resolvedMaxChars),
    [compact, logo.shortMark, logo.wordmark, resolvedMaxChars]
  )
  const cells = useMemo(() => {
    const chars = mark.split('')
    const totalCols = chars.length * 6 - 1
    const textWidth = hasLogoAsset && !compact ? width * 0.55 : width
    const textOffset = hasLogoAsset && !compact ? width * 0.15 : 0
    const cell = Math.min(textWidth / (totalCols + 1.2), height / 8.4)
    const startX = textOffset - ((totalCols - 1) * cell) / 2
    const startY = 3 * cell
    const out: Array<{ key: string; x: number; y: number; color: string }> = []
    chars.forEach((ch, charIndex) => {
      const glyph = GLYPHS[ch] ?? GLYPHS['-']
      glyph.forEach((row, rowIndex) => {
        row.split('').forEach((on, colIndex) => {
          if (on !== '1') return
          out.push({
            key: `${ch}-${charIndex}-${rowIndex}-${colIndex}`,
            x: startX + (charIndex * 6 + colIndex) * cell,
            y: startY - rowIndex * cell,
            color: rowIndex <= 1 ? logo.textColor : logo.brandColor
          })
        })
      })
    })
    return { cell, items: out }
  }, [compact, hasLogoAsset, height, logo.brandColor, logo.textColor, mark, width])

  return (
    <group position={position} rotation={rotation} scale={scale}>
      <RoundedBox args={[width, height, depth]} radius={Math.min(width, height) * 0.13} smoothness={3} castShadow receiveShadow>
        <meshStandardMaterial color={logo.plateColor} metalness={0.34} roughness={0.46} />
      </RoundedBox>
      <mesh position={[0, height / 2 - cells.cell * 0.72, depth / 2 + 0.003]}>
        <boxGeometry args={[width * 0.78, cells.cell * 0.36, 0.006]} />
        <meshStandardMaterial color={logo.brandColor} emissive={logo.brandColor} emissiveIntensity={0.62} toneMapped={false} />
      </mesh>
      <ProviderLogoTexture logo={logo} width={width} height={height} depth={depth} compact={compact} />
      {cells.items.map((cell) => (
        <mesh key={cell.key} position={[cell.x, cell.y - cells.cell * 0.22, depth / 2 + 0.006]}>
          <boxGeometry args={[cells.cell * 0.72, cells.cell * 0.72, 0.006]} />
          <meshStandardMaterial
            color={cell.color}
            emissive={cell.color}
            emissiveIntensity={0.72}
            transparent={hasWordmarkAsset}
            opacity={hasWordmarkAsset ? 0.2 : 1}
            roughness={0.22}
            metalness={0.08}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}
