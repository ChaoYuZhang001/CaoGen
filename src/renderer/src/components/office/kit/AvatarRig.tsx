import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { RoundedBox } from '@react-three/drei'
import { Shape } from 'three'
import type { Group, Object3D } from 'three'
import ProviderLogoBadge from './ProviderLogoBadge'
import type { ProviderLogoSpec } from './ProviderLogos'
import ReferenceRobotModelAsset, {
  createEmptyAvatarRefs,
  hasReferenceRobotModelAsset,
  REFERENCE_ROBOT_GLB_URL
} from './RobotModelAsset'

/** 视觉道具通用位姿 props(与其它 kit 组件一致) */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

/**
 * 外部动画驱动句柄:各主要部位的 group(Object3D)。
 * - root:整体根节点(可做上下浮动 / 缩放)
 * - head:头部(点头 / 摇头)
 * - armL / armR:肩部枢轴;elbowL / elbowR:肘部枢轴;wristL / wristR:腕部枢轴
 * - handL / handR:手掌中心的末端参考点(供双骨骼 IK 对齐输入目标)
 * - legL / legR:髋部枢轴;kneeL / kneeR:膝部枢轴
 * 新增细分关节保持可选,兼容只提供旧六字段的调用方。
 */
export type AvatarRefs = {
  root: Object3D | null
  head: Object3D | null
  armL: Object3D | null
  armR: Object3D | null
  elbowL?: Object3D | null
  elbowR?: Object3D | null
  wristL?: Object3D | null
  wristR?: Object3D | null
  handL?: Object3D | null
  handR?: Object3D | null
  legL: Object3D | null
  legR: Object3D | null
  kneeL?: Object3D | null
  kneeR?: Object3D | null
}

type Props = OfficeProp & {
  bodyColor?: string
  accentColor?: string
  skinColor?: string
  emblem?: string
  providerLogo?: ProviderLogoSpec
  catEars?: boolean
  modelUrl?: string
  preferModelAsset?: boolean
  /** 可选:把各部位 group 写入外部传入的引用对象(与转发 ref 二选一或并用) */
  refs?: AvatarRefs
}

type Side = -1 | 1

const DEFAULT_ACCENT = '#8fe9ff'
const FRAME = '#151a22'
const SOFT_BLACK = '#0f141b'
const HUMANOID_SILVER = '#d7dee5'
const HUMANOID_SILVER_HIGHLIGHT = '#eef3f7'
const HUMANOID_SILVER_SHADOW = '#b7c2cc'
const HUMANOID_DARK = '#070c11'
const HUMANOID_VISOR = '#86f2ff'
const JOINT_BLACK = '#0a0f15'
const PANEL_SEAM = '#b7c2cf'
const HELMET_SHELL = '#05080d'
const HELMET_SOFT_BLACK = '#111820'
const HELMET_CYAN = '#59dcff'
const HELMET_CYAN_CORE = '#d8fbff'
const SENSOR_GLASS = '#061017'
const ROBOT_BLACK_POLYMER = '#060a0f'
const ROBOT_CARBON_INSERT = '#202a35'
const ROBOT_SOLE = '#04070b'
const MICRO_FASTENER = '#eef3f7'
const HUMANOID_PROPORTION_SCALE: [number, number, number] = [0.78, 1.22, 0.9]

