import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { InstancedMesh } from 'three'
import { Object3D } from 'three'
import type { OfficePacket } from './model'

export interface StationInfo {
  pos: [number, number, number]
  active: boolean
}

/**
 * 真实任务流消息包:仅渲染 OfficeModel 派生出的活跃 tool_use / permission packet。
 * packet 的存在由会话状态决定;这里只负责稳定、可重复的飞行动画。
 */
export default function MessagePackets({
  stations,
  packets
}: {
  stations: StationInfo[]
  packets: OfficePacket[]
}): React.JSX.Element | null {
  const meshRef = useRef<InstancedMesh>(null)
  const dummy = useMemo(() => new Object3D(), [])
  const a = useMemo(() => new Vector3(), [])
  const b = useMemo(() => new Vector3(), [])
  const c = useMemo(() => new Vector3(), [])
  const p = useMemo(() => new Vector3(), [])

  const visiblePackets = useMemo(
    () => packets.filter((pk) => stations[pk.from] && stations[pk.to]),
    [packets, stations]
  )
  const count = visiblePackets.length

  useFrame((state) => {
    const mesh = meshRef.current
    if (!mesh || count === 0) return
    const elapsed = state.clock.getElapsedTime()
    for (let i = 0; i < count; i++) {
      const pk = visiblePackets[i]
      const sa = stations[pk.from].pos
      const sb = stations[pk.to].pos
      const h = hash(pk.id)
      const lane = ((h % 7) - 3) * 0.055
      const sameStation = pk.from === pk.to
      const speed = pk.status === 'awaiting' ? 0.45 : 0.62
      const offset = ((h >>> 4) % 100) / 100
      const t = (elapsed * speed + offset) % 1

      a.set(sa[0] - (sameStation ? 0.38 : 0), 0.72, sa[2] - 0.35 + lane)
      b.set(sb[0] + (sameStation ? 0.38 : 0), 0.72, sb[2] - 0.35 - lane)
      c.set(
        (a.x + b.x) / 2,
        sameStation ? 1.55 + (h % 5) * 0.08 : 2.2 + a.distanceTo(b) * 0.08,
        (a.z + b.z) / 2 - (sameStation ? 0.26 : 0)
      )
      // 二次贝塞尔
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
    <instancedMesh key={count} ref={meshRef} args={[undefined, undefined, count]} frustumCulled={false}>
      <sphereGeometry args={[0.05, 10, 10]} />
      <meshStandardMaterial
        color="#8fe9ff"
        emissive="#8fe9ff"
        emissiveIntensity={1.2}
        toneMapped={false}
      />
    </instancedMesh>
  )
}

function hash(v: string): number {
  let h = 2166136261
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
