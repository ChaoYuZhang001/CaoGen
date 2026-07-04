import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { Group } from 'three'

/** 视觉道具通用入参:位置/旋转/缩放 */
export interface OfficeProp {
  position?: [number, number, number]
  rotation?: [number, number, number]
  scale?: number
}

type Kind = 'speak' | 'think'

interface SpeechBubbleProps extends OfficeProp {
  /** 气泡文本;为空时不渲染内容 */
  text?: string
  /** speak=对话框(带尖角尾巴);think=思考云(带小圆点链) */
  kind?: Kind
}

const BUBBLE_STYLE: React.CSSProperties = {
  position: 'relative',
  maxWidth: 180,
  padding: '8px 12px',
  fontSize: 12,
  lineHeight: 1.35,
  color: '#151515',
  background: '#f4f4f4',
  border: '1px solid rgba(0,0,0,0.08)',
  boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
  userSelect: 'none',
  pointerEvents: 'none',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}

/**
 * 头顶漂浮气泡:纯 drei <Html> 实现(不产生 three 材质,故无需 toneMapped/Bloom)。
 * speak 为圆角对话框(底部尖角尾巴指向小人);
 * think 为思考云(更圆润 + 下方一串递减的小圆点)。
 * 随 useFrame 做轻微上下浮动与缓慢摆动,营造"活着"的气息。
 */
export default function SpeechBubble({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
  text = '',
  kind = 'speak'
}: SpeechBubbleProps): React.JSX.Element {
  const groupRef = useRef<Group>(null)

  // 闭包外派生浮动相位(避免每帧计算/new)
  const phase = useMemo(
    () => (position[0] * 1.7 + position[2] * 0.9) % (Math.PI * 2),
    [position]
  )
  const baseY = position[1]

  useFrame((state) => {
    const g = groupRef.current
    if (!g) return
    const t = state.clock.getElapsedTime() + phase
    // 轻微上下浮动 + 缓慢左右摆动
    g.position.y = baseY + Math.sin(t * 1.6) * 0.03
    g.rotation.z = Math.sin(t * 0.9) * 0.03
  })

  const isThink = kind === 'think'
  const radius = isThink ? 18 : 10

  return (
    <group ref={groupRef} position={position} rotation={rotation} scale={scale}>
      <Html position={[0, 0, 0]} center distanceFactor={9} occlude={false} zIndexRange={[20, 0]}>
        <div style={{ position: 'relative', transform: 'translateY(-50%)' }}>
          <div style={{ ...BUBBLE_STYLE, borderRadius: radius }}>{text}</div>

          {isThink ? (
            // 思考云:下方一串递减的小圆点
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: '100%',
                transform: 'translateX(-50%)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                marginTop: 3
              }}
            >
              <span style={dot(8)} />
              <span style={dot(5)} />
              <span style={dot(3)} />
            </div>
          ) : (
            // 对话框:底部尖角尾巴(CSS 三角)
            <span
              style={{
                position: 'absolute',
                left: '50%',
                top: '100%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent',
                borderTop: '9px solid #f4f4f4',
                filter: 'drop-shadow(0 3px 3px rgba(0,0,0,0.25))'
              }}
            />
          )}
        </div>
      </Html>
    </group>
  )
}

/** 思考云小圆点样式 */
function dot(size: number): React.CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    background: '#f4f4f4',
    boxShadow: '0 2px 5px rgba(0,0,0,0.3)'
  }
}
