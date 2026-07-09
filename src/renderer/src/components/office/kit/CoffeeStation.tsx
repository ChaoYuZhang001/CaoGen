import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { MeshStandardMaterial } from 'three'

/** 视觉道具通用入参:统一 position / rotation / scale */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const CYAN = '#8fe9ff'
const COUNTER = '#1e1e1e'
const METAL = '#2c313c'
const WHITE = '#f4f4f4'
const WATER = '#9fe8ff'

// 杯子摆位(相对台面),闭包外定义避免每帧重建
const CUPS: Array<{ x: number; z: number; c: string }> = [
  { x: -0.5, z: 0.18, c: WHITE },
  { x: -0.32, z: 0.24, c: WHITE },
  { x: -0.14, z: 0.16, c: '#d8d8d8' }
]

/**
 * 茶水角:小台面 + 咖啡机 + 几个杯子 + 饮水机。
 * 咖啡机正面有个小发光指示灯(青色),缓慢呼吸,配合 Bloom(toneMapped={false})。
 * 台面约 1.4m 宽,占地约 2m×2m。
 */
export default function CoffeeStation({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const ledMatRef = useRef<MeshStandardMaterial>(null)

  // 闭包外复用:相位错开呼吸
  const phase = useMemo(() => (position[0] * 1.1 + position[2] * 0.6) % (Math.PI * 2), [position])

  useFrame((state) => {
    const t = state.clock.getElapsedTime() + phase
    const led = ledMatRef.current
    if (led) {
      // 指示灯缓慢呼吸,偶尔像"冲煮就绪"般轻闪
      led.emissiveIntensity = 1.6 + Math.sin(t * 2.2) * 0.5
    }
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 机器人补水停靠垫:低矮不挡视线,把茶水角从道具变成可抵达服务点。 */}
      <group position={[-0.52, 0.018, 0.78]}>
        <mesh receiveShadow>
          <cylinderGeometry args={[0.34, 0.34, 0.018, 36]} />
          <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={0.22} transparent opacity={0.28} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.018, 0]}>
          <torusGeometry args={[0.28, 0.012, 8, 36]} />
          <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={0.42} transparent opacity={0.7} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.024, -0.02]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.08, 0.18, 3]} />
          <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={0.46} transparent opacity={0.68} toneMapped={false} />
        </mesh>
      </group>

      {/* ---- 小台面(柜体 + 台板) ---- */}
      {/* 柜体 */}
      <mesh position={[0, 0.36, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.4, 0.72, 0.5]} />
        <meshStandardMaterial color={COUNTER} metalness={0.15} roughness={0.75} />
      </mesh>
      {/* 台板(略微外挑,浅色高光) */}
      <mesh position={[0, 0.735, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.46, 0.04, 0.56]} />
        <meshStandardMaterial color="#3a4150" metalness={0.3} roughness={0.5} />
      </mesh>
      {/* 柜门缝(装饰性中缝) */}
      <mesh position={[0, 0.36, 0.251]}>
        <boxGeometry args={[0.02, 0.6, 0.005]} />
        <meshStandardMaterial color="#101010" />
      </mesh>

      {/* ---- 咖啡机(台面右侧) ---- */}
      <group position={[0.42, 0.755, 0.02]}>
        {/* 机身 */}
        <mesh position={[0, 0.19, 0]} castShadow>
          <boxGeometry args={[0.3, 0.38, 0.32]} />
          <meshStandardMaterial color={METAL} metalness={0.55} roughness={0.35} />
        </mesh>
        {/* 顶部豆仓 */}
        <mesh position={[0, 0.42, -0.03]} castShadow>
          <cylinderGeometry args={[0.09, 0.1, 0.12, 16]} />
          <meshStandardMaterial color="#15181e" metalness={0.4} roughness={0.4} />
        </mesh>
        {/* 出水口 */}
        <mesh position={[0, 0.18, 0.14]}>
          <cylinderGeometry args={[0.018, 0.018, 0.08, 12]} />
          <meshStandardMaterial color="#40485a" metalness={0.7} roughness={0.3} />
        </mesh>
        {/* 接水滴盘 */}
        <mesh position={[0, 0.03, 0.13]}>
          <boxGeometry args={[0.16, 0.02, 0.1]} />
          <meshStandardMaterial color="#101216" metalness={0.3} roughness={0.6} />
        </mesh>
        {/* 出水口下的小咖啡杯 */}
        <mesh position={[0, 0.075, 0.13]} castShadow>
          <cylinderGeometry args={[0.035, 0.028, 0.07, 16]} />
          <meshStandardMaterial color={WHITE} roughness={0.6} />
        </mesh>

        {/* 发光指示灯(青色,呼吸;供 Bloom) */}
        <mesh position={[0.11, 0.28, 0.161]}>
          <sphereGeometry args={[0.018, 16, 16]} />
          <meshStandardMaterial
            ref={ledMatRef}
            color={CYAN}
            emissive={CYAN}
            emissiveIntensity={1.6}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* ---- 台面上的备用杯子 ---- */}
      {CUPS.map((cup, i) => (
        <group key={i} position={[cup.x, 0.755, cup.z]}>
          {/* 杯身 */}
          <mesh position={[0, 0.045, 0]} castShadow>
            <cylinderGeometry args={[0.04, 0.032, 0.09, 16]} />
            <meshStandardMaterial color={cup.c} roughness={0.55} metalness={0.05} />
          </mesh>
          {/* 把手 */}
          <mesh position={[0.05, 0.045, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.025, 0.007, 8, 16]} />
            <meshStandardMaterial color={cup.c} roughness={0.55} />
          </mesh>
        </group>
      ))}

      {/* ---- 饮水机(台面左侧,落地) ---- */}
      <group position={[-0.82, 0, 0]}>
        {/* 机身 */}
        <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.34, 1.1, 0.34]} />
          <meshStandardMaterial color="#202020" metalness={0.2} roughness={0.7} />
        </mesh>
        {/* 顶部水桶(半透青蓝) */}
        <mesh position={[0, 1.28, 0]} castShadow>
          <cylinderGeometry args={[0.16, 0.14, 0.34, 32]} />
          <meshStandardMaterial
            color="#bfe9f2"
            transparent
            opacity={0.45}
            roughness={0.15}
            metalness={0.1}
          />
        </mesh>
        {/* 桶颈 */}
        <mesh position={[0, 1.08, 0]}>
          <cylinderGeometry args={[0.06, 0.08, 0.08, 24]} />
          <meshStandardMaterial color="#a0d8e0" transparent opacity={0.5} roughness={0.2} />
        </mesh>
        {/* 出水面板 */}
        <mesh position={[0, 0.66, 0.171]}>
          <boxGeometry args={[0.24, 0.2, 0.02]} />
          <meshStandardMaterial color="#15181e" metalness={0.3} roughness={0.5} />
        </mesh>
        {/* 冷/热龙头 */}
        <mesh position={[-0.05, 0.6, 0.19]}>
          <boxGeometry args={[0.03, 0.05, 0.03]} />
          <meshStandardMaterial color="#4aa3ff" metalness={0.4} roughness={0.4} />
        </mesh>
        <mesh position={[0.05, 0.6, 0.19]}>
          <boxGeometry args={[0.03, 0.05, 0.03]} />
          <meshStandardMaterial color="#d8593c" metalness={0.4} roughness={0.4} />
        </mesh>
        {/* 接水格栅 */}
        <mesh position={[0, 0.48, 0.18]}>
          <boxGeometry args={[0.22, 0.02, 0.06]} />
          <meshStandardMaterial color="#101216" metalness={0.3} roughness={0.6} />
        </mesh>
        {/* 补水信标:几何水滴 + 短光条,不使用文字标签。 */}
        <group position={[0, 1.58, 0.05]}>
          <mesh position={[0, 0.045, 0]}>
            <sphereGeometry args={[0.06, 18, 18]} />
            <meshStandardMaterial color={WATER} emissive={WATER} emissiveIntensity={0.36} transparent opacity={0.88} toneMapped={false} />
          </mesh>
          <mesh position={[0, -0.025, 0]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.052, 0.12, 18]} />
            <meshStandardMaterial color={WATER} emissive={WATER} emissiveIntensity={0.32} transparent opacity={0.84} toneMapped={false} />
          </mesh>
          <mesh position={[0, -0.135, 0]}>
            <boxGeometry args={[0.26, 0.018, 0.014]} />
            <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={0.48} toneMapped={false} />
          </mesh>
        </group>
      </group>

      {/* 窄杯架:补足真实茶水间细节,也让远景更容易识别这里不是普通柜子。 */}
      <group position={[-0.26, 1.02, 0.255]}>
        <mesh castShadow>
          <boxGeometry args={[0.42, 0.055, 0.06]} />
          <meshStandardMaterial color="#303845" metalness={0.36} roughness={0.52} />
        </mesh>
        {[-0.14, 0, 0.14].map((x) => (
          <mesh key={x} position={[x, 0.055, 0.01]} castShadow>
            <cylinderGeometry args={[0.032, 0.026, 0.07, 14]} />
            <meshStandardMaterial color="#dce7f2" roughness={0.5} metalness={0.08} />
          </mesh>
        ))}
      </group>
    </group>
  )
}
