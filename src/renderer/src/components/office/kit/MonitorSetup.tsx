import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group, Mesh, MeshStandardMaterial } from 'three'

/** 视觉道具通用属性:局部放置于 <Canvas> 内的某个 group 下 */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

type MonitorSetupProps = OfficeProp & {
  /** 屏幕发光色(默认青)。 */
  screenColor?: string
  /** 屏幕辉光强度倍率(默认 1)。 */
  glow?: number
}

// 深灰机身/支架配色,克制中性,主黑副白
const CASE_COLOR = '#1c1f26'
const BEZEL_COLOR = '#15181e'
const ARM_COLOR = '#2c313c'
const BASE_COLOR = '#22262f'
const HIGHLIGHT = '#f4f4f4'
const SCREEN_INK = '#071018'
const SCREEN_TEXT = '#dce7f2'

/**
 * 双显示器 + 显示器支架臂。
 * 两块屏幕对称内八字摆放,屏幕用 emissive + toneMapped={false} 发光(配合 Bloom),
 * glow 控制发光强度并带轻微呼吸脉动。几何体全部代码生成。
 */
export default function MonitorSetup({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  screenColor = '#8fe9ff',
  glow = 1
}: MonitorSetupProps): React.JSX.Element {
  const leftScreenRef = useRef<Mesh>(null)
  const rightScreenRef = useRef<Mesh>(null)

  // 屏幕基准发光强度(闭包外语义,避免每帧重算)
  const baseGlow = useMemo(() => 0.9 * glow, [glow])

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    // 两屏相位错开,产生轻微不同步的呼吸感
    const left = leftScreenRef.current?.material as MeshStandardMaterial | undefined
    const right = rightScreenRef.current?.material as MeshStandardMaterial | undefined
    if (left) left.emissiveIntensity = baseGlow + Math.sin(t * 2.4) * 0.18 * glow
    if (right) right.emissiveIntensity = baseGlow + Math.sin(t * 2.4 + 1.1) * 0.18 * glow
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 共用底座 */}
      <mesh position={[0, 0.02, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.22, 0.26, 0.04, 32]} />
        <meshStandardMaterial color={BASE_COLOR} metalness={0.5} roughness={0.5} />
      </mesh>

      {/* 支架立柱 */}
      <mesh position={[0, 0.28, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.045, 0.52, 16]} />
        <meshStandardMaterial color={ARM_COLOR} metalness={0.6} roughness={0.4} />
      </mesh>

      {/* 立柱顶部枢纽 */}
      <mesh position={[0, 0.54, 0]} castShadow>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshStandardMaterial color={ARM_COLOR} metalness={0.6} roughness={0.4} />
      </mesh>

      {/* 左显示器(含支臂 + 机身 + 发光屏) */}
      <Monitor
        side="left"
        screenRef={leftScreenRef}
        screenColor={screenColor}
        baseGlow={baseGlow}
      />
      {/* 右显示器 */}
      <Monitor
        side="right"
        screenRef={rightScreenRef}
        screenColor={screenColor}
        baseGlow={baseGlow}
      />
    </group>
  )
}

interface MonitorProps {
  side: 'left' | 'right'
  screenRef: React.RefObject<Mesh>
  screenColor: string
  baseGlow: number
}

