import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { RoundedBox } from '@react-three/drei'
import type { Group, Object3D } from 'three'
import ProviderLogoBadge from './ProviderLogoBadge'
import type { ProviderLogoSpec } from './ProviderLogos'

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
 * - armL / armR:肩部枢轴(整条手臂绕肩摆动;前臂为其子节点)
 * - legL / legR:髋部枢轴(整条腿绕髋摆动;小腿为其子节点)
 */
export type AvatarRefs = {
  root: Object3D | null
  head: Object3D | null
  armL: Object3D | null
  armR: Object3D | null
  legL: Object3D | null
  legR: Object3D | null
}

type Props = OfficeProp & {
  bodyColor?: string
  accentColor?: string
  skinColor?: string
  emblem?: string
  providerLogo?: ProviderLogoSpec
  catEars?: boolean
  /** 可选:把各部位 group 写入外部传入的引用对象(与转发 ref 二选一或并用) */
  refs?: AvatarRefs
}

const DEFAULT_ACCENT = '#8fe9ff'
const JOINT = '#252c36'
const FRAME = '#151a22'
const DARK_GLASS = '#08131a'
const SOFT_BLACK = '#0f141b'
const SERVICE_WHITE = '#dce7f2'
const SERVICE_GLOW = '#f4fbff'
const HUMANOID_SILVER = '#dfe7ef'
const HUMANOID_DARK = '#070c11'
const HUMANOID_VISOR = '#86f2ff'
const HUMANOID_VISOR_CORE = '#d8fbff'
const JOINT_BLACK = '#0a0f15'
const PANEL_SEAM = '#b7c2cf'
const HUMANOID_PROPORTION_SCALE: [number, number, number] = [0.9, 1.14, 0.92]

function cleanEmblem(value?: string): string {
  const raw = (value ?? '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()
  return raw || 'AG'
}

function HumanoidFaceHalo({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group position={[0, 0.165, 0.188]}>
      <mesh scale={[0.72, 1.08, 1]} castShadow>
        <torusGeometry args={[0.15, 0.012, 10, 72]} />
        <meshStandardMaterial color={HUMANOID_VISOR} emissive={HUMANOID_VISOR} emissiveIntensity={1.48} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.006, -0.006]} scale={[0.64, 0.94, 1]}>
        <circleGeometry args={[0.15, 48]} />
        <meshStandardMaterial color={HUMANOID_DARK} roughness={0.18} metalness={0.32} />
      </mesh>
      <mesh position={[0, 0.03, 0.006]}>
        <boxGeometry args={[0.18, 0.014, 0.01]} />
        <meshStandardMaterial color={HUMANOID_VISOR} emissive={HUMANOID_VISOR} emissiveIntensity={1.8} toneMapped={false} />
      </mesh>
      <mesh position={[-0.055, 0.018, 0.012]}>
        <boxGeometry args={[0.036, 0.012, 0.008]} />
        <meshStandardMaterial color={HUMANOID_VISOR_CORE} emissive={HUMANOID_VISOR} emissiveIntensity={1.05} toneMapped={false} />
      </mesh>
      <mesh position={[0.055, 0.018, 0.012]}>
        <boxGeometry args={[0.036, 0.012, 0.008]} />
        <meshStandardMaterial color={HUMANOID_VISOR_CORE} emissive={HUMANOID_VISOR} emissiveIntensity={1.05} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.118, 0.01]}>
        <boxGeometry args={[0.105, 0.01, 0.008]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.72} toneMapped={false} />
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
  return (
    <group position={[0, 0, 0]}>
      <RoundedBox args={[0.43, 0.5, 0.055]} radius={0.048} smoothness={5} position={[0, 0.95, 0.195]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.34} metalness={0.48} />
      </RoundedBox>
      <RoundedBox args={[0.32, 0.17, 0.062]} radius={0.036} smoothness={4} position={[0, 1.1, 0.225]} castShadow>
        <meshStandardMaterial color="#f4f8fb" roughness={0.28} metalness={0.42} />
      </RoundedBox>
      <RoundedBox args={[0.3, 0.18, 0.062]} radius={0.032} smoothness={4} position={[0, 0.81, 0.225]} castShadow>
        <meshStandardMaterial color="#cbd5df" roughness={0.36} metalness={0.5} />
      </RoundedBox>
      <mesh position={[0, 0.67, 0.12]} castShadow>
        <cylinderGeometry args={[0.14, 0.16, 0.12, 28]} />
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.36} metalness={0.62} />
      </mesh>
      {[-0.105, 0.105].map((x) => (
        <mesh key={`chest-port-${x}`} position={[x, 0.93, 0.233]}>
          <circleGeometry args={[0.026, 18]} />
          <meshStandardMaterial color="#e9f4fb" emissive={accent} emissiveIntensity={0.12} roughness={0.24} metalness={0.38} />
        </mesh>
      ))}
      <mesh position={[0, 1.15, 0.233]}>
        <boxGeometry args={[0.24, 0.014, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.48} toneMapped={false} />
      </mesh>
      {providerLogo && (
        <ProviderLogoBadge
          logo={providerLogo}
          position={[0, 1.048, 0.258]}
          width={0.21}
          height={0.064}
          depth={0.012}
          maxChars={4}
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
        <cylinderGeometry args={[radius * 0.22, radius * 0.22, 0.008, 18]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.3} roughness={0.24} metalness={0.38} toneMapped={false} />
      </mesh>
    </group>
  )
}

function HumanoidPelvisArmor({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group position={[0, 0, 0]}>
      <RoundedBox args={[0.26, 0.12, 0.19]} radius={0.038} smoothness={4} position={[0, 0.66, 0.035]} castShadow>
        <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.34} metalness={0.5} />
      </RoundedBox>
      <RoundedBox args={[0.17, 0.13, 0.13]} radius={0.03} smoothness={4} position={[0, 0.58, 0.02]} castShadow>
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.36} metalness={0.72} />
      </RoundedBox>
      {[-0.095, 0.095].map((x) => (
        <RoundedBox key={`pelvis-wing-${x}`} args={[0.09, 0.13, 0.07]} radius={0.022} smoothness={3} position={[x, 0.63, 0.05]} rotation={[0, 0, x < 0 ? -0.14 : 0.14]} castShadow>
          <meshStandardMaterial color="#eef4f8" roughness={0.3} metalness={0.48} />
        </RoundedBox>
      ))}
      <mesh position={[0, 0.715, 0.144]}>
        <boxGeometry args={[0.13, 0.012, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.42} toneMapped={false} />
      </mesh>
    </group>
  )
}

