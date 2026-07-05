import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector2 } from 'three'
import type { Group, Mesh, MeshStandardMaterial } from 'three'

/**
 * 厂商 3D 吉祥物:全部用 three 几何体代码生成(无外部模型/贴图),
 * 漂浮在工位桌面上方缓慢旋转 + 上下浮动。按 vendorKey 分派造型。
 * DeepSeek=鲸鱼🐳、OpenAI=结环、Anthropic=星花、Google=宝石、
 * Qwen=祥云、Kimi=月牙、其余=默认光球。
 */

interface Props {
  vendorKey: string
  position?: [number, number, number]
  scale?: number
}

const SKIN: Record<string, { body: string; accent: string }> = {
  deepseek: { body: '#4d6bfe', accent: '#eaf0ff' },
  openai: { body: '#1f9f84', accent: '#7fffd8' },
  anthropic: { body: '#d97757', accent: '#ffd9a0' },
  google: { body: '#3b6fe0', accent: '#9ec7ff' },
  qwen: { body: '#7a5cff', accent: '#cbbcff' },
  kimi: { body: '#16b8a6', accent: '#7ff0e0' },
  zhipu: { body: '#3859ff', accent: '#a9baff' },
  default: { body: '#5b6472', accent: '#8fe9ff' }
}

