import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import type { Group } from 'three'

/** 视觉道具通用属性 */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

// 配色:银灰复合桌面 + 哑光金属,减少木色造成的杂乱。
const TOP_WOOD = '#707b85' // 中性复合桌面
const TOP_EDGE = '#4f5a65' // 桌面封边
const METAL = '#39424d' // 哑光金属腿/横梁
const METAL_DARK = '#2d353f' // 金属暗部
const TROUGH = '#202832' // 侧边理线槽内壁
const CABLE = '#8fe9ff' // 理线槽内的线缆微光(青)

// 桌体尺寸(约 1.4 宽 × 0.7 深),桌面高约 0.74
const W = 1.4
const D = 0.7
const TOP_Y = 0.74
const TOP_T = 0.04 // 桌面厚
const LEG = 0.05 // 腿方料

/**
 * 现代办公桌:木质哑光桌面 + 金属桌腿(带脚横梁)+ 一侧的理线槽。
 * 纯代码几何,发光的线缆材质带 toneMapped={false} 以配合 Bloom。
 */
export default function Desk({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const groupRef = useRef<Group>(null)

  // 极轻微的空闲呼吸,让静物不至死板(不在 useFrame 内 new 对象)
  useFrame((state) => {
    const g = groupRef.current
    if (!g) return
    const t = state.clock.getElapsedTime()
    g.position.y = position[1] + Math.sin(t * 0.6) * 0.002
  })

  const legInset = 0.08 // 腿相对桌面边缘内缩
  const lx = W / 2 - legInset - LEG / 2
  const lz = D / 2 - legInset - LEG / 2
  const legH = TOP_Y - TOP_T

  return (
    <group ref={groupRef} position={position} rotation={rotation} scale={scale}>
      {/* 桌面(中性复合材质) */}
      <RoundedBox args={[W, TOP_T, D]} radius={0.025} smoothness={3} position={[0, TOP_Y - TOP_T / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={TOP_WOOD} metalness={0.18} roughness={0.62} />
      </RoundedBox>
      {/* 桌面封边(压在桌面上方一薄层,做出复合板边缘层次) */}
      <RoundedBox args={[W + 0.01, 0.012, D + 0.01]} radius={0.022} smoothness={3} position={[0, TOP_Y - TOP_T + 0.006, 0]} castShadow>
        <meshStandardMaterial color={TOP_EDGE} metalness={0.22} roughness={0.58} />
      </RoundedBox>
      <mesh position={[0, TOP_Y + 0.004, D / 2 - 0.045]}>
        <boxGeometry args={[W * 0.95, 0.018, 0.032]} />
        <meshStandardMaterial color={CABLE} emissive={CABLE} emissiveIntensity={0.78} toneMapped={false} />
      </mesh>
      <mesh position={[0, TOP_Y + 0.003, -D / 2 + 0.045]}>
        <boxGeometry args={[W * 0.78, 0.014, 0.026]} />
        <meshStandardMaterial color={CABLE} emissive={CABLE} emissiveIntensity={0.56} transparent opacity={0.86} toneMapped={false} />
      </mesh>

      {/* 四条金属方腿 */}
      {(
        [
          [-lx, -lz],
          [lx, -lz],
          [-lx, lz],
          [lx, lz]
        ] as Array<[number, number]>
      ).map(([x, z], i) => (
        <RoundedBox key={i} args={[LEG, legH, LEG]} radius={0.012} smoothness={2} position={[x, legH / 2, z]} castShadow receiveShadow>
          <meshStandardMaterial color={METAL} metalness={0.8} roughness={0.4} />
        </RoundedBox>
      ))}

      {/* 前后两根脚部横梁(稳定感 + 金属工业风) */}
      <mesh position={[0, 0.06, -lz]} castShadow>
        <boxGeometry args={[lx * 2, 0.04, 0.04]} />
        <meshStandardMaterial color={METAL_DARK} metalness={0.8} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0.06, lz]} castShadow>
        <boxGeometry args={[lx * 2, 0.04, 0.04]} />
        <meshStandardMaterial color={METAL_DARK} metalness={0.8} roughness={0.45} />
      </mesh>
      {/* 桌面下横向连梁(顶住两侧腿) */}
      <mesh position={[0, legH - 0.06, 0]}>
        <boxGeometry args={[lx * 2, 0.03, 0.03]} />
        <meshStandardMaterial color={METAL_DARK} metalness={0.8} roughness={0.45} />
      </mesh>

      {/* 侧边理线槽:挂在桌面后缘下方,开口朝下的浅金属槽 */}
      <group position={[0, legH - 0.05, -D / 2 + 0.06]}>
        {/* 槽体外壳 */}
        <mesh castShadow>
          <boxGeometry args={[W * 0.6, 0.09, 0.06]} />
          <meshStandardMaterial color={METAL} metalness={0.7} roughness={0.5} />
        </mesh>
        {/* 槽内壁(暗腔) */}
        <mesh position={[0, 0.005, 0.005]}>
          <boxGeometry args={[W * 0.6 - 0.03, 0.06, 0.045]} />
          <meshStandardMaterial color={TROUGH} metalness={0.3} roughness={0.9} />
        </mesh>
        {/* 槽内一束发光线缆(青),配合 Bloom */}
        <mesh position={[0, -0.005, 0.01]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.008, 0.008, W * 0.55, 16]} />
          <meshStandardMaterial
            color={CABLE}
            emissive={CABLE}
            emissiveIntensity={0.9}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  )
}
