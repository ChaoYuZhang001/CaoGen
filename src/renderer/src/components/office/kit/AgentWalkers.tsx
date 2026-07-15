import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { Group } from 'three'
import AvatarRig from './AvatarRig'
import type { AvatarRefs } from './AvatarRig'
import { applyIdle, applyStandingTalking, applyWalking } from './AvatarAnimations'
import { vendorSkin } from './VendorSkins'
import { providerLogoFor } from './ProviderLogos'

export type AgentWalkReason = 'tea' | 'approval' | 'restroom' | 'dining'

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
  holdAtTarget?: boolean
  departureDelay?: number
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
const MAX_TRAVEL_SECONDS = 6
const GAIT_STRIDE_LENGTH = 0.82
const GAIT_STEP_HEIGHT = 0.105
const GAIT_FOOT_SPACING = 0.105
const GAIT_LANDING_LEAD = GAIT_STRIDE_LENGTH * 0.54
const TAU = Math.PI * 2
const DWELL_SECONDS: Record<AgentWalkReason, number> = {
  tea: 6.5,
  approval: 8.5,
  restroom: 7.5,
  dining: 10.5
}
const REST_SECONDS: Record<AgentWalkReason, number> = {
  tea: 9.5,
  approval: 12,
  restroom: 11,
  dining: 13
}
const ROUTE_COLOR: Record<AgentWalkReason, string> = {
  tea: '#5c8794',
  approval: '#6f8fa0',
  restroom: '#5c8794',
  dining: '#5f7f8c'
}
const WALKER_ACCENT = '#59dcff'
const WALKER_NEUTRAL = '#9fb2c2'

function routeColor(reason: AgentWalkReason, accent: string): string {
  return reason === 'tea' ? WALKER_ACCENT || accent : ROUTE_COLOR[reason]
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
      mid: new Vector3((home.x + target.x) / 2, 0, (home.z + target.z) / 2)
    }
  }, [home, target])

  if (!route) return null
  const color = routeColor(reason, accent)
  return (
    <group position={[route.mid.x, 0.018, route.mid.z]} rotation={[0, route.yaw, 0]}>
      <mesh position={[0, 0, 0]} receiveShadow>
        <boxGeometry args={[0.05, 0.008, route.length]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={reason === 'approval' ? 0.24 : 0.18}
          transparent
          opacity={0.18}
          roughness={0.45}
          metalness={0.08}
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
  const color = routeColor(reason, accent)
  const position: [number, number, number] = reason === 'approval' ? [-0.26, 0.034, 0.36] : [0.28, 0.034, 0.34]
  return (
    <group position={position}>
      <mesh receiveShadow>
        <boxGeometry args={[0.34, 0.018, 0.18]} />
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
      {[-0.08, 0.08].map((x) => (
        <mesh key={`marker-slat-${x}`} position={[x, 0.017, 0]}>
          <boxGeometry args={[0.11, 0.012, 0.022]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.36} transparent opacity={0.56} toneMapped={false} />
        </mesh>
      ))}
      {reason === 'approval' ? (
        <group position={[0, 0.035, 0]}>
          <mesh position={[-0.035, 0, 0.012]} rotation={[0, 0, -0.75]}>
            <boxGeometry args={[0.09, 0.016, 0.012]} />
            <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.18} toneMapped={false} />
          </mesh>
          <mesh position={[0.036, 0, -0.015]} rotation={[0, 0, 0.72]}>
            <boxGeometry args={[0.16, 0.016, 0.012]} />
            <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.18} toneMapped={false} />
          </mesh>
        </group>
      ) : reason === 'dining' ? (
        <group position={[0, 0.036, 0]}>
          <mesh position={[-0.058, 0, 0]} rotation={[0, 0, -0.04]}>
            <boxGeometry args={[0.018, 0.22, 0.014]} />
            <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.16} toneMapped={false} />
          </mesh>
          {[-0.092, -0.058, -0.024].map((x) => (
            <mesh key={x} position={[x, 0.092, 0]}>
              <boxGeometry args={[0.012, 0.072, 0.012]} />
              <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.14} toneMapped={false} />
            </mesh>
          ))}
          <mesh position={[0.07, 0.012, 0]} rotation={[0, 0, -0.16]}>
            <boxGeometry args={[0.018, 0.24, 0.014]} />
            <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.16} toneMapped={false} />
          </mesh>
          <mesh position={[0.088, 0.11, 0]} rotation={[0, 0, -0.16]}>
            <boxGeometry args={[0.058, 0.07, 0.012]} />
            <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.14} toneMapped={false} />
          </mesh>
        </group>
      ) : reason === 'restroom' ? (
        <group position={[0, 0.036, 0]}>
          {[-0.065, 0.065].map((x) => (
            <group key={x} position={[x, 0, 0]}>
              <mesh position={[0, 0.07, 0]}>
                <boxGeometry args={[0.052, 0.052, 0.014]} />
                <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.16} toneMapped={false} />
              </mesh>
              <mesh position={[0, -0.032, 0]}>
                <boxGeometry args={[0.052, 0.12, 0.014]} />
                <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.14} toneMapped={false} />
              </mesh>
            </group>
          ))}
        </group>
      ) : (
        <group position={[0, 0.034, 0]}>
          <mesh position={[0, 0, 0.014]}>
            <boxGeometry args={[0.13, 0.026, 0.014]} />
            <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.18} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, -0.038]}>
            <boxGeometry args={[0.08, 0.02, 0.014]} />
            <meshStandardMaterial color={WALKER_NEUTRAL} emissive={color} emissiveIntensity={0.16} toneMapped={false} />
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