function cleanEmblem(value?: string): string {
  const raw = (value ?? '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()
  return raw || 'AG'
}

function UnitreeHelmetHead({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group position={[0, 0.18, 0.035]}>
      <RoundedBox args={[0.245, 0.205, 0.185]} radius={0.055} smoothness={6} position={[0, 0.058, -0.06]} castShadow>
        <meshStandardMaterial color={HELMET_SHELL} roughness={0.22} metalness={0.72} />
      </RoundedBox>
      <RoundedBox args={[0.24, 0.07, 0.205]} radius={0.04} smoothness={5} position={[0, 0.138, -0.115]} castShadow>
        <meshStandardMaterial color={HELMET_SOFT_BLACK} roughness={0.23} metalness={0.7} />
      </RoundedBox>
      <RoundedBox args={[0.15, 0.122, 0.105]} radius={0.036} smoothness={5} position={[0, -0.018, -0.118]} castShadow>
        <meshStandardMaterial color={HELMET_SHELL} roughness={0.23} metalness={0.74} />
      </RoundedBox>
      <RoundedBox args={[0.24, 0.048, 0.075]} radius={0.018} smoothness={4} position={[0, 0.058, 0.145]} castShadow>
        <meshStandardMaterial color={SENSOR_GLASS} roughness={0.18} metalness={0.6} />
      </RoundedBox>
      <RoundedBox args={[0.23, 0.03, 0.028]} radius={0.014} smoothness={4} position={[0, 0.051, 0.183]}>
        <meshStandardMaterial color={HELMET_CYAN} emissive={HELMET_CYAN} emissiveIntensity={1.34} toneMapped={false} />
      </RoundedBox>
      <RoundedBox args={[0.162, 0.016, 0.03]} radius={0.009} smoothness={4} position={[0, 0.052, 0.202]}>
        <meshStandardMaterial color={HELMET_CYAN_CORE} emissive={HELMET_CYAN} emissiveIntensity={1.78} toneMapped={false} />
      </RoundedBox>
      <mesh position={[0, -0.043, 0.125]} rotation={[0, 0, 0]} scale={[0.75, 0.9, 0.1]}>
        <torusGeometry args={[0.125, 0.018, 14, 80]} />
        <meshStandardMaterial color={HELMET_SHELL} roughness={0.2} metalness={0.72} />
      </mesh>
      <mesh position={[0, -0.043, 0.143]} rotation={[0, 0, 0]} scale={[0.77, 0.91, 0.08]}>
        <torusGeometry args={[0.125, 0.0045, 10, 88]} />
        <meshStandardMaterial color={HELMET_CYAN} emissive={HELMET_CYAN} emissiveIntensity={1.18} toneMapped={false} />
      </mesh>
      {([-1, 1] as Side[]).map((side) => (
        <group key={`visor-cheek-rail-${side}`} position={[side * 0.118, -0.075, 0.157]} rotation={[0.04, 0, side * 0.15]}>
          <RoundedBox args={[0.026, 0.188, 0.03]} radius={0.013} smoothness={4} castShadow>
            <meshStandardMaterial color={HELMET_SHELL} roughness={0.22} metalness={0.72} />
          </RoundedBox>
          <RoundedBox args={[0.006, 0.158, 0.012]} radius={0.004} smoothness={3} position={[side * 0.014, 0.006, 0.018]}>
            <meshStandardMaterial color={HELMET_CYAN} emissive={HELMET_CYAN} emissiveIntensity={0.92} toneMapped={false} />
          </RoundedBox>
        </group>
      ))}
      <RoundedBox args={[0.12, 0.036, 0.044]} radius={0.016} smoothness={4} position={[0, -0.15, 0.112]} castShadow>
        <meshStandardMaterial color={ROBOT_BLACK_POLYMER} roughness={0.32} metalness={0.48} />
      </RoundedBox>
      {([-1, 1] as Side[]).map((side) => (
        <group key={`helmet-side-led-${side}`} position={[side * 0.132, 0.006, 0.03]} rotation={[0, side * 0.18, side * 0.08]}>
          <RoundedBox args={[0.006, 0.19, 0.012]} radius={0.004} smoothness={3} castShadow>
            <meshStandardMaterial color={HELMET_CYAN} emissive={HELMET_CYAN} emissiveIntensity={0.72} toneMapped={false} />
          </RoundedBox>
        </group>
      ))}
      {([-1, 1] as Side[]).map((side) => (
        <group key={`helmet-side-anchor-${side}`} position={[side * 0.151, 0.014, -0.006]} rotation={[0, 0, Math.PI / 2]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.041, 0.041, 0.024, 32]} />
            <meshStandardMaterial color={HELMET_SOFT_BLACK} roughness={0.24} metalness={0.78} />
          </mesh>
          <mesh position={[0, 0.015, 0]}>
            <cylinderGeometry args={[0.027, 0.027, 0.01, 28]} />
            <meshStandardMaterial color={HELMET_CYAN} emissive={HELMET_CYAN} emissiveIntensity={0.34} toneMapped={false} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, -0.15, -0.016]} castShadow>
        <cylinderGeometry args={[0.066, 0.096, 0.19, 30]} />
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.3} metalness={0.78} />
      </mesh>
      {[-0.052, 0, 0.052].map((x) => (
        <mesh key={`helmet-neck-strut-${x}`} position={[x, -0.15, 0.05]} rotation={[0.18, 0, x * 1.7]} castShadow>
          <boxGeometry args={[0.012, 0.18, 0.012]} />
          <meshStandardMaterial color="#2b333d" roughness={0.32} metalness={0.66} />
        </mesh>
      ))}
      <mesh position={[0, -0.034, -0.126]}>
        <boxGeometry args={[0.062, 0.009, 0.009]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.22} toneMapped={false} />
      </mesh>
      <RoundedBox args={[0.16, 0.14, 0.014]} radius={0.024} smoothness={4} position={[0, 0.0, -0.208]} castShadow>
        <meshStandardMaterial color={ROBOT_CARBON_INSERT} roughness={0.34} metalness={0.5} />
      </RoundedBox>
      <mesh position={[0, 0.012, -0.222]} scale={[0.8, 1.04, 0.055]}>
        <torusGeometry args={[0.104, 0.006, 8, 96]} />
        <meshStandardMaterial color={HELMET_CYAN_CORE} emissive={HELMET_CYAN} emissiveIntensity={1.08} toneMapped={false} />
      </mesh>
    </group>
  )
}

