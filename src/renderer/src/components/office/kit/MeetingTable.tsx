import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color } from 'three'
import type { Group, Mesh, MeshStandardMaterial } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const ACCENT = '#8fe9ff'
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
 * 圆形会议桌 + 环绕椅子 + 中央发光协作枢纽。
 * seats 默认 4;椅子均匀环绕并朝向桌心。中央枢纽缓慢旋转并呼吸辉光(配合 Bloom)。
 */
export default function MeetingTable({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  seats = 4
}: OfficeProp & { seats?: number }): React.JSX.Element {
  const hubRef = useRef<Group>(null)
  const hubMatRef = useRef<MeshStandardMaterial>(null)
  const glowRef = useRef<Mesh>(null)

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

  const accentColor = useMemo(() => new Color(ACCENT), [])

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (hubRef.current) hubRef.current.rotation.y = t * 0.6
    if (hubMatRef.current) {
      hubMatRef.current.emissive.copy(accentColor)
      hubMatRef.current.emissiveIntensity = 1.6 + Math.sin(t * 2) * 0.6
    }
    if (glowRef.current) {
      const s = 1 + Math.sin(t * 1.8) * 0.06
      glowRef.current.scale.setScalar(s)
    }
  })

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
        <meshStandardMaterial color="#f4f4f4" metalness={0.3} roughness={0.5} opacity={0.35} transparent />
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

      {/* 中央协作枢纽:发光核心(供 Bloom) */}
      <group ref={hubRef} position={[0, 0.9, 0]}>
        <mesh>
          <icosahedronGeometry args={[0.13, 1]} />
          <meshStandardMaterial
            ref={hubMatRef}
            color={ACCENT}
            emissive={ACCENT}
            emissiveIntensity={1.8}
            toneMapped={false}
          />
        </mesh>
      </group>
      {/* 枢纽下方桌面发光基座环 */}
      <mesh ref={glowRef} position={[0, 0.76, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.16, 0.24, 32]} />
        <meshStandardMaterial
          color={ACCENT}
          emissive={ACCENT}
          emissiveIntensity={1.4}
          transparent
          opacity={0.7}
          toneMapped={false}
        />
      </mesh>

      {/* 环绕椅子 */}
      {chairs.map((c, i) => (
        <group key={i} position={[c.x, 0, c.z]} rotation={[0, c.rotY, 0]}>
          <Chair color="#2f3542" />
        </group>
      ))}
    </group>
  )
}
