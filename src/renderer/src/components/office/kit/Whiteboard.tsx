import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group, MeshStandardMaterial } from 'three'

/** 视觉道具通用入参:位置 / 旋转 / 统一缩放 */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

// 常量色板(主黑副白 + 青色强调)
const BOARD_WHITE = '#f4f4f4'
const FRAME_DARK = '#242424'
const TRAY_DARK = '#1c1c1c'
const MARKER_INK = '#23262b'
const ACCENT = '#8fe9ff'

// 板面局部坐标(以板中心为原点):x∈[-0.8,0.8] y∈[-0.5,0.5],涂鸦贴在前表面
const DOODLE_Z = 0.024
const STROKE = 0.02 // 笔迹粗细
const STROKE_D = 0.008 // 笔迹厚度(略微凸起)

type Stroke = {
  key: string
  position: [number, number, number]
  size: [number, number, number]
  color: string
  glow?: boolean
}

/** 生成一个矩形描边(流程框)的四条笔迹 */
function rectStrokes(
  prefix: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  color: string,
  glow?: boolean
): Stroke[] {
  return [
    { key: `${prefix}-t`, position: [cx, cy + h / 2, DOODLE_Z], size: [w + STROKE, STROKE, STROKE_D], color, glow },
    { key: `${prefix}-b`, position: [cx, cy - h / 2, DOODLE_Z], size: [w + STROKE, STROKE, STROKE_D], color, glow },
    { key: `${prefix}-l`, position: [cx - w / 2, cy, DOODLE_Z], size: [STROKE, h, STROKE_D], color, glow },
    { key: `${prefix}-r`, position: [cx + w / 2, cy, DOODLE_Z], size: [STROKE, h, STROKE_D], color, glow }
  ]
}

/**
 * 白板道具:白板面 + 深色边框 + 用细 box 手绘的流程图涂鸦(两个流程框 + 箭头 + 判定菱形),
 * 底部托盘上放三支笔。青色强调笔迹配合 Bloom 呼吸辉光。
 */
