import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { InstancedMesh } from 'three'
import { Object3D } from 'three'

export interface StationInfo {
  pos: [number, number, number]
  active: boolean
}

interface Packet {
  from: number
  to: number
  t: number
  /** 负值表示尚未出发(等待延迟) */
  delay: number
  speed: number
}

/**
 * 工位间飞行的消息包:代表 Agent 之间的"沟通/协作"氛围。
 * 发光小球沿贝塞尔弧线从一个工位飞到另一个,Bloom 下拖出光尾感。
 * 优先从"工作中"的工位发出;工位少于 2 个则不显示。
 * 说明:当前会话彼此独立,此为表意动画;接入真实多 Agent 编排后可绑真数据。
 */
export default function MessagePackets({ stations }: { stations: StationInfo[] }): React.JSX.Element | null {
  const meshRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const a = useMemo(() => new Vector3(), [])
  const b = useMemo(() => new Vector3(), [])
  const c = useMemo(() => new Vector3(), [])
  const p = useMemo(() => new Vector3(), [])

  const count = Math.min(12, Math.max(0, stations.length * 2))

  const pickTarget = (from: number): number => {
    const n = stations.length
    if (n < 2) return from
    let to = Math.floor(Math.random() * n)
    if (to === from) to = (to + 1) % n
    return to
  }

  const spawn = (): Packet => {
    const actives = stations.map((s, i) => (s.active ? i : -1)).filter((i) => i >= 0)
    const from =
      actives.length > 0 && Math.random() < 0.75
        ? actives[Math.floor(Math.random() * actives.length)]
        : Math.floor(Math.random() * stations.length)
    return { from, to: pickTarget(from), t: 0, delay: -Math.random() * 2.5, speed: 0.45 + Math.random() * 0.35 }
  }

  const packets = useRef<Packet[]>([])
  // 初始化 / 站点数变化时重建包池
  if (packets.current.length !== count) {
    packets.current = Array.from({ length: count }, () => spawn())
  }

  useFrame((_, dt) => {
    const mesh = meshRef.current
    if (!mesh || stations.length < 2) return
    const clamped = Math.min(dt, 0.05)
    for (let i = 0; i < packets.current.length; i++) {
      const pk = packets.current[i]
      if (pk.delay < 0) {
        pk.delay += clamped
        // 未出发:藏到远处
        dummy.position.set(0, -100, 0)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
        continue
      }
      pk.t += clamped * pk.speed
      if (pk.t >= 1 || pk.from >= stations.length || pk.to >= stations.length) {
        packets.current[i] = spawn()
        continue
      }
      const sa = stations[pk.from].pos
      const sb = stations[pk.to].pos
      a.set(sa[0], 0.72, sa[2] - 0.35)
      b.set(sb[0], 0.72, sb[2] - 0.35)
      c.set((sa[0] + sb[0]) / 2, 2.2 + a.distanceTo(b) * 0.08, (sa[2] + sb[2]) / 2)
      // 二次贝塞尔
      const t = pk.t
      const mt = 1 - t
      p.set(0, 0, 0)
        .addScaledVector(a, mt * mt)
        .addScaledVector(c, 2 * mt * t)
        .addScaledVector(b, t * t)
      dummy.position.copy(p)
      const s = 0.6 + Math.sin(t * Math.PI) * 0.9 // 中途略大,首尾收窄
      dummy.scale.setScalar(s)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
  })

  if (count === 0) return null

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]} frustumCulled={false}>
      <sphereGeometry args={[0.05, 10, 10]} />
      <meshStandardMaterial
        color="#8fe9ff"
        emissive="#8fe9ff"
        emissiveIntensity={3}
        toneMapped={false}
      />
    </instancedMesh>
  )
}
