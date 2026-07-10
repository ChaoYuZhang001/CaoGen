import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group, MeshStandardMaterial } from 'three'

/** 视觉道具通用入参:统一 position / rotation / scale */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const LAMP_COOL = '#b9cbe0'

/**
 * 可折臂台灯:底座 + 两段臂(下臂/上臂)+ 灯头。
 * on 时灯头冷灰色发光并投出一盏 pointLight,发光材质配合 Bloom(toneMapped={false})。
 */
export default function DeskLamp({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  on = true
}: OfficeProp & { on?: boolean }): React.JSX.Element {
  const shadeMatRef = useRef<MeshStandardMaterial>(null)
  const bulbRef = useRef<Group>(null)

  // 闭包外复用:避免 useFrame 内 new
  const phase = useMemo(() => (position[0] * 1.3 + position[2] * 0.7) % (Math.PI * 2), [position])

  useFrame((state) => {
    const t = state.clock.getElapsedTime() + phase
    const shade = shadeMatRef.current
    if (shade) {
      // 亮起时暖光轻微呼吸;熄灭时收暗
      shade.emissiveIntensity = on ? 1.6 + Math.sin(t * 2.4) * 0.25 : 0.04
    }
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 底座:低矮轴承座 + 短颈 */}
      <mesh position={[0, 0.02, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.24, 0.04, 0.18]} />
        <meshStandardMaterial color="#22252c" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.06, 16]} />
        <meshStandardMaterial color="#2c313c" metalness={0.7} roughness={0.35} />
      </mesh>

      {/* 关节 1(底座顶) */}
      <mesh position={[0, 0.1, 0]}>
        <boxGeometry args={[0.066, 0.042, 0.052]} />
        <meshStandardMaterial color="#3a4150" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* 下臂:向后上方倾斜 */}
      <group position={[0, 0.1, 0]} rotation={[0.5, 0, 0]}>
        <mesh position={[0, 0.16, 0]} castShadow>
          <cylinderGeometry args={[0.016, 0.016, 0.32, 12]} />
          <meshStandardMaterial color="#40485a" metalness={0.7} roughness={0.3} />
        </mesh>

        {/* 关节 2 */}
        <mesh position={[0, 0.32, 0]}>
          <boxGeometry args={[0.056, 0.038, 0.046]} />
          <meshStandardMaterial color="#3a4150" metalness={0.7} roughness={0.3} />
        </mesh>

        {/* 上臂:向前下方折回 */}
        <group position={[0, 0.32, 0]} rotation={[-1.7, 0, 0]}>
          <mesh position={[0, 0.14, 0]} castShadow>
            <cylinderGeometry args={[0.016, 0.016, 0.28, 12]} />
            <meshStandardMaterial color="#40485a" metalness={0.7} roughness={0.3} />
          </mesh>

          {/* 关节 3(灯头接点) */}
          <mesh position={[0, 0.28, 0]}>
            <boxGeometry args={[0.056, 0.038, 0.046]} />
            <meshStandardMaterial color="#3a4150" metalness={0.7} roughness={0.3} />
          </mesh>

          {/* 灯头:锥形罩,罩口朝下前方 */}
          <group ref={bulbRef} position={[0, 0.28, 0]} rotation={[1.2, 0, 0]}>
            <mesh position={[0, 0.02, 0]} castShadow>
              <coneGeometry args={[0.11, 0.16, 32, 1, true]} />
              <meshStandardMaterial color="#2c313c" metalness={0.6} roughness={0.4} side={2} />
            </mesh>
            {/* 罩内暖色发光盘(供 Bloom) */}
            <mesh position={[0, -0.05, 0]} rotation={[Math.PI, 0, 0]}>
              <circleGeometry args={[0.09, 32]} />
              <meshStandardMaterial
                ref={shadeMatRef}
                color={LAMP_COOL}
                emissive={LAMP_COOL}
                emissiveIntensity={on ? 1.6 : 0.04}
                toneMapped={false}
              />
            </mesh>
            {/* 投射光:仅 on 时点亮 */}
            {on && (
              <pointLight
                position={[0, -0.12, 0]}
                intensity={0.9}
                distance={2.4}
                decay={2}
                color={LAMP_COOL}
                castShadow
              />
            )}
          </group>
        </group>
      </group>
    </group>
  )
}
