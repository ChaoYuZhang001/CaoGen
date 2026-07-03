import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { Group, Mesh, MeshStandardMaterial } from 'three'
import type { SessionState } from '../../store'
import { formatCost } from '../../format'

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

const STATUS_LABEL: Record<Activity, string> = {
  idle: '空闲',
  working: '工作中',
  awaiting: '待授权',
  error: '异常'
}

interface Props {
  session: SessionState
  position: [number, number, number]
  active: boolean
  /** 厂商品牌色(小人身体着色);缺省用状态色 */
  brandColor?: string
  /** 办公区 / 宠物设置 */
  showBadge?: boolean
  liveliness?: number
  catEars?: boolean
  onSelect: () => void
}

export default function Workstation({
  session,
  position,
  active,
  brandColor,
  showBadge = true,
  liveliness = 1,
  catEars = false,
  onSelect
}: Props): React.JSX.Element {
  const activity = activityOf(session)
  const color = COLORS[activity]
  // 身体 = 厂商品牌色(身份),光环/屏幕 = 状态色(活动),两个维度一眼分辨
  const bodyColor = brandColor ?? color
  const L = liveliness

  const avatarRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const armLRef = useRef<Group>(null)
  const armRRef = useRef<Group>(null)
  const screenRef = useRef<Mesh>(null)
  const haloRef = useRef<Mesh>(null)
  const smokeRef = useRef<Group>(null)
  // 每个工位相位错开,避免整齐划一像机器人
  const phase = useMemo(() => (position[0] * 1.7 + position[2] * 0.9) % (Math.PI * 2), [position])

  useFrame((state) => {
    const t = state.clock.getElapsedTime() + phase
    const avatar = avatarRef.current
    const head = headRef.current
    if (!avatar || !head) return

    if (activity === 'working') {
      // 打字:身体快速小幅上下 + 头微点 + 双臂交替(活跃度调频)
      avatar.position.y = Math.abs(Math.sin(t * 8 * L)) * 0.04
      head.rotation.x = 0.12 + Math.sin(t * 8 * L) * 0.06
      head.rotation.z = 0
      if (armLRef.current) armLRef.current.rotation.x = -0.6 + Math.sin(t * 16 * L) * 0.4
      if (armRRef.current) armRRef.current.rotation.x = -0.6 + Math.cos(t * 16 * L) * 0.4
    } else if (activity === 'awaiting') {
      // 举手求授权:整体弹跳 + 一只手举高
      avatar.position.y = Math.abs(Math.sin(t * 4 * L)) * 0.12
      head.rotation.x = -0.1
      head.rotation.z = 0
      if (armLRef.current) armLRef.current.rotation.x = -0.3
      if (armRRef.current) armRRef.current.rotation.x = -2.6 + Math.sin(t * 8 * L) * 0.2
    } else if (activity === 'error') {
      // 异常:低头 + 轻微颤抖
      avatar.position.y = 0
      head.rotation.x = 0.4
      head.rotation.z = Math.sin(t * 20 * L) * 0.03
      if (armLRef.current) armLRef.current.rotation.x = -0.1
      if (armRRef.current) armRRef.current.rotation.x = -0.1
    } else {
      // 打盹:缓慢呼吸 + 头歪
      avatar.position.y = 0
      head.rotation.x = 0.05
      head.rotation.z = 0.28 + Math.sin(t * 1.2 * L) * 0.05
      const breathe = 1 + Math.sin(t * 1.6 * L) * 0.03
      avatar.scale.y = breathe
      if (armLRef.current) armLRef.current.rotation.x = -0.05
      if (armRRef.current) armRRef.current.rotation.x = -0.05
    }

    // 屏幕辉光:工作时脉动
    if (screenRef.current) {
      const mat = screenRef.current.material as MeshStandardMaterial
      const glow = activity === 'working' ? 0.6 + Math.abs(Math.sin(t * 6)) * 0.6 : 0.15
      mat.emissiveIntensity = glow
    }

    // 状态光环旋转
    if (haloRef.current) haloRef.current.rotation.z = t * 0.6

    // 异常冒烟:三团上升淡出
    if (smokeRef.current) {
      smokeRef.current.visible = activity === 'error'
      if (activity === 'error') {
        smokeRef.current.children.forEach((puff, i) => {
          const local = (t * 0.6 + i * 0.5) % 1
          puff.position.y = 0.7 + local * 0.9
          puff.position.x = Math.sin((t + i) * 2) * 0.08
          const m = puff as Mesh
          const mat = m.material as MeshStandardMaterial
          mat.opacity = (1 - local) * 0.5
          const sc = 0.05 + local * 0.12
          m.scale.setScalar(sc)
        })
      }
    }
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
        <circleGeometry args={[1.15, 32]} />
        <meshStandardMaterial color={active ? '#2b3550' : '#20242c'} />
      </mesh>

      {/* 状态光环 */}
      <mesh ref={haloRef} position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.0, 1.12, 40]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} transparent opacity={0.85} />
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
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.3} />
      </mesh>
      <mesh position={[0, 0.5, -0.5]}>
        <boxGeometry args={[0.06, 0.06, 0.06]} />
        <meshStandardMaterial color="#2c313c" />
      </mesh>

      {/* Agent 小人 */}
      <group ref={avatarRef} position={[0, 0, 0.15]} onClick={onSelect}>
        {/* 身体(厂商品牌色) */}
        <mesh position={[0, 0.32, 0]} castShadow>
          <capsuleGeometry args={[0.16, 0.28, 6, 12]} />
          <meshStandardMaterial color={bodyColor} />
        </mesh>
        {/* 左臂 */}
        <group ref={armLRef} position={[-0.17, 0.42, 0]}>
          <mesh position={[0, -0.12, 0.02]}>
            <capsuleGeometry args={[0.05, 0.2, 4, 8]} />
            <meshStandardMaterial color={bodyColor} />
          </mesh>
        </group>
        {/* 右臂 */}
        <group ref={armRRef} position={[0.17, 0.42, 0]}>
          <mesh position={[0, -0.12, 0.02]}>
            <capsuleGeometry args={[0.05, 0.2, 4, 8]} />
            <meshStandardMaterial color={bodyColor} />
          </mesh>
        </group>
        {/* 头 */}
        <group ref={headRef} position={[0, 0.62, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.15, 16, 16]} />
            <meshStandardMaterial color="#e8d9c4" />
          </mesh>
          {/* 宠物化:猫耳(品牌色) */}
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

      {/* 桌上厂商工牌(品牌色小立牌) */}
      {showBadge && (
        <mesh position={[0.4, 0.53, -0.3]} rotation={[0, -0.3, 0]}>
          <boxGeometry args={[0.16, 0.11, 0.015]} />
          <meshStandardMaterial color={bodyColor} emissive={bodyColor} emissiveIntensity={0.25} />
        </mesh>
      )}

      {/* 异常冒烟 */}
      <group ref={smokeRef} position={[0, 0, 0.15]} visible={false}>
        {[0, 1, 2].map((i) => (
          <mesh key={i}>
            <sphereGeometry args={[1, 8, 8]} />
            <meshStandardMaterial color="#888" transparent opacity={0.4} depthWrite={false} />
          </mesh>
        ))}
      </group>

      {/* 待授权:头顶感叹号 */}
      {activity === 'awaiting' && (
        <mesh position={[0, 1.15, 0.15]}>
          <sphereGeometry args={[0.09, 12, 12]} />
          <meshStandardMaterial color="#e0a33c" emissive="#e0a33c" emissiveIntensity={0.9} />
        </mesh>
      )}

      {/* 悬浮标签 */}
      <Html position={[0, 1.5, 0.15]} center distanceFactor={9} occlude={false}>
        <div className={`ws-label ${active ? 'ws-label-active' : ''}`} onClick={onSelect}>
          <div className="ws-label-title">{session.meta.title}</div>
          <div className="ws-label-meta">
            <span className="ws-dot" style={{ background: color }} />
            {STATUS_LABEL[activity]} · {formatCost(session.meta.costUsd)}
          </div>
        </div>
      </Html>
    </group>
  )
}
