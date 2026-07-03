import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, ContactShadows, Sparkles } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import { useStore } from '../../store'
import Workstation, { activityOf } from './Workstation'
import MessagePackets from './MessagePackets'
import { brandFor } from './brand'

/** 把会话按网格铺开;返回每个会话的世界坐标 */
function gridPositions(count: number): Array<[number, number, number]> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const gap = 3.0
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const rowCount = Math.ceil(count / cols)
    const x = (col - (cols - 1) / 2) * gap
    const z = (row - (rowCount - 1) / 2) * gap
    out.push([x, 0, z])
  }
  return out
}

export default function OfficeView(): React.JSX.Element {
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const providers = useStore((s) => s.providers)
  const office = useStore((s) => s.settings.office)
  const themePref = useStore((s) => s.settings.theme)
  const activeId = useStore((s) => s.activeId)
  const selectSession = useStore((s) => s.selectSession)
  const setView = useStore((s) => s.setView)
  const setShowNewSession = useStore((s) => s.setShowNewSession)

  // 办公区场景色随主题切换
  const isLight =
    themePref === 'light' ||
    (themePref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
  const scene = isLight
    ? { bg: '#f0f0f0', floor: '#e6e6e6', grid1: '#d0d0d0', grid2: '#dcdcdc', ground: '#ececec' }
    : { bg: '#0d0d0d', floor: '#151515', grid1: '#2a2a2a', grid2: '#1c1c1c', ground: '#151515' }

  const ids = order.filter((id) => sessions[id])
  const positions = gridPositions(ids.length)

  // 会话 → 厂商品牌色(providerId 映射到 Provider 名称,空则官方)
  const brandColorFor = (providerId: string): string => {
    const name = providerId ? providers.find((p) => p.id === providerId)?.name : ''
    return brandFor(name).color
  }

  const focus = (id: string): void => {
    selectSession(id)
    setView('list')
  }

  return (
    <div className="office">
      <div className="office-topbar drag-region">
        <div className="office-title no-drag">🏢 办公区</div>
        <div className="office-actions no-drag">
          <span className="office-hint">拖拽旋转 · 滚轮缩放 · 点击工位进入会话</span>
          <button className="btn btn-ghost" onClick={() => setShowNewSession(true)}>
            + 新建
          </button>
          <button className="btn btn-primary" onClick={() => setView('list')}>
            列表视图
          </button>
        </div>
      </div>

      {ids.length === 0 ? (
        <div className="office-empty">
          <div className="office-empty-inner">
            <div className="office-empty-mark">🏢</div>
            <p>办公区还没有工位。新建一个会话,看它入职开工。</p>
            <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
              + 新建会话
            </button>
          </div>
        </div>
      ) : (
        <Canvas shadows camera={{ position: [7, 7, 9], fov: 42 }} dpr={[1, 1.75]}>
          <color attach="background" args={[scene.bg]} />
          <fog attach="fog" args={[scene.bg, 16, 38]} />
          <ambientLight intensity={isLight ? 0.75 : 0.4} />
          <directionalLight
            position={[6, 12, 6]}
            intensity={isLight ? 1.3 : 1}
            castShadow
            shadow-mapSize={[2048, 2048]}
          />
          <directionalLight position={[-8, 6, -6]} intensity={0.4} color="#8fb4ff" />
          {/* 顶部聚光,强化中心舞台感 */}
          <spotLight position={[0, 14, 2]} angle={0.6} penumbra={0.8} intensity={isLight ? 0.5 : 0.9} />
          {/* 补一盏跟随状态色调的点光,增强氛围 */}
          <pointLight position={[0, 3, 4]} intensity={isLight ? 0.3 : 0.6} color={isLight ? '#ffffff' : '#4a5a80'} />

          {/* 地板 + 接触阴影 */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
            <planeGeometry args={[60, 60]} />
            <meshStandardMaterial color={scene.ground} metalness={0.2} roughness={0.85} />
          </mesh>
          <gridHelper args={[60, 60, scene.grid1, scene.grid2]} position={[0, 0.001, 0]} />
          <ContactShadows
            position={[0, 0.02, 0]}
            opacity={isLight ? 0.35 : 0.55}
            scale={40}
            blur={2.2}
            far={6}
          />

          {/* 环境浮尘 */}
          <Sparkles
            count={60}
            scale={[26, 8, 26]}
            position={[0, 4, 0]}
            size={2}
            speed={0.3}
            opacity={isLight ? 0.3 : 0.5}
            color={isLight ? '#888' : '#aab'}
          />

          <Suspense fallback={null}>
            {ids.map((id, i) => (
              <Workstation
                key={id}
                session={sessions[id]}
                position={positions[i]}
                active={id === activeId}
                brandColor={brandColorFor(sessions[id].meta.providerId)}
                showBadge={office.showBadges}
                liveliness={office.liveliness}
                catEars={office.catEars}
                onSelect={() => focus(id)}
              />
            ))}
            {/* 工位间飞行的消息包:多 Agent 协作氛围 */}
            <MessagePackets
              stations={ids.map((id, i) => ({
                pos: positions[i],
                active: activityOf(sessions[id]) === 'working'
              }))}
            />
          </Suspense>

          <OrbitControls
            enablePan={false}
            minDistance={6}
            maxDistance={22}
            maxPolarAngle={Math.PI / 2.2}
            autoRotate
            autoRotateSpeed={0.35}
            target={[0, 0.6, 0]}
          />

          {/* 后处理:辉光让发光材质/粒子"绚"起来 + 暗角聚焦 */}
          <EffectComposer>
            <Bloom
              intensity={isLight ? 0.6 : 1.3}
              luminanceThreshold={isLight ? 0.5 : 0.25}
              luminanceSmoothing={0.9}
              mipmapBlur
            />
            <Vignette eskil={false} offset={0.15} darkness={isLight ? 0.4 : 0.75} />
          </EffectComposer>
        </Canvas>
      )}
    </div>
  )
}
