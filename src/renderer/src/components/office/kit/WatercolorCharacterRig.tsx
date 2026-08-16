import { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { SRGBColorSpace, type Sprite } from 'three'
import type { WatercolorCharacterRole, WatercolorCharacterState } from '../../../../../shared/watercolor-character'
import type { OfficeHairStyle, OfficeOutfitPalette } from '../../../../../shared/types'
import { watercolorCharacterAssetUrl } from '../watercolor-character-assets'

export interface WatercolorCharacterRigProps {
  role: WatercolorCharacterRole
  state: WatercolorCharacterState
  position?: [number, number, number]
  scale?: number
  compact?: boolean
  liveliness?: number
  outfitPalette?: OfficeOutfitPalette
  hairStyle?: OfficeHairStyle
}

export default function WatercolorCharacterRig(props: WatercolorCharacterRigProps): React.JSX.Element | null {
  const assetUrl = watercolorCharacterAssetUrl(props.role, props.state)
  if (!assetUrl) return null
  return <LoadedWatercolorCharacterRig {...props} assetUrl={assetUrl} />
}

function LoadedWatercolorCharacterRig({
  assetUrl,
  compact = false,
  liveliness = 1,
  position = [0, 0.94, 0.58],
  role,
  scale = 1,
  state,
  outfitPalette = 'role-default',
  hairStyle = 'role-default'
}: WatercolorCharacterRigProps & { assetUrl: string }): React.JSX.Element {
  const spriteRef = useRef<Sprite>(null)
  const texture = useTexture(assetUrl)
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const baseY = position[1]
  const dimensions: [number, number, number] = compact
    ? [0.72 * scale, 1.08 * scale, 1]
    : [0.88 * scale, 1.32 * scale, 1]

  useEffect(() => {
    texture.colorSpace = SRGBColorSpace
    texture.anisotropy = Math.max(texture.anisotropy, 4)
    texture.needsUpdate = true
  }, [texture])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReducedMotion(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useFrame(({ clock }) => {
    const sprite = spriteRef.current
    if (!sprite) return
    if (reducedMotion) {
      sprite.position.y = baseY
      sprite.material.opacity = 1
      return
    }
    const time = clock.getElapsedTime()
    const motion = stateMotion(state, time)
    const motionScale = Math.min(Math.max(liveliness, 0.2), 1.2)
    sprite.position.y = baseY + motion.y * motionScale
    sprite.rotation.z = motion.rotation * motionScale
    sprite.material.opacity = motion.opacity
  })

  return (
    <group
      name="office-watercolor-character"
      userData={{
        officeWatercolorCharacter: true,
        officeWatercolorRole: role,
        officeWatercolorState: state,
        outfitPalette,
        hairStyle
      }}
    >
      <sprite
        ref={spriteRef}
        name="watercolor-digital-worker"
        position={position}
        scale={dimensions}
        userData={{ watercolorRole: role, watercolorState: state, transparentAsset: true }}
      >
        <spriteMaterial map={texture} color={outfitTint(outfitPalette)} transparent alphaTest={0.045} depthWrite={false} toneMapped={false} />
      </sprite>
      {hairStyle !== 'role-default' && (
        <mesh position={[position[0], position[1] + (compact ? 0.42 : 0.51) * scale, position[2] + 0.012]} scale={hairScale(hairStyle, scale)}>
          <sphereGeometry args={[0.22, 20, 12]} />
          <meshBasicMaterial color="#283039" transparent opacity={0.78} depthWrite={false} />
        </mesh>
      )}
    </group>
  )
}

function outfitTint(palette: OfficeOutfitPalette): string {
  if (palette === 'graphite') return '#bcc3ca'
  if (palette === 'teal') return '#9fd0ca'
  if (palette === 'rose') return '#d8abb4'
  return '#ffffff'
}

function hairScale(style: OfficeHairStyle, scale: number): [number, number, number] {
  if (style === 'long') return [1.15 * scale, 1.45 * scale, 0.55]
  if (style === 'tied') return [0.95 * scale, 1.12 * scale, 0.55]
  return [1.05 * scale, 0.78 * scale, 0.55]
}

function stateMotion(
  state: WatercolorCharacterState,
  time: number
): { y: number; rotation: number; opacity: number } {
  if (state === 'thinking') return { y: Math.sin(time * 1.2) * 0.012, rotation: Math.sin(time * 0.7) * 0.008, opacity: 1 }
  if (state === 'tool-running') return { y: Math.sin(time * 2.4) * 0.018, rotation: Math.sin(time * 1.2) * 0.006, opacity: 1 }
  if (state === 'awaiting-approval') return { y: Math.sin(time * 1.4) * 0.009, rotation: 0, opacity: 0.9 + Math.sin(time * 2) * 0.08 }
  if (state === 'repairing') return { y: Math.sin(time * 1.8) * 0.014, rotation: Math.sin(time * 0.9) * 0.01, opacity: 1 }
  if (state === 'delivering') return { y: Math.sin(time * 1.1) * 0.02 + 0.012, rotation: 0, opacity: 1 }
  return { y: 0, rotation: 0, opacity: state === 'blocked' ? 0.82 : 1 }
}