function HumanoidChestArmor({
  accent,
  providerLogo
}: {
  accent: string
  providerLogo?: ProviderLogoSpec
}): React.JSX.Element {
  const chestPlateShape = useMemo(() => {
    const shape = new Shape()
    shape.moveTo(-0.198, 0.205)
    shape.bezierCurveTo(-0.225, 0.15, -0.226, -0.085, -0.16, -0.218)
    shape.quadraticCurveTo(0, -0.29, 0.16, -0.218)
    shape.bezierCurveTo(0.226, -0.085, 0.225, 0.15, 0.198, 0.205)
    shape.quadraticCurveTo(0, 0.265, -0.198, 0.205)
    return shape
  }, [])
  const abdomenPlateShape = useMemo(() => {
    const shape = new Shape()
    shape.moveTo(-0.116, 0.09)
    shape.bezierCurveTo(-0.132, 0.035, -0.115, -0.09, -0.068, -0.122)
    shape.quadraticCurveTo(0, -0.155, 0.068, -0.122)
    shape.bezierCurveTo(0.115, -0.09, 0.132, 0.035, 0.116, 0.09)
    shape.quadraticCurveTo(0, 0.13, -0.116, 0.09)
    return shape
  }, [])

  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.91, 0.02]} scale={[0.94, 1, 0.68]} castShadow>
        <cylinderGeometry args={[0.232, 0.148, 0.55, 48]} />
        <meshStandardMaterial color={FRAME} roughness={0.38} metalness={0.6} />
      </mesh>
      <mesh position={[0, 0.965, 0.18]} castShadow>
        <extrudeGeometry
          args={[
            chestPlateShape,
            { depth: 0.042, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.012, bevelSegments: 5 }
          ]}
        />
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.27} metalness={0.58} />
      </mesh>
      <mesh position={[0, 0.728, 0.178]} castShadow>
        <extrudeGeometry
          args={[
            abdomenPlateShape,
            { depth: 0.036, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.01, bevelSegments: 4 }
          ]}
        />
        <meshStandardMaterial color={HUMANOID_SILVER_SHADOW} roughness={0.3} metalness={0.58} />
      </mesh>
      <RoundedBox args={[0.22, 0.096, 0.048]} radius={0.026} smoothness={5} position={[0, 1.06, 0.224]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.24} metalness={0.56} />
      </RoundedBox>
      <RoundedBox args={[0.42, 0.052, 0.21]} radius={0.024} smoothness={4} position={[0, 1.112, 0.01]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.3} metalness={0.55} />
      </RoundedBox>
      <RoundedBox args={[0.32, 0.11, 0.028]} radius={0.024} smoothness={5} position={[0, 1.075, 0.24]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.22} metalness={0.58} />
      </RoundedBox>
      <RoundedBox args={[0.158, 0.045, 0.018]} radius={0.011} smoothness={4} position={[0, 1.072, 0.262]} castShadow>
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.3} metalness={0.68} />
      </RoundedBox>
      {([-1, 1] as Side[]).map((side) => (
        <RoundedBox
          key={`torso-side-channel-${side}`}
          args={[0.04, 0.42, 0.074]}
          radius={0.018}
          smoothness={4}
          position={[side * 0.188, 0.89, 0.085]}
          rotation={[0, side * -0.16, side * 0.08]}
          castShadow
        >
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.74} />
        </RoundedBox>
      ))}
      <mesh position={[0, 0.9, 0.235]} castShadow>
        <boxGeometry args={[0.012, 0.3, 0.009]} />
        <meshStandardMaterial color={PANEL_SEAM} roughness={0.36} metalness={0.4} />
      </mesh>
      {[0.84, 0.905].map((y) => (
        <mesh key={`torso-shell-seam-${y}`} position={[0, y, 0.238]} castShadow>
          <boxGeometry args={[0.25, 0.007, 0.009]} />
          <meshStandardMaterial color={PANEL_SEAM} roughness={0.34} metalness={0.46} />
        </mesh>
      ))}
      <mesh position={[0, 1.149, 0.135]}>
        <boxGeometry args={[0.17, 0.01, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.32} toneMapped={false} />
      </mesh>
      {([-1, 1] as Side[]).map((side) => (
        <mesh key={`chest-port-${side}`} position={[side * 0.096, 0.97, 0.236]}>
          <circleGeometry args={[0.021, 20]} />
          <meshStandardMaterial
            color={HUMANOID_SILVER_HIGHLIGHT}
            emissive={accent}
            emissiveIntensity={0.08}
            roughness={0.24}
            metalness={0.44}
          />
        </mesh>
      ))}
      <mesh position={[0, 0.66, 0.096]} castShadow>
        <cylinderGeometry args={[0.12, 0.155, 0.115, 30]} />
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.34} metalness={0.72} />
      </mesh>
      {providerLogo && (
        <ProviderLogoBadge
          logo={providerLogo}
          position={[0, 1.072, 0.252]}
          scale={0.82}
          width={0.132}
          height={0.038}
          depth={0.008}
          maxChars={3}
          compact
        />
      )}
    </group>
  )
}

function HumanoidJointBearing({
  accent,
  position,
  rotation = [0, 0, 0],
  radius = 0.07
}: {
  accent: string
  position: [number, number, number]
  rotation?: [number, number, number]
  radius?: number
}): React.JSX.Element {
  return (
    <group position={position} rotation={rotation}>
      <mesh castShadow>
        <cylinderGeometry args={[radius, radius, 0.018, 32]} />
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.28} metalness={0.82} />
      </mesh>
      <mesh position={[0, 0.011, 0]}>
        <torusGeometry args={[radius * 0.72, radius * 0.055, 8, 36]} />
        <meshStandardMaterial color={PANEL_SEAM} roughness={0.32} metalness={0.72} />
      </mesh>
      <mesh position={[0, 0.022, 0]}>
        <cylinderGeometry args={[radius * 0.2, radius * 0.2, 0.008, 18]} />
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.18}
          roughness={0.24}
          metalness={0.38}
          toneMapped={false}
        />
      </mesh>
    </group>
  )
}

function RobotFastener({ position }: { position: [number, number, number] }): React.JSX.Element {
  return (
    <mesh position={position}>
      <circleGeometry args={[0.006, 12]} />
      <meshStandardMaterial color={MICRO_FASTENER} roughness={0.24} metalness={0.76} />
    </mesh>
  )
}

function RobotBlackBearing({
  radius,
  depth,
  accent
}: {
  radius: number
  depth: number
  accent?: string
}): React.JSX.Element {
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[radius, radius, depth, 32]} />
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.28} metalness={0.82} />
      </mesh>
      {accent && (
        <mesh position={[0, 0, depth / 2 + 0.002]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[radius * 0.56, radius * 0.045, 8, 36]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.16} toneMapped={false} />
        </mesh>
      )}
    </group>
  )
}

