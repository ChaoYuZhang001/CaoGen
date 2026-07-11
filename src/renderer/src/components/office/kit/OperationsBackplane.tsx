import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { MeshStandardMaterial } from 'three'
import type { OfficeProp } from './Floor'

const SIGNAL_CYAN = '#72b8c8'
const STEEL_BLUE = '#7f95a6'
const APPROVAL = '#6f8fa0'
const PANEL = '#101820'
const FRAME = '#26313b'
const GLASS = '#8294a3'
const DIM = '#516071'

function PulseBar({
  position,
  size,
  color = SIGNAL_CYAN,
  intensity = 0.42,
  opacity = 0.72
}: {
  position: [number, number, number]
  size: [number, number, number]
  color?: string
  intensity?: number
  opacity?: number
}): React.JSX.Element {
  return (
    <mesh position={position}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={intensity}
        transparent
        opacity={opacity}
        toneMapped={false}
      />
    </mesh>
  )
}

function OperationsPanel({
  position,
  accent,
  index
}: {
  position: [number, number, number]
  accent: string
  index: number
}): React.JSX.Element {
  const bars = useMemo(
    () =>
      Array.from({ length: 5 }, (_, i) => ({
        y: 0.18 - i * 0.075,
        w: 0.28 + ((index + i) % 3) * 0.13,
        x: -0.16 + ((index * 7 + i * 3) % 4) * 0.025
      })),
    [index]
  )

  return (
    <group position={position}>
      <mesh receiveShadow>
        <boxGeometry args={[0.88, 0.58, 0.032]} />
        <meshStandardMaterial color={PANEL} metalness={0.22} roughness={0.58} transparent opacity={0.78} />
      </mesh>
      <mesh position={[0, 0, 0.022]}>
        <planeGeometry args={[0.78, 0.48]} />
        <meshStandardMaterial color={GLASS} transparent opacity={0.065} roughness={0.24} metalness={0.28} depthWrite={false} />
      </mesh>
      <PulseBar position={[0, 0.25, 0.04]} size={[0.68, 0.018, 0.014]} color={accent} intensity={0.42} opacity={0.74} />
      {bars.map((bar, i) => (
        <PulseBar
          key={`${index}-bar-${i}`}
          position={[bar.x - (0.64 - bar.w) / 2, bar.y, 0.04]}
          size={[bar.w, 0.018, 0.014]}
          color={i % 3 === 0 ? accent : DIM}
          intensity={i % 3 === 0 ? 0.38 : 0.1}
          opacity={i % 3 === 0 ? 0.72 : 0.48}
        />
      ))}
      {Array.from({ length: 4 }).map((_, i) => {
        const active = (index + i) % 2 === 0
        return (
          <mesh key={`${index}-node-${i}`} position={[-0.32 + i * 0.21, -0.22, 0.045]}>
            <boxGeometry args={[0.045, 0.045, 0.014]} />
            <meshStandardMaterial
              color={active ? accent : '#1e2834'}
              emissive={active ? accent : '#000000'}
              emissiveIntensity={active ? 0.46 : 0}
              transparent
              opacity={active ? 0.82 : 0.55}
              toneMapped={false}
            />
          </mesh>
        )
      })}
    </group>
  )
}

