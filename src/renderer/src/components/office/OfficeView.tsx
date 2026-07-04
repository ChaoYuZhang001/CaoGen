import { Suspense, useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, ContactShadows, Sparkles } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import Workstation, { activityOf } from './Workstation'
import MessagePackets from './MessagePackets'
import OfficeScene from './kit/OfficeScene'
import Wanderers, { type WandererSpec } from './kit/Wanderers'
import { brandFor } from './brand'
import { buildOfficeModel } from './model'

/**
 * 把会话按网格铺开在房间中央空地(OfficeScene 家具占外围:
 * 前区 z≈+6~8 休息/会议、左右墙 x≈±9.5、四角盆栽)。
 * 网格限定在 x∈[-6,6]、z∈[-5,3] 的安全区,间距随数量自适应收紧,绝不越界撞家具。
 */
function gridPositions(count: number): Array<[number, number, number]> {
  if (count === 0) return []
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rowCount = Math.ceil(count / cols)
  const SAFE_X = 12 // 中央可用宽度(x∈[-6,6])
  const SAFE_Z = 8 // 中央可用进深(z∈[-5,3])
  const gapX = cols > 1 ? Math.min(3.2, SAFE_X / (cols - 1)) : 0
  const gapZ = rowCount > 1 ? Math.min(3.2, SAFE_Z / (rowCount - 1)) : 0
  const centerZ = -1 // 整体略朝后,给前区休息/会议区留白
  const out: Array<[number, number, number]> = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = (col - (cols - 1) / 2) * gapX
    const z = (row - (rowCount - 1) / 2) * gapZ + centerZ
    out.push([x, 0, z])
  }
  return out
}

export default function OfficeView(): React.JSX.Element {
  const t = useT()
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
  const officeModel = useMemo(() => buildOfficeModel(ids, sessions), [ids, sessions])

  // 会话 → 厂商品牌色(providerId 映射到 Provider 名称,空则官方)
  const brandColorFor = (providerId: string): string => {
    const name = providerId ? providers.find((p) => p.id === providerId)?.name : ''
    return brandFor(name).color
  }

  // 空闲工位派 ≤3 个小人去会议桌(≈[7,0,6.5])环绕交流;活跃工位留守打字
  const wandererSpecs = useMemo<WandererSpec[]>(() => {
    const idle = ids.filter((id) => activityOf(sessions[id]) === 'idle')
    const MEET = [7, 0, 6.5] as const
    const seats: Array<[number, number, number]> = [
      [7, 0, 5.1],
      [8.4, 0, 6.5],
      [5.6, 0, 6.5]
    ]
    return idle.slice(0, 3).map((id, i) => {
      const idx = ids.indexOf(id)
      return {
        id,
        home: positions[idx] ?? [0, 0, 0],
        meet: seats[i] ?? [MEET[0], MEET[1], MEET[2]],
        bodyColor: brandColorFor(sessions[id].meta.providerId),
        phase: i * 2.3
      }
    })
  }, [ids, sessions, positions]) // eslint-disable-line react-hooks/exhaustive-deps

  const focus = (id: string): void => {
    selectSession(id)
    setView('list')
  }

  return (
    <div className="office">
      <div className="office-topbar drag-region">
        <div className="office-title no-drag">{t('officeTitle')}</div>
        <div className="office-actions no-drag">
          <span className="office-hint">{t('officeHint')}</span>
          <button className="btn btn-ghost" onClick={() => setShowNewSession(true)}>
            {t('newShort')}
          </button>
          <button className="btn btn-primary" onClick={() => setView('list')}>
            {t('listView')}
          </button>
        </div>
      </div>

      {ids.length === 0 ? (
        <div className="office-empty">
          <div className="office-empty-inner">
            <div className="office-empty-mark">🏢</div>
            <p>{t('officeEmpty')}</p>
            <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
              {t('newSession')}
            </button>
          </div>
        </div>
      ) : (
        <Canvas shadows camera={{ position: [7, 7, 9], fov: 42 }} dpr={[1, 1.75]}>
          <color attach="background" args={[scene.bg]} />
          <fog attach="fog" args={[scene.bg, 16, 38]} />
          <ambientLight intensity={isLight ? 0.95 : 0.7} />
          <directionalLight
            position={[6, 12, 6]}
            intensity={isLight ? 1.4 : 1.15}
            castShadow
            shadow-mapSize={[2048, 2048]}
          />
          <directionalLight position={[-8, 6, -6]} intensity={0.55} color="#9fc0ff" />
          {/* 顶部聚光,强化中心舞台感 */}
          <spotLight position={[0, 14, 2]} angle={0.7} penumbra={0.8} intensity={isLight ? 0.6 : 1.1} />
          {/* 中央暖色补光,提亮工位区,驱散 night 家具阴影 */}
          <pointLight position={[0, 5, 0]} intensity={isLight ? 0.4 : 0.9} distance={26} color={isLight ? '#ffffff' : '#cfd8f0'} />
          <hemisphereLight args={[isLight ? '#ffffff' : '#8a97b8', '#20242c', isLight ? 0.5 : 0.45]} />
          {/* 补一盏跟随状态色调的点光,增强氛围 */}
          <pointLight position={[0, 3, 4]} intensity={isLight ? 0.3 : 0.6} color={isLight ? '#ffffff' : '#4a5a80'} />

          {/* 富场景背景层:地板/墙/落地窗/家具/休息区/会议桌/白板/机架/茶水角 */}
          <Suspense fallback={null}>
            <OfficeScene />
          </Suspense>
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
                currentTask={officeModel.sessions[id]?.currentTask}
                taskStats={officeModel.sessions[id]?.taskStats}
                onSelect={() => focus(id)}
              />
            ))}
            {/* 真实任务流消息包:由 tool_use/runningTools/toolResults/pendingPermissions 派生 */}
            <MessagePackets
              stations={ids.map((id, i) => ({
                pos: positions[i],
                active: activityOf(sessions[id]) === 'working'
              }))}
              packets={officeModel.packets}
            />
            {/* 空闲小人离席去会议桌交流(纯氛围,让办公室"活"起来) */}
            <Wanderers specs={wandererSpecs} />
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