function RobotShoulderShell({ side, accent }: { side: Side; accent: string }): React.JSX.Element {
  return (
    <group position={[side * 0.032, 0.004, 0.026]} rotation={[0, side * 0.03, side * 0.16]}>
      <RoundedBox args={[0.128, 0.086, 0.082]} radius={0.028} smoothness={4} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.27} metalness={0.6} />
      </RoundedBox>
      <mesh position={[0, 0, 0.046]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.046, 0.046, 0.016, 32]} />
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.24} metalness={0.62} />
      </mesh>
      <mesh position={[0, 0, 0.056]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.035, 0.0035, 8, 40]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.12} toneMapped={false} />
      </mesh>
      <RoundedBox args={[0.038, 0.066, 0.024]} radius={0.011} smoothness={3} position={[side * -0.046, -0.006, -0.026]} castShadow>
        <meshStandardMaterial color={ROBOT_CARBON_INSERT} roughness={0.36} metalness={0.52} />
      </RoundedBox>
    </group>
  )
}

function RobotForearmArmor({
  side,
  accent,
  body
}: {
  side: Side
  accent: string
  body: string
}): React.JSX.Element {
  return (
    <group position={[side * 0.005, -0.118, 0.026]} rotation={[0, 0, side * 0.035]}>
      <RoundedBox args={[0.082, 0.22, 0.047]} radius={0.022} smoothness={4} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.26} metalness={0.6} />
      </RoundedBox>
      <RoundedBox args={[0.024, 0.19, 0.019]} radius={0.009} smoothness={3} position={[side * -0.043, 0, -0.006]} castShadow>
        <meshStandardMaterial color={body} roughness={0.4} metalness={0.5} />
      </RoundedBox>
      <RoundedBox args={[0.018, 0.15, 0.014]} radius={0.006} smoothness={3} position={[side * 0.042, -0.008, 0.018]} castShadow>
        <meshStandardMaterial color={ROBOT_CARBON_INSERT} roughness={0.34} metalness={0.54} />
      </RoundedBox>
      <mesh position={[0, 0.086, 0.031]}>
        <boxGeometry args={[0.048, 0.009, 0.01]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.2} toneMapped={false} />
      </mesh>
      <RobotFastener position={[side * -0.026, 0.078, 0.032]} />
      <RobotFastener position={[side * 0.026, -0.082, 0.032]} />
    </group>
  )
}

function RobotUpperArmArmor({
  side,
  accent,
  body
}: {
  side: Side
  accent: string
  body: string
}): React.JSX.Element {
  return (
    <group position={[side * 0.01, -0.126, 0.022]} rotation={[0, 0, side * -0.035]}>
      <RoundedBox args={[0.086, 0.24, 0.05]} radius={0.024} smoothness={4} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.28} metalness={0.58} />
      </RoundedBox>
      <RoundedBox args={[0.026, 0.17, 0.022]} radius={0.009} smoothness={3} position={[side * 0.043, -0.008, -0.012]} castShadow>
        <meshStandardMaterial color={body} roughness={0.4} metalness={0.52} />
      </RoundedBox>
      <mesh position={[side * -0.004, 0.08, 0.032]}>
        <boxGeometry args={[0.056, 0.01, 0.01]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.16} toneMapped={false} />
      </mesh>
      <RobotFastener position={[side * -0.026, -0.082, 0.033]} />
      <RobotFastener position={[side * 0.026, 0.084, 0.033]} />
    </group>
  )
}

function RobotThighArmor({
  side,
  accent,
  body
}: {
  side: Side
  accent: string
  body: string
}): React.JSX.Element {
  return (
    <group position={[0, -0.156, 0.034]} rotation={[0, 0, side * 0.018]}>
      <RoundedBox args={[0.118, 0.29, 0.054]} radius={0.032} smoothness={4} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.27} metalness={0.6} />
      </RoundedBox>
      <RoundedBox args={[0.026, 0.224, 0.02]} radius={0.01} smoothness={3} position={[side * -0.06, -0.004, -0.006]} castShadow>
        <meshStandardMaterial color={body} roughness={0.38} metalness={0.52} />
      </RoundedBox>
      <mesh position={[side * 0.042, 0.083, 0.033]}>
        <boxGeometry args={[0.018, 0.082, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.16} toneMapped={false} />
      </mesh>
      <RobotFastener position={[side * -0.034, 0.112, 0.035]} />
      <RobotFastener position={[side * 0.034, -0.112, 0.035]} />
    </group>
  )
}

function RobotCalfArmor({
  side,
  accent,
  body
}: {
  side: Side
  accent: string
  body: string
}): React.JSX.Element {
  return (
    <group position={[0, -0.136, 0.034]} rotation={[0, 0, side * 0.02]}>
      <RoundedBox args={[0.108, 0.31, 0.052]} radius={0.031} smoothness={4} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.26} metalness={0.6} />
      </RoundedBox>
      <RoundedBox args={[0.024, 0.24, 0.02]} radius={0.009} smoothness={3} position={[side * 0.056, -0.008, -0.008]} castShadow>
        <meshStandardMaterial color={body} roughness={0.4} metalness={0.52} />
      </RoundedBox>
      <RoundedBox args={[0.028, 0.18, 0.016]} radius={0.007} smoothness={3} position={[side * -0.038, -0.03, 0.027]} castShadow>
        <meshStandardMaterial color={ROBOT_CARBON_INSERT} roughness={0.32} metalness={0.58} />
      </RoundedBox>
      <mesh position={[0, 0.106, 0.034]}>
        <boxGeometry args={[0.064, 0.01, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.18} toneMapped={false} />
      </mesh>
      <RobotFastener position={[side * -0.032, 0.126, 0.036]} />
      <RobotFastener position={[side * 0.032, -0.134, 0.036]} />
    </group>
  )
}

