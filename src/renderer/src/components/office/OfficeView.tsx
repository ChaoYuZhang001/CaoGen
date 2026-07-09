import { Suspense, useCallback, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import MessagePackets from './MessagePackets'
import AgentWalkers from './kit/AgentWalkers'
import type { AgentWalkerSpec } from './kit/AgentWalkers'
import CameraRig from './kit/CameraRig'
import OfficeScene from './kit/OfficeScene'
import WorkstationPro, { activityOf } from './kit/WorkstationPro'
import { vendorKeyFor } from './kit/VendorSkins'
import { providerLogoFor } from './kit/ProviderLogos'
import { buildOfficeModel } from './model'
import type { OfficeSessionActivity } from './model'

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
  const centerZ = -1.7 // 整体后移,避免前景家具遮挡工位
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

const TEA_STOPS: Array<[number, number, number]> = [
  [4.35, 0, 1.82],
  [4.95, 0, 1.82]
]
const TEA_LOOK_AT: [number, number, number] = [5.48, 0, 2.02]
const APPROVAL_STOPS: Array<[number, number, number]> = [[4.18, 0, 0.74]]
const APPROVAL_LOOK_AT: [number, number, number] = [5.18, 0, 0.78]
const OFFICE_CAMERA_POSITION: [number, number, number] = [0.28, 4.58, 9.28]
const OFFICE_CAMERA_TARGET: [number, number, number] = [0.02, 0.76, -1.12]
const DEFAULT_OFFICE_SETTINGS = { showBadges: true, liveliness: 0.6, catEars: false }
type CameraPreset = 'overview' | 'agent' | 'facilities'

const ACTIVITY_LABEL_KEYS: Record<OfficeSessionActivity, string> = {
  idle: 'officeStatusIdle',
  working: 'activityWorking',
  awaiting: 'activityAwaiting',
  completed: 'officeStatusCompleted',
  error: 'activityError'
}

export default function OfficeView(): React.JSX.Element {
  const t = useT()
  const order = useStore((s) => s.order)
  const sessions = useStore((s) => s.sessions)
  const providers = useStore((s) => s.providers)
  const office = useStore((s) => s.settings?.office ?? DEFAULT_OFFICE_SETTINGS)
  const themePref = useStore((s) => s.settings?.theme ?? 'dark')
  const activeId = useStore((s) => s.activeId)
  const selectSession = useStore((s) => s.selectSession)
  const setView = useStore((s) => s.setView)
  const setShowNewSession = useStore((s) => s.setShowNewSession)
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('overview')

  // 省电:窗口失焦/页面隐藏(最小化、切他窗、熄屏)时暂停 3D 渲染循环
  // (切回列表视图时 OfficeView 整体卸载,无需在此处理)
  // 办公区场景色随主题切换
  const isLight =
    themePref === 'light' ||
    (themePref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
  const scene = isLight
    ? { bg: '#f0f0f0', floor: '#e6e6e6', grid1: '#d0d0d0', grid2: '#dcdcdc', ground: '#ececec' }
    : { bg: '#111820', floor: '#1d232b', grid1: '#33404d', grid2: '#232b35', ground: '#1a2028' }

  const ids = order.filter((id) => sessions[id])
  const positions = gridPositions(ids.length)
  const officeModel = useMemo(() => buildOfficeModel(ids, sessions), [ids, sessions])
  const subagentPacketCount = officeModel.packets.filter((packet) => packet.toolName === 'Subagent').length
  const activitySummary = useMemo(
    () =>
      ids.reduce(
        (acc, id) => {
          acc.total += 1
          acc[activityOf(sessions[id])] += 1
          return acc
        },
        { total: 0, idle: 0, working: 0, awaiting: 0, completed: 0, error: 0 }
      ),
    [ids, sessions]
  )

  const providerNameOf = (providerId: string): string => {
    return providerId ? (providers.find((p) => p.id === providerId)?.name ?? '') : ''
  }
  const providerBaseUrlOf = (providerId: string): string => {
    return providerId ? (providers.find((p) => p.id === providerId)?.baseUrl ?? '') : ''
  }

  // 会话 → 厂商键(驱动桌面抽象厂商造型),空则中性 Agent;model 名也参与识别。
  const vendorKeyOf = (providerId: string, modelName?: string): string => {
    return vendorKeyFor([providerNameOf(providerId), modelName, providerBaseUrlOf(providerId)].filter(Boolean).join(' '))
  }
  const sessionLogoSpecs = ids.map((id) => {
    const session = sessions[id]
    return providerLogoFor([
      providerNameOf(session.meta.providerId),
      session.meta.model,
      providerBaseUrlOf(session.meta.providerId)
    ])
  })
  const knownLogoCount = sessionLogoSpecs.filter((logo) => logo.known).length
  const logoAssetCount = sessionLogoSpecs.filter((logo) => Boolean(logo.assetUrl)).length
  const logoWordmarkAssetCount = sessionLogoSpecs.filter((logo) => Boolean(logo.wordmarkAssetUrl)).length
  const cnSessionCount = sessionLogoSpecs.filter((logo) => logo.cn).length
  const cnLogoAssetCount = sessionLogoSpecs.filter((logo) => logo.cn && Boolean(logo.assetUrl)).length
  const cnLogoWordmarkAssetCount = sessionLogoSpecs.filter((logo) => logo.cn && Boolean(logo.wordmarkAssetUrl)).length
  const qwenSessionCount = sessionLogoSpecs.filter((logo) => logo.key === 'qwen').length
  const deepseekSessionCount = sessionLogoSpecs.filter((logo) => logo.key === 'deepseek').length
  const abstractLogoFallbacks = sessionLogoSpecs.filter((logo) => !logo.known).length

  const semanticWalkers = useMemo<AgentWalkerSpec[]>(() => {
    const idle: AgentWalkerSpec[] = []
    const awaiting: AgentWalkerSpec[] = []

    ids.forEach((id, i) => {
      const session = sessions[id]
      const position = positions[i]
      if (!session || !position) return
      const activity = activityOf(session)
      const home: [number, number, number] = [position[0], 0, position[2] + 0.78]
      const homeLookAt: [number, number, number] = [position[0], 0, position[2] - 0.48]
      const providerName = providerNameOf(session.meta.providerId)
      const providerBaseUrl = providerBaseUrlOf(session.meta.providerId)
      const modelName = session.meta.model

      if (activity === 'awaiting') {
        const target = APPROVAL_STOPS[awaiting.length % APPROVAL_STOPS.length]
        awaiting.push({
          id: `${id}:approval`,
          sessionId: id,
          home,
          homeLookAt,
          target,
          targetLookAt: APPROVAL_LOOK_AT,
          reason: 'approval',
          providerName,
          providerBaseUrl,
          modelName,
          // 打开办公区时直接展示"已抵达审批台"的状态,避免验收截图停在半路。
          phase: 8.4 + awaiting.length * 4.5
        })
      } else if (activity === 'idle') {
        const target = TEA_STOPS[idle.length % TEA_STOPS.length]
        idle.push({
          id: `${id}:tea`,
          sessionId: id,
          home,
          homeLookAt,
          target,
          targetLookAt: TEA_LOOK_AT,
          reason: 'tea',
          providerName,
          providerBaseUrl,
          modelName,
          // 启动时先让离席 Agent 已经在茶水点,避免默认视角里像是站在工位前背对电脑。
          phase: 8.4 + idle.length * 5.15
        })
      }
    })

    return [...awaiting.slice(0, 1), ...idle.slice(0, 1)]
  }, [ids, positions, sessions, providers])
  const [awaySessionIds, setAwaySessionIds] = useState<Set<string>>(() => new Set())
  const handleWalkerAwayChange = useCallback((sessionId: string, away: boolean): void => {
    setAwaySessionIds((current) => {
      if (current.has(sessionId) === away) return current
      const next = new Set(current)
      if (away) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])
  const teaWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'tea').length
  const approvalWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'approval').length
  const deskRobotCount = Math.max(0, ids.length - awaySessionIds.size)
  const activeOfficeId = activeId && ids.includes(activeId) ? activeId : (ids[0] ?? null)
  const activeOfficeIndex = activeOfficeId ? ids.indexOf(activeOfficeId) : -1
  const activeOfficeSession = activeOfficeId ? sessions[activeOfficeId] : undefined
  const activeOfficeActivity = activeOfficeSession ? activityOf(activeOfficeSession) : undefined
  const activeWalker = activeOfficeId ? semanticWalkers.find((spec) => spec.sessionId === activeOfficeId) : undefined
  const activeOfficePosition =
    activeWalker && awaySessionIds.has(activeWalker.sessionId)
      ? activeWalker.target
      : activeOfficeIndex >= 0
        ? positions[activeOfficeIndex]
        : undefined
  const cameraPose = useMemo(() => {
    if (cameraPreset === 'facilities') {
      return {
        position: [4.2, 3.35, 6.35] as [number, number, number],
        target: [4.78, 0.8, 1.62] as [number, number, number]
      }
    }
    if (cameraPreset === 'agent' && activeOfficePosition) {
      return {
        position: [activeOfficePosition[0] + 2.4, 2.85, activeOfficePosition[2] + 4.15] as [number, number, number],
        target: [activeOfficePosition[0], 0.86, activeOfficePosition[2] + 0.08] as [number, number, number]
      }
    }
    return { position: OFFICE_CAMERA_POSITION, target: OFFICE_CAMERA_TARGET }
  }, [activeOfficePosition, cameraPreset])

  const selectOfficeSession = (id: string): void => {
    selectSession(id)
    setCameraPreset('agent')
  }
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
            <div className="office-empty-mark">AGENT</div>
            <p>{t('officeEmpty')}</p>
            <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
              {t('newSession')}
            </button>
          </div>
        </div>
      ) : (
        <div
          className="office-canvas-wrap"
          data-office-sessions={ids.length}
          data-office-idle-sessions={activitySummary.idle}
          data-office-running-sessions={activitySummary.working}
          data-office-waiting-approval-sessions={activitySummary.awaiting}
          data-office-completed-sessions={activitySummary.completed}
          data-office-failed-sessions={activitySummary.error}
          data-office-packets={officeModel.packets.length}
          data-office-subagent-packets={subagentPacketCount}
          data-office-walkers={semanticWalkers.length}
          data-office-away-sessions={awaySessionIds.size}
          data-office-desk-robots={deskRobotCount}
          data-office-tea-walkers={teaWalkerCount}
          data-office-approval-walkers={approvalWalkerCount}
          data-office-approval-stations={1}
          data-office-hydration-stations={1}
          data-office-service-wayfinding={1}
          data-office-amenity-portals={2}
          data-office-facility-signals={4}
          data-office-side-glass={1}
          data-office-architectural-lights={1}
          data-office-work-zone-glass={1}
          data-office-vendor-emblems={1}
          data-office-desk-facing-screens={deskRobotCount}
          data-office-operator-contact-links={deskRobotCount * 2}
          data-office-screen-focus-links={deskRobotCount * 2}
          data-office-desk-status-plaques={deskRobotCount}
          data-office-walker-floor-badges={semanticWalkers.length}
          data-office-work-inputs={deskRobotCount}
          data-office-operator-input-arrays={deskRobotCount}
          data-office-service-foreground-occluders={0}
          data-office-screen-panels={ids.length * 2}
          data-office-walker-routes={semanticWalkers.length}
          data-office-sightline-safe={1}
          data-office-cutaway-walls={1}
          data-office-overhead-fixtures-hidden={1}
          data-office-side-glass-cutaway={1}
          data-office-wall-occluders={0}
          data-office-long-light-occluders={0}
          data-office-presentation-backdrop={1}
          data-office-industrial-robots={deskRobotCount + semanticWalkers.length}
          data-office-provider-skin-panels={ids.length + semanticWalkers.length}
          data-office-real-provider-logo-skins={knownLogoCount}
          data-office-real-provider-logo-assets={logoAssetCount}
          data-office-real-provider-logo-wordmarks={logoWordmarkAssetCount}
          data-office-cn-provider-logo-skins={cnSessionCount}
          data-office-cn-provider-logo-assets={cnLogoAssetCount}
          data-office-cn-provider-logo-wordmarks={cnLogoWordmarkAssetCount}
          data-office-detected-cn-sessions={cnSessionCount}
          data-office-qwen-logo-skins={qwenSessionCount}
          data-office-qwen-sessions={qwenSessionCount}
          data-office-deepseek-logo-skins={deepseekSessionCount}
          data-office-deepseek-sessions={deepseekSessionCount}
          data-office-abstract-logo-skins={abstractLogoFallbacks}
          data-office-provider-logo-badges={deskRobotCount * 3 + semanticWalkers.length * 2}
          data-office-provider-logo-texture-badges={deskRobotCount * 3 + semanticWalkers.length * 2}
          data-office-provider-logo-wordmark-badges={deskRobotCount * 2 + semanticWalkers.length}
          data-office-clickable-workstations={ids.length}
          data-office-clickable-walkers={semanticWalkers.length}
          data-office-selected-session={activeOfficeId ?? ''}
          data-office-selected-workstations={activeOfficeId ? 1 : 0}
          data-office-camera-presets={3}
          data-office-active-camera-preset={cameraPreset}
          data-office-ops-backplane={1}
          data-office-data-trunks={1}
          data-office-workstation-branches={Math.max(4, ids.length)}
          data-office-subject-framing={1}
        >
          <div className="office-command-strip no-drag">
            <div className="office-metric">
              <span>{t('officeMetricSessions')}</span>
              <strong>{activitySummary.total}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricWorking')}</span>
              <strong>{activitySummary.working}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricAwaiting')}</span>
              <strong>{activitySummary.awaiting}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricCompleted')}</span>
              <strong>{activitySummary.completed}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricPackets')}</span>
              <strong>{officeModel.packets.length}</strong>
            </div>
          </div>
          <div className="office-camera-strip no-drag" data-office-camera-preset-controls={3}>
            {(['overview', 'agent', 'facilities'] as CameraPreset[]).map((preset) => (
              <button
                key={preset}
                className={`office-camera-button ${cameraPreset === preset ? 'active' : ''}`}
                onClick={() => setCameraPreset(preset)}
              >
                {t(`officePreset${preset[0].toUpperCase()}${preset.slice(1)}`)}
              </button>
            ))}
          </div>
          {activeOfficeSession && activeOfficeId && activeOfficeActivity && (
            <div className="office-selection-panel no-drag" data-office-selection-panel={activeOfficeId}>
              <div className="office-selection-kicker">{t('officeSelectedAgent')}</div>
              <div className="office-selection-title">{activeOfficeSession.meta.title}</div>
              <div className="office-selection-meta">
                <span>{t(ACTIVITY_LABEL_KEYS[activeOfficeActivity])}</span>
                <span>{activeOfficeSession.meta.model || '-'}</span>
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => focus(activeOfficeId)}>
                {t('officeOpenSession')}
              </button>
            </div>
          )}
          <Canvas
            shadows
            camera={{ position: OFFICE_CAMERA_POSITION, fov: 43, near: 0.1, far: 100 }}
            dpr={[1, 1.5]}
            frameloop="always"
            resize={{ offsetSize: true }}
            onCreated={({ camera }) => {
              camera.lookAt(...OFFICE_CAMERA_TARGET)
              camera.updateProjectionMatrix()
            }}
          >
          <color attach="background" args={[scene.bg]} />
          <fog attach="fog" args={[scene.bg, 18, 42]} />
          <ambientLight intensity={isLight ? 0.95 : 0.82} />
          <directionalLight
            position={[6, 12, 6]}
            intensity={isLight ? 1.4 : 1.28}
            castShadow
            shadow-mapSize={[1024, 1024]}
          />
          <directionalLight position={[-8, 6, -6]} intensity={isLight ? 0.55 : 0.72} color="#9fc0ff" />
          {/* 顶部聚光,强化中心舞台感 */}
          <spotLight position={[0, 14, 2]} angle={0.7} penumbra={0.8} intensity={isLight ? 0.6 : 1.1} />
          {/* 中央暖色补光,提亮工位区,驱散 night 家具阴影 */}
          <pointLight position={[0, 5, 0]} intensity={isLight ? 0.4 : 1.12} distance={26} color={isLight ? '#ffffff' : '#d8e4ff'} />
          <hemisphereLight args={[isLight ? '#ffffff' : '#9fb2d8', '#252b34', isLight ? 0.5 : 0.56]} />
          {/* 不可见工位补光:只提亮机器人/桌面,不增加任何会挡镜头的实体灯具。 */}
          <pointLight position={[0, 2.35, 0.65]} intensity={isLight ? 0.36 : 1.08} distance={10.5} color={isLight ? '#ffffff' : '#c8f1ff'} />
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

          <Suspense fallback={null}>
            {ids.map((id, i) => (
              <WorkstationPro
                key={id}
                position={positions[i]}
                active={id === activeId}
                activity={activityOf(sessions[id])}
                title={sessions[id].meta.title}
                costUsd={sessions[id].meta.costUsd}
                brandName={
                  sessions[id].meta.providerId
                    ? providerNameOf(sessions[id].meta.providerId)
                    : undefined
                }
                providerBaseUrl={providerBaseUrlOf(sessions[id].meta.providerId)}
                modelName={sessions[id].meta.model}
                vendorKey={vendorKeyOf(sessions[id].meta.providerId, sessions[id].meta.model)}
                showBadge={office.showBadges}
                liveliness={office.liveliness}
                catEars={office.catEars}
                operatorAway={awaySessionIds.has(id)}
                currentTask={officeModel.sessions[id]?.currentTask}
                taskStats={officeModel.sessions[id]?.taskStats}
                onSelect={() => focus(id)}
                onOpen={() => focus(id)}
              />
            ))}
            <AgentWalkers
              specs={semanticWalkers}
              activeSessionId={activeOfficeId}
              onAwayChange={handleWalkerAwayChange}
              onSelect={selectOfficeSession}
              onOpen={focus}
            />
            {/* 真实任务流消息包:由 tool_use/runningTools/toolResults/pendingPermissions 派生 */}
            <MessagePackets
              stations={ids.map((id, i) => ({
                pos: positions[i],
                active: activityOf(sessions[id]) === 'working'
              }))}
              packets={officeModel.packets}
            />
          </Suspense>

          <CameraRig position={cameraPose.position} target={cameraPose.target} auto={false} />

          </Canvas>
        </div>
      )}
    </div>
  )
}
