import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { MeshStandardMaterial } from 'three'

export type OfficeFacilityKey = 'hydration' | 'restroom' | 'dining'

export interface OfficeFacilitySpec {
  key: OfficeFacilityKey
  labelKey: string
  statusKey: string
  accent: string
  position: [number, number, number]
  hit: [number, number, number]
  cameraPosition: [number, number, number]
  cameraTarget: [number, number, number]
}

export const OFFICE_FACILITY_OVERVIEW_CAMERA = {
  position: [-1.6, 5.5, 14.6] as [number, number, number],
  target: [-1.6, 0.82, 4.2] as [number, number, number]
}

export const OFFICE_FACILITY_SPECS: OfficeFacilitySpec[] = [
  {
    key: 'hydration',
    labelKey: 'officeFacilityHydration',
    statusKey: 'officeFacilityReady',
    accent: '#8fe9ff',
    position: [4.86, 0, 1.82],
    hit: [4.86, 1.9, 1.82],
    cameraPosition: [3.1, 2.95, 5.72],
    cameraTarget: [4.78, 0.76, 1.72]
  },
  {
    key: 'restroom',
    labelKey: 'officeFacilityRestroom',
    statusKey: 'officeFacilityReady',
    accent: '#8fe9ff',
    position: [-8, 0, 4.65],
    hit: [-8, 2.02, 4.71],
    cameraPosition: [-6.45, 4.6, 9.15],
    cameraTarget: [-8, 0.45, 5.35]
  },
  {
    key: 'dining',
    labelKey: 'officeFacilityDining',
    statusKey: 'officeFacilityReady',
    accent: '#5f7f8c',
    position: [-5, 0, 6],
    hit: [-5, 2.02, 6.06],
    cameraPosition: [-2, 4.5, 10.8],
    cameraTarget: [-4.45, 0.55, 6.25]
  }
]

interface FacilityHotspotsProps {
  specs: OfficeFacilitySpec[]
  activeKey?: OfficeFacilityKey | null
  onSelect: (key: OfficeFacilityKey) => void
}

function FacilityHotspot({
  spec,
  active,
  onSelect
}: {
  spec: OfficeFacilitySpec
  active: boolean
  onSelect: (key: OfficeFacilityKey) => void
}): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const ringRef = useRef<MeshStandardMaterial>(null)

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = (active ? 0.24 : 0.08) + Math.sin(t * 2.4) * (active ? 0.05 : 0.02)
      pulseRef.current.opacity = (active ? 0.36 : 0.12) + Math.sin(t * 2.1) * 0.025
    }
    if (ringRef.current) {
      ringRef.current.emissiveIntensity = (active ? 0.32 : 0.1) + Math.sin(t * 3.2) * (active ? 0.06 : 0.025)
    }
  })

  const cursorOver = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    document.body.style.cursor = 'pointer'
  }
  const cursorOut = (): void => {
    document.body.style.cursor = 'default'
  }
  const clickSelect = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onSelect(spec.key)
  }

  return (
    <group position={spec.position} onClick={clickSelect} onDoubleClick={clickSelect} onPointerOver={cursorOver} onPointerOut={cursorOut}>
      <mesh position={[0, 0.024, 0]} receiveShadow>
        <boxGeometry args={[0.82, 0.012, 0.48]} />
        <meshStandardMaterial
          ref={pulseRef}
          color={spec.accent}
          emissive={spec.accent}
          emissiveIntensity={active ? 0.24 : 0.08}
          transparent
          opacity={active ? 0.36 : 0.12}
          toneMapped={false}
        />
      </mesh>
      {[-0.2, 0.2].map((x) => (
        <mesh key={`facility-active-slat-${x}`} position={[x, 0.042, 0.14]}>
          <boxGeometry args={[active ? 0.28 : 0.16, 0.012, 0.022]} />
          <meshStandardMaterial
            ref={x < 0 ? ringRef : undefined}
            color={active ? '#b7c4ce' : spec.accent}
            emissive={spec.accent}
            emissiveIntensity={active ? 0.32 : 0.1}
            transparent
            opacity={active ? 0.62 : 0.24}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh position={[0, spec.hit[1], spec.hit[2] - spec.position[2]]} visible>
        <boxGeometry args={[1.4, 0.36, 0.52]} />
        <meshBasicMaterial transparent opacity={0.01} depthWrite={false} />
      </mesh>
    </group>
  )
}

export default function FacilityHotspots({ specs, activeKey, onSelect }: FacilityHotspotsProps): React.JSX.Element {
  return (
    <>
      {specs.map((spec) => (
        <FacilityHotspot key={spec.key} spec={spec} active={spec.key === activeKey} onSelect={onSelect} />
      ))}
    </>
  )
}