function RobotAnklePiston({ side }: { side: Side }): React.JSX.Element {
  return (
    <group position={[side * -0.045, -0.232, 0.058]} rotation={[0.08, 0, side * 0.08]}>
      <mesh position={[0, 0.025, 0]} rotation={[0, 0, side * 0.08]} castShadow>
        <cylinderGeometry args={[0.008, 0.008, 0.17, 12]} />
        <meshStandardMaterial color={PANEL_SEAM} roughness={0.24} metalness={0.76} />
      </mesh>
      <RoundedBox args={[0.025, 0.072, 0.017]} radius={0.006} smoothness={3} position={[0, 0.087, 0]} castShadow>
        <meshStandardMaterial color={ROBOT_CARBON_INSERT} roughness={0.34} metalness={0.54} />
      </RoundedBox>
    </group>
  )
}

function RobotReferenceShoe({ side, accent }: { side: Side; accent: string }): React.JSX.Element {
  return (
    <group position={[0, -0.371, 0.096]}>
      <RoundedBox args={[0.172, 0.046, 0.34]} radius={0.024} smoothness={4} position={[0, -0.016, 0.018]} castShadow>
        <meshStandardMaterial color={ROBOT_SOLE} roughness={0.42} metalness={0.58} />
      </RoundedBox>
      <RoundedBox args={[0.152, 0.048, 0.25]} radius={0.025} smoothness={4} position={[0, 0.015, 0.01]} castShadow>
        <meshStandardMaterial color={SOFT_BLACK} roughness={0.38} metalness={0.62} />
      </RoundedBox>
      <RoundedBox args={[0.132, 0.038, 0.16]} radius={0.019} smoothness={4} position={[0, 0.037, 0.065]} castShadow>
        <meshStandardMaterial color={ROBOT_BLACK_POLYMER} roughness={0.36} metalness={0.68} />
      </RoundedBox>
      <RoundedBox args={[0.07, 0.026, 0.096]} radius={0.011} smoothness={3} position={[side * -0.035, 0.045, -0.066]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_SHADOW} roughness={0.28} metalness={0.62} />
      </RoundedBox>
      <mesh position={[0, 0.052, 0.138]}>
        <boxGeometry args={[0.078, 0.008, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.18} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.046, -0.09]} castShadow>
        <boxGeometry args={[0.152, 0.012, 0.052]} />
        <meshStandardMaterial color="#10161d" roughness={0.45} metalness={0.46} />
      </mesh>
    </group>
  )
}

function HumanoidPelvisArmor({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group position={[0, 0, 0]}>
      <mesh position={[0, 0.622, 0.02]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.066, 0.076, 0.34, 34]} />
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.78} />
      </mesh>
      <RoundedBox args={[0.32, 0.14, 0.17]} radius={0.04} smoothness={5} position={[0, 0.61, 0.075]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.28} metalness={0.58} />
      </RoundedBox>
      <RoundedBox args={[0.22, 0.045, 0.14]} radius={0.02} smoothness={4} position={[0, 0.657, 0.145]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.24} metalness={0.58} />
      </RoundedBox>
      <RoundedBox args={[0.16, 0.13, 0.11]} radius={0.032} smoothness={4} position={[0, 0.548, 0.045]} castShadow>
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.34} metalness={0.76} />
      </RoundedBox>
      {([-1, 1] as Side[]).map((side) => (
        <group key={`pelvis-bearing-${side}`} position={[side * 0.142, 0.615, 0.052]} rotation={[0, 0, Math.PI / 2]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.073, 0.073, 0.026, 32]} />
            <meshStandardMaterial color="#707985" roughness={0.3} metalness={0.7} />
          </mesh>
          <mesh position={[0, 0.016, 0]}>
            <cylinderGeometry args={[0.048, 0.048, 0.012, 28]} />
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.28} metalness={0.8} />
          </mesh>
        </group>
      ))}
      {([-1, 1] as Side[]).map((side) => (
        <RoundedBox
          key={`hip-black-housing-${side}`}
          args={[0.085, 0.12, 0.09]}
          radius={0.024}
          smoothness={4}
          position={[side * 0.175, 0.565, 0.018]}
          rotation={[0, side * 0.18, side * -0.08]}
          castShadow
        >
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.72} />
        </RoundedBox>
      ))}
      <mesh position={[0, 0.704, 0.148]}>
        <boxGeometry args={[0.1, 0.01, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.28} toneMapped={false} />
      </mesh>
    </group>
  )
}

