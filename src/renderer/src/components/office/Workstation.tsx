import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { Color } from 'three'
import type { Group, Mesh, MeshStandardMaterial, Points } from 'three'
import type { SessionState } from '../../store'
import { useT } from '../../i18n'
import { formatCost } from '../../format'
import type { OfficeTask, OfficeTaskStats } from './model'
import VendorMascot from './kit/VendorMascot'

export type Activity = 'idle' | 'working' | 'awaiting' | 'error'

export function activityOf(s: SessionState): Activity {
  if (s.pendingPermissions.length > 0) return 'awaiting'
  if (s.meta.status === 'running' || s.meta.status === 'starting') return 'working'
  if (s.meta.status === 'error') return 'error'
  return 'idle'
}

const COLORS: Record<Activity, string> = {
  idle: '#5b6472',
  working: '#3fc9c0',
  awaiting: '#e0a33c',
  error: '#d8593c'
}

const STATUS_LABEL_KEY: Record<Activity, string> = {
  idle: 'statusIdle',
  working: 'activityWorking',
  awaiting: 'activityAwaiting',
  error: 'activityError'
}

const PARTICLE_COUNT = 14

interface Props {
  session: SessionState
  position: [number, number, number]
  active: boolean
  brandColor?: string
  /** 厂商键(deepseek/openai…),驱动桌面 3D 吉祥物造型 */
  vendorKey?: string
  showBadge?: boolean
  liveliness?: number
  catEars?: boolean
  currentTask?: OfficeTask
  taskStats?: OfficeTaskStats
  onSelect: () => void
}

/**
 * 单工位:桌子 + 显示器 + Agent 小人 + 按活动状态的粒子特效。
 * 状态色平滑过渡(lerp);发光材质配合 Bloom 后处理产生辉光。
 */
