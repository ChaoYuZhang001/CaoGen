import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { RoundedBox } from '@react-three/drei'
import AvatarRig from './AvatarRig'
import type { AvatarRefs } from './AvatarRig'
import Desk from './Desk'
import OfficeChair from './OfficeChair'
import MonitorSetup from './MonitorSetup'
import DeskAccessories from './DeskAccessories'
import DeskLamp from './DeskLamp'
import SpeechBubble from './SpeechBubble'
import VendorMascot from './VendorMascot'
import { vendorSkin } from './VendorSkins'
import ProviderLogoBadge from './ProviderLogoBadge'
import { providerLogoFor } from './ProviderLogos'
import type { ProviderLogoSpec } from './ProviderLogos'
import { applyMonitoring, applyTyping, applyTalking, applyThinking } from './AvatarAnimations'
import { officeActivityOf, type OfficeSessionActivity, type OfficeTask, type OfficeTaskStats } from '../model'
import type { MeshStandardMaterial } from 'three'

export type WorkstationActivity = OfficeSessionActivity

interface WorkstationProProps {
  position: [number, number, number]
  active: boolean
  activity: WorkstationActivity
  title: string
  costUsd: number
  brandName?: string
  providerBaseUrl?: string
  modelName?: string
  vendorKey?: string
  showBadge?: boolean
  liveliness?: number
  catEars?: boolean
  operatorAway?: boolean
  currentTask?: OfficeTask
  taskStats?: OfficeTaskStats
  onSelect: () => void
  onOpen?: () => void
}

/** 活动 → 屏幕/强调色(与办公区状态色规范一致,克制) */
const ACTIVITY_COLOR: Record<WorkstationActivity, string> = {
  idle: '#9dbfd6',
  working: '#3fc9c0',
  awaiting: '#e0a33c',
  completed: '#7fcf7a',
  error: '#d8593c'
}

/** 待授权时头顶气泡文案 */
const AWAITING_TEXT = '等待授权'

export const activityOf = officeActivityOf

function signalFromText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 997
  return hash
}