function HumanoidBackArmor({
  accent,
  codeBits
}: {
  accent: string
  codeBits: number[]
}): React.JSX.Element {
  return (
    <group position={[0, 0, 0]}>
      <RoundedBox args={[0.34, 0.55, 0.062]} radius={0.034} smoothness={5} position={[0, 0.91, -0.18]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.24} metalness={0.6} />
      </RoundedBox>
      <RoundedBox args={[0.058, 0.44, 0.038]} radius={0.017} smoothness={3} position={[0, 0.91, -0.222]} castShadow>
        <meshStandardMaterial color={HUMANOID_DARK} roughness={0.26} metalness={0.78} />
      </RoundedBox>
      <RoundedBox args={[0.25, 0.055, 0.024]} radius={0.015} smoothness={3} position={[0, 1.11, -0.213]} castShadow>
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.3} metalness={0.76} />
      </RoundedBox>
      <RoundedBox args={[0.235, 0.035, 0.018]} radius={0.012} smoothness={3} position={[0, 0.69, -0.211]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.24} metalness={0.58} />
      </RoundedBox>
      {([-1, 1] as Side[]).map((side) => (
        <RoundedBox
          key={`back-scapula-panel-${side}`}
          args={[0.12, 0.31, 0.044]}
          radius={0.024}
          smoothness={4}
          position={[side * 0.128, 0.98, -0.158]}
          rotation={[0.03, side * 0.06, side * -0.12]}
          castShadow
        >
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.28} metalness={0.56} />
        </RoundedBox>
      ))}
      {([-1, 1] as Side[]).map((side) => (
        <group key={`back-hip-actuator-${side}`} position={[side * 0.142, 0.64, -0.198]} rotation={[Math.PI / 2, 0, 0]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.058, 0.058, 0.018, 32]} />
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.28} metalness={0.82} />
          </mesh>
          <mesh position={[0, 0.012, 0]}>
            <cylinderGeometry args={[0.037, 0.037, 0.008, 28]} />
            <meshStandardMaterial color={HUMANOID_SILVER_SHADOW} roughness={0.26} metalness={0.62} />
          </mesh>
        </group>
      ))}
      {[0.79, 0.91, 1.03].map((y) => (
        <mesh key={`back-light-${y}`} position={[0, y, -0.236]}>
          <boxGeometry args={[0.044, 0.01, 0.009]} />
          <meshStandardMaterial color={HUMANOID_VISOR} emissive={HUMANOID_VISOR} emissiveIntensity={0.36} toneMapped={false} />
        </mesh>
      ))}
      <group position={[0, 0.94, -0.246]}>
        {codeBits.map((bit, i) => (
          <mesh key={`code-bit-${i}`} position={[-0.045 + i * 0.03, (bit - 1) * 0.006, 0]}>
            <boxGeometry args={[0.014, 0.017 + bit * 0.005, 0.007]} />
            <meshStandardMaterial
              color={bit === 0 ? '#0b1118' : accent}
              emissive={accent}
              emissiveIntensity={0.1 + bit * 0.12}
              roughness={0.3}
              metalness={0.24}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  )
}

function RobotKnuckleFinger({ x, side }: { x: number; side: Side }): React.JSX.Element {
  const spread = x * -1.6
  return (
    <group position={[x, -0.038, 0.044]} rotation={[0.18, side * -0.08, spread]}>
      <RoundedBox args={[0.014, 0.05, 0.014]} radius={0.006} smoothness={3} position={[0, -0.02, 0.018]} castShadow>
        <meshStandardMaterial color={ROBOT_BLACK_POLYMER} roughness={0.38} metalness={0.52} />
      </RoundedBox>
      <mesh position={[0, -0.048, 0.027]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.008, 0.008, 0.018, 12]} />
        <meshStandardMaterial color={PANEL_SEAM} roughness={0.26} metalness={0.72} />
      </mesh>
      <RoundedBox args={[0.012, 0.043, 0.013]} radius={0.005} smoothness={3} position={[0, -0.073, 0.04]} rotation={[0.28, 0, 0]} castShadow>
        <meshStandardMaterial color={ROBOT_BLACK_POLYMER} roughness={0.38} metalness={0.5} />
      </RoundedBox>
      <mesh position={[0, -0.101, 0.052]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.006, 0.006, 0.014, 10]} />
        <meshStandardMaterial color={PANEL_SEAM} roughness={0.3} metalness={0.7} />
      </mesh>
    </group>
  )
}

function HumanoidHand({ side, handRef }: { side: Side; handRef?: React.Ref<Group> }): React.JSX.Element {
  return (
    <group ref={handRef} position={[side * 0.01, 0.013, 0.04]} rotation={[0.05, side * -0.08, side * -0.03]}>
      <RoundedBox args={[0.08, 0.042, 0.088]} radius={0.014} smoothness={3} castShadow>
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.34} metalness={0.66} />
      </RoundedBox>
      <RoundedBox args={[0.064, 0.024, 0.052]} radius={0.009} smoothness={3} position={[0, -0.02, 0.03]} castShadow>
        <meshStandardMaterial color={ROBOT_CARBON_INSERT} roughness={0.34} metalness={0.56} />
      </RoundedBox>
      {[-0.034, -0.011, 0.011, 0.034].map((x) => (
        <RobotKnuckleFinger key={`finger-${side}-${x}`} x={x} side={side} />
      ))}
      <group position={[side * -0.055, -0.02, 0.037]} rotation={[0.18, 0, side * -0.44]}>
        <RoundedBox args={[0.014, 0.06, 0.015]} radius={0.005} smoothness={3} castShadow>
          <meshStandardMaterial color={ROBOT_BLACK_POLYMER} roughness={0.38} metalness={0.52} />
        </RoundedBox>
        <RoundedBox args={[0.012, 0.04, 0.013]} radius={0.005} smoothness={3} position={[side * -0.008, -0.042, 0.013]} rotation={[0.28, 0, side * -0.12]} castShadow>
          <meshStandardMaterial color={ROBOT_BLACK_POLYMER} roughness={0.38} metalness={0.5} />
        </RoundedBox>
      </group>
    </group>
  )
}

