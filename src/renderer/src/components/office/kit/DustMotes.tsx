import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Points } from 'three'

/** 视觉道具通用摆放属性 */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

interface Props extends OfficeProp {
  /** 浮尘颗粒数量(默认 120) */
  count?: number
  /** 是否附带一盏柔和体积光,强化"光柱见尘"氛围(默认关闭) */
  light?: boolean
}

const AREA_X = 24
const AREA_Y = 9
const AREA_Z = 24
const BASE_Y = 3.5
const DUST_COLOR = '#8fe9ff'

interface Mote {
  x: number
  y: number
  z: number
  /** 垂直缓慢漂浮速度 */
  vy: number
  /** 水平环绕相位与半径 */
  swayPhase: number
  swayRadius: number
  swaySpeed: number
}

/**
 * 空气浮尘:自建 points,在体积范围内缓慢飘浮 + 轻微环绕,
 * 营造被灯光照亮的悬浮微粒氛围。发光材质配合 Bloom(toneMapped={false})。
 * 只用 useFrame 驱动动画,闭包外复用缓冲,不在帧内 new 对象。
 */
export default function DustMotes({
  count = 120,
  light = false,
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: Props): React.JSX.Element {
  const pointsRef = useRef<Points>(null)

  // 每颗尘埃的初始状态与漂浮参数(一次性生成,帧内只读)
  const motes = useMemo<Mote[]>(() => {
    const arr: Mote[] = []
    for (let i = 0; i < count; i++) {
      arr.push({
        x: (Math.random() - 0.5) * AREA_X,
        y: Math.random() * AREA_Y,
        z: (Math.random() - 0.5) * AREA_Z,
        vy: 0.05 + Math.random() * 0.12,
        swayPhase: Math.random() * Math.PI * 2,
        swayRadius: 0.2 + Math.random() * 0.8,
        swaySpeed: 0.1 + Math.random() * 0.25
      })
    }
    return arr
  }, [count])

  // 位置缓冲:帧内原地更新,避免重新分配
  const positionsAttr = useMemo(() => {
    const a = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const m = motes[i]
      a[i * 3] = m.x
      a[i * 3 + 1] = m.y
      a[i * 3 + 2] = m.z
    }
    return a
  }, [count, motes])

  useFrame((state) => {
    const pts = pointsRef.current
    if (!pts) return
    const t = state.clock.getElapsedTime()
    const posAttr = pts.geometry.attributes.position
    for (let i = 0; i < count; i++) {
      const m = motes[i]
      // 垂直缓慢上升,越界后从底部循环
      let y = m.y + t * m.vy
      y = ((y % AREA_Y) + AREA_Y) % AREA_Y
      // 水平轻微环绕漂移
      const ang = m.swayPhase + t * m.swaySpeed
      const x = m.x + Math.cos(ang) * m.swayRadius
      const z = m.z + Math.sin(ang) * m.swayRadius
      posAttr.setXYZ(i, x, y, z)
    }
    posAttr.needsUpdate = true
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      <points ref={pointsRef} position={[0, BASE_Y - AREA_Y / 2, 0]}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positionsAttr, 3]} count={count} />
        </bufferGeometry>
        <pointsMaterial
          color={DUST_COLOR}
          size={0.04}
          sizeAttenuation
          transparent
          opacity={0.35}
          depthWrite={false}
          toneMapped={false}
        />
      </points>

      {light && (
        <pointLight
          position={[0, BASE_Y + 3, 0]}
          intensity={0.35}
          distance={AREA_X}
          decay={2}
          color={DUST_COLOR}
        />
      )}
    </group>
  )
}
