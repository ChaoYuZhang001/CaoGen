import { useMemo } from 'react'
import { Color } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

// 中性布色:副白偏灰的软家具调性,克制不抢戏
const FABRIC = '#5a5f66'
const FABRIC_DARK = '#4a4e54'
const FRAME = '#2a2c30'
const FOOT = '#1c1d20'

/**
 * 休息区沙发:座垫 + 靠背 + 扶手,柔和体量,中性布色。
 * 纯代码几何:box 圆角靠体量与错落分块营造软感;不使用发光材质。
 * 面向 -Z(与工位约定一致),约 1.9m 宽,占地约 2m×0.9m。
 */
export default function LoungeSofa({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  // 复用颜色对象,避免重复分配
  const fabric = useMemo(() => new Color(FABRIC), [])
  const fabricDark = useMemo(() => new Color(FABRIC_DARK), [])

  // 三个座垫的 X 位置(靠错落分块表现软垫拼接)
  const seatX = useMemo<[number, number, number]>(() => [-0.6, 0, 0.6], [])

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 底座框体:承托整张沙发的体量 */}
      <mesh position={[0, 0.18, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.24, 0.82]} />
        <meshStandardMaterial color={FRAME} metalness={0.1} roughness={0.9} />
      </mesh>

      {/* 座垫:三块并排,柔和厚实 */}
      {seatX.map((x, i) => (
        <mesh key={`seat-${i}`} position={[x, 0.4, 0.03]} castShadow receiveShadow>
          <boxGeometry args={[0.58, 0.22, 0.7]} />
          <meshStandardMaterial
            color={i % 2 === 0 ? fabric : fabricDark}
            metalness={0}
            roughness={0.95}
          />
        </mesh>
      ))}

      {/* 靠背:三块与座垫对应,略后仰的体量 */}
      {seatX.map((x, i) => (
        <mesh key={`back-${i}`} position={[x, 0.66, -0.32]} rotation={[-0.12, 0, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.58, 0.5, 0.22]} />
          <meshStandardMaterial
            color={i % 2 === 0 ? fabricDark : fabric}
            metalness={0}
            roughness={0.95}
          />
        </mesh>
      ))}

      {/* 扶手:左右两侧饱满圆柱错落收边 */}
      <group position={[-1.0, 0.5, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.22, 0.6, 0.82]} />
          <meshStandardMaterial color={fabric} metalness={0} roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.32, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.11, 0.11, 0.82, 32]} />
          <meshStandardMaterial color={fabric} metalness={0} roughness={0.95} />
        </mesh>
      </group>
      <group position={[1.0, 0.5, 0]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[0.22, 0.6, 0.82]} />
          <meshStandardMaterial color={fabric} metalness={0} roughness={0.95} />
        </mesh>
        <mesh position={[0, 0.32, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.11, 0.11, 0.82, 32]} />
          <meshStandardMaterial color={fabric} metalness={0} roughness={0.95} />
        </mesh>
      </group>

      {/* 靠背顶部收边圆柱,软化上沿 */}
      <mesh position={[0, 0.92, -0.38]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.09, 0.09, 1.74, 32]} />
        <meshStandardMaterial color={FABRIC} metalness={0} roughness={0.95} />
      </mesh>

      {/* 四只矮脚 */}
      {([
        [-0.82, -0.34],
        [0.82, -0.34],
        [-0.82, 0.34],
        [0.82, 0.34]
      ] as Array<[number, number]>).map(([fx, fz], i) => (
        <mesh key={`foot-${i}`} position={[fx, 0.04, fz]} castShadow>
          <cylinderGeometry args={[0.05, 0.04, 0.08, 16]} />
          <meshStandardMaterial color={FOOT} metalness={0.3} roughness={0.6} />
        </mesh>
      ))}
    </group>
  )
}