function HumanoidArm({
  side,
  accent,
  body,
  elbowRef,
  wristRef,
  handRef
}: {
  side: Side
  accent: string
  body: string
  elbowRef?: React.Ref<Group>
  wristRef?: React.Ref<Group>
  handRef?: React.Ref<Group>
}): React.JSX.Element {
  return (
    <group>
      <RobotBlackBearing radius={0.068} depth={0.03} accent={accent} />
      <HumanoidJointBearing accent={accent} position={[0, 0, 0.016]} rotation={[Math.PI / 2, 0, 0]} radius={0.058} />
      <RobotShoulderShell side={side} accent={accent} />
      <mesh position={[side * 0.012, -0.125, 0]} rotation={[0, 0, side * -0.04]} castShadow>
        <capsuleGeometry args={[0.043, 0.24, 8, 20]} />
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.34} metalness={0.5} />
      </mesh>
      <RobotUpperArmArmor side={side} accent={accent} body={body} />
      <RoundedBox
        args={[0.048, 0.2, 0.036]}
        radius={0.014}
        smoothness={3}
        position={[side * -0.032, -0.125, -0.038]}
        rotation={[0, 0, side * 0.05]}
        castShadow
      >
        <meshStandardMaterial color={body} roughness={0.42} metalness={0.42} />
      </RoundedBox>
      <mesh position={[side * 0.024, -0.054, 0.046]}>
        <boxGeometry args={[0.056, 0.012, 0.014]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.18} toneMapped={false} />
      </mesh>
      <group ref={elbowRef} position={[side * 0.006, -0.262, 0]}>
        <RobotBlackBearing radius={0.044} depth={0.024} accent={accent} />
        <HumanoidJointBearing accent={accent} position={[0, 0, 0.014]} rotation={[Math.PI / 2, 0, 0]} radius={0.04} />
        <mesh position={[side * 0.004, -0.118, 0.003]} rotation={[0, 0, side * 0.03]} castShadow>
          <capsuleGeometry args={[0.038, 0.22, 8, 18]} />
          <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.28} metalness={0.58} />
        </mesh>
        <RobotForearmArmor side={side} accent={accent} body={body} />
        <RoundedBox args={[0.044, 0.19, 0.034]} radius={0.013} smoothness={3} position={[side * 0.034, -0.112, -0.036]} castShadow>
          <meshStandardMaterial color={body} roughness={0.42} metalness={0.42} />
        </RoundedBox>
        <group ref={wristRef} position={[0, -0.238, 0.004]}>
          <RoundedBox args={[0.068, 0.032, 0.054]} radius={0.012} smoothness={3} castShadow>
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.72} />
          </RoundedBox>
          <HumanoidHand side={side} handRef={handRef} />
        </group>
      </group>
    </group>
  )
}

function HumanoidLeg({
  side,
  accent,
  body,
  kneeRef
}: {
  side: Side
  accent: string
  body: string
  kneeRef?: React.Ref<Group>
}): React.JSX.Element {
  return (
    <group>
      <RobotBlackBearing radius={0.06} depth={0.03} accent={accent} />
      <HumanoidJointBearing accent={accent} position={[0, 0, 0.014]} rotation={[Math.PI / 2, 0, 0]} radius={0.05} />
      <mesh position={[0, -0.155, 0.005]} rotation={[0, 0, side * 0.018]} castShadow>
        <capsuleGeometry args={[0.058, 0.27, 8, 22]} />
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.28} metalness={0.58} />
      </mesh>
      <RobotThighArmor side={side} accent={accent} body={body} />
      <RoundedBox args={[0.06, 0.278, 0.03]} radius={0.017} smoothness={3} position={[side * -0.05, -0.152, -0.038]} rotation={[0, 0, side * 0.05]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER_SHADOW} roughness={0.3} metalness={0.58} />
      </RoundedBox>
      <RoundedBox args={[0.035, 0.19, 0.03]} radius={0.012} smoothness={3} position={[side * 0.045, -0.15, 0.043]} rotation={[0, 0, side * -0.08]} castShadow>
        <meshStandardMaterial color={body} roughness={0.4} metalness={0.38} />
      </RoundedBox>
      <mesh position={[side * 0.055, -0.105, 0.006]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 0.02, 28]} />
        <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.24} metalness={0.62} />
      </mesh>
      <group ref={kneeRef} position={[0, -0.318, 0]}>
        <RobotBlackBearing radius={0.052} depth={0.028} accent={accent} />
        <HumanoidJointBearing accent={accent} position={[0, 0, 0.014]} rotation={[Math.PI / 2, 0, 0]} radius={0.046} />
        <group position={[0, -0.027, 0]}>
          <mesh position={[0, -0.135, 0.003]} castShadow>
            <capsuleGeometry args={[0.052, 0.3, 8, 22]} />
            <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.28} metalness={0.58} />
          </mesh>
          <RobotCalfArmor side={side} accent={accent} body={body} />
          <RoundedBox args={[0.056, 0.31, 0.03]} radius={0.016} smoothness={3} position={[side * -0.044, -0.13, -0.035]} rotation={[0, 0, side * 0.04]} castShadow>
            <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.28} metalness={0.58} />
          </RoundedBox>
          <mesh position={[side * 0.039, -0.124, 0.044]} rotation={[0, 0, side * -0.06]}>
            <boxGeometry args={[0.012, 0.2, 0.015]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.18} toneMapped={false} />
          </mesh>
          <RoundedBox args={[0.074, 0.034, 0.054]} radius={0.012} smoothness={3} position={[0, -0.305, 0.018]} castShadow>
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.72} />
          </RoundedBox>
          <RobotAnklePiston side={side} />
          <RobotReferenceShoe side={side} accent={accent} />
        </group>
      </group>
    </group>
  )
}

/**
 * 未来办公室协作机器人装配(rig)。
 * 每个可动部位由独立 group 包裹并暴露给外部,由调用方在 useFrame 中驱动动画;
 * 本组件自身不做任何动画,只负责结构与外形。
 *
 * 站姿参考(单位≈米,y=0 为脚底):
 *   腿高 ~0.62,躯干中心 ~0.9,肩枢轴 ~1.03,头部中心 ~1.38,总高约 1.55m。
 */
