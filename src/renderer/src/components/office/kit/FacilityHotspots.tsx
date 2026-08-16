import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { MeshStandardMaterial } from 'three'
import { CONTROL_ROOM_LAYOUT } from './controlRoomLayout'

export type OfficeFacilityKey = 'assistant' | 'project' | 'video'

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
  position: CONTROL_ROOM_LAYOUT.zoneOverview.position as [number, number, number],
  target: CONTROL_ROOM_LAYOUT.zoneOverview.target as [number, number, number]
}

export const OFFICE_FACILITY_SPECS: OfficeFacilitySpec[] = [
  {
    key: 'assistant',
    labelKey: 'officeZoneAssistant',
    statusKey: 'officeZoneLive',
    accent: '#8fb8c6',
    position: CONTROL_ROOM_LAYOUT.assistant.station,
    hit: CONTROL_ROOM_LAYOUT.assistant.hit,
    cameraPosition: CONTROL_ROOM_LAYOUT.assistant.cameraPosition,
    cameraTarget: CONTROL_ROOM_LAYOUT.assistant.cameraTarget
  },
  {
    key: 'project',
    labelKey: 'officeZoneProject',
    statusKey: 'officeZoneLive',
    accent: '#8ba88f',
    position: CONTROL_ROOM_LAYOUT.project.station,
    hit: CONTROL_ROOM_LAYOUT.project.hit,
    cameraPosition: CONTROL_ROOM_LAYOUT.project.cameraPosition,
    cameraTarget: CONTROL_ROOM_LAYOUT.project.cameraTarget
  },
  {
    key: 'video',
    labelKey: 'officeZoneVideo',
    statusKey: 'officeZoneLive',
    accent: '#c39b73',
    position: CONTROL_ROOM_LAYOUT.video.station,
    hit: CONTROL_ROOM_LAYOUT.video.hit,
    cameraPosition: CONTROL_ROOM_LAYOUT.video.cameraPosition,
    cameraTarget: CONTROL_ROOM_LAYOUT.video.cameraTarget
  }
]

interface FacilityHotspotsProps {
  specs: OfficeFacilitySpec[]
  activeKey?: OfficeFacilityKey | null
  interactive?: boolean
  onSelect: (key: OfficeFacilityKey) => void
}

function FacilityHotspot({
  spec,
  active,
  interactive,
  onSelect
}: {
  spec: OfficeFacilitySpec
  active: boolean
  interactive: boolean
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
  const interactionProps = interactive
    ? { onClick: clickSelect, onDoubleClick: clickSelect, onPointerOver: cursorOver, onPointerOut: cursorOut }
    : {}

  return (
    <group position={spec.position} {...interactionProps}>
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
      <mesh
        position={[
          spec.hit[0] - spec.position[0],
          spec.hit[1] - spec.position[1],
          spec.hit[2] - spec.position[2]
        ]}
        visible
      >
        <boxGeometry args={[1.4, 0.36, 0.52]} />
        <meshBasicMaterial transparent opacity={0.01} depthWrite={false} />
      </mesh>
    </group>
  )
}

export default function FacilityHotspots({ specs, activeKey, interactive = true, onSelect }: FacilityHotspotsProps): React.JSX.Element {
  return (
    <>
      {specs.map((spec) => (
        <FacilityHotspot
          key={spec.key}
          spec={spec}
          active={spec.key === activeKey}
          interactive={interactive}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}