function HumanoidBackArmor({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group position={[0, 0, 0]}>
      <RoundedBox args={[0.14, 0.46, 0.038]} radius={0.026} smoothness={4} position={[0, 0.91, -0.188]} castShadow>
        <meshStandardMaterial color={JOINT_BLACK} roughness={0.3} metalness={0.76} />
      </RoundedBox>
      <RoundedBox args={[0.085, 0.52, 0.03]} radius={0.018} smoothness={3} position={[0, 0.9, -0.212]} castShadow>
        <meshStandardMaterial color={HUMANOID_DARK} roughness={0.26} metalness={0.78} />
      </RoundedBox>
      {[-0.145, 0.145].map((x) => (
        <RoundedBox key={`back-scapula-${x}`} args={[0.12, 0.28, 0.032]} radius={0.026} smoothness={3} position={[x, 0.98, -0.176]} rotation={[0, 0, x < 0 ? -0.1 : 0.1]} castShadow>
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.32} metalness={0.5} />
        </RoundedBox>
      ))}
      {[0.78, 0.9, 1.02].map((y) => (
        <mesh key={`back-light-${y}`} position={[0, y, -0.231]}>
          <boxGeometry args={[0.052, 0.012, 0.01]} />
          <meshStandardMaterial color={HUMANOID_VISOR} emissive={HUMANOID_VISOR} emissiveIntensity={0.82} toneMapped={false} />
        </mesh>
      ))}
      <RoundedBox args={[0.045, 0.24, 0.055]} radius={0.014} smoothness={3} position={[0.245, 0.91, -0.085]} castShadow>
        <meshStandardMaterial color={HUMANOID_DARK} roughness={0.32} metalness={0.72} />
      </RoundedBox>
      <mesh position={[0.247, 0.94, -0.056]}>
        <boxGeometry args={[0.028, 0.01, 0.01]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.58} toneMapped={false} />
      </mesh>
    </group>
  )
}

/**
 * 未来办公室协作机器人装配(rig)。
 * 每个可动部位由独立 group 包裹并暴露给外部,由调用方在 useFrame 中驱动动画;
 * 本组件自身不做任何动画,只负责结构与外形。
 *
 * 站姿参考(单位≈米,y=0 为脚底):
 *   腿高 ~0.5,躯干中心 ~0.86,肩枢轴 ~1.02,传感器头中心 ~1.32,总高约 1.5m。
 */
