import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Shape, Path } from 'three'
import type { Group, MeshStandardMaterial } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

/** 把一个圆角矩形轮廓写入给定的 Shape/Path(以中心为原点,XY 平面) */
function traceRoundedRect(target: Shape | Path, w: number, h: number, r: number): void {
  const hw = w / 2
  const hh = h / 2
  const rad = Math.min(r, hw, hh)
  target.moveTo(-hw + rad, -hh)
  target.lineTo(hw - rad, -hh)
  target.quadraticCurveTo(hw, -hh, hw, -hh + rad)
  target.lineTo(hw, hh - rad)
  target.quadraticCurveTo(hw, hh, hw - rad, hh)
  target.lineTo(-hw + rad, hh)
  target.quadraticCurveTo(-hw, hh, -hw, hh - rad)
  target.lineTo(-hw, -hh + rad)
  target.quadraticCurveTo(-hw, -hh, -hw + rad, -hh)
}

// 基础尺寸:约覆盖一个 2m×2m 工位;用 scale 缩放
const RUG_W = 2.2
const RUG_H = 2.2
const RUG_R = 0.32
const TRIM = 0.09 // 发光边框厚度

/**
 * 地毯:圆角矩形薄板,微高于地面,用于划分工位/休息区。
 * 主体为中性深色哑光板;内嵌一圈克制的发光边框(默认青,或由 color 指定),
 * 边框缓慢呼吸并配合 Bloom 产生柔和辉光。几何体全部代码生成。
 */
export default function AreaRug({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  color = '#8fe9ff'
}: OfficeProp & { color?: string }): React.JSX.Element {
  const trimMatRef = useRef<MeshStandardMaterial>(null)
  const groupRef = useRef<Group>(null)

  // 主体圆角矩形
  const rugShape = useMemo(() => {
    const s = new Shape()
    traceRoundedRect(s, RUG_W, RUG_H, RUG_R)
    return s
  }, [])

  // 边框:外圈圆角矩形挖去内圈圆角矩形形成的细框
  const trimShape = useMemo(() => {
    const s = new Shape()
    traceRoundedRect(s, RUG_W, RUG_H, RUG_R)
    const hole = new Path()
    traceRoundedRect(hole, RUG_W - TRIM * 2, RUG_H - TRIM * 2, Math.max(0.02, RUG_R - TRIM))
    s.holes.push(hole)
    return s
  }, [])

  // 相位随位置错开,让多张地毯的呼吸不同步
  const phase = useMemo(() => (position[0] * 1.3 + position[2] * 0.7) % (Math.PI * 2), [position])

  useFrame((state) => {
    const mat = trimMatRef.current
    if (!mat) return
    const t = state.clock.getElapsedTime() + phase
    mat.emissiveIntensity = 0.7 + Math.sin(t * 1.2) * 0.25
  })

  return (
    <group ref={groupRef} position={position} rotation={rotation} scale={scale}>
      {/* 主体薄板:中性深灰哑光,平铺于地面上方,朝上 */}
      <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <shapeGeometry args={[rugShape, 12]} />
        <meshStandardMaterial color="#1b1b1b" roughness={0.92} metalness={0.05} />
      </mesh>

      {/* 发光边框:略高于主体,避免 z-fighting */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[trimShape, 12]} />
        <meshStandardMaterial
          ref={trimMatRef}
          color={color}
          emissive={color}
          emissiveIntensity={0.7}
          roughness={0.5}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}
