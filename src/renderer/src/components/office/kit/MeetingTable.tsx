import { useMemo } from 'react'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const ACCENT = '#59b8c8'
const TABLE_RADIUS = 0.95
const CHAIR_ORBIT = 1.5

/** 单把椅子:座面 + 靠背 + 中柱 + 五爪底座,朝向桌心(-local Z 面向中心) */
function Chair({ color }: { color: string }): React.JSX.Element {
  return (
    <group>
      {/* 座面 */}
      <mesh position={[0, 0.46, 0]} castShadow>
        <cylinderGeometry args={[0.24, 0.22, 0.07, 32]} />
        <meshStandardMaterial color={color} metalness={0.15} roughness={0.7} />
      </mesh>
      {/* 靠背 */}
      <mesh position={[0, 0.72, 0.22]} rotation={[0.12, 0, 0]} castShadow>
        <boxGeometry args={[0.42, 0.42, 0.06]} />
        <meshStandardMaterial color={color} metalness={0.15} roughness={0.7} />
      </mesh>
      {/* 中柱 */}
      <mesh position={[0, 0.28, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.3, 16]} />
        <meshStandardMaterial color="#2c313c" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* 底座圆盘 */}
      <mesh position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.28, 0.3, 0.03, 32]} />
        <meshStandardMaterial color="#22262f" metalness={0.5} roughness={0.45} />
      </mesh>
    </group>
  )
}

/**
 * 圆形会议桌 + 环绕椅子 + 中央硬表面协作信号。
 * seats 默认 4;椅子均匀环绕并朝向桌心。中央信号保持低轮廓、固定且克制。
 */
export default function MeetingTable({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  seats = 4
}: OfficeProp & { seats?: number }): React.JSX.Element {
  const seatCount = Math.max(1, Math.floor(seats))

  // 椅子的角度/位置/朝向预计算(闭包外复用,避免每帧计算)
  const chairs = useMemo(() => {
    const out: Array<{ x: number; z: number; rotY: number }> = []
    for (let i = 0; i < seatCount; i++) {
      const a = (i / seatCount) * Math.PI * 2
      const x = Math.sin(a) * CHAIR_ORBIT
      const z = Math.cos(a) * CHAIR_ORBIT
      // 靠背在 +local Z,面向中心需绕 Y 旋转,使靠背背离桌心
      out.push({ x, z, rotY: a + Math.PI })
    }
    return out
  }, [seatCount])

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 桌面 */}
      <mesh position={[0, 0.72, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[TABLE_RADIUS, TABLE_RADIUS, 0.06, 48]} />
        <meshStandardMaterial color="#3a4150" metalness={0.25} roughness={0.55} />
      </mesh>
      {/* 桌面高光内圈 */}
      <mesh position={[0, 0.755, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[TABLE_RADIUS - 0.12, TABLE_RADIUS - 0.04, 48]} />
        <meshStandardMaterial color="#9fb2c2" metalness={0.3} roughness={0.5} opacity={0.28} transparent />
      </mesh>
      {/* 中柱 */}
      <mesh position={[0, 0.36, 0]}>
        <cylinderGeometry args={[0.12, 0.16, 0.7, 24]} />
        <meshStandardMaterial color="#2c313c" metalness={0.5} roughness={0.4} />
      </mesh>
      {/* 底座 */}
      <mesh position={[0, 0.03, 0]} receiveShadow>
        <cylinderGeometry args={[0.42, 0.5, 0.06, 32]} />
        <meshStandardMaterial color="#22262f" metalness={0.5} roughness={0.45} />
      </mesh>

      {/* 中央协作信号:固定圆柱基座 + 窄盒状态条。 */}
      <group position={[0, 0.755, 0]}>
        <mesh position={[0, 0.035, 0]} castShadow>
          <cylinderGeometry args={[0.18, 0.2, 0.07, 24]} />
          <meshStandardMaterial color="#252b34" metalness={0.58} roughness={0.38} />
        </mesh>
        <mesh position={[0, 0.09, 0]} castShadow>
          <boxGeometry args={[0.22, 0.035, 0.08]} />
          <meshStandardMaterial
            color={ACCENT}
            emissive={ACCENT}
            emissiveIntensity={0.28}
            roughness={0.32}
            metalness={0.38}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* 环绕椅子 */}
      {chairs.map((c, i) => (
        <group key={i} position={[c.x, 0, c.z]} rotation={[0, c.rotY, 0]}>
          <Chair color="#2f3542" />
        </group>
      ))}
    </group>
  )
}