const AvatarRig = forwardRef<AvatarRefs, Props>(function AvatarRig(
  { position, rotation, scale = 1, accentColor, emblem, providerLogo, refs },
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
  const legLRef = useRef<Group>(null)
  const legRRef = useRef<Group>(null)

  // 同时把句柄写入外部 refs 对象与转发 ref;二者共享同一组内部 ref。
  const collect = (): AvatarRefs => {
    const bag: AvatarRefs = {
      root: rootRef.current,
      head: headRef.current,
      armL: armLRef.current,
      armR: armRRef.current,
      legL: legLRef.current,
      legR: legRRef.current
    }
    if (refs) {
      refs.root = bag.root
      refs.head = bag.head
      refs.armL = bag.armL
      refs.armR = bag.armR
      refs.legL = bag.legL
      refs.legR = bag.legR
    }
    return bag
  }
  useImperativeHandle(ref, collect, [refs])

  return (
    <group ref={rootRef} position={position} rotation={rotation} scale={scale}>
      <group scale={HUMANOID_PROPORTION_SCALE}>
      {/* ===== 模块化躯干 ===== */}
      <RoundedBox args={[0.36, 0.54, 0.23]} radius={0.06} smoothness={5} position={[0, 0.88, 0]} castShadow>
        <meshStandardMaterial color={FRAME} roughness={0.42} metalness={0.58} />
      </RoundedBox>
      <RoundedBox args={[0.3, 0.48, 0.23]} radius={0.052} smoothness={5} position={[0, 0.89, 0.018]} castShadow>
        <meshStandardMaterial color={body} roughness={0.54} metalness={0.32} />
      </RoundedBox>
      <RoundedBox args={[0.17, 0.28, 0.22]} radius={0.04} smoothness={4} position={[0, 0.94, 0.032]} castShadow>
        <meshStandardMaterial color={FRAME} roughness={0.38} metalness={0.58} />
      </RoundedBox>
      <HumanoidChestArmor accent={accent} providerLogo={providerLogo} />
      <HumanoidBackArmor accent={accent} />
      {/* 抽象工装/护甲:由 provider/model 皮肤驱动,不是厂商 logo。 */}
      <RoundedBox args={[0.44, 0.065, 0.24]} radius={0.026} smoothness={3} position={[0, 1.08, 0.002]} castShadow>
        <meshStandardMaterial color={shell} roughness={0.36} metalness={0.46} />
      </RoundedBox>
      <RoundedBox args={[0.12, 0.31, 0.036]} radius={0.014} smoothness={3} position={[-0.19, 0.9, 0.015]} rotation={[0, 0, -0.08]} castShadow>
        <meshStandardMaterial color={shell} roughness={0.4} metalness={0.42} />
      </RoundedBox>
      <RoundedBox args={[0.12, 0.31, 0.036]} radius={0.014} smoothness={3} position={[0.19, 0.9, 0.015]} rotation={[0, 0, 0.08]} castShadow>
        <meshStandardMaterial color={shell} roughness={0.4} metalness={0.42} />
      </RoundedBox>
      <RoundedBox args={[0.31, 0.055, 0.255]} radius={0.018} smoothness={3} position={[0, 0.675, 0.002]} castShadow>
        <meshStandardMaterial color={FRAME} roughness={0.34} metalness={0.68} />
      </RoundedBox>
      <mesh position={[-0.115, 0.678, 0.139]}>
        <boxGeometry args={[0.08, 0.018, 0.016]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.46} toneMapped={false} />
      </mesh>
      <mesh position={[0.115, 0.678, 0.139]}>
        <boxGeometry args={[0.08, 0.018, 0.016]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.46} toneMapped={false} />
      </mesh>
      <RoundedBox args={[0.165, 0.17, 0.018]} radius={0.014} smoothness={3} position={[0, 0.9, 0.172]}>
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.18}
          roughness={0.32}
          metalness={0.42}
          toneMapped={false}
        />
      </RoundedBox>
      <mesh position={[0, 0.785, 0.169]}>
        <boxGeometry args={[0.19, 0.018, 0.014]} />
        <meshStandardMaterial
          color={SERVICE_WHITE}
          emissive={SERVICE_GLOW}
          emissiveIntensity={0.18}
          roughness={0.38}
          metalness={0.44}
          toneMapped={false}
        />
      </mesh>
      {/* 后向服务屏:坐席机器人面对电脑时,默认镜头看到的是背面,这里保证机器人仍然可读。 */}
      <RoundedBox args={[0.33, 0.46, 0.032]} radius={0.028} smoothness={3} position={[0, 0.89, -0.151]} castShadow>
        <meshStandardMaterial color={shell} roughness={0.37} metalness={0.44} />
      </RoundedBox>
      <RoundedBox args={[0.22, 0.28, 0.026]} radius={0.024} smoothness={3} position={[0, 0.94, -0.137]} castShadow>
        <meshStandardMaterial
          color={SERVICE_WHITE}
          emissive={SERVICE_GLOW}
          emissiveIntensity={0.16}
          roughness={0.32}
          metalness={0.28}
          toneMapped={false}
        />
      </RoundedBox>
      <mesh position={[0, 0.99, -0.156]}>
        <boxGeometry args={[0.15, 0.026, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.42} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.91, -0.156]}>
        <boxGeometry args={[0.1, 0.018, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.82} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.82, -0.154]} castShadow>
        <boxGeometry args={[0.12, 0.18, 0.018]} />
        <meshStandardMaterial color={FRAME} roughness={0.34} metalness={0.72} />
      </mesh>
      <mesh position={[-0.085, 0.82, -0.168]}>
        <boxGeometry args={[0.018, 0.15, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.62} toneMapped={false} />
      </mesh>
      <mesh position={[0.085, 0.82, -0.168]}>
        <boxGeometry args={[0.018, 0.15, 0.012]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.62} toneMapped={false} />
      </mesh>
      <group position={[0, 0.945, -0.174]}>
        <RoundedBox args={[0.18, 0.074, 0.014]} radius={0.009} smoothness={3} castShadow>
          <meshStandardMaterial
            color={SERVICE_WHITE}
            emissive={SERVICE_GLOW}
            emissiveIntensity={0.18}
            roughness={0.32}
            metalness={0.34}
            toneMapped={false}
          />
        </RoundedBox>
        <mesh position={[0, 0.021, -0.009]}>
          <boxGeometry args={[0.13, 0.008, 0.006]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.82} toneMapped={false} />
        </mesh>
        <mesh position={[0, -0.021, -0.009]}>
          <boxGeometry args={[0.09, 0.007, 0.006]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.58} toneMapped={false} />
        </mesh>
        {codeBits.map((bit, i) => (
          <mesh key={`code-bit-${i}`} position={[-0.06 + i * 0.04, -0.001 + (bit - 1) * 0.006, -0.011]}>
            <boxGeometry args={[0.018, 0.018 + bit * 0.006, 0.006]} />
            <meshStandardMaterial
              color={bit === 0 ? '#0b1118' : accent}
              emissive={accent}
              emissiveIntensity={0.14 + bit * 0.16}
              roughness={0.3}
              metalness={0.24}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
      {providerLogo && (
        <ProviderLogoBadge
          logo={providerLogo}
          position={[0, 0.945, -0.19]}
          rotation={[0, Math.PI, 0]}
          width={0.2}
          height={0.082}
          depth={0.012}
          maxChars={4}
          compact
        />
      )}
      <RoundedBox args={[0.18, 0.09, 0.018]} radius={0.012} smoothness={3} position={[0, 0.965, 0.166]}>
        <meshStandardMaterial
          color={accent}
          emissive={accent}
          emissiveIntensity={0.52}
          roughness={0.28}
          metalness={0.18}
          toneMapped={false}
        />
      </RoundedBox>
      {providerLogo && (
        <ProviderLogoBadge
          logo={providerLogo}
          position={[0, 0.964, 0.184]}
          width={0.17}
          height={0.078}
          depth={0.012}
          maxChars={4}
          compact
        />
      )}
      <mesh position={[-0.145, 0.99, 0.165]}>
        <boxGeometry args={[0.022, 0.2, 0.014]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.24} toneMapped={false} />
      </mesh>
      <mesh position={[0.145, 0.99, 0.165]}>
        <boxGeometry args={[0.022, 0.2, 0.014]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.24} toneMapped={false} />
      </mesh>
      <mesh position={[-0.205, 0.86, 0.006]} rotation={[0, 0, -0.12]} castShadow>
        <boxGeometry args={[0.035, 0.28, 0.032]} />
        <meshStandardMaterial color={JOINT} roughness={0.32} metalness={0.76} />
      </mesh>
      <mesh position={[0.205, 0.86, 0.006]} rotation={[0, 0, 0.12]} castShadow>
        <boxGeometry args={[0.035, 0.28, 0.032]} />
        <meshStandardMaterial color={JOINT} roughness={0.32} metalness={0.76} />
      </mesh>
      <mesh position={[0, 1.09, 0.018]} castShadow>
        <boxGeometry args={[0.5, 0.06, 0.18]} />
        <meshStandardMaterial color={JOINT} roughness={0.34} metalness={0.76} />
      </mesh>
      <RoundedBox args={[0.58, 0.055, 0.22]} radius={0.026} smoothness={3} position={[0, 1.112, 0.002]} castShadow>
        <meshStandardMaterial color={shell} roughness={0.36} metalness={0.46} />
      </RoundedBox>
      <mesh position={[-0.23, 1.065, 0.006]} rotation={[0, 0, 0.16]} castShadow>
        <boxGeometry args={[0.13, 0.052, 0.16]} />
        <meshStandardMaterial color={shell} roughness={0.4} metalness={0.42} />
      </mesh>
      <mesh position={[0.23, 1.065, 0.006]} rotation={[0, 0, -0.16]} castShadow>
        <boxGeometry args={[0.13, 0.052, 0.16]} />
        <meshStandardMaterial color={shell} roughness={0.4} metalness={0.42} />
      </mesh>
      <mesh position={[-0.272, 1.064, -0.102]} rotation={[0, 0, 0.16]}>
        <boxGeometry args={[0.12, 0.018, 0.02]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.78} toneMapped={false} />
      </mesh>
      <mesh position={[0.272, 1.064, -0.102]} rotation={[0, 0, -0.16]}>
        <boxGeometry args={[0.12, 0.018, 0.02]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.78} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.69, 0]} castShadow>
        <cylinderGeometry args={[0.14, 0.18, 0.12, 24]} />
        <meshStandardMaterial color={SOFT_BLACK} roughness={0.48} metalness={0.5} />
      </mesh>
      <HumanoidPelvisArmor accent={accent} />
      <mesh position={[0, 1.13, 0]} castShadow>
        <cylinderGeometry args={[0.055, 0.07, 0.1, 24]} />
        <meshStandardMaterial color={JOINT} roughness={0.36} metalness={0.72} />
      </mesh>

      {/* ===== 传感器头(点头/摇头枢轴在颈根 y≈1.18) ===== */}
      <group ref={headRef} position={[0, 1.18, 0]}>
        <mesh position={[0, 0.21, -0.03]} scale={[0.76, 0.6, 0.78]} castShadow>
          <sphereGeometry args={[0.22, 32, 18]} />
          <meshStandardMaterial color={HUMANOID_DARK} roughness={0.22} metalness={0.48} />
        </mesh>
        <mesh position={[0, 0.265, -0.06]} scale={[0.68, 0.32, 0.64]} castShadow>
          <sphereGeometry args={[0.21, 32, 12]} />
          <meshStandardMaterial color="#131a22" roughness={0.22} metalness={0.46} />
        </mesh>
        <RoundedBox args={[0.31, 0.2, 0.25]} radius={0.046} smoothness={5} position={[0, 0.14, 0]} castShadow>
          <meshStandardMaterial color={FRAME} roughness={0.34} metalness={0.66} />
        </RoundedBox>
        <RoundedBox args={[0.27, 0.17, 0.265]} radius={0.04} smoothness={5} position={[0, 0.145, 0.012]} castShadow>
          <meshStandardMaterial color={HUMANOID_DARK} roughness={0.24} metalness={0.5} />
        </RoundedBox>
        <RoundedBox args={[0.25, 0.07, 0.026]} radius={0.018} smoothness={4} position={[0, 0.16, 0.155]}>
          <meshStandardMaterial
            color={DARK_GLASS}
            emissive={HUMANOID_VISOR}
            emissiveIntensity={0.52}
            roughness={0.12}
            metalness={0.28}
            toneMapped={false}
          />
        </RoundedBox>
        <mesh position={[0, 0.161, 0.174]}>
          <boxGeometry args={[0.18, 0.01, 0.008]} />
          <meshStandardMaterial color={HUMANOID_VISOR} emissive={HUMANOID_VISOR} emissiveIntensity={1.35} toneMapped={false} />
        </mesh>
        <HumanoidFaceHalo accent={accent} />
        <RoundedBox args={[0.18, 0.046, 0.022]} radius={0.012} smoothness={3} position={[0, 0.16, -0.137]}>
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.72} roughness={0.16} metalness={0.22} toneMapped={false} />
        </RoundedBox>
        <mesh position={[-0.072, 0.16, 0.188]}>
          <boxGeometry args={[0.028, 0.014, 0.01]} />
          <meshStandardMaterial color={HUMANOID_VISOR_CORE} emissive={HUMANOID_VISOR} emissiveIntensity={0.92} toneMapped={false} />
        </mesh>
        <mesh position={[0.072, 0.16, 0.188]}>
          <boxGeometry args={[0.028, 0.014, 0.01]} />
          <meshStandardMaterial color={HUMANOID_VISOR_CORE} emissive={HUMANOID_VISOR} emissiveIntensity={0.92} toneMapped={false} />
        </mesh>
        <mesh position={[-0.16, 0.14, 0.02]} castShadow>
          <boxGeometry args={[0.022, 0.11, 0.15]} />
          <meshStandardMaterial color={body} roughness={0.46} metalness={0.38} />
        </mesh>
        <mesh position={[0.16, 0.14, 0.02]} castShadow>
          <boxGeometry args={[0.022, 0.11, 0.15]} />
          <meshStandardMaterial color={body} roughness={0.46} metalness={0.38} />
        </mesh>
        <mesh position={[0, 0.27, 0.015]} castShadow>
          <cylinderGeometry args={[0.105, 0.12, 0.035, 28]} />
          <meshStandardMaterial color={JOINT} roughness={0.34} metalness={0.72} />
        </mesh>
        <mesh position={[0, 0.294, 0.018]}>
          <cylinderGeometry args={[0.088, 0.088, 0.01, 28]} />
          <meshStandardMaterial
            color={accent}
            emissive={accent}
            emissiveIntensity={0.28}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[0, 0.018, 0]} castShadow>
          <cylinderGeometry args={[0.044, 0.054, 0.062, 20]} />
          <meshStandardMaterial color={JOINT} roughness={0.34} metalness={0.72} />
        </mesh>
      </group>

      {/* ===== 左臂:肩枢轴 y≈1.02 ===== */}
      <group ref={armLRef} position={[-0.235, 1.03, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.078, 24, 16]} />
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.28} metalness={0.78} />
        </mesh>
        <HumanoidJointBearing accent={accent} position={[0, 0, 0.016]} rotation={[Math.PI / 2, 0, 0]} radius={0.064} />
        <mesh position={[-0.035, 0.006, 0.005]} rotation={[0, 0, -0.2]} castShadow>
          <sphereGeometry args={[0.122, 28, 18]} />
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.3} metalness={0.5} />
        </mesh>
        <mesh position={[0, -0.11, 0]} castShadow>
          <capsuleGeometry args={[0.052, 0.24, 8, 18]} />
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.36} metalness={0.48} />
        </mesh>
        <RoundedBox args={[0.074, 0.16, 0.04]} radius={0.014} smoothness={3} position={[0, -0.105, -0.038]} castShadow>
          <meshStandardMaterial color={body} roughness={0.42} metalness={0.42} />
        </RoundedBox>
        <mesh position={[0, -0.045, 0.045]}>
          <boxGeometry args={[0.07, 0.018, 0.018]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.28} toneMapped={false} />
        </mesh>
        <group position={[0, -0.22, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.041, 16, 10]} />
            <meshStandardMaterial color={JOINT} roughness={0.32} metalness={0.74} />
          </mesh>
          <HumanoidJointBearing accent={accent} position={[0, 0, 0.013]} rotation={[Math.PI / 2, 0, 0]} radius={0.038} />
          <mesh position={[0, -0.1, 0]} castShadow>
            <capsuleGeometry args={[0.038, 0.18, 8, 14]} />
            <meshStandardMaterial color={body} roughness={0.5} metalness={0.28} />
          </mesh>
          <RoundedBox args={[0.078, 0.13, 0.044]} radius={0.014} smoothness={3} position={[0, -0.095, -0.038]} castShadow>
            <meshStandardMaterial color={shell} roughness={0.42} metalness={0.42} />
          </RoundedBox>
          <RoundedBox args={[0.09, 0.04, 0.09]} radius={0.018} smoothness={3} position={[0, -0.205, 0.035]} castShadow>
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.36} metalness={0.68} />
          </RoundedBox>
          <mesh position={[0, -0.17, 0.084]}>
            <boxGeometry args={[0.072, 0.018, 0.018]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.42} toneMapped={false} />
          </mesh>
          <mesh position={[-0.025, -0.225, 0.09]} rotation={[0.2, 0, 0.14]} castShadow>
            <boxGeometry args={[0.014, 0.014, 0.12]} />
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.38} metalness={0.52} />
          </mesh>
          <mesh position={[0.025, -0.225, 0.09]} rotation={[0.2, 0, -0.14]} castShadow>
            <boxGeometry args={[0.014, 0.014, 0.12]} />
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.38} metalness={0.52} />
          </mesh>
          {[-0.047, 0, 0.047].map((x) => (
            <mesh key={`left-finger-${x}`} position={[x, -0.246, 0.102]} rotation={[0.22, 0, x * -3.2]} castShadow>
              <boxGeometry args={[0.011, 0.012, 0.095]} />
              <meshStandardMaterial color={JOINT_BLACK} roughness={0.36} metalness={0.44} />
            </mesh>
          ))}
        </group>
      </group>

      {/* ===== 右臂:肩枢轴 y≈1.02 ===== */}
      <group ref={armRRef} position={[0.235, 1.03, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.078, 24, 16]} />
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.28} metalness={0.78} />
        </mesh>
        <HumanoidJointBearing accent={accent} position={[0, 0, 0.016]} rotation={[Math.PI / 2, 0, 0]} radius={0.064} />
        <mesh position={[0.035, 0.006, 0.005]} rotation={[0, 0, 0.2]} castShadow>
          <sphereGeometry args={[0.122, 28, 18]} />
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.3} metalness={0.5} />
        </mesh>
        <mesh position={[0, -0.11, 0]} castShadow>
          <capsuleGeometry args={[0.052, 0.24, 8, 18]} />
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.36} metalness={0.48} />
        </mesh>
        <RoundedBox args={[0.074, 0.16, 0.04]} radius={0.014} smoothness={3} position={[0, -0.105, -0.038]} castShadow>
          <meshStandardMaterial color={body} roughness={0.42} metalness={0.42} />
        </RoundedBox>
        <mesh position={[0, -0.045, 0.045]}>
          <boxGeometry args={[0.07, 0.018, 0.018]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.28} toneMapped={false} />
        </mesh>
        <group position={[0, -0.22, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.041, 16, 10]} />
            <meshStandardMaterial color={JOINT} roughness={0.32} metalness={0.74} />
          </mesh>
          <HumanoidJointBearing accent={accent} position={[0, 0, 0.013]} rotation={[Math.PI / 2, 0, 0]} radius={0.038} />
          <mesh position={[0, -0.1, 0]} castShadow>
            <capsuleGeometry args={[0.038, 0.18, 8, 14]} />
            <meshStandardMaterial color={body} roughness={0.5} metalness={0.28} />
          </mesh>
          <RoundedBox args={[0.078, 0.13, 0.044]} radius={0.014} smoothness={3} position={[0, -0.095, -0.038]} castShadow>
            <meshStandardMaterial color={shell} roughness={0.42} metalness={0.42} />
          </RoundedBox>
          <RoundedBox args={[0.09, 0.04, 0.09]} radius={0.018} smoothness={3} position={[0, -0.205, 0.035]} castShadow>
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.36} metalness={0.68} />
          </RoundedBox>
          <mesh position={[0, -0.17, 0.084]}>
            <boxGeometry args={[0.072, 0.018, 0.018]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.42} toneMapped={false} />
          </mesh>
          <mesh position={[-0.025, -0.225, 0.09]} rotation={[0.2, 0, 0.14]} castShadow>
            <boxGeometry args={[0.014, 0.014, 0.12]} />
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.38} metalness={0.52} />
          </mesh>
          <mesh position={[0.025, -0.225, 0.09]} rotation={[0.2, 0, -0.14]} castShadow>
            <boxGeometry args={[0.014, 0.014, 0.12]} />
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.38} metalness={0.52} />
          </mesh>
          {[-0.047, 0, 0.047].map((x) => (
            <mesh key={`right-finger-${x}`} position={[x, -0.246, 0.102]} rotation={[0.22, 0, x * -3.2]} castShadow>
              <boxGeometry args={[0.011, 0.012, 0.095]} />
              <meshStandardMaterial color={JOINT_BLACK} roughness={0.36} metalness={0.44} />
            </mesh>
          ))}
        </group>
      </group>

      {/* ===== 左腿:髋枢轴 y≈0.66 ===== */}
      <group ref={legLRef} position={[-0.095, 0.66, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.065, 22, 14]} />
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.74} />
        </mesh>
        <HumanoidJointBearing accent={accent} position={[0, 0, 0.014]} rotation={[Math.PI / 2, 0, 0]} radius={0.052} />
        <mesh position={[0, -0.16, 0]} castShadow>
          <capsuleGeometry args={[0.07, 0.31, 8, 18]} />
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.36} metalness={0.48} />
        </mesh>
        <RoundedBox args={[0.155, 0.3, 0.068]} radius={0.032} smoothness={4} position={[0, -0.16, -0.045]} castShadow>
          <meshStandardMaterial color="#cfd8e2" roughness={0.34} metalness={0.5} />
        </RoundedBox>
        <RoundedBox args={[0.072, 0.16, 0.032]} radius={0.014} smoothness={3} position={[0.034, -0.15, 0.044]} rotation={[0, 0, -0.08]} castShadow>
          <meshStandardMaterial color={body} roughness={0.4} metalness={0.38} />
        </RoundedBox>
        <mesh position={[0, -0.295, 0]} castShadow>
          <sphereGeometry args={[0.055, 18, 12]} />
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.74} />
        </mesh>
        <HumanoidJointBearing accent={accent} position={[0, -0.295, 0.014]} rotation={[Math.PI / 2, 0, 0]} radius={0.047} />
        <group position={[0, -0.32, 0]}>
          <mesh position={[0, -0.14, 0]} castShadow>
            <capsuleGeometry args={[0.066, 0.31, 8, 18]} />
            <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.36} metalness={0.48} />
          </mesh>
          <RoundedBox args={[0.145, 0.31, 0.06]} radius={0.03} smoothness={4} position={[0, -0.15, -0.046]} castShadow>
            <meshStandardMaterial color="#d8e1ea" roughness={0.34} metalness={0.48} />
          </RoundedBox>
          <mesh position={[0.042, -0.13, 0.04]} rotation={[0, 0, -0.06]}>
            <boxGeometry args={[0.016, 0.2, 0.018]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.32} toneMapped={false} />
          </mesh>
          <RoundedBox args={[0.145, 0.06, 0.22]} radius={0.022} smoothness={3} position={[0, -0.295, 0.055]} castShadow>
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.34} metalness={0.72} />
          </RoundedBox>
          <RoundedBox args={[0.21, 0.045, 0.32]} radius={0.022} smoothness={4} position={[0, -0.345, 0.095]} castShadow>
            <meshStandardMaterial color={SOFT_BLACK} roughness={0.38} metalness={0.62} />
          </RoundedBox>
          <mesh position={[0, -0.245, 0.145]}>
            <boxGeometry args={[0.085, 0.012, 0.018]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.35} toneMapped={false} />
          </mesh>
        </group>
      </group>

      {/* ===== 右腿:髋枢轴 y≈0.66 ===== */}
      <group ref={legRRef} position={[0.095, 0.66, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.065, 22, 14]} />
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.74} />
        </mesh>
        <HumanoidJointBearing accent={accent} position={[0, 0, 0.014]} rotation={[Math.PI / 2, 0, 0]} radius={0.052} />
        <mesh position={[0, -0.16, 0]} castShadow>
          <capsuleGeometry args={[0.07, 0.31, 8, 18]} />
          <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.36} metalness={0.48} />
        </mesh>
        <RoundedBox args={[0.155, 0.3, 0.068]} radius={0.032} smoothness={4} position={[0, -0.16, -0.045]} castShadow>
          <meshStandardMaterial color="#cfd8e2" roughness={0.34} metalness={0.5} />
        </RoundedBox>
        <RoundedBox args={[0.072, 0.16, 0.032]} radius={0.014} smoothness={3} position={[-0.034, -0.15, 0.044]} rotation={[0, 0, 0.08]} castShadow>
          <meshStandardMaterial color={body} roughness={0.4} metalness={0.38} />
        </RoundedBox>
        <mesh position={[0, -0.295, 0]} castShadow>
          <sphereGeometry args={[0.055, 18, 12]} />
          <meshStandardMaterial color={JOINT_BLACK} roughness={0.32} metalness={0.74} />
        </mesh>
        <HumanoidJointBearing accent={accent} position={[0, -0.295, 0.014]} rotation={[Math.PI / 2, 0, 0]} radius={0.047} />
        <group position={[0, -0.32, 0]}>
          <mesh position={[0, -0.14, 0]} castShadow>
            <capsuleGeometry args={[0.066, 0.31, 8, 18]} />
            <meshStandardMaterial color={HUMANOID_SILVER} roughness={0.36} metalness={0.48} />
          </mesh>
          <RoundedBox args={[0.145, 0.31, 0.06]} radius={0.03} smoothness={4} position={[0, -0.15, -0.046]} castShadow>
            <meshStandardMaterial color="#d8e1ea" roughness={0.34} metalness={0.48} />
          </RoundedBox>
          <mesh position={[-0.042, -0.13, 0.04]} rotation={[0, 0, 0.06]}>
            <boxGeometry args={[0.016, 0.2, 0.018]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.32} toneMapped={false} />
          </mesh>
          <RoundedBox args={[0.145, 0.06, 0.22]} radius={0.022} smoothness={3} position={[0, -0.295, 0.055]} castShadow>
            <meshStandardMaterial color={JOINT_BLACK} roughness={0.34} metalness={0.72} />
          </RoundedBox>
          <RoundedBox args={[0.21, 0.045, 0.32]} radius={0.022} smoothness={4} position={[0, -0.345, 0.095]} castShadow>
            <meshStandardMaterial color={SOFT_BLACK} roughness={0.38} metalness={0.62} />
          </RoundedBox>
          <mesh position={[0, -0.245, 0.145]}>
            <boxGeometry args={[0.085, 0.012, 0.018]} />
            <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.35} toneMapped={false} />
          </mesh>
        </group>
      </group>
      </group>
    </group>
  )
})

export default AvatarRig