function DataTrunk(): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = 0.08 + Math.sin(t * 2.6) * 0.025
      pulseRef.current.opacity = 0.22 + Math.sin(t * 1.8) * 0.03
    }
  })

  return (
    <group>
      {/* 中央数据主干和四条工位分支,全部贴地,不遮挡机器人/屏幕。 */}
      <mesh position={[0, 0.041, -1.05]} receiveShadow>
        <boxGeometry args={[0.1, 0.018, 6.1]} />
        <meshStandardMaterial color="#0f151d" metalness={0.22} roughness={0.62} transparent opacity={0.86} />
      </mesh>
      <mesh position={[0, 0.058, -1.05]} receiveShadow>
        <boxGeometry args={[0.026, 0.012, 5.72]} />
        <meshStandardMaterial
          ref={pulseRef}
          color={STEEL_BLUE}
          emissive={STEEL_BLUE}
          emissiveIntensity={0.08}
          transparent
          opacity={0.22}
          toneMapped={false}
        />
      </mesh>
      {[
        [-1.72, -3.28, -0.86],
        [1.72, -3.28, 0.86],
        [-1.72, -0.1, -0.86],
        [1.72, -0.1, 0.86]
      ].map(([x, z, dir], i) => (
        <group key={`branch-${i}`}>
          <mesh position={[x / 2, 0.046, z]} receiveShadow>
            <boxGeometry args={[Math.abs(x), 0.014, 0.056]} />
            <meshStandardMaterial color="#111923" metalness={0.2} roughness={0.64} transparent opacity={0.78} />
          </mesh>
          <mesh position={[x / 2, 0.06, z + dir * 0.08]} receiveShadow>
            <boxGeometry args={[Math.abs(x) * 0.82, 0.01, 0.02]} />
            <meshStandardMaterial color={STEEL_BLUE} emissive={STEEL_BLUE} emissiveIntensity={0.05} transparent opacity={0.2} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {[-3.82, -2.62, -1.42, -0.22, 0.98, 2.18].map((z, i) => (
        <mesh key={`node-${z}`} position={[0, 0.074, z]} receiveShadow>
          <boxGeometry args={[i % 3 === 0 ? 0.18 : 0.12, 0.01, 0.035]} />
          <meshStandardMaterial
            color={i % 3 === 0 ? APPROVAL : SIGNAL_CYAN}
            emissive={i % 3 === 0 ? APPROVAL : SIGNAL_CYAN}
            emissiveIntensity={0.08}
            transparent
            opacity={0.24}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  )
}

/**
 * 后墙运营背板 + 地面数据总线。
 * 这是控制室的"运行感"层:抽象任务面板、数据流和工位分支,全部放在后景/贴地,
 * 不使用文字或真实厂商标识,也不进入默认相机与机器人之间。
 */
export default function OperationsBackplane({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <DataTrunk />

      <group position={[0, 1.42, -8.68]}>
        <mesh position={[0, 0, -0.018]} receiveShadow>
          <boxGeometry args={[5.15, 0.92, 0.032]} />
          <meshStandardMaterial color="#0d141d" metalness={0.24} roughness={0.74} transparent opacity={0.24} />
        </mesh>
        {[-1.95, 0, 1.95].map((x, i) => (
          <PulseBar
            key={`segment-signal-${x}`}
            position={[x, 0.6, 0.012]}
            size={[0.64, 0.018, 0.014]}
            color={i === 1 ? APPROVAL : SIGNAL_CYAN}
            intensity={0.18}
            opacity={0.28}
          />
        ))}
        {[-1.95, 0, 1.95].map((x) => (
          <PulseBar
            key={`segment-baseline-${x}`}
            position={[x, -0.6, 0.012]}
            size={[0.48, 0.014, 0.012]}
            color={DIM}
            intensity={0.06}
            opacity={0.22}
          />
        ))}
        <OperationsPanel position={[-1.95, 0.02, 0.04]} accent={SIGNAL_CYAN} index={0} />
        <OperationsPanel position={[0, 0.02, 0.04]} accent={APPROVAL} index={1} />
        <OperationsPanel position={[1.95, 0.02, 0.04]} accent={SIGNAL_CYAN} index={2} />
        {[-2.85, -0.95, 0.95, 2.85].map((x, i) => (
          <mesh key={`uplink-${x}`} position={[x, -0.76, 0.05]}>
            <boxGeometry args={[0.035, 0.3, 0.018]} />
            <meshStandardMaterial
            color={i % 2 === 0 ? SIGNAL_CYAN : APPROVAL}
            emissive={i % 2 === 0 ? SIGNAL_CYAN : APPROVAL}
            emissiveIntensity={0.12}
            transparent
            opacity={0.3}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  )
}