/** DeepSeek 鲸鱼:身体(压扁球)+ 腹部 + 尾鳍 + 双侧鳍 + 眼 + 顶部喷水柱 */
function Whale({ body, accent }: { body: string; accent: string }): React.JSX.Element {
  const whaleRef = useRef<Group>(null)
  const tailRef = useRef<Group>(null)
  const spoutRef = useRef<Mesh>(null)
  const profile = useMemo(
    () => [
      new Vector2(0.02, -0.52),
      new Vector2(0.18, -0.42),
      new Vector2(0.31, -0.18),
      new Vector2(0.35, 0.08),
      new Vector2(0.28, 0.34),
      new Vector2(0.11, 0.5),
      new Vector2(0.02, 0.54)
    ],
    []
  )
  const bellyProfile = useMemo(
    () => [
      new Vector2(0.015, -0.36),
      new Vector2(0.13, -0.28),
      new Vector2(0.2, -0.02),
      new Vector2(0.17, 0.24),
      new Vector2(0.06, 0.38),
      new Vector2(0.015, 0.4)
    ],
    []
  )
  useFrame((s) => {
    const t = s.clock.getElapsedTime()
    if (whaleRef.current) whaleRef.current.rotation.z = Math.sin(t * 0.8) * 0.05
    if (tailRef.current) tailRef.current.rotation.z = Math.sin(t * 2.2) * 0.28
    if (spoutRef.current) {
      const grow = (Math.sin(t * 1.5) + 1) / 2 // 0..1 喷水起伏
      spoutRef.current.scale.set(1, 0.4 + grow * 1.1, 1)
      const m = spoutRef.current.material as MeshStandardMaterial
      m.opacity = 0.28 + grow * 0.3
      m.emissiveIntensity = 0.75 + grow * 0.25
    }
  })
  return (
    <group ref={whaleRef}>
      {/* 身体:LatheGeometry 流线剖面,避免压扁球观感 */}
      <mesh rotation={[0, 0, Math.PI / 2]} scale={[1, 0.95, 1]} castShadow>
        <latheGeometry args={[profile, 32]} />
        <meshStandardMaterial color={body} roughness={0.5} metalness={0.1} />
      </mesh>
      {/* 腹部(浅色) */}
      <mesh position={[0.04, -0.13, 0.01]} rotation={[0, 0, Math.PI / 2]} scale={[1, 0.55, 0.78]}>
        <latheGeometry args={[bellyProfile, 28]} />
        <meshStandardMaterial color={accent} roughness={0.6} />
      </mesh>
      {/* 尾柄 + 尾鳍(两片) */}
      <group ref={tailRef} position={[-0.52, 0.02, 0]}>
        <mesh rotation={[0, 0, 0.3]} scale={[0.5, 0.3, 0.3]}>
          <sphereGeometry args={[0.2, 16, 12]} />
          <meshStandardMaterial color={body} roughness={0.55} />
        </mesh>
        <mesh position={[-0.22, 0.14, 0]} rotation={[0, 0.5, 0.7]}>
          <coneGeometry args={[0.16, 0.28, 8]} />
          <meshStandardMaterial color={body} roughness={0.55} />
        </mesh>
        <mesh position={[-0.22, -0.08, 0]} rotation={[0, -0.5, 2.4]}>
          <coneGeometry args={[0.16, 0.28, 8]} />
          <meshStandardMaterial color={body} roughness={0.55} />
        </mesh>
      </group>
      {/* 侧鳍 */}
      <mesh position={[0.05, -0.1, 0.28]} rotation={[0.6, 0, -0.3]}>
        <coneGeometry args={[0.1, 0.24, 8]} />
        <meshStandardMaterial color={body} roughness={0.55} />
      </mesh>
      <mesh position={[0.05, -0.1, -0.28]} rotation={[-0.6, 0, -0.3]}>
        <coneGeometry args={[0.1, 0.24, 8]} />
        <meshStandardMaterial color={body} roughness={0.55} />
      </mesh>
      {/* 眼睛(前方两颗) */}
      <mesh position={[0.42, 0.06, 0.14]}>
        <sphereGeometry args={[0.045, 8, 8]} />
        <meshStandardMaterial color="#0a0a0a" />
      </mesh>
      <mesh position={[0.42, 0.06, -0.14]}>
        <sphereGeometry args={[0.045, 8, 8]} />
        <meshStandardMaterial color="#0a0a0a" />
      </mesh>
      {/* 顶部喷水柱(发光,随时间起伏) */}
      <mesh ref={spoutRef} position={[0.05, 0.5, 0]}>
        <cylinderGeometry args={[0.03, 0.09, 0.5, 8]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={1.0}
          transparent
          opacity={0.52}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}

/** OpenAI:环形结(torus knot),科技感 */
function Knot({ body, accent }: { body: string; accent: string }): React.JSX.Element {
  return (
    <mesh castShadow scale={0.42}>
      <torusKnotGeometry args={[0.5, 0.16, 96, 12]} />
      <meshStandardMaterial color={body} emissive={accent} emissiveIntensity={0.35} metalness={0.4} roughness={0.3} toneMapped={false} />
    </mesh>
  )
}

/** Anthropic:八角星花(两个交叉的四棱锥) */
function StarBurst({ body, accent }: { body: string; accent: string }): React.JSX.Element {
  return (
    <group scale={0.5}>
      <mesh castShadow>
        <octahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial color={body} emissive={accent} emissiveIntensity={0.3} toneMapped={false} />
      </mesh>
      <mesh rotation={[0, Math.PI / 4, Math.PI / 4]} scale={0.8}>
        <octahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} toneMapped={false} />
      </mesh>
    </group>
  )
}

/** Google:多面宝石(icosahedron) */
function Gem({ body, accent }: { body: string; accent: string }): React.JSX.Element {
  return (
    <mesh castShadow scale={0.5}>
      <icosahedronGeometry args={[0.5, 0]} />
      <meshStandardMaterial color={body} emissive={accent} emissiveIntensity={0.35} metalness={0.5} roughness={0.15} flatShading toneMapped={false} />
    </mesh>
  )
}

/** Qwen 祥云 / Kimi 月牙 / 默认:三团球叠成云 / 环缺 / 光球 */
function Cloud({ body, accent }: { body: string; accent: string }): React.JSX.Element {
  return (
    <group scale={0.5}>
      {[[-0.3, 0, 0, 0.3], [0.25, 0.05, 0, 0.34], [0, 0.18, 0, 0.28]].map((c, i) => (
        <mesh key={i} position={[c[0], c[1], c[2]]} castShadow>
          <sphereGeometry args={[c[3], 14, 12]} />
          <meshStandardMaterial color={i === 2 ? accent : body} roughness={0.7} />
        </mesh>
      ))}
    </group>
  )
}

function Moon({ body, accent }: { body: string; accent: string }): React.JSX.Element {
  return (
    <group scale={0.5}>
      <mesh castShadow>
        <sphereGeometry args={[0.5, 20, 16]} />
        <meshStandardMaterial color={body} emissive={accent} emissiveIntensity={0.4} toneMapped={false} />
      </mesh>
      {/* 缺口:深色球偏置遮出月牙 */}
      <mesh position={[0.28, 0.05, 0.3]}>
        <sphereGeometry args={[0.42, 18, 14]} />
        <meshStandardMaterial color="#14161b" />
      </mesh>
    </group>
  )
}

function OrbShape({ body, accent }: { body: string; accent: string }): React.JSX.Element {
  return (
    <mesh castShadow scale={0.45}>
      <sphereGeometry args={[0.5, 20, 16]} />
      <meshStandardMaterial color={body} emissive={accent} emissiveIntensity={0.5} toneMapped={false} />
    </mesh>
  )
}

function Shape({ vendorKey }: { vendorKey: string }): React.JSX.Element {
  const s = SKIN[vendorKey] ?? SKIN.default
  switch (vendorKey) {
    case 'deepseek':
      return <Whale {...s} />
    case 'openai':
      return <Knot {...s} />
    case 'anthropic':
      return <StarBurst {...s} />
    case 'google':
      return <Gem {...s} />
    case 'qwen':
      return <Cloud {...s} />
    case 'kimi':
      return <Moon {...s} />
    case 'zhipu':
      return <Gem {...s} />
    default:
      return <OrbShape {...s} />
  }
}

export default function VendorMascot({ vendorKey, position = [0, 1, 0], scale = 1 }: Props): React.JSX.Element {
  const groupRef = useRef<Group>(null)
  const phase = useMemo(() => Math.random() * Math.PI * 2, [])
  useFrame((s) => {
    const g = groupRef.current
    if (!g) return
    const t = s.clock.getElapsedTime() + phase
    g.rotation.y = t * 0.6
    g.position.y = position[1] + Math.sin(t * 1.2) * 0.06 // 上下浮动
  })
  return (
    <group ref={groupRef} position={position} scale={scale}>
      <Shape vendorKey={vendorKey} />
    </group>
  )
}
