import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { Group } from 'three'
import AvatarRig from './AvatarRig'
import type { AvatarRefs } from './AvatarRig'
import { applyIdle, applyTalking, applyWalking } from './AvatarAnimations'
import { vendorSkin } from './VendorSkins'
import ProviderLogoBadge from './ProviderLogoBadge'
import { providerLogoFor } from './ProviderLogos'

export type AgentWalkReason = 'tea' | 'approval'

export interface AgentWalkerSpec {
  id: string
  sessionId: string
  home: [number, number, number]
  homeLookAt: [number, number, number]
  target: [number, number, number]
  targetLookAt: [number, number, number]
  reason: AgentWalkReason
  providerName?: string
  providerBaseUrl?: string
  modelName?: string
  phase: number
}

interface AgentWalkersProps {
  specs: AgentWalkerSpec[]
  activeSessionId?: string | null
  onAwayChange?: (sessionId: string, away: boolean) => void
  onSelect?: (sessionId: string) => void
  onOpen?: (sessionId: string) => void
}

type WalkStage = 'toTarget' | 'target' | 'toHome' | 'home'

const SPEED = 1.05
const MIN_TRAVEL_SECONDS = 2.8
const MAX_TRAVEL_SECONDS = 7.2
const DWELL_SECONDS: Record<AgentWalkReason, number> = {
  tea: 6.5,
  approval: 8.5
}
const REST_SECONDS: Record<AgentWalkReason, number> = {
  tea: 9.5,
  approval: 12
}
const ROUTE_COLOR: Record<AgentWalkReason, string> = {
  tea: '#8fe9ff',
  approval: '#e0a33c'
}

function WalkerRouteTrail({
  home,
  target,
  reason,
  accent
}: {
  home: Vector3
  target: Vector3
  reason: AgentWalkReason
  accent: string
}): React.JSX.Element | null {
  const route = useMemo(() => {
    const dx = target.x - home.x
    const dz = target.z - home.z
    const length = Math.hypot(dx, dz)
    if (length < 0.4) return null
    return {
      length,
      yaw: Math.atan2(dx, dz),
      mid: new Vector3((home.x + target.x) / 2, 0, (home.z + target.z) / 2),
      dotCount: Math.min(9, Math.max(4, Math.floor(length / 0.55)))
    }
  }, [home, target])

  if (!route) return null
  const color = reason === 'approval' ? ROUTE_COLOR.approval : accent || ROUTE_COLOR.tea
  return (
    <group position={[route.mid.x, 0.034, route.mid.z]} rotation={[0, route.yaw, 0]}>
      <mesh position={[0, 0, 0]} receiveShadow>
        <boxGeometry args={[0.055, 0.012, route.length]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={reason === 'approval' ? 0.3 : 0.24}
          transparent
          opacity={0.22}
          roughness={0.45}
          metalness={0.08}
          toneMapped={false}
        />
      </mesh>
      {Array.from({ length: route.dotCount }).map((_, i) => {
        const k = route.dotCount === 1 ? 0.5 : i / (route.dotCount - 1)
        const z = -route.length / 2 + k * route.length
        const side = i % 2 === 0 ? -0.065 : 0.065
        return (
          <mesh key={`${reason}-step-${i}`} position={[side, 0.012, z]} rotation={[Math.PI / 2, 0, 0.18 * (i % 2 === 0 ? -1 : 1)]}>
            <capsuleGeometry args={[0.018, 0.06, 4, 8]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={reason === 'approval' ? 0.45 : 0.36}
              transparent
              opacity={0.52}
              roughness={0.36}
              metalness={0.14}
              toneMapped={false}
            />
          </mesh>
        )
      })}
      <mesh position={[0, 0.014, route.length / 2 - 0.09]} rotation={[Math.PI / 2, 0, Math.PI]}>
        <coneGeometry args={[0.07, 0.16, 3]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={reason === 'approval' ? 0.52 : 0.42}
          transparent
          opacity={0.58}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}

function AgentStatusMarker({
  reason,
  accent
}: {
  reason: AgentWalkReason
  accent: string
}): React.JSX.Element {
  const color = reason === 'approval' ? ROUTE_COLOR.approval : accent
  const position: [number, number, number] = reason === 'approval' ? [-0.26, 0.034, 0.36] : [0.28, 0.034, 0.34]
  return (
    <group position={position}>
      <mesh receiveShadow>
        <cylinderGeometry args={[0.19, 0.19, 0.018, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={reason === 'approval' ? 0.18 : 0.22}
          transparent
          opacity={0.32}
          roughness={0.46}
          metalness={0.1}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 0.015, 0]}>
        <torusGeometry args={[0.13, 0.01, 8, 32]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.36}
          transparent
          opacity={0.56}
          toneMapped={false}
        />
      </mesh>
      {reason === 'approval' ? (
        <group position={[0, 0.035, 0]}>
          <mesh position={[-0.035, 0, 0.012]} rotation={[0, 0, -0.75]}>
            <boxGeometry args={[0.09, 0.016, 0.012]} />
            <meshStandardMaterial color="#fff2cf" emissive={color} emissiveIntensity={0.42} toneMapped={false} />
          </mesh>
          <mesh position={[0.036, 0, -0.015]} rotation={[0, 0, 0.72]}>
            <boxGeometry args={[0.16, 0.016, 0.012]} />
            <meshStandardMaterial color="#fff2cf" emissive={color} emissiveIntensity={0.42} toneMapped={false} />
          </mesh>
        </group>
      ) : (
        <group position={[0, 0.034, 0]}>
          <mesh position={[0, 0, 0.014]}>
            <sphereGeometry args={[0.052, 16, 12]} />
            <meshStandardMaterial color="#c8f6ff" emissive={color} emissiveIntensity={0.42} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, -0.038]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.052, 0.12, 18]} />
            <meshStandardMaterial color="#c8f6ff" emissive={color} emissiveIntensity={0.36} toneMapped={false} />
          </mesh>
        </group>
      )}
    </group>
  )
}

function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x))
  return c * c * (3 - 2 * c)
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