export default function Whiteboard({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1
}: OfficeProp): React.JSX.Element {
  const glowMatRef = useRef<MeshStandardMaterial>(null)

  // 涂鸦笔迹(细 box)——闭包外一次性生成,避免每帧计算
  const strokes = useMemo<Stroke[]>(() => {
    const s: Stroke[] = []
    // 流程框 A(上)
    s.push(...rectStrokes('a', -0.38, 0.24, 0.46, 0.26, MARKER_INK))
    // A → B 向下箭头竖线
    s.push({ key: 'arr-down', position: [-0.38, 0.02, DOODLE_Z], size: [STROKE, 0.16, STROKE_D], color: MARKER_INK })
    // 流程框 B(下)
    s.push(...rectStrokes('b', -0.38, -0.28, 0.46, 0.26, MARKER_INK))
    // B → 判定 向右箭头横线(青色强调)
    s.push({ key: 'arr-right', position: [0.0, -0.28, DOODLE_Z], size: [0.28, STROKE, STROKE_D], color: ACCENT, glow: true })
    // 右上角随手涂鸦(两笔斜线)
    s.push({ key: 'sq1', position: [0.42, 0.3, DOODLE_Z], size: [0.24, STROKE, STROKE_D], color: MARKER_INK })
    s.push({ key: 'sq2', position: [0.42, 0.22, DOODLE_Z], size: [0.18, STROKE, STROKE_D], color: MARKER_INK })
    return s
  }, [])

  // 呼吸辉光:仅驱动强调笔迹的 emissiveIntensity(不在 useFrame 内 new 对象)
  useFrame((state) => {
    const mat = glowMatRef.current
    if (mat) {
      const e = state.clock.getElapsedTime()
      mat.emissiveIntensity = 1.4 + Math.sin(e * 2.4) * 0.6
    }
  })

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {/* 板体位于 y=1.35,面朝 +Z */}
      <group position={[0, 1.35, 0]}>
        {/* 白板面 */}
        <mesh castShadow receiveShadow>
          <boxGeometry args={[1.62, 1.04, 0.04]} />
          <meshStandardMaterial color={BOARD_WHITE} roughness={0.55} metalness={0.02} />
        </mesh>

        {/* 边框(四条细 box,略微前凸) */}
        <mesh position={[0, 0.53, 0.005]}>
          <boxGeometry args={[1.7, 0.06, 0.06]} />
          <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, -0.53, 0.005]}>
          <boxGeometry args={[1.7, 0.06, 0.06]} />
          <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[-0.83, 0, 0.005]}>
          <boxGeometry args={[0.06, 1.12, 0.06]} />
          <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0.83, 0, 0.005]}>
          <boxGeometry args={[0.06, 1.12, 0.06]} />
          <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
        </mesh>

        {/* 涂鸦笔迹(细 box) */}
        {strokes.map((st) =>
          st.glow ? (
            <mesh key={st.key} position={st.position}>
              <boxGeometry args={st.size} />
              <meshStandardMaterial
                ref={glowMatRef}
                color={st.color}
                emissive={st.color}
                emissiveIntensity={1.6}
                toneMapped={false}
              />
            </mesh>
          ) : (
            <mesh key={st.key} position={st.position}>
              <boxGeometry args={st.size} />
              <meshStandardMaterial color={st.color} roughness={0.8} />
            </mesh>
          )
        )}

        {/* 向下箭头头(锥,尖朝 -Y) */}
        <mesh position={[-0.38, -0.08, DOODLE_Z]} rotation={[0, 0, Math.PI]}>
          <coneGeometry args={[0.05, 0.08, 4]} />
          <meshStandardMaterial color={MARKER_INK} roughness={0.8} />
        </mesh>

        {/* 向右箭头头(锥,尖朝 +X,青色强调发光) */}
        <mesh position={[0.16, -0.28, DOODLE_Z]} rotation={[0, 0, -Math.PI / 2]}>
          <coneGeometry args={[0.05, 0.08, 4]} />
          <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={1.8} toneMapped={false} />
        </mesh>

        {/* 判定菱形(旋转 45° 的细描边方块,青色强调发光) */}
        <mesh position={[0.42, -0.28, DOODLE_Z]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[0.2, 0.2, STROKE_D]} />
          <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={1.5} toneMapped={false} />
        </mesh>
        {/* 菱形内挖白(叠一层白面遮住中心,形成描边观感) */}
        <mesh position={[0.42, -0.28, DOODLE_Z + 0.001]} rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[0.15, 0.15, STROKE_D]} />
          <meshStandardMaterial color={BOARD_WHITE} roughness={0.6} />
        </mesh>

        {/* 底部笔托 */}
        <mesh position={[0, -0.5, 0.1]} castShadow>
          <boxGeometry args={[0.7, 0.03, 0.11]} />
          <meshStandardMaterial color={TRAY_DARK} metalness={0.4} roughness={0.5} />
        </mesh>
        {/* 托盘挡边 */}
        <mesh position={[0, -0.47, 0.15]}>
          <boxGeometry args={[0.7, 0.04, 0.012]} />
          <meshStandardMaterial color={TRAY_DARK} metalness={0.4} roughness={0.5} />
        </mesh>

        {/* 三支笔(横卧在托盘上) */}
        <mesh position={[-0.18, -0.47, 0.11]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.016, 0.016, 0.24, 16]} />
          <meshStandardMaterial color="#2b2f36" roughness={0.5} />
        </mesh>
        <mesh position={[-0.18, -0.47, 0.155]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.017, 0.017, 0.05, 16]} />
          <meshStandardMaterial color={ACCENT} emissive={ACCENT} emissiveIntensity={0.9} toneMapped={false} />
        </mesh>
        <mesh position={[0.04, -0.47, 0.11]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.016, 0.016, 0.24, 16]} />
          <meshStandardMaterial color="#3a3f47" roughness={0.5} />
        </mesh>
        <mesh position={[0.24, -0.47, 0.11]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.016, 0.016, 0.24, 16]} />
          <meshStandardMaterial color="#d8593c" roughness={0.5} />
        </mesh>
      </group>

      {/* 支腿(两侧外撇) + 后支撑,画架式站立 */}
      <mesh position={[-0.72, 0.44, -0.04]} rotation={[0, 0, 0.17]} castShadow>
        <boxGeometry args={[0.05, 0.9, 0.05]} />
        <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0.72, 0.44, -0.04]} rotation={[0, 0, -0.17]} castShadow>
        <boxGeometry args={[0.05, 0.9, 0.05]} />
        <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.5, -0.28]} rotation={[0.32, 0, 0]} castShadow>
        <boxGeometry args={[0.05, 0.95, 0.05]} />
        <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
      </mesh>
      {/* 横撑 */}
      <mesh position={[0, 0.28, -0.02]}>
        <boxGeometry args={[1.4, 0.04, 0.04]} />
        <meshStandardMaterial color={FRAME_DARK} metalness={0.5} roughness={0.4} />
      </mesh>
    </group>
  )
}
