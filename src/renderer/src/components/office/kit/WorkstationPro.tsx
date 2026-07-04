import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import AvatarRig from './AvatarRig'
import type { AvatarRefs } from './AvatarRig'
import Desk from './Desk'
import OfficeChair from './OfficeChair'
import MonitorSetup from './MonitorSetup'
import DeskAccessories from './DeskAccessories'
import DeskLamp from './DeskLamp'
import SpeechBubble from './SpeechBubble'
import { vendorSkin } from './VendorSkins'
import { applyIdle, applyTyping, applyTalking, applyThinking } from './AvatarAnimations'

export type WorkstationActivity = 'idle' | 'working' | 'awaiting' | 'error'

interface WorkstationProProps {
  position: [number, number, number]
  active: boolean
  activity: WorkstationActivity
  title: string
  costUsd: number
  brandName?: string
  onSelect: () => void
}

/** 活动 → 屏幕/强调色(与办公区状态色规范一致,克制) */
const ACTIVITY_COLOR: Record<WorkstationActivity, string> = {
  idle: '#5b6472',
  working: '#3fc9c0',
  awaiting: '#e0a33c',
  error: '#d8593c'
}

/** 活动 → 中文状态标签 */
const ACTIVITY_LABEL: Record<WorkstationActivity, string> = {
  idle: '空闲',
  working: '工作中',
  awaiting: '待授权',
  error: '出错'
}

/** 待授权时头顶气泡文案 */
const AWAITING_TEXT = '需要你确认下一步'

function formatCost(usd: number): string {
  const v = Number.isFinite(usd) ? usd : 0
  return `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`
}

/**
 * 完整写实工位:办公桌 + 转椅 + 双显示器 + 桌面小物 + 台灯 + Agent 小人。
 * 屏幕色与小人动作随 activity 驱动:working→打字,idle→待机,
 * awaiting→说话并弹出气泡,error→思考托腮。
 * 悬浮 <Html> 工牌显示 title / 状态 / 累计花费;整组可点击选中。
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
  onSelect
}: WorkstationProProps): React.JSX.Element {
  const skin = useMemo(() => vendorSkin(brandName), [brandName])
  const screenColor = ACTIVITY_COLOR[activity]

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
    const opts = { phase }
    if (activity === 'working') applyTyping(refs, t, opts)
    else if (activity === 'awaiting') applyTalking(refs, t, opts)
    else if (activity === 'error') applyThinking(refs, t, opts)
    else applyIdle(refs, t, opts)
  })

  const cursorOver = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation()
    document.body.style.cursor = 'pointer'
  }
  const cursorOut = (): void => {
    document.body.style.cursor = 'default'
  }

  return (
    <group position={position} onClick={onSelect} onPointerOver={cursorOver} onPointerOut={cursorOut}>
      {/* 选中/悬停地台高亮 */}
      <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.1, 32]} />
        <meshStandardMaterial color={active ? '#232a3a' : '#181b22'} roughness={0.9} />
      </mesh>

      {/* 选中态发光环(配合 Bloom) */}
      {active && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.02, 1.14, 48]} />
          <meshStandardMaterial
            color={skin.accent}
            emissive={skin.accent}
            emissiveIntensity={1.6}
            transparent
            opacity={0.85}
            toneMapped={false}
          />
        </mesh>
      )}

      {/* 办公桌:桌面 y≈0.74,面向 +Z 的使用者 */}
      <Desk position={[0, 0, -0.18]} />

      {/* 双显示器:置于桌面靠后 */}
      <MonitorSetup
        position={[0, 0.74, -0.34]}
        screenColor={screenColor}
        glow={activity === 'working' ? 1.4 : 0.7}
      />

      {/* 桌面小物:键盘/鼠标/马克杯/笔记本 */}
      <DeskAccessories position={[0, 0.74, -0.02]} />

      {/* 台灯:桌面右后角,working 时点亮更积极 */}
      <DeskLamp position={[0.52, 0.74, -0.28]} on={activity !== 'idle'} />

      {/* 转椅:面向 -Z(靠背在 +Z 侧) */}
      <OfficeChair position={[0, 0, 0.52]} />

      {/* Agent 小人:身体色取厂商皮肤;默认朝 -Z 面向桌子 */}
      <AvatarRig ref={rigRef} position={[0, 0, 0.44]} bodyColor={skin.bodyColor} />

      {/* 待授权:头顶说话气泡 */}
      {activity === 'awaiting' && (
        <SpeechBubble position={[0, 1.72, 0.44]} kind="speak" text={AWAITING_TEXT} />
      )}

      {/* 悬浮工牌:标题 / 状态 / 累计花费 */}
      <Html position={[0, 1.98, 0]} center distanceFactor={9} occlude={false} zIndexRange={[18, 0]}>
        <div
          onClick={onSelect}
          style={{
            minWidth: 120,
            maxWidth: 200,
            padding: '6px 10px',
            borderRadius: 10,
            background: active ? 'rgba(24,27,34,0.96)' : 'rgba(20,20,20,0.9)',
            border: `1px solid ${active ? skin.accent : 'rgba(244,244,244,0.14)'}`,
            boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
            color: '#f4f4f4',
            font: '12px/1.35 system-ui, -apple-system, sans-serif',
            userSelect: 'none',
            cursor: 'pointer'
          }}
        >
          <div
            style={{
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, opacity: 0.85 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: screenColor,
                boxShadow: `0 0 6px ${screenColor}`
              }}
            />
            <span>{ACTIVITY_LABEL[activity]}</span>
            <span style={{ opacity: 0.6 }}>·</span>
            <span>{formatCost(costUsd)}</span>
          </div>
        </div>
      </Html>
    </group>
  )
}
