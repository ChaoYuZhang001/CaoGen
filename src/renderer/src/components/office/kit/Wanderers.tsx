import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { Group } from 'three'
import AvatarRig from './AvatarRig'
import type { AvatarRefs } from './AvatarRig'
import { applyWalking, applyTalking, applyIdle } from './AvatarAnimations'

/** 漫游小人:离开工位 → 走到会议点 → 开会/交流 → 走回,循环。纯氛围。 */
export interface WandererSpec {
  id: string
  /** 工位坐标(家) */
  home: [number, number, number]
  bodyColor?: string
  /** 会议/交流点 */
  meet: [number, number, number]
  /** 相位错开,避免同步 */
  phase: number
}

type Leg = 'toMeet' | 'meeting' | 'toHome' | 'resting'

const SPEED = 1.4 // m/s
const MEET_SECONDS = 6
const REST_SECONDS = 5

function OneWanderer({ spec }: { spec: WandererSpec }): React.JSX.Element {
  const groupRef = useRef<Group>(null)
  const refs = useRef<AvatarRefs>({
    root: null,
    head: null,
    armL: null,
    armR: null,
    legL: null,
    legR: null
  })
  const home = useMemo(() => new Vector3(...spec.home), [spec.home])
  const meet = useMemo(() => new Vector3(...spec.meet), [spec.meet])
  const pos = useMemo(() => home.clone(), [home])
  const tmp = useMemo(() => new Vector3(), [])

  // 状态机:用 ref 保存,避免每帧 setState
  const leg = useRef<Leg>('resting')
  const legStarted = useRef(-spec.phase) // 负相位:错开各自起步
  const facing = useRef(0)

  useFrame((state) => {
    const g = groupRef.current
    if (!g) return
    const t = state.clock.getElapsedTime()
    const elapsed = t - legStarted.current

    const walkTo = (target: Vector3): boolean => {
      tmp.subVectors(target, pos)
      const dist = tmp.length()
      if (dist < 0.05) return true
      tmp.normalize()
      const step = Math.min(SPEED * 0.016, dist)
      pos.addScaledVector(tmp, step)
      facing.current = Math.atan2(-tmp.x, -tmp.z)
      return false
    }

    switch (leg.current) {
      case 'resting':
        if (elapsed > REST_SECONDS + spec.phase) {
          leg.current = 'toMeet'
          legStarted.current = t
        }
        applyIdle(refs.current, t, { phase: spec.phase, facing: 0 })
        break
      case 'toMeet':
        if (walkTo(meet)) {
          leg.current = 'meeting'
          legStarted.current = t
        }
        applyWalking(refs.current, t, { phase: spec.phase, facing: 0 })
        break
      case 'meeting':
        if (elapsed > MEET_SECONDS) {
          leg.current = 'toHome'
          legStarted.current = t
        }
        // 面向会议中心(略朝 -Z)交流;转向交给外层 group,动画不覆盖
        facing.current = Math.PI
        applyTalking(refs.current, t, { phase: spec.phase, facing: 0 })
        break
      case 'toHome':
        if (walkTo(home)) {
          leg.current = 'resting'
          legStarted.current = t
        }
        applyWalking(refs.current, t, { phase: spec.phase, facing: 0 })
        break
    }

    g.position.copy(pos)
    // 平滑转向
    const cur = g.rotation.y
    let d = facing.current - cur
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    g.rotation.y = cur + d * 0.15
  })

  return (
    <group ref={groupRef}>
      <AvatarRig refs={refs.current} bodyColor={spec.bodyColor} scale={0.9} />
    </group>
  )
}

export default function Wanderers({ specs }: { specs: WandererSpec[] }): React.JSX.Element | null {
  if (specs.length === 0) return null
  return (
    <>
      {specs.map((s) => (
        <OneWanderer key={s.id} spec={s} />
      ))}
    </>
  )
}