interface FootStepState {
  initialized: boolean
  inStance: boolean
  target: Vector3
  swingStart: Vector3
  swingEnd: Vector3
}

function createFootStepState(): FootStepState {
  return {
    initialized: false,
    inStance: true,
    target: new Vector3(),
    swingStart: new Vector3(),
    swingEnd: new Vector3()
  }
}

function wrapPhase(value: number): number {
  const wrapped = value % TAU
  return wrapped < 0 ? wrapped + TAU : wrapped
}

function footBase(
  output: Vector3,
  body: Vector3,
  forward: Vector3,
  right: Vector3,
  lateralSign: number,
  lead = 0
): Vector3 {
  return output
    .copy(body)
    .addScaledVector(right, lateralSign * GAIT_FOOT_SPACING)
    .addScaledVector(forward, lead)
    .setY(body.y)
}

function updateFootTarget(
  state: FootStepState,
  target: Group | null,
  phase: number,
  body: Vector3,
  forward: Vector3,
  right: Vector3,
  lateralSign: number,
  motion: number
): void {
  if (!target) return
  const inStance = phase < Math.PI

  if (!state.initialized) {
    footBase(state.target, body, forward, right, lateralSign)
    state.swingStart.copy(state.target)
    footBase(state.swingEnd, body, forward, right, lateralSign, GAIT_LANDING_LEAD)
    state.inStance = inStance
    state.initialized = true
  } else if (state.inStance !== inStance) {
    if (inStance) {
      state.target.copy(state.swingEnd).setY(body.y)
    } else {
      state.swingStart.copy(state.target).setY(body.y)
      footBase(state.swingEnd, body, forward, right, lateralSign, GAIT_LANDING_LEAD)
    }
    state.inStance = inStance
  }

  if (inStance) {
    target.position.copy(state.target).setY(body.y)
    return
  }

  const progress = clamp((phase - Math.PI) / Math.PI, 0, 1)
  const travel = smoothstep(progress)
  state.target.lerpVectors(state.swingStart, state.swingEnd, travel)
  state.target.y = body.y + Math.sin(progress * Math.PI) * GAIT_STEP_HEIGHT * motion
  target.position.copy(state.target)
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
  const leftFootTargetRef = useRef<Group>(null)
  const rightFootTargetRef = useRef<Group>(null)
  const stageRef = useRef<WalkStage>('toTarget')
  const awayRef = useRef(false)
  const startedAtRef = useRef<number | null>(null)
  const [stage, setStage] = useState<WalkStage>('toTarget')

  const home = useMemo(() => new Vector3(...spec.home), [spec.home])
  const homeLookAt = useMemo(() => new Vector3(...spec.homeLookAt), [spec.homeLookAt])
  const target = useMemo(() => new Vector3(...spec.target), [spec.target])
  const targetLookAt = useMemo(() => new Vector3(...spec.targetLookAt), [spec.targetLookAt])
  const position = useMemo(() => home.clone(), [home])
  const previousPositionRef = useRef(home.clone())
  const walkedDistanceRef = useRef(0)
  const wasWalkingRef = useRef(false)
  const leftFootStepRef = useRef<FootStepState>(createFootStepState())
  const rightFootStepRef = useRef<FootStepState>(createFootStepState())
  const forwardRef = useRef(new Vector3(0, 0, 1))
  const rightRef = useRef(new Vector3(1, 0, 0))
  const skin = useMemo(() => vendorSkin(skinKey(spec.providerName, spec.modelName, spec.providerBaseUrl)), [spec.providerName, spec.modelName, spec.providerBaseUrl])
  const providerLogo = useMemo(
    () => providerLogoFor([spec.providerName, spec.modelName, spec.providerBaseUrl]),
    [spec.providerName, spec.modelName, spec.providerBaseUrl]
  )

  const travelSeconds = useMemo(
    () => clamp(home.distanceTo(target) / SPEED, MIN_TRAVEL_SECONDS, MAX_TRAVEL_SECONDS),
    [home, target]
  )
  const gaitStrideLength = useMemo(() => {
    const routeDistance = home.distanceTo(target)
    const strideCount = Math.max(1, Math.round(routeDistance / GAIT_STRIDE_LENGTH))
    return Math.max(0.1, routeDistance / strideCount)
  }, [home, target])
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

  useEffect(() => {
    previousPositionRef.current.copy(home)
    walkedDistanceRef.current = 0
    wasWalkingRef.current = false
    leftFootStepRef.current.initialized = false
    rightFootStepRef.current.initialized = false
  }, [home, target])

  useFrame((state, delta) => {
    const group = groupRef.current
    const refs = rigRef.current
    if (!group || !refs) return

    const clock = state.clock.getElapsedTime()
    const elapsed = clock + spec.phase
    if (startedAtRef.current === null) startedAtRef.current = clock
    const oneWayElapsed = Math.max(0, clock - startedAtRef.current)
    const oneWay = spec.reason === 'approval' || spec.holdAtTarget
    const departureDelay = Math.max(0, spec.departureDelay ?? 0)
    const waitingToDepart = oneWay && oneWayElapsed < departureDelay
    const local = oneWay ? Math.max(0, oneWayElapsed - departureDelay) : elapsed % cycleSeconds
    const dwellEnd = travelSeconds + DWELL_SECONDS[spec.reason]
    const backEnd = dwellEnd + travelSeconds
    let nextStage: WalkStage
    let desiredFacing = group.rotation.y
    let walking = false

    if (waitingToDepart) {
      position.copy(home)
      desiredFacing = facingFromTo(home, homeLookAt, desiredFacing)
      nextStage = 'home'
    } else if (local < travelSeconds) {
      const k = smoothstep(local / travelSeconds)
      position.copy(home).lerp(target, k)
      desiredFacing = facingFromTo(home, target, desiredFacing)
      nextStage = 'toTarget'
      walking = true
    } else if (spec.reason === 'approval' || spec.holdAtTarget || local < dwellEnd) {
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
    const turnFactor = 1 - Math.pow(1 - 0.18, Math.min(delta, 0.1) * 60)
    group.rotation.y = lerpAngle(group.rotation.y, desiredFacing, turnFactor)
    group.visible = nextAway

    const secondsToStop =
      nextStage === 'toTarget'
        ? travelSeconds - local
        : nextStage === 'toHome'
          ? backEnd - local
          : 0
    const arrivalEase = walking ? smoothstep(clamp(secondsToStop / 0.9, 0, 1)) : 0
    let gaitPhase = 0
    let gaitMotion = 0
    if (walking) {
      if (!wasWalkingRef.current) {
        previousPositionRef.current.copy(position)
        walkedDistanceRef.current = 0
        leftFootStepRef.current.initialized = false
        rightFootStepRef.current.initialized = false
      }

      const frameDistance = previousPositionRef.current.distanceTo(position)
      walkedDistanceRef.current += frameDistance
      const actualSpeed = delta > 0 ? frameDistance / delta : 0
      gaitMotion = clamp(actualSpeed / SPEED, 0.12, 1)
      gaitPhase = (walkedDistanceRef.current / gaitStrideLength) * TAU

      const forward = forwardRef.current.set(Math.sin(group.rotation.y), 0, Math.cos(group.rotation.y)).normalize()
      const right = rightRef.current.set(Math.cos(group.rotation.y), 0, -Math.sin(group.rotation.y)).normalize()
      updateFootTarget(
        leftFootStepRef.current,
        leftFootTargetRef.current,
        wrapPhase(gaitPhase),
        position,
        forward,
        right,
        1,
        gaitMotion
      )
      updateFootTarget(
        rightFootStepRef.current,
        rightFootTargetRef.current,
        wrapPhase(gaitPhase + Math.PI),
        position,
        forward,
        right,
        -1,
        gaitMotion
      )
      wasWalkingRef.current = true
    } else {
      wasWalkingRef.current = false
      walkedDistanceRef.current = 0
      leftFootStepRef.current.initialized = false
      rightFootStepRef.current.initialized = false
    }
    previousPositionRef.current.copy(position)

    const animOpts = { phase: spec.phase * 0.17, liveliness: walking ? 0.2 + arrivalEase * 0.72 : 0.62 }
    if (walking) {
      applyWalking(refs, clock, {
        ...animOpts,
        gaitPhase,
        gaitSpeed: gaitMotion,
        walkFootTargets: {
          left: leftFootTargetRef.current,
          right: rightFootTargetRef.current
        }
      })
    } else if (nextStage === 'target' && spec.reason === 'approval') applyStandingTalking(refs, clock, animOpts)
    else applyIdle(refs, clock, animOpts)
  })

  return (
    <>
      <WalkerRouteTrail home={home} target={target} reason={spec.reason} accent={WALKER_ACCENT} />
      <group ref={leftFootTargetRef} name="walker-left-foot-contact-target" />
      <group ref={rightFootTargetRef} name="walker-right-foot-contact-target" />
      <group
        ref={groupRef}
        onClick={clickSelect}
        onDoubleClick={doubleClickOpen}
        onPointerOver={cursorOver}
        onPointerOut={cursorOut}
      >
        <mesh name="walker-select-hitbox" position={[0, 0.88, 0]}>
          <boxGeometry args={[0.82, 1.76, 0.66]} />
          <meshBasicMaterial transparent opacity={0.001} depthWrite={false} colorWrite={false} />
        </mesh>
        <mesh position={[0, 0.012, 0]} receiveShadow>
          <boxGeometry args={[0.62, 0.018, 0.28]} />
          <meshStandardMaterial
            color={WALKER_ACCENT}
            emissive={WALKER_ACCENT}
            emissiveIntensity={0.14}
            transparent
            opacity={0.22}
            toneMapped={false}
          />
        </mesh>
        {active && (
          <>
            {[-0.22, 0.22].map((x) => (
              <mesh key={`walker-active-slat-${x}`} position={[x, 0.034, 0]}>
                <boxGeometry args={[0.16, 0.014, 0.028]} />
                <meshStandardMaterial color={WALKER_NEUTRAL} emissive={WALKER_ACCENT} emissiveIntensity={0.24} transparent opacity={0.32} toneMapped={false} />
              </mesh>
            ))}
          </>
        )}
        <AvatarRig
          ref={rigRef}
          bodyColor={skin.bodyColor}
          skinColor={skin.shellColor}
          accentColor={WALKER_ACCENT}
          emblem={skin.emblem}
          providerLogo={providerLogo}
          scale={1}
        />
        {stage === 'target' && <AgentStatusMarker reason={spec.reason} accent={WALKER_ACCENT} />}
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