function OperatorWorkSurface({
  accent,
  screenColor,
  activity,
  progress
}: {
  accent: string
  screenColor: string
  activity: WorkstationActivity
  progress: number
}): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const railRef = useRef<MeshStandardMaterial>(null)
  const active = activity === 'working' || activity === 'awaiting'

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = (active ? 0.54 : 0.22) + Math.sin(t * 3.1) * (active ? 0.16 : 0.05)
    }
    if (railRef.current) {
      railRef.current.emissiveIntensity = (active ? 0.7 : 0.28) + Math.sin(t * 4.2 + 0.8) * (active ? 0.18 : 0.06)
    }
  })

  return (
    <group position={[0, 0.768, 0.16]}>
      <RoundedBox args={[0.66, 0.026, 0.32]} radius={0.025} smoothness={3} position={[0, 0, 0.02]} castShadow receiveShadow>
        <meshStandardMaterial color="#101820" metalness={0.28} roughness={0.52} transparent opacity={0.84} />
      </RoundedBox>
      <RoundedBox args={[0.5, 0.012, 0.18]} radius={0.018} smoothness={3} position={[0, 0.021, 0.02]}>
        <meshStandardMaterial
          ref={pulseRef}
          color={screenColor}
          emissive={screenColor}
          emissiveIntensity={active ? 0.48 : 0.2}
          transparent
          opacity={active ? 0.32 : 0.18}
          roughness={0.24}
          metalness={0.18}
          toneMapped={false}
        />
      </RoundedBox>
      <mesh position={[-0.18, 0.034, 0.07]}>
        <boxGeometry args={[0.16, 0.012, 0.022]} />
        <meshStandardMaterial ref={railRef} color={accent} emissive={accent} emissiveIntensity={0.6} toneMapped={false} />
      </mesh>
      <mesh position={[0.18, 0.034, 0.07]}>
        <boxGeometry args={[0.16, 0.012, 0.022]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.48} toneMapped={false} />
      </mesh>
      <RoundedBox args={[0.13, 0.032, 0.07]} radius={0.018} smoothness={3} position={[-0.18, 0.072, 0.19]} castShadow>
        <meshStandardMaterial color="#dce7f2" roughness={0.28} metalness={0.34} />
      </RoundedBox>
      <RoundedBox args={[0.13, 0.032, 0.07]} radius={0.018} smoothness={3} position={[0.18, 0.072, 0.19]} castShadow>
        <meshStandardMaterial color="#dce7f2" roughness={0.28} metalness={0.34} />
      </RoundedBox>
      <mesh position={[-0.18, 0.093, 0.19]}>
        <boxGeometry args={[0.088, 0.012, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.72 : 0.34} toneMapped={false} />
      </mesh>
      <mesh position={[0.18, 0.093, 0.19]}>
        <boxGeometry args={[0.088, 0.012, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.72 : 0.34} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.036, -0.08]}>
        <boxGeometry args={[0.42, 0.01, 0.018]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.42 : 0.2} toneMapped={false} />
      </mesh>
      <mesh position={[-0.11, 0.039, -0.005]} rotation={[0, 0.34, 0]}>
        <boxGeometry args={[0.018, 0.01, 0.18]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.38 : 0.16} toneMapped={false} />
      </mesh>
      <mesh position={[0.11, 0.039, -0.005]} rotation={[0, -0.34, 0]}>
        <boxGeometry args={[0.018, 0.01, 0.18]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={active ? 0.38 : 0.16} toneMapped={false} />
      </mesh>
      <mesh position={[-(0.46 * (1 - progress)) / 2, 0.043, 0.15]}>
        <boxGeometry args={[0.46 * progress, 0.01, 0.018]} />
        <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={active ? 0.58 : 0.22} toneMapped={false} />
      </mesh>
    </group>
  )
}

function OperatorInputArray({
  accent,
  screenColor,
  activity
}: {
  accent: string
  screenColor: string
  activity: WorkstationActivity
}): React.JSX.Element {
  const pulseRef = useRef<MeshStandardMaterial>(null)
  const active = activity === 'working' || activity === 'awaiting'

  useFrame((state) => {
    const t = state.clock.getElapsedTime()
    if (pulseRef.current) {
      pulseRef.current.emissiveIntensity = (active ? 0.74 : 0.34) + Math.sin(t * 5.4) * (active ? 0.2 : 0.08)
      pulseRef.current.opacity = (active ? 0.78 : 0.48) + Math.sin(t * 3.6) * 0.08
    }
  })

  return (
    <group position={[0, 0.858, 0.34]} rotation={[-0.08, 0, 0]}>
      <RoundedBox args={[0.78, 0.032, 0.28]} radius={0.024} smoothness={3} castShadow receiveShadow>
        <meshStandardMaterial color="#0e151d" metalness={0.34} roughness={0.52} transparent opacity={0.88} />
      </RoundedBox>
      {[-0.21, 0.21].map((x) => (
        <group key={x} position={[x, 0.027, 0.01]}>
          <RoundedBox args={[0.27, 0.018, 0.16]} radius={0.018} smoothness={3}>
            <meshStandardMaterial
              color={screenColor}
              emissive={screenColor}
              emissiveIntensity={active ? 0.42 : 0.22}
              transparent
              opacity={active ? 0.38 : 0.22}
              roughness={0.28}
              metalness={0.18}
              toneMapped={false}
            />
          </RoundedBox>
          {Array.from({ length: 5 }).map((_, i) => (
            <mesh key={`${x}-key-${i}`} position={[-0.09 + i * 0.045, 0.02, 0.012 + (i % 2) * 0.038]}>
              <boxGeometry args={[0.026, 0.012, 0.026]} />
              <meshStandardMaterial
                color={i % 2 === 0 ? accent : '#dce7f2'}
                emissive={i % 2 === 0 ? accent : screenColor}
                emissiveIntensity={active ? 0.68 : 0.3}
                transparent
                opacity={0.9}
                toneMapped={false}
              />
            </mesh>
          ))}
        </group>
      ))}
      <mesh position={[0, 0.046, -0.092]}>
        <boxGeometry args={[0.62, 0.014, 0.024]} />
        <meshStandardMaterial
          ref={pulseRef}
          color={accent}
          emissive={accent}
          emissiveIntensity={active ? 0.74 : 0.34}
          transparent
          opacity={active ? 0.78 : 0.48}
          toneMapped={false}
        />
      </mesh>
      {[-0.18, 0.18].map((x) => (
        <mesh key={`finger-target-${x}`} position={[x, 0.065, 0.12]} castShadow>
          <boxGeometry args={[0.12, 0.018, 0.038]} />
          <meshStandardMaterial color="#dce7f2" roughness={0.32} metalness={0.34} />
        </mesh>
      ))}
    </group>
  )
}