function lerpAngle(current: number, target: number, factor: number): number {
  let delta = target - current
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return current + delta * factor
}

function facingFromTo(from: Vector3, to: Vector3, fallback: number): number {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return fallback
  return Math.atan2(dx, dz)
}

function skinKey(providerName?: string, modelName?: string, providerBaseUrl?: string): string {
  return [providerName, modelName, providerBaseUrl].filter(Boolean).join(' ')
}

function OneAgentWalker({
  spec,
  active,
  onAwayChange,
  onSelect,
  onOpen
}: {
  spec: AgentWalkerSpec
  active: boolean
  onAwayChange?: (sessionId: string, away: boolean) => void
  onSelect?: (sessionId: string) => void
  onOpen?: (sessionId: string) => void
}): React.JSX.Element {
  const groupRef = useRef<Group>(null)
  const rigRef = useRef<AvatarRefs>(null)
  const stageRef = useRef<WalkStage>('toTarget')
  const awayRef = useRef(false)
  const [stage, setStage] = useState<WalkStage>('toTarget')

  const home = useMemo(() => new Vector3(...spec.home), [spec.home])
  const homeLookAt = useMemo(() => new Vector3(...spec.homeLookAt), [spec.homeLookAt])
  const target = useMemo(() => new Vector3(...spec.target), [spec.target])
  const targetLookAt = useMemo(() => new Vector3(...spec.targetLookAt), [spec.targetLookAt])
  const position = useMemo(() => home.clone(), [home])
  const skin = useMemo(() => vendorSkin(skinKey(spec.providerName, spec.modelName, spec.providerBaseUrl)), [spec.providerName, spec.modelName, spec.providerBaseUrl])
  const providerLogo = useMemo(
    () => providerLogoFor([spec.providerName, spec.modelName, spec.providerBaseUrl]),
    [spec.providerName, spec.modelName, spec.providerBaseUrl]
  )

  const travelSeconds = useMemo(
    () => clamp(home.distanceTo(target) / SPEED, MIN_TRAVEL_SECONDS, MAX_TRAVEL_SECONDS),
    [home, target]
  )
  const cycleSeconds =
    travelSeconds * 2 + DWELL_SECONDS[spec.reason] + REST_SECONDS[spec.reason]

  const cursorOver = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    document.body.style.cursor = 'pointer'
  }
  const cursorOut = (): void => {
    document.body.style.cursor = 'default'
  }
  const clickSelect = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onSelect?.(spec.sessionId)
  }
  const doubleClickOpen = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onOpen?.(spec.sessionId)
  }

  useEffect(() => {
    return () => {
      if (awayRef.current) onAwayChange?.(spec.sessionId, false)
    }
  }, [onAwayChange, spec.sessionId])

  useFrame((state) => {
    const group = groupRef.current
    const refs = rigRef.current
    if (!group || !refs) return

    const clock = state.clock.getElapsedTime()
    const elapsed = clock + spec.phase
    const local = spec.reason === 'approval' ? elapsed : elapsed % cycleSeconds
    const dwellEnd = travelSeconds + DWELL_SECONDS[spec.reason]
    const backEnd = dwellEnd + travelSeconds
    let nextStage: WalkStage
    let desiredFacing = group.rotation.y
    let walking = false

    if (local < travelSeconds) {
      const k = smoothstep(local / travelSeconds)
      position.copy(home).lerp(target, k)
      desiredFacing = facingFromTo(home, target, desiredFacing)
      nextStage = 'toTarget'
      walking = true
    } else if (spec.reason === 'approval' || local < dwellEnd) {
      position.copy(target)
      desiredFacing = facingFromTo(target, targetLookAt, desiredFacing)
      nextStage = 'target'
    } else if (local < backEnd) {
      const k = smoothstep((local - dwellEnd) / travelSeconds)
      position.copy(target).lerp(home, k)
      desiredFacing = facingFromTo(target, home, desiredFacing)
      nextStage = 'toHome'
      walking = true
    } else {
      position.copy(home)
      desiredFacing = facingFromTo(home, homeLookAt, desiredFacing)
      nextStage = 'home'
    }

    if (stageRef.current !== nextStage) {
      stageRef.current = nextStage
      setStage(nextStage)
    }

    const nextAway = nextStage !== 'home'
    if (awayRef.current !== nextAway) {
      awayRef.current = nextAway
      onAwayChange?.(spec.sessionId, nextAway)
    }

    group.position.copy(position)
    group.rotation.y = lerpAngle(group.rotation.y, desiredFacing, 0.18)
    group.visible = nextAway

    const animOpts = { phase: spec.phase * 0.17, liveliness: walking ? 0.92 : 0.62 }
    if (walking) applyWalking(refs, clock, animOpts)
    else if (nextStage === 'target' && spec.reason === 'approval') applyTalking(refs, clock, animOpts)
    else applyIdle(refs, clock, animOpts)
  })

  return (
    <>
      <WalkerRouteTrail home={home} target={target} reason={spec.reason} accent={skin.accent} />
      <group
        ref={groupRef}
        onClick={clickSelect}
        onDoubleClick={doubleClickOpen}
        onPointerOver={cursorOver}
        onPointerOut={cursorOut}
      >
        <mesh position={[0, 0.012, 0]} receiveShadow>
          <cylinderGeometry args={[0.36, 0.36, 0.018, 32]} />
          <meshStandardMaterial
            color={skin.accent}
            emissive={skin.accent}
            emissiveIntensity={0.24}
            transparent
            opacity={0.42}
            toneMapped={false}
          />
        </mesh>
        {active && (
          <mesh position={[0, 0.034, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.46, 0.018, 8, 72]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive={skin.accent}
              emissiveIntensity={0.76}
              transparent
              opacity={0.72}
              toneMapped={false}
            />
          </mesh>
        )}
        <AvatarRig
          ref={rigRef}
          bodyColor={skin.bodyColor}
          skinColor={skin.shellColor}
          accentColor={skin.accent}
          emblem={skin.emblem}
          providerLogo={providerLogo}
          scale={0.96}
        />
        <ProviderLogoBadge
          logo={providerLogo}
          position={[0, 0.92, 0.19]}
          width={0.38}
          height={0.092}
          depth={0.014}
        />
        {stage === 'target' && <AgentStatusMarker reason={spec.reason} accent={skin.accent} />}
      </group>
    </>
  )
}

export default function AgentWalkers({
  specs,
  activeSessionId,
  onAwayChange,
  onSelect,
  onOpen
}: AgentWalkersProps): React.JSX.Element | null {
  if (specs.length === 0) return null
  return (
    <>
      {specs.map((spec) => (
        <OneAgentWalker
          key={spec.id}
          spec={spec}
          active={spec.sessionId === activeSessionId}
          onAwayChange={onAwayChange}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}