export default function Workstation({
  session,
  position,
  active,
  brandColor,
  vendorKey,
  showBadge = true,
  liveliness = 1,
  catEars = false,
  currentTask,
  taskStats,
  onSelect
}: Props): React.JSX.Element {
  // useT 基于 zustand(useSyncExternalStore),不依赖 React Context,R3F 树内可安全使用
  const t = useT()
  const activity = activityOf(session)
  const targetColor = COLORS[activity]
  const bodyColor = brandColor ?? targetColor
  const L = liveliness

  const avatarRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const armLRef = useRef<Group>(null)
  const armRRef = useRef<Group>(null)
  const screenRef = useRef<Mesh>(null)
  const haloRef = useRef<Mesh>(null)
  const haloMatRef = useRef<MeshStandardMaterial>(null)
  const glowRingRef = useRef<Mesh>(null)
  const particlesRef = useRef<Points>(null)
  const bangRef = useRef<Mesh>(null)

  const phase = useMemo(() => (position[0] * 1.7 + position[2] * 0.9) % (Math.PI * 2), [position])

  // 平滑过渡的当前状态色(每帧向 targetColor 逼近)
  const curColor = useRef(new Color(targetColor))
  const tmpColor = useRef(new Color())

  // 粒子初始位置(随机分布在工位周围),供各活动复用
  const particleData = useMemo(() => {
    const arr: Array<{ x: number; z: number; speed: number; off: number }> = []
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const a = (i / PARTICLE_COUNT) * Math.PI * 2
      arr.push({
        x: Math.cos(a) * (0.25 + (i % 3) * 0.12),
        z: Math.sin(a) * (0.25 + (i % 3) * 0.12) + 0.1,
        speed: 0.5 + (i % 5) * 0.14,
        off: (i * 0.37) % 1
      })
    }
    return arr
  }, [])

  const positionsAttr = useMemo(() => new Float32Array(PARTICLE_COUNT * 3), [])
  const taskLine = taskLabel(currentTask, taskStats)

  useFrame((state) => {
    const t = state.clock.getElapsedTime() + phase
    const avatar = avatarRef.current
    const head = headRef.current
    if (!avatar || !head) return

    // 状态色平滑过渡
    tmpColor.current.set(targetColor)
    curColor.current.lerp(tmpColor.current, 0.08)

    // ---- 小人动画 ----
    if (activity === 'working') {
      avatar.position.y = Math.abs(Math.sin(t * 8 * L)) * 0.05
      head.rotation.x = 0.12 + Math.sin(t * 8 * L) * 0.07
      head.rotation.z = 0
      if (armLRef.current) armLRef.current.rotation.x = -0.6 + Math.sin(t * 16 * L) * 0.5
      if (armRRef.current) armRRef.current.rotation.x = -0.6 + Math.cos(t * 16 * L) * 0.5
      avatar.scale.y = 1
    } else if (activity === 'awaiting') {
      avatar.position.y = Math.abs(Math.sin(t * 4 * L)) * 0.14
      head.rotation.x = -0.1
      head.rotation.z = 0
      if (armLRef.current) armLRef.current.rotation.x = -0.3
      if (armRRef.current) armRRef.current.rotation.x = -2.7 + Math.sin(t * 8 * L) * 0.25
      avatar.scale.y = 1
    } else if (activity === 'error') {
      avatar.position.y = 0
      head.rotation.x = 0.4
      head.rotation.z = Math.sin(t * 22 * L) * 0.04
      if (armLRef.current) armLRef.current.rotation.x = -0.1
      if (armRRef.current) armRRef.current.rotation.x = -0.1
      avatar.scale.y = 1
    } else {
      avatar.position.y = Math.sin(t * 1.6 * L) * 0.01
      head.rotation.x = 0.05
      head.rotation.z = 0.28 + Math.sin(t * 1.2 * L) * 0.06
      avatar.scale.y = 1 + Math.sin(t * 1.6 * L) * 0.03
      if (armLRef.current) armLRef.current.rotation.x = -0.05
      if (armRRef.current) armRRef.current.rotation.x = -0.05
    }

    // ---- 屏幕辉光脉动 ----
    if (screenRef.current) {
      const mat = screenRef.current.material as MeshStandardMaterial
      mat.emissive.copy(curColor.current)
      mat.emissiveIntensity =
        activity === 'working' ? 1.2 + Math.abs(Math.sin(t * 6)) * 1.3 : 0.35
    }

    // ---- 状态光环:旋转 + 呼吸缩放 + 颜色过渡 ----
    if (haloRef.current && haloMatRef.current) {
      haloRef.current.rotation.z = t * 0.8
      const s = 1 + Math.sin(t * 2.2) * (activity === 'awaiting' ? 0.12 : 0.04)
      haloRef.current.scale.setScalar(s)
      haloMatRef.current.color.copy(curColor.current)
      haloMatRef.current.emissive.copy(curColor.current)
      haloMatRef.current.emissiveIntensity = 1.6 + Math.sin(t * 3) * 0.5
    }

    // ---- 待授权:外扩光爆环 ----
    if (glowRingRef.current) {
      const on = activity === 'awaiting'
      glowRingRef.current.visible = on
      if (on) {
        const pulse = (t * 0.9) % 1
        glowRingRef.current.scale.setScalar(1 + pulse * 1.4)
        const m = glowRingRef.current.material as MeshStandardMaterial
        m.opacity = (1 - pulse) * 0.6
        m.emissive.copy(curColor.current)
      }
    }

    // ---- 感叹号弹跳 ----
    if (bangRef.current) {
      bangRef.current.visible = activity === 'awaiting'
      if (activity === 'awaiting') bangRef.current.position.y = 1.18 + Math.abs(Math.sin(t * 5)) * 0.1
    }

    // ---- 活动粒子 ----
    const pts = particlesRef.current
    if (pts) {
      const showParticles = activity !== 'idle' || true // idle 也有轻微飘浮
      pts.visible = showParticles
      const posAttr = pts.geometry.attributes.position
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const d = particleData[i]
        let local: number
        let y: number
        let x = d.x
        let z = d.z
        if (activity === 'working') {
          // 码粒:从桌面快速上升
          local = (t * d.speed * 1.6 + d.off) % 1
          y = 0.5 + local * 1.1
          x = d.x * 0.5
          z = -0.3 + Math.sin((t + i) * 3) * 0.05
        } else if (activity === 'error') {
          // 火花:快速外爆下落
          local = (t * d.speed * 2.2 + d.off) % 1
          y = 0.9 - local * 0.7
          x = d.x * (0.4 + local * 0.9)
          z = d.z * (0.4 + local * 0.9)
        } else if (activity === 'awaiting') {
          // 上升的关注光点
          local = (t * d.speed + d.off) % 1
          y = 0.6 + local * 0.9
        } else {
          // idle:缓慢环绕飘浮
          local = (t * d.speed * 0.3 + d.off) % 1
          y = 0.5 + local * 0.5
          x = d.x * (1 + Math.sin(t * 0.5 + i) * 0.15)
          z = d.z * (1 + Math.cos(t * 0.5 + i) * 0.15)
        }
        posAttr.setXYZ(i, x, y, z)
      }
      posAttr.needsUpdate = true
      const pm = pts.material as MeshStandardMaterial & { size?: number; opacity: number }
      pm.opacity = activity === 'idle' ? 0.25 : 0.9
    }

    // ---- 选中工位轻微悬浮整体 ----
  })

  return (
    <group position={position}>
      {/* 地台 / 选中高亮 */}
      <mesh
        position={[0, 0.01, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={onSelect}
        onPointerOver={(e) => {
          e.stopPropagation()
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'default'
        }}
      >
        <circleGeometry args={[1.15, 40]} />
        <meshStandardMaterial color={active ? '#232a3a' : '#181b22'} />
      </mesh>

      {/* 状态光环(发光,供 Bloom) */}
      <mesh ref={haloRef} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.0, 1.14, 48]} />
        <meshStandardMaterial
          ref={haloMatRef}
          color={targetColor}
          emissive={targetColor}
          emissiveIntensity={1.6}
          transparent
          opacity={0.9}
          toneMapped={false}
        />
      </mesh>

      {/* 待授权外扩光爆 */}
      <mesh ref={glowRingRef} position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[1.05, 1.2, 48]} />
        <meshStandardMaterial
          color={targetColor}
          emissive={targetColor}
          emissiveIntensity={2}
          transparent
          opacity={0.5}
          toneMapped={false}
        />
      </mesh>

      {/* 桌子 */}
      <mesh position={[0, 0.44, -0.35]} castShadow>
        <boxGeometry args={[1.1, 0.06, 0.5]} />
        <meshStandardMaterial color="#3a4150" />
      </mesh>
      <mesh position={[-0.45, 0.22, -0.35]}>
        <boxGeometry args={[0.06, 0.44, 0.06]} />
        <meshStandardMaterial color="#2c313c" />
      </mesh>
      <mesh position={[0.45, 0.22, -0.35]}>
        <boxGeometry args={[0.06, 0.44, 0.06]} />
        <meshStandardMaterial color="#2c313c" />
      </mesh>

      {/* 显示器 */}
      <mesh position={[0, 0.72, -0.5]}>
        <boxGeometry args={[0.62, 0.4, 0.04]} />
        <meshStandardMaterial color="#15181e" />
      </mesh>
      <mesh ref={screenRef} position={[0, 0.72, -0.475]}>
        <planeGeometry args={[0.54, 0.32]} />
        <meshStandardMaterial
          color={targetColor}
          emissive={targetColor}
          emissiveIntensity={0.35}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 0.5, -0.5]}>
        <boxGeometry args={[0.06, 0.06, 0.06]} />
        <meshStandardMaterial color="#2c313c" />
      </mesh>

      {/* Agent 小人 */}
      <group ref={avatarRef} position={[0, 0, 0.15]} onClick={onSelect}>
        <mesh position={[0, 0.32, 0]} castShadow>
          <capsuleGeometry args={[0.16, 0.28, 6, 12]} />
          <meshStandardMaterial color={bodyColor} />
        </mesh>
        <group ref={armLRef} position={[-0.17, 0.42, 0]}>
          <mesh position={[0, -0.12, 0.02]}>
            <capsuleGeometry args={[0.05, 0.2, 4, 8]} />
            <meshStandardMaterial color={bodyColor} />
          </mesh>
        </group>
        <group ref={armRRef} position={[0.17, 0.42, 0]}>
          <mesh position={[0, -0.12, 0.02]}>
            <capsuleGeometry args={[0.05, 0.2, 4, 8]} />
            <meshStandardMaterial color={bodyColor} />
          </mesh>
        </group>
        <group ref={headRef} position={[0, 0.62, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.15, 16, 16]} />
            <meshStandardMaterial color="#e8d9c4" />
          </mesh>
          {catEars && (
            <>
              <mesh position={[-0.09, 0.13, 0]} rotation={[0, 0, 0.3]}>
                <coneGeometry args={[0.05, 0.11, 4]} />
                <meshStandardMaterial color={bodyColor} />
              </mesh>
              <mesh position={[0.09, 0.13, 0]} rotation={[0, 0, -0.3]}>
                <coneGeometry args={[0.05, 0.11, 4]} />
                <meshStandardMaterial color={bodyColor} />
              </mesh>
            </>
          )}
        </group>
      </group>

      {/* 桌上厂商工牌 */}
      {showBadge && (
        <mesh position={[0.4, 0.53, -0.3]} rotation={[0, -0.3, 0]}>
          <boxGeometry args={[0.16, 0.11, 0.015]} />
          <meshStandardMaterial
            color={bodyColor}
            emissive={bodyColor}
            emissiveIntensity={0.35}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* 待授权头顶感叹号(发光) */}
      <mesh ref={bangRef} position={[0, 1.18, 0.15]} visible={false}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshStandardMaterial color="#e0a33c" emissive="#e0a33c" emissiveIntensity={2.4} toneMapped={false} />
      </mesh>

      {/* 活动粒子(发光点,供 Bloom) */}
      <points ref={particlesRef} position={[0, 0, 0.15]}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positionsAttr, 3]} count={PARTICLE_COUNT} />
        </bufferGeometry>
        <pointsMaterial
          color={targetColor}
          size={0.07}
          sizeAttenuation
          transparent
          opacity={0.9}
          depthWrite={false}
          toneMapped={false}
        />
      </points>

      {/* 厂商 3D 吉祥物:漂浮在桌面上方,缓慢旋转(DeepSeek 鲸鱼等) */}
      {vendorKey && <VendorMascot vendorKey={vendorKey} position={[0, 0.95, -0.35]} />}

      {/* 悬浮标签 */}
      <Html position={[0, 1.5, 0.15]} center distanceFactor={9} occlude={false}>
        <div className={`ws-label ${active ? 'ws-label-active' : ''}`} onClick={onSelect}>
          <div className="ws-label-title">{session.meta.title}</div>
          <div className="ws-label-meta">
            <span className="ws-dot" style={{ background: targetColor }} />
            {t(STATUS_LABEL_KEY[activity])} · {formatCost(session.meta.costUsd)}
          </div>
          {taskLine && (
            <div
              className="ws-label-meta"
              title={currentTask?.title}
              style={{ maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {taskLine}
            </div>
          )}
        </div>
      </Html>
    </group>
  )
}

function taskLabel(task: OfficeTask | undefined, stats: OfficeTaskStats | undefined): string {
  if (task) {
    const prefix =
      task.status === 'awaiting'
        ? '待授权'
        : task.status === 'running'
          ? '运行中'
          : task.status === 'error'
            ? '失败'
            : task.status === 'done'
              ? '已完成'
              : '排队'
    return `${prefix}: ${task.title}`
  }
  if (!stats || stats.total === 0) return ''
  if (stats.subtasks > 0) return `子任务 ${stats.subtasks} · 工具 ${stats.tools}`
  return `工具 ${stats.tools}`
}