function OperatorContactLinks({
  accent,
  activity
}: {
  accent: string
  activity: WorkstationActivity
}): React.JSX.Element {
  const active = activity === 'working' || activity === 'awaiting'
  return (
    <group position={[0, 0, 0]}>
      {[-0.18, 0.18].map((x) => (
        <group key={x} position={[x, 0.865, 0.43]} rotation={[-0.22, 0, 0]}>
          <mesh>
            <boxGeometry args={[0.026, 0.014, 0.42]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={active ? 0.5 : 0.24}
              transparent
              opacity={active ? 0.62 : 0.34}
              roughness={0.3}
              metalness={0.16}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0.018, -0.21]}>
            <boxGeometry args={[0.11, 0.012, 0.035]} />
            <meshStandardMaterial color="#dce7f2" roughness={0.28} metalness={0.34} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function OperatorFocusLinks({
  accent,
  activity
}: {
  accent: string
  activity: WorkstationActivity
}): React.JSX.Element {
  const active = activity === 'working' || activity === 'awaiting'
  const opacity = active ? 0.22 : 0.11
  return (
    <group position={[0, 0, 0]}>
      {[-1, 1].map((dir) => (
        <group key={dir} position={[dir * 0.28, 1.31, 0.02]} rotation={[0, -dir * 0.52, 0]}>
          <mesh>
            <boxGeometry args={[0.018, 0.01, 1.08]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={active ? 0.36 : 0.16}
              transparent
              opacity={opacity}
              roughness={0.26}
              metalness={0.08}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0, -0.52]}>
            <boxGeometry args={[0.11, 0.014, 0.014]} />
            <meshStandardMaterial
              color={accent}
              emissive={accent}
              emissiveIntensity={active ? 0.48 : 0.22}
              transparent
              opacity={active ? 0.38 : 0.18}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  )
}

function DeskStatusPlaque({
  title,
  costUsd,
  accent,
  screenColor,
  activity,
  active,
  progress,
  currentTask,
  taskStats,
  providerLogo
}: {
  title: string
  costUsd: number
  accent: string
  screenColor: string
  activity: WorkstationActivity
  active: boolean
  progress: number
  currentTask?: OfficeTask
  taskStats?: OfficeTaskStats
  providerLogo: ProviderLogoSpec
}): React.JSX.Element {
  const signal = useMemo(() => signalFromText(title), [title])
  const costSignal = Math.max(0, Math.min(4, Math.ceil(Math.log10(Math.max(1, costUsd * 10000 + 1)))))
  const taskSignal =
    currentTask?.status === 'awaiting'
      ? '#e0a33c'
      : currentTask?.status === 'error'
        ? '#d8593c'
        : currentTask?.status === 'running'
          ? '#3fc9c0'
          : screenColor
  const toolTicks = Math.min(4, Math.max(1, taskStats?.tools ?? 1))
  const glow = activity === 'idle' ? 0.16 : active ? 0.5 : 0.32

  return (
    <group position={[-0.78, 0.096, 0.98]} rotation={[0, 0.08, 0]}>
      <RoundedBox args={[0.58, 0.035, 0.2]} radius={0.018} smoothness={3} receiveShadow castShadow>
        <meshStandardMaterial color="#121821" metalness={0.32} roughness={0.6} transparent opacity={0.86} />
      </RoundedBox>
      <mesh position={[0, 0.024, -0.074]}>
        <boxGeometry args={[0.46, 0.012, 0.018]} />
        <meshStandardMaterial
          color={screenColor}
          emissive={screenColor}
          emissiveIntensity={glow}
          transparent
          opacity={0.78}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[-(0.44 * (1 - progress)) / 2, 0.034, -0.073]}>
        <boxGeometry args={[0.44 * progress, 0.014, 0.022]} />
        <meshStandardMaterial color={screenColor} emissive={screenColor} emissiveIntensity={glow + 0.12} toneMapped={false} />
      </mesh>
      <mesh position={[-0.23, 0.032, 0.045]}>
        <cylinderGeometry args={[0.03, 0.03, 0.012, 16]} />
        <meshStandardMaterial color={taskSignal} emissive={taskSignal} emissiveIntensity={0.5} toneMapped={false} />
      </mesh>
      {Array.from({ length: 4 }).map((_, i) => {
        const enabled = i < toolTicks
        return (
          <mesh key={`tool-${i}`} position={[-0.11 + i * 0.055, 0.032, 0.045]}>
            <boxGeometry args={[0.026, 0.011, 0.026]} />
            <meshStandardMaterial
              color={enabled ? accent : '#2b3440'}
              emissive={enabled ? accent : '#000000'}
              emissiveIntensity={enabled ? 0.34 : 0}
              transparent
              opacity={enabled ? 0.82 : 0.58}
              toneMapped={false}
            />
          </mesh>
        )
      })}
      {Array.from({ length: 3 }).map((_, i) => {
        const phase = (signal + i * 7) % 3
        const enabled = i <= costSignal % 3
        return (
          <mesh key={`sig-${i}`} position={[0.16 + i * 0.045, 0.032, 0.044 + (phase - 1) * 0.006]}>
            <boxGeometry args={[0.026, 0.01, 0.018]} />
            <meshStandardMaterial
              color={enabled ? '#dce7f2' : '#2b3440'}
              emissive={enabled ? accent : '#000000'}
              emissiveIntensity={enabled ? 0.2 : 0}
              transparent
              opacity={enabled ? 0.78 : 0.52}
              toneMapped={false}
            />
          </mesh>
        )
      })}
      <ProviderLogoBadge
        logo={providerLogo}
        position={[0.13, 0.052, -0.03]}
        rotation={[-Math.PI / 2, 0, 0]}
        width={0.32}
        height={0.072}
        depth={0.012}
      />
    </group>
  )
}

/**
 * 完整写实工位:办公桌 + 转椅 + 双显示器 + 桌面小物 + 台灯 + Agent 小人。
 * 屏幕色与小人动作随 activity 驱动:working→打字,idle/completed→值守,
 * awaiting→说话并弹出气泡,error→思考托腮。
 * 低位 3D 状态铭牌表达标题/任务/成本的摘要信号;整组可点击选中。
 *
 * 坐标:自身原点在地面(y=0),桌面 y=0.74,朝 -Z 面向桌子。占地约 2m×2m。
 */
export default function WorkstationPro({
  position,
  active,
  activity,
  title,
  costUsd,
  brandName,
  providerBaseUrl,
  modelName,
  vendorKey,
  showBadge = true,
  liveliness = 1,
  catEars = false,
  operatorAway = false,
  currentTask,
  taskStats,
  onSelect,
  onOpen
}: WorkstationProProps): React.JSX.Element {
  const skin = useMemo(() => vendorSkin([brandName, modelName].filter(Boolean).join(' ')), [brandName, modelName])
  const providerLogo = useMemo(
    () => providerLogoFor([brandName, modelName, providerBaseUrl]),
    [brandName, modelName, providerBaseUrl]
  )
  const screenColor = ACTIVITY_COLOR[activity]
  const motionScale = Math.min(Math.max(liveliness, 0.2), 1.2)
  const totalTasks = taskStats?.total ?? 0
  const progress =
    totalTasks > 0
      ? Math.max(0.08, Math.min(1, ((taskStats?.done ?? 0) + (taskStats?.error ?? 0)) / totalTasks))
      : activity === 'working'
        ? 0.36
        : activity === 'awaiting'
          ? 0.62
          : activity === 'error' || activity === 'completed'
            ? 1
            : 0.08
  const showMascot = Boolean(vendorKey && showBadge && motionScale >= 1.15)
  const showOperator = !operatorAway

  // AvatarRig 在挂载后把各关节写入该句柄;useFrame 内读取并驱动动画。
  const rigRef = useRef<AvatarRefs>(null)

  // 相位偏移:让同类工位的小人动作错峰,避免整齐划一。
  const phase = useMemo(
    () => (position[0] * 1.7 + position[2] * 0.9) % (Math.PI * 2),
    [position]
  )

  useFrame((state) => {
    const refs = rigRef.current
    if (!refs) return
    const t = state.clock.getElapsedTime()
    const opts = { phase, liveliness: motionScale }
    if (activity === 'working') applyTyping(refs, t, opts)
    else if (activity === 'awaiting') applyTalking(refs, t, opts)
    else if (activity === 'error') applyThinking(refs, t, opts)
    else applyMonitoring(refs, t, opts)
  })

  const cursorOver = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    document.body.style.cursor = 'pointer'
  }
  const cursorOut = (): void => {
    document.body.style.cursor = 'default'
  }
  const clickSelect = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onSelect()
  }
  const doubleClickOpen = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    onOpen?.()
  }

  return (
    <group position={position} onClick={clickSelect} onDoubleClick={doubleClickOpen} onPointerOver={cursorOver} onPointerOut={cursorOut}>
      {/* 控制台基座:矩形信息区取代玩具感发光圆圈。 */}
      <RoundedBox args={[2.1, 0.045, 1.72]} radius={0.055} smoothness={3} position={[0, 0.024, 0.08]} receiveShadow>
        <meshStandardMaterial
          color={active ? '#20252d' : '#14181f'}
          metalness={0.28}
          roughness={0.78}
        />
      </RoundedBox>
      <mesh position={[0, 0.052, 0.92]} castShadow>
        <boxGeometry args={[1.72, 0.018, 0.052]} />
        <meshStandardMaterial color="#252b34" roughness={0.72} metalness={0.18} />
      </mesh>
      <mesh position={[-(1.72 * (1 - progress)) / 2, 0.068, 0.92]} castShadow>
        <boxGeometry args={[1.72 * progress, 0.026, 0.064]} />
        <meshStandardMaterial
          color={screenColor}
          emissive={screenColor}
          emissiveIntensity={activity === 'idle' ? 0.34 : 0.58}
          toneMapped={false}
        />
      </mesh>
      {active && (
        <>
          <mesh position={[0, 0.082, 0.08]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.13, 0.018, 8, 96]} />
            <meshStandardMaterial
              color={skin.accent}
              emissive={skin.accent}
              emissiveIntensity={0.68}
              transparent
              opacity={0.82}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0.095, 0.08]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.29, 0.006, 8, 96]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive={skin.accent}
              emissiveIntensity={0.42}
              transparent
              opacity={0.48}
              toneMapped={false}
            />
          </mesh>
        </>
      )}
      {active && (
        <mesh position={[0, 0.071, -0.78]} castShadow>
          <boxGeometry args={[1.76, 0.022, 0.055]} />
          <meshStandardMaterial
            color={skin.accent}
            emissive={skin.accent}
            emissiveIntensity={0.55}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* 办公桌:桌面 y≈0.74,面向 +Z 的使用者 */}
      <Desk position={[0, 0, -0.32]} />

      {/* 双显示器:置于桌面靠后 */}
      <MonitorSetup
        position={[0, 0.74, -0.48]}
        screenColor={screenColor}
        glow={activity === 'working' ? 1.35 : activity === 'awaiting' ? 1.18 : 1}
      />

      {/* 桌面小物:键盘/鼠标/马克杯/笔记本 */}
      <DeskAccessories position={[0, 0.74, -0.16]} />

      {/* 台灯:桌面右后角,working 时点亮更积极 */}
      <DeskLamp position={[0.52, 0.74, -0.42]} on={activity !== 'idle'} />

      {showBadge && (
        <ProviderLogoBadge
          logo={providerLogo}
          position={[0.36, 0.82, -0.09]}
          rotation={[0, -0.35, 0]}
          width={0.42}
          height={0.12}
          depth={0.018}
        />
      )}

      {showOperator && (
        <>
          <mesh position={[0, 0.061, 0.62]} receiveShadow>
            <cylinderGeometry args={[0.48, 0.48, 0.012, 40]} />
            <meshStandardMaterial
              color={skin.accent}
              emissive={skin.accent}
              emissiveIntensity={activity === 'idle' ? 0.66 : 0.86}
              transparent
              opacity={activity === 'idle' ? 0.48 : 0.56}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0.078, 0.98]} castShadow>
            <boxGeometry args={[0.46, 0.022, 0.042]} />
            <meshStandardMaterial
              color={skin.accent}
              emissive={skin.accent}
              emissiveIntensity={activity === 'idle' ? 0.62 : 0.78}
              roughness={0.32}
              metalness={0.24}
              toneMapped={false}
            />
          </mesh>

          {/* 转椅:面向 -Z(靠背在 +Z 侧) */}
          <OfficeChair position={[0, 0, 0.5]} />

          <OperatorWorkSurface
            accent={skin.accent}
            screenColor={screenColor}
            activity={activity}
            progress={progress}
          />
          <OperatorInputArray
            accent={skin.accent}
            screenColor={screenColor}
            activity={activity}
          />

          {/* Agent 操作员:未离席时始终面向 -Z 的显示器;离席时由 AgentWalkers 接管同一个 Agent。 */}
          <AvatarRig
            ref={rigRef}
            position={[0, 0.02, 0.64]}
            rotation={[0, Math.PI, 0]}
            scale={1}
            bodyColor={skin.bodyColor}
            skinColor={skin.shellColor}
            accentColor={skin.accent}
            emblem={skin.emblem}
            providerLogo={providerLogo}
            catEars={catEars}
          />
          <OperatorContactLinks accent={skin.accent} activity={activity} />
          <OperatorFocusLinks accent={skin.accent} activity={activity} />
        </>
      )}

      {showMascot && <VendorMascot vendorKey={vendorKey!} position={[0.5, 1.05, -0.38]} scale={0.32} />}

      {/* 待授权:头顶说话气泡 */}
      {activity === 'awaiting' && !operatorAway && (
        <SpeechBubble position={[0, 1.62, 0.58]} kind="speak" text={AWAITING_TEXT} />
      )}

      {/* 低位 3D 状态铭牌:保留状态可读性,避开 HTML 覆盖层。 */}
      {!operatorAway && (
        <DeskStatusPlaque
          title={title}
          costUsd={costUsd}
          accent={skin.accent}
          screenColor={screenColor}
          activity={activity}
          active={active}
          progress={progress}
          currentTask={currentTask}
          taskStats={taskStats}
          providerLogo={providerLogo}
        />
      )}
    </group>
  )
}