const AvatarRig = forwardRef<AvatarRefs, Props>(function AvatarRig(
  {
    position,
    rotation,
    scale = 1,
    accentColor,
    emblem,
    providerLogo,
    refs,
    modelUrl = REFERENCE_ROBOT_GLB_URL,
    preferModelAsset = true
  },
  ref
): React.JSX.Element {
  const body = '#17202a'
  const shell = HUMANOID_SILVER
  const accent = accentColor ?? DEFAULT_ACCENT
  const code = cleanEmblem(emblem)
  const codeBits = useMemo(
    () =>
      Array.from({ length: 4 }, (_, i) => {
        const ch = code.charCodeAt(i % code.length)
        return (ch + i * 17) % 3
      }),
    [code]
  )

  const rootRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const armLRef = useRef<Group>(null)
  const armRRef = useRef<Group>(null)
  const elbowLRef = useRef<Group>(null)
  const elbowRRef = useRef<Group>(null)
  const wristLRef = useRef<Group>(null)
  const wristRRef = useRef<Group>(null)
  const handLRef = useRef<Group>(null)
  const handRRef = useRef<Group>(null)
  const legLRef = useRef<Group>(null)
  const legRRef = useRef<Group>(null)
  const kneeLRef = useRef<Group>(null)
  const kneeRRef = useRef<Group>(null)
  const modelAssetRefs = useRef<AvatarRefs>(createEmptyAvatarRefs())
  const useModelAsset = preferModelAsset && hasReferenceRobotModelAsset(modelUrl)

  // 同时把句柄写入外部 refs 对象与转发 ref;二者共享同一组内部 ref。
  const collect = (): AvatarRefs => {
    const bag: AvatarRefs = useModelAsset
      ? modelAssetRefs.current
      : {
          root: rootRef.current,
          head: headRef.current,
          armL: armLRef.current,
          armR: armRRef.current,
          elbowL: elbowLRef.current,
          elbowR: elbowRRef.current,
          wristL: wristLRef.current,
          wristR: wristRRef.current,
          handL: handLRef.current,
          handR: handRRef.current,
          legL: legLRef.current,
          legR: legRRef.current,
          kneeL: kneeLRef.current,
          kneeR: kneeRRef.current
        }
    if (refs) {
      refs.root = bag.root
      refs.head = bag.head
      refs.armL = bag.armL
      refs.armR = bag.armR
      refs.elbowL = bag.elbowL
      refs.elbowR = bag.elbowR
      refs.wristL = bag.wristL
      refs.wristR = bag.wristR
      refs.handL = bag.handL
      refs.handR = bag.handR
      refs.legL = bag.legL
      refs.legR = bag.legR
      refs.kneeL = bag.kneeL
      refs.kneeR = bag.kneeR
    }
    return bag
  }
  useImperativeHandle(ref, collect, [refs, useModelAsset])

  if (useModelAsset) {
    return (
      <ReferenceRobotModelAsset
        refs={modelAssetRefs.current}
        modelUrl={modelUrl}
        position={position}
        rotation={rotation}
        scale={scale}
        accentColor={accent}
        providerLogo={providerLogo}
      />
    )
  }

  return (
    <group ref={rootRef} position={position} rotation={rotation} scale={scale}>
      <group scale={HUMANOID_PROPORTION_SCALE}>
        {/* ===== 工程机器人躯干 ===== */}
        <HumanoidChestArmor accent={accent} providerLogo={providerLogo} />
        <HumanoidBackArmor accent={accent} codeBits={codeBits} />
        <HumanoidPelvisArmor accent={accent} />
        <mesh position={[0, 1.13, 0]} castShadow>
          <cylinderGeometry args={[0.052, 0.072, 0.112, 28]} />
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.34} metalness={0.72} />
        </mesh>
        <RoundedBox args={[0.34, 0.045, 0.15]} radius={0.02} smoothness={4} position={[0, 1.105, -0.01]} castShadow>
          <meshStandardMaterial color={shell} roughness={0.34} metalness={0.5} />
        </RoundedBox>
        <RoundedBox args={[0.23, 0.22, 0.04]} radius={0.026} smoothness={4} position={[0, 0.79, -0.195]} castShadow>
          <meshStandardMaterial color={HUMANOID_SILVER_HIGHLIGHT} roughness={0.26} metalness={0.58} />
        </RoundedBox>
        <RoundedBox args={[0.042, 0.18, 0.018]} radius={0.012} smoothness={3} position={[0, 0.79, -0.226]} castShadow>
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.28} metalness={0.76} />
        </RoundedBox>

        {/* ===== 头部:点头/摇头枢轴在颈根 y≈1.18 ===== */}
        <group ref={headRef} position={[0, 1.19, 0]} scale={0.88}>
          <UnitreeHelmetHead accent={accent} />
        </group>

        {/* ===== 双臂:肩枢轴 y≈1.03 ===== */}
        <group ref={armLRef} position={[-0.215, 1.032, 0]}>
          <HumanoidArm
            side={-1}
            accent={accent}
            body={body}
            elbowRef={elbowLRef}
            wristRef={wristLRef}
            handRef={handLRef}
          />
        </group>
        <group ref={armRRef} position={[0.215, 1.032, 0]}>
          <HumanoidArm
            side={1}
            accent={accent}
            body={body}
            elbowRef={elbowRRef}
            wristRef={wristRRef}
            handRef={handRRef}
          />
        </group>

        {/* ===== 双腿:髋枢轴 y≈0.62 ===== */}
        <group ref={legLRef} position={[-0.09, 0.62, 0]}>
          <HumanoidLeg side={-1} accent={accent} body={body} kneeRef={kneeLRef} />
        </group>
        <group ref={legRRef} position={[0.09, 0.62, 0]}>
          <HumanoidLeg side={1} accent={accent} body={body} kneeRef={kneeRRef} />
        </group>
      </group>
    </group>
  )
})

export default AvatarRig