/** 单块显示器:横向支臂 + 云台 + 机身外壳 + 发光屏面 + 状态灯 */
function Monitor({ side, screenRef, screenColor, baseGlow }: MonitorProps): React.JSX.Element {
  const dir = side === 'left' ? -1 : 1
  // 内八字:各自向内旋转,面向坐在 +Z 一侧的使用者
  const yaw = -dir * 0.32
  const armMidX = dir * 0.28
  const headX = dir * 0.56

  const groupRef = useRef<Group>(null)

  return (
    <group ref={groupRef}>
      {/* 横向支臂:从中央枢纽伸向两侧 */}
      <mesh position={[armMidX, 0.54, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.028, 0.028, 0.56, 12]} />
        <meshStandardMaterial color={ARM_COLOR} metalness={0.6} roughness={0.4} />
      </mesh>

      {/* 屏体云台/后挂点 */}
      <group position={[headX, 0.62, 0]} rotation={[0, yaw, 0]}>
        {/* 挂点小球 */}
        <mesh position={[0, -0.08, -0.03]} castShadow>
          <sphereGeometry args={[0.04, 16, 16]} />
          <meshStandardMaterial color={ARM_COLOR} metalness={0.6} roughness={0.4} />
        </mesh>

        {/* 机身外壳 */}
        <mesh position={[0, 0, -0.02]} castShadow>
          <boxGeometry args={[0.62, 0.4, 0.045]} />
          <meshStandardMaterial color={CASE_COLOR} metalness={0.35} roughness={0.6} />
        </mesh>

        {/* 边框 */}
        <mesh position={[0, 0, 0.001]}>
          <boxGeometry args={[0.6, 0.38, 0.03]} />
          <meshStandardMaterial color={BEZEL_COLOR} metalness={0.2} roughness={0.7} />
        </mesh>

        {/* 发光屏面(emissive + toneMapped=false,供 Bloom) */}
        <mesh ref={screenRef} position={[0, 0, 0.02]}>
          <planeGeometry args={[0.54, 0.32]} />
          <meshStandardMaterial
            color={screenColor}
            emissive={screenColor}
            emissiveIntensity={baseGlow}
            toneMapped={false}
          />
        </mesh>
        <ScreenWorkspace side={side} screenColor={screenColor} />

        {/* 机身底缘白高光条,统一写实感 */}
        <mesh position={[0, -0.185, 0.005]}>
          <boxGeometry args={[0.6, 0.012, 0.03]} />
          <meshStandardMaterial color={HIGHLIGHT} metalness={0.3} roughness={0.5} />
        </mesh>

        {/* 电源状态灯(轻发光) */}
        <mesh position={[0.26, -0.175, 0.02]}>
          <sphereGeometry args={[0.012, 8, 8]} />
          <meshStandardMaterial
            color={screenColor}
            emissive={screenColor}
            emissiveIntensity={1.4}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  )
}

function ScreenWorkspace({ side, screenColor }: { side: 'left' | 'right'; screenColor: string }): React.JSX.Element {
  const dir = side === 'left' ? -1 : 1
  const lineYs = side === 'left' ? [0.085, 0.045, 0.005, -0.035] : [0.07, 0.025, -0.02]
  const lineWidths = side === 'left' ? [0.28, 0.22, 0.31, 0.18] : [0.18, 0.28, 0.21]

  return (
    <group position={[0, 0, 0.025]}>
      <mesh position={[0, 0.112, 0]}>
        <boxGeometry args={[0.46, 0.032, 0.006]} />
        <meshStandardMaterial color={SCREEN_INK} transparent opacity={0.5} roughness={0.2} metalness={0.1} />
      </mesh>
      <mesh position={[-0.16, 0.112, 0.004]}>
        <boxGeometry args={[0.12, 0.012, 0.006]} />
        <meshStandardMaterial color={SCREEN_TEXT} emissive={SCREEN_TEXT} emissiveIntensity={0.28} toneMapped={false} />
      </mesh>
      <mesh position={[0.15, 0.112, 0.004]}>
        <boxGeometry args={[0.1, 0.012, 0.006]} />
        <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={0.55} toneMapped={false} />
      </mesh>

      {lineYs.map((y, i) => (
        <group key={`${side}-line-${i}`} position={[-0.14 + i * 0.012 * dir, y, 0.004]}>
          <mesh position={[lineWidths[i] / 2, 0, 0]}>
            <boxGeometry args={[lineWidths[i], 0.012, 0.006]} />
            <meshStandardMaterial color={SCREEN_TEXT} emissive={SCREEN_TEXT} emissiveIntensity={0.18} toneMapped={false} transparent opacity={0.82} />
          </mesh>
          <mesh position={[-0.038, 0, 0.002]}>
            <boxGeometry args={[0.026, 0.012, 0.007]} />
            <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={0.42} toneMapped={false} />
          </mesh>
        </group>
      ))}

      <mesh position={[0.14 * dir, -0.085, 0.004]}>
        <boxGeometry args={[0.19, 0.086, 0.006]} />
        <meshStandardMaterial color={SCREEN_INK} transparent opacity={0.38} roughness={0.24} metalness={0.12} />
      </mesh>
      {[0.025, 0.052, 0.038, 0.068].map((h, i) => (
        <mesh key={`${side}-bar-${i}`} position={[0.075 * dir + i * 0.034 * dir, -0.12 + h / 2, 0.008]}>
          <boxGeometry args={[0.018, h, 0.007]} />
          <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={0.48} toneMapped={false} transparent opacity={0.9} />
        </mesh>
      ))}
      <mesh position={[-0.15 * dir, -0.108, 0.006]}>
        <boxGeometry args={[0.16, 0.012, 0.006]} />
        <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={0.52} toneMapped={false} />
      </mesh>
    </group>
  )
}
