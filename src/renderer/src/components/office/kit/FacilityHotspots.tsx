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
  position: [-2.4, 4.9, 12] as [number, number, number],
  target: [-0.15, 0.82, 2] as [number, number, number]
}

export const OFFICE_FACILITY_SPECS: OfficeFacilitySpec[] = [
  {
    key: 'hydration',
    labelKey: 'officeFacilityHydration',
    statusKey: 'officeFacilityReady',
    accent: '#8fe9ff',
    position: [4.86, 0, 1.82],
    hit: [4.86, 0.74, 1.82],
    cameraPosition: [3.1, 2.95, 5.72],
    cameraTarget: [4.78, 0.76, 1.72]
  },
  {
    key: 'restroom',
    labelKey: 'officeFacilityRestroom',
    statusKey: 'officeFacilityReady',
    accent: '#8fe9ff',
    position: [-5.62, 0, 2.64],
    hit: [-5.62, 0.52, 2.72],
    cameraPosition: [-3.72, 2.85, 5.98],
    cameraTarget: [-5.44, 0.64, 2.68]
  },
  {
    key: 'dining',
    labelKey: 'officeFacilityDining',
    statusKey: 'officeFacilityReady',
    accent: '#5f7f8c',
    position: [-4.74, 0, 2.78],
    hit: [-4.74, 0.52, 2.86],
    cameraPosition: [-3.2, 2.82, 6.04],
    cameraTarget: [-4.7, 0.62, 2.8]
  }
]

interface FacilityHotspotsProps {
  specs: OfficeFacilitySpec[]
  activeKey?: OfficeFacilityKey | null
  onSelect: (key: OfficeFacilityKey) => void
}

function FacilityGlyph({ kind, accent }: { kind: OfficeFacilityKey; accent: string }): React.JSX.Element {
  if (kind === 'hydration') {
    return (
      <group position={[0, 0.18, 0]}>
        {[-0.04, 0.02, 0.08].map((y, i) => (
          <mesh key={`hydration-glyph-slat-${i}`} position={[0, y, 0]}>
            <boxGeometry args={[0.16 - i * 0.035, 0.022, 0.018]} />
            <meshStandardMaterial color="#9fb2c2" emissive={accent} emissiveIntensity={0.3 + i * 0.06} transparent opacity={0.78} toneMapped={false} />
          </mesh>
        ))}
      </group>
    )
  }

  if (kind === 'restroom') {
    return (
      <group position={[0, 0.2, 0]}>
        {[-0.075, 0.075].map((x) => (
          <group key={x} position={[x, 0, 0]}>
            <mesh position={[0, 0.09, 0]}>
              <boxGeometry args={[0.07, 0.07, 0.018]} />
              <meshStandardMaterial color="#9fb2c2" emissive={accent} emissiveIntensity={0.38} toneMapped={false} />
            </mesh>
            <mesh position={[0, -0.035, 0]}>
              <boxGeometry args={[0.07, 0.16, 0.018]} />
              <meshStandardMaterial color="#9fb2c2" emissive={accent} emissiveIntensity={0.28} toneMapped={false} />
            </mesh>
          </group>
        ))}
      </group>
    )
  }

  return (
    <group position={[0, 0.2, 0]}>
      <mesh position={[-0.06, 0, 0]}>
        <boxGeometry args={[0.026, 0.28, 0.018]} />
        <meshStandardMaterial color="#9fb2c2" emissive={accent} emissiveIntensity={0.32} toneMapped={false} />
      </mesh>
      {[-0.1, -0.06, -0.02].map((x) => (
        <mesh key={x} position={[x, 0.13, 0]}>
          <boxGeometry args={[0.014, 0.088, 0.016]} />
          <meshStandardMaterial color="#9fb2c2" emissive={accent} emissiveIntensity={0.3} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0.08, 0.02, 0]} rotation={[0, 0, -0.1]}>
        <boxGeometry args={[0.03, 0.31, 0.018]} />
        <meshStandardMaterial color="#9fb2c2" emissive={accent} emissiveIntensity={0.32} toneMapped={false} />
      </mesh>
      <mesh position={[0.1, 0.14, 0]} rotation={[0, 0, -0.1]}>
        <boxGeometry args={[0.07, 0.09, 0.016]} />
        <meshStandardMaterial color="#9fb2c2" emissive={accent} emissiveIntensity={0.3} toneMapped={false} />
      </mesh>
    </group>
  )
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
      pulseRef.current.emissiveIntensity = (active ? 0.52 : 0.28) + Math.sin(t * 2.4) * (active ? 0.18 : 0.08)
      pulseRef.current.opacity = (active ? 0.6 : 0.34) + Math.sin(t * 2.1) * 0.06
    }
    if (ringRef.current) {
      ringRef.current.emissiveIntensity = (active ? 0.74 : 0.36) + Math.sin(t * 3.2) * (active ? 0.2 : 0.08)
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
      <mesh position={[0, 0.046, 0]} receiveShadow>
        <boxGeometry args={[0.68, 0.02, 0.34]} />
        <meshStandardMaterial
          ref={pulseRef}
          color={spec.accent}
          emissive={spec.accent}
          emissiveIntensity={0.34}
          transparent
          opacity={0.38}
          toneMapped={false}
        />
      </mesh>
      {[-0.2, 0.2].map((x) => (
        <mesh key={`facility-active-slat-${x}`} position={[x, 0.066, 0]}>
          <boxGeometry args={[active ? 0.24 : 0.16, 0.014, 0.024]} />
          <meshStandardMaterial
            ref={x < 0 ? ringRef : undefined}
            color={active ? '#b7c4ce' : spec.accent}
            emissive={spec.accent}
            emissiveIntensity={active ? 0.78 : 0.36}
            transparent
            opacity={active ? 0.7 : 0.48}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh position={[0, 0.36, 0]} castShadow>
        <boxGeometry args={[0.32, 0.035, 0.09]} />
        <meshStandardMaterial color={spec.accent} emissive={spec.accent} emissiveIntensity={0.52} toneMapped={false} />
      </mesh>
      <FacilityGlyph kind={spec.key} accent={spec.accent} />
      <mesh position={[0, 0.52, 0]} visible>
        <boxGeometry args={[0.86, 1.04, 0.86]} />
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
