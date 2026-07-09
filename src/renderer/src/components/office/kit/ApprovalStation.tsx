import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { MeshStandardMaterial } from 'three'

export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

const BASE = '#171b22'
const PANEL = '#202733'
const METAL = '#303845'
const ACCENT = '#e0a33c'
const CYAN = '#8fe9ff'

/**
 * 审批/确认台:等待授权的 Agent 会走到这里。
 * 造型保持低矮、剖切视角友好,避免像墙体或大屏一样遮挡工位主体。
 */
export default function ApprovalStation({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const scanRef = useRef<MeshStandardMaterial>(null)
  const phase = useMemo(() => (position[0] * 0.7 + position[2] * 1.3) % (Math.PI * 2), [position])

  useFrame((state) => {
    const t = state.clock.getElapsedTime() + phase
    const pulse = pulseRef.current
    const scan = scanRef.current
    if (pulse) pulse.emissiveIntensity = 0.9 + Math.sin(t * 1.8) * 0.28
    if (scan) scan.emissiveIntensity = 1.2 + Math.sin(t * 3.2) * 0.4
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 地面停靠垫:告诉用户这里是授权机器人停留点。 */}
      <mesh position={[-0.72, 0.018, 0.04]} rotation={[0, 0, 0]} receiveShadow>
        <cylinderGeometry args={[0.42, 0.42, 0.022, 40]} />
        <meshStandardMaterial
          color={ACCENT}
          emissive={ACCENT}
          emissiveIntensity={0.18}
          transparent
          opacity={0.32}
          toneMapped={false}
        />
      </mesh>

      {/* 低矮确认台。 */}
      <mesh position={[0, 0.29, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.96, 0.58, 0.48]} />
        <meshStandardMaterial color={BASE} metalness={0.26} roughness={0.74} />
      </mesh>
      <mesh position={[0, 0.6, -0.02]} castShadow receiveShadow>
        <boxGeometry args={[1.04, 0.045, 0.54]} />
        <meshStandardMaterial color={METAL} metalness={0.36} roughness={0.5} />
      </mesh>

      {/* 倾斜操作面板。 */}
      <group position={[0, 0.78, -0.04]} rotation={[-0.36, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.74, 0.36, 0.04]} />
          <meshStandardMaterial color={PANEL} metalness={0.34} roughness={0.46} />
        </mesh>
        <mesh position={[0, 0, 0.026]}>
          <planeGeometry args={[0.6, 0.24]} />
          <meshStandardMaterial
            ref={pulseRef}
            color={ACCENT}
            emissive={ACCENT}
            emissiveIntensity={0.9}
            transparent
            opacity={0.62}
            toneMapped={false}
          />
        </mesh>

        {/* 几何确认符号,不用贴图/字体。 */}
        <mesh position={[-0.08, -0.02, 0.054]} rotation={[0, 0, -0.72]}>
          <boxGeometry args={[0.22, 0.035, 0.018]} />
          <meshStandardMaterial color="#fff2cf" emissive={ACCENT} emissiveIntensity={0.55} toneMapped={false} />
        </mesh>
        <mesh position={[0.11, 0.015, 0.055]} rotation={[0, 0, 0.74]}>
          <boxGeometry args={[0.38, 0.035, 0.018]} />
          <meshStandardMaterial color="#fff2cf" emissive={ACCENT} emissiveIntensity={0.55} toneMapped={false} />
        </mesh>
      </group>

      {/* 右侧权限芯片槽。 */}
      <group position={[0.41, 0.73, 0.16]} rotation={[-0.16, 0, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.2, 0.13, 0.032]} />
          <meshStandardMaterial color="#11151b" metalness={0.3} roughness={0.52} />
        </mesh>
        <mesh position={[0, 0, 0.022]}>
          <boxGeometry args={[0.14, 0.032, 0.012]} />
          <meshStandardMaterial ref={scanRef} color={CYAN} emissive={CYAN} emissiveIntensity={1.2} toneMapped={false} />
        </mesh>
      </group>

      {/* 后侧短立屏,高度低于工牌,避免挡主体。 */}
      <group position={[0.2, 0.98, -0.3]} rotation={[0.16, -0.28, 0]}>
        <mesh castShadow>
          <boxGeometry args={[0.34, 0.36, 0.04]} />
          <meshStandardMaterial color="#151920" metalness={0.38} roughness={0.5} />
        </mesh>
        <mesh position={[0, 0, 0.026]}>
          <planeGeometry args={[0.25, 0.26]} />
          <meshStandardMaterial color={CYAN} emissive={CYAN} emissiveIntensity={0.48} toneMapped={false} />
        </mesh>
        <mesh position={[0, -0.31, -0.01]} castShadow>
          <boxGeometry args={[0.065, 0.1, 0.065]} />
          <meshStandardMaterial color={METAL} metalness={0.5} roughness={0.42} />
        </mesh>
      </group>
    </group>
  )
}
