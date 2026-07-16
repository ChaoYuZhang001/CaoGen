import { memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import { useStore } from '../../store'
import { useT } from '../../i18n'
import AgentWalkers from './kit/AgentWalkers'
import type { AgentWalkerSpec } from './kit/AgentWalkers'
import CameraRig from './kit/CameraRig'
import FacilityHotspots, {
  OFFICE_FACILITY_OVERVIEW_CAMERA,
  OFFICE_FACILITY_SPECS
} from './kit/FacilityHotspots'
import type { OfficeFacilityKey } from './kit/FacilityHotspots'
import OfficeScene from './kit/OfficeScene'
import OfficePerformanceProbe from './kit/OfficePerformanceProbe'
import OfficeFrameDriver, { useOfficeRenderQuality } from './kit/OfficeRenderQuality'
import WorkstationPro, { activityOf } from './kit/WorkstationPro'
import { vendorKeyFor } from './kit/VendorSkins'
import { providerLogoFor } from './kit/ProviderLogos'
import {
  preloadReferenceRobotDecoder,
  preloadReferenceRobotModel,
  REFERENCE_ROBOT_GLB_URL
} from './kit/RobotModelAsset'
import { buildOfficeModel } from './model'
import type { OfficeSessionActivity } from './model'
import type { OfficeContactShadowMode } from './quality'
import type { GitStatus, SchedulerStrategy } from '../../../../shared/types'

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
  const centerZ = -2.1 // 整体后移,保证前排机器人与座椅完整入镜
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
const RESTROOM_STOPS: Array<[number, number, number]> = [[-7.62, 0, 3.92]]
const RESTROOM_LOOK_AT: [number, number, number] = [-8, 0, 4.65]
const DINING_STOPS: Array<[number, number, number]> = [[-5.34, 0, 5.18]]
const DINING_LOOK_AT: [number, number, number] = [-4.45, 0, 6.55]
const OFFICE_CAMERA_POSITION: [number, number, number] = [0.28, 4.5, 9.55]
const OFFICE_CAMERA_TARGET: [number, number, number] = [0.02, 0.82, -1.18]
const OFFICE_CAMERA_FOV = 44
const WALKER_VISUAL_SCALE = 1.18
const DEFAULT_OFFICE_SETTINGS = { qualityMode: 'auto' as const, showBadges: true, liveliness: 1, catEars: false }
const OFFICE_CONTACT_SHADOW_POSITION: [number, number, number] = [0, 0.02, 0]
type CameraPreset = 'overview' | 'agent' | 'facilities' | 'incidents'
const CAMERA_PRESETS: CameraPreset[] = ['overview', 'agent', 'facilities', 'incidents']
let fullRobotPreloadScheduled = false

export function preloadOfficeAssets(): void {
  preloadReferenceRobotDecoder()
  if (fullRobotPreloadScheduled) return
  fullRobotPreloadScheduled = true
  preloadReferenceRobotModel(REFERENCE_ROBOT_GLB_URL)
}

const OfficeContactShadows = memo(function OfficeContactShadows({
  lightMode,
  mode,
  frames,
  resolution
}: {
  lightMode: boolean
  mode: OfficeContactShadowMode
  frames: number
  resolution: number
}): React.JSX.Element {
  return (
    <ContactShadows
      position={OFFICE_CONTACT_SHADOW_POSITION}
      opacity={lightMode ? 0.24 : 0.34}
      scale={40}
      blur={1.4}
      far={3.5}
      frames={frames}
      resolution={resolution}
      smooth={mode === 'dynamic'}
    />
  )
})

function OfficeBootScene({
  ids,
  positions,
  activeId,
  lightMode,
  onSelect,
  onOpen
}: {
  ids: string[]
  positions: Array<[number, number, number]>
  activeId: string | null
  lightMode: boolean
  onSelect: (id: string) => void
  onOpen: (id: string) => void
}): React.JSX.Element {
  return (
    <group name="office-boot-scene" userData={{ officeBootScene: true }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[42, 30]} />
        <meshBasicMaterial color={lightMode ? '#a7b1b7' : '#202832'} />
      </mesh>
      {ids.map((id, index) => {
        const position = positions[index]
        const accent = id === activeId ? '#59dcff' : '#697680'
        return (
          <group
            key={id}
            name="office-boot-workstation"
            position={position}
            userData={{ officeBootWorkstation: true, officeRobotSessionId: id }}
            onClick={(event) => {
              event.stopPropagation()
              onSelect(id)
            }}
            onDoubleClick={(event) => {
              event.stopPropagation()
              onOpen(id)
            }}
          >
            <mesh position={[0, 0.04, 0.08]}>
              <boxGeometry args={[2.05, 0.08, 1.66]} />
              <meshBasicMaterial color={lightMode ? '#89969e' : '#182029'} />
            </mesh>
            <mesh position={[0, 0.62, -0.34]}>
              <boxGeometry args={[1.45, 0.08, 0.62]} />
              <meshBasicMaterial color={lightMode ? '#65737d' : '#303a45'} />
            </mesh>
            <group
              name="office-boot-robot"
              position={[0, 0, 0.28]}
              userData={{
                officeRobotLoading: true,
                officeRobotRequestedLod: id === activeId ? 'full' : 'low',
                officeRobotSessionId: id
              }}
            >
              <mesh position={[0, 0.86, 0]}>
                <capsuleGeometry args={[0.14, 0.48, 4, 8]} />
                <meshBasicMaterial color={lightMode ? '#d8dee3' : '#95a2ad'} />
              </mesh>
              <mesh position={[0, 1.28, 0]}>
                <sphereGeometry args={[0.17, 12, 8]} />
                <meshBasicMaterial color={lightMode ? '#19222b' : '#0e151c'} />
              </mesh>
              <mesh position={[0, 1.28, 0.16]}>
                <boxGeometry args={[0.19, 0.025, 0.016]} />
                <meshBasicMaterial color={accent} toneMapped={false} />
              </mesh>
            </group>
          </group>
        )
      })}
    </group>
  )
}

function walkerLocalPoint(point: [number, number, number]): [number, number, number] {
  return [
    point[0] / WALKER_VISUAL_SCALE,
    point[1] / WALKER_VISUAL_SCALE,
    point[2] / WALKER_VISUAL_SCALE
  ]
}

const ACTIVITY_LABEL_KEYS: Record<OfficeSessionActivity, string> = {
  idle: 'officeStatusIdle',
  working: 'activityWorking',
  awaiting: 'activityAwaiting',
  completed: 'officeStatusCompleted',
  error: 'activityError'
}

function routingStrategyKey(strategy: SchedulerStrategy): string {
  if (strategy === 'quality') return 'routingStrategyQuality'
  if (strategy === 'cost') return 'routingStrategyCost'
  if (strategy === 'speed') return 'routingStrategySpeed'
  return 'routingStrategyBalanced'
}

function moneyShort(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`
}

function durationShort(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '0s'
  if (value < 60_000) return `${Math.max(1, Math.round(value / 1000))}s`
  return `${Math.round(value / 60_000)}m`
}

function workspaceChangeShort(signal: {
  changedFiles: number
  insertions: number
  deletions: number
  gitOk?: boolean
  gitStaged?: number
  gitUnstaged?: number
  gitUntracked?: number
}): string {
  if (signal.gitOk === false) return 'git error'
  if (signal.gitOk === true) {
    if (signal.changedFiles <= 0) return 'clean'
    return `${signal.changedFiles} · S${signal.gitStaged ?? 0}/U${signal.gitUnstaged ?? 0}/?${signal.gitUntracked ?? 0}`
  }
  if (signal.changedFiles <= 0) return '0'
  return `${signal.changedFiles} · +${signal.insertions}/-${signal.deletions}`
}

function gitStatusError(id: string, err: unknown): GitStatus {
  return {
    ok: false,
    cwd: '',
    branch: '',
    files: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    error: `office git status failed for ${id}: ${err instanceof Error ? err.message : String(err)}`
  }
}

export default function OfficeView(): React.JSX.Element {
  const t = useT()
  const hydrated = useStore((s) => s.hydrated)
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
  const [selectedFacility, setSelectedFacility] = useState<OfficeFacilityKey | null>(null)
  const [sceneDetailEnabled, setSceneDetailEnabled] = useState(false)
  const [robotAssetsEnabled, setRobotAssetsEnabled] = useState(false)
  const assetPreloadStartedRef = useRef(false)
  const bootFrameRenderedRef = useRef(false)
  const detailUpgradeTimerRef = useRef<number | null>(null)
  const [officeGitStatusBySession, setOfficeGitStatusBySession] = useState<Record<string, GitStatus | undefined>>({})
  const renderQuality = useOfficeRenderQuality(office.qualityMode)
  const qualityDprMaximum = Array.isArray(renderQuality.profile.dpr)
    ? renderQuality.profile.dpr[1]
    : renderQuality.profile.dpr

  const handleOfficeFrame = useCallback(
    (frameMs: number): void => {
      renderQuality.recordFrame(frameMs)
      if (!assetPreloadStartedRef.current) {
        assetPreloadStartedRef.current = true
        preloadOfficeAssets()
      }
      if (bootFrameRenderedRef.current) return
      bootFrameRenderedRef.current = true
      detailUpgradeTimerRef.current = window.setTimeout(() => setSceneDetailEnabled(true), 50)
    },
    [renderQuality.recordFrame]
  )

  useEffect(
    () => () => {
      if (detailUpgradeTimerRef.current !== null) window.clearTimeout(detailUpgradeTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!sceneDetailEnabled || robotAssetsEnabled) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setRobotAssetsEnabled(true)
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [robotAssetsEnabled, sceneDetailEnabled])

  // 办公区场景色随主题切换
  const isLight =
    themePref === 'light' ||
    (themePref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
  const scene = isLight
    ? { bg: '#d8dde0', floor: '#a7b1b7', grid1: '#6f7d86', grid2: '#bcc4c9', ground: '#b2bcc2' }
    : { bg: '#10151b', floor: '#202832', grid1: '#34404c', grid2: '#26313a', ground: '#1d252d' }

  const ids = order.filter((id) => sessions[id])
  const idsKey = ids.join('\0')
  const positions = gridPositions(ids.length)
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      if (ids.length === 0) {
        if (!cancelled) setOfficeGitStatusBySession({})
        return
      }
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await window.agentDesk.gitStatus(id)] as const
          } catch (err) {
            return [id, gitStatusError(id, err)] as const
          }
        })
      )
      if (cancelled) return
      const next: Record<string, GitStatus | undefined> = {}
      for (const [id, status] of entries) next[id] = status
      setOfficeGitStatusBySession(next)
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [idsKey])
  const officeModel = useMemo(
    () => buildOfficeModel(ids, sessions, officeGitStatusBySession),
    [ids, sessions, officeGitStatusBySession]
  )
  const realtime = officeModel.realtime
  const subagentPacketCount = officeModel.packets.filter((packet) => packet.toolName === 'Subagent').length
  const officeSignalPanelCount = ids.filter((id) => {
    const signal = officeModel.sessions[id]?.signal
    return Boolean(
      signal?.routing ||
      signal?.failover ||
      signal?.workspace.gitOk !== undefined ||
      signal?.workspace.isolated ||
      signal?.workspace.changedFiles ||
      signal?.budget.budgetUsd ||
      signal?.budget.costUsd
    )
  }).length
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
    const completedFacility: AgentWalkerSpec[] = []

    ids.forEach((id, i) => {
      const session = sessions[id]
      const position = positions[i]
      if (!session || !position) return
      const activity = activityOf(session)
      const home: [number, number, number] = [position[0], 0, position[2] + 0.64]
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
          phase: 8.4 + awaiting.length * 4.5,
          departureDelay: 0
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
          phase: 8.4 + idle.length * 5.15,
          holdAtTarget: true,
          departureDelay: 0.4
        })
      } else if (activity === 'completed') {
        const reason = completedFacility.length % 2 === 0 ? 'dining' : 'restroom'
        const target =
          reason === 'dining'
            ? DINING_STOPS[completedFacility.length % DINING_STOPS.length]
            : RESTROOM_STOPS[completedFacility.length % RESTROOM_STOPS.length]
        completedFacility.push({
          id: `${id}:${reason}`,
          sessionId: id,
          home,
          homeLookAt,
          target,
          targetLookAt: reason === 'dining' ? DINING_LOOK_AT : RESTROOM_LOOK_AT,
          reason,
          providerName,
          providerBaseUrl,
          modelName,
          phase: 8.4 + completedFacility.length * 4.85,
          holdAtTarget: true,
          departureDelay: 2.2 + completedFacility.length * 1.4
        })
      }
    })

    return [...awaiting.slice(0, 1), ...idle.slice(0, 1), ...completedFacility.slice(0, 2)]
  }, [ids, positions, sessions, providers])
  const walkerRenderSpecs = useMemo<AgentWalkerSpec[]>(
    () =>
      semanticWalkers.map((spec) => ({
        ...spec,
        home: walkerLocalPoint(spec.home),
        homeLookAt: walkerLocalPoint(spec.homeLookAt),
        target: walkerLocalPoint(spec.target),
        targetLookAt: walkerLocalPoint(spec.targetLookAt)
      })),
    [semanticWalkers]
  )
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
  const restroomWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'restroom').length
  const diningWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'dining').length
  const facilityWalkerCount = teaWalkerCount + restroomWalkerCount + diningWalkerCount
  const deskRobotCount = Math.max(0, ids.length - awaySessionIds.size)
  const activeOfficeId = activeId && ids.includes(activeId) ? activeId : (ids[0] ?? null)
  const presentedWalkerSpecs = useMemo(
    () =>
      cameraPreset === 'agent' && activeOfficeId
        ? walkerRenderSpecs.filter((spec) => spec.sessionId !== activeOfficeId)
        : walkerRenderSpecs,
    [activeOfficeId, cameraPreset, walkerRenderSpecs]
  )
  const activeOfficeIndex = activeOfficeId ? ids.indexOf(activeOfficeId) : -1
  const activeOfficeSession = activeOfficeId ? sessions[activeOfficeId] : undefined
  const activeOfficeActivity = activeOfficeSession ? activityOf(activeOfficeSession) : undefined
  const activeOfficeSignal = activeOfficeId ? officeModel.sessions[activeOfficeId]?.signal : undefined
  const faultHitTargets = ids
    .map((id, i) => ({
      id,
      activity: activityOf(sessions[id]),
      x: positions[i]?.[0] ?? 0,
      y: 0.9,
      z: (positions[i]?.[2] ?? 0) + 0.54
    }))
    .filter((target) => target.activity === 'error')
  const primaryFaultTarget = faultHitTargets[0]
  const incidentCamera = primaryFaultTarget
    ? {
        position: [primaryFaultTarget.x + 2.18, 2.72, primaryFaultTarget.z + 3.36] as [number, number, number],
        target: [primaryFaultTarget.x - 0.12, 0.92, primaryFaultTarget.z + 0.08] as [number, number, number]
      }
    : {
        position: OFFICE_CAMERA_POSITION,
        target: OFFICE_CAMERA_TARGET
      }
  const selectedFacilitySpec = selectedFacility
    ? OFFICE_FACILITY_SPECS.find((spec) => spec.key === selectedFacility)
    : undefined
  const activeOfficePosition = activeOfficeIndex >= 0 ? positions[activeOfficeIndex] : undefined
  const cameraPose = useMemo(() => {
    if (cameraPreset === 'facilities') {
      if (selectedFacilitySpec) {
        return {
          position: selectedFacilitySpec.cameraPosition,
          target: selectedFacilitySpec.cameraTarget
        }
      }
      return {
        position: OFFICE_FACILITY_OVERVIEW_CAMERA.position,
        target: OFFICE_FACILITY_OVERVIEW_CAMERA.target
      }
    }
    if (cameraPreset === 'agent' && activeOfficePosition) {
      const focusX = activeOfficePosition[0]
      const focusZ = activeOfficePosition[2] + 0.34
      return {
        position: [focusX + 1.58, 2.34, focusZ + 3.48] as [number, number, number],
        target: [focusX - 0.18, 0.86, focusZ - 0.06] as [number, number, number]
      }
    }
    if (cameraPreset === 'incidents') return incidentCamera
    return { position: OFFICE_CAMERA_POSITION, target: OFFICE_CAMERA_TARGET }
  }, [activeOfficePosition, cameraPreset, incidentCamera, selectedFacilitySpec])
  const cameraMinDistance =
    cameraPreset === 'overview' || (cameraPreset === 'facilities' && !selectedFacilitySpec) ? 5.5 : 2.6
  const workstationHitTargets = ids.map((id, i) => ({
    id,
    x: positions[i]?.[0] ?? 0,
    y: 0.78,
    z: (positions[i]?.[2] ?? 0) + 0.08
  }))
  const walkerHitTargets = semanticWalkers.map((spec) => ({
    id: spec.sessionId,
    reason: spec.reason,
    x: spec.target[0],
    y: 0.88,
    z: spec.target[2]
  }))
  const facilityHitTargets = OFFICE_FACILITY_SPECS.map((spec) => ({
    id: spec.key,
    x: spec.hit[0],
    y: spec.hit[1],
    z: spec.hit[2]
  }))
  const officeOptimizationComplete =
    ids.length > 0 &&
    deskRobotCount + awaySessionIds.size === ids.length &&
    OFFICE_FACILITY_SPECS.length === 3 &&
    CAMERA_PRESETS.length === 4 &&
    knownLogoCount >= ids.length &&
    logoAssetCount >= ids.length &&
    cnLogoAssetCount >= cnSessionCount &&
    abstractLogoFallbacks === 0 &&
    semanticWalkers.length === approvalWalkerCount + facilityWalkerCount &&
    facilityHitTargets.length === 3 &&
    activitySummary.error === faultHitTargets.length

  const selectOfficeSession = (id: string): void => {
    setSelectedFacility(null)
    selectSession(id)
    setCameraPreset('agent')
  }
  const selectCameraPreset = (preset: CameraPreset): void => {
    if (preset !== 'facilities') setSelectedFacility(null)
    if (preset === 'incidents' && primaryFaultTarget) selectSession(primaryFaultTarget.id)
    setCameraPreset(preset)
  }
  const selectFacility = (key: OfficeFacilityKey): void => {
    setSelectedFacility(key)
    setCameraPreset('facilities')
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

      {hydrated && ids.length === 0 ? (
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
          data-office-routed-sessions={realtime.routedSessions}
          data-office-failover-sessions={realtime.failoverSessions}
          data-office-budgeted-sessions={realtime.budgetedSessions}
          data-office-over-budget-sessions={realtime.overBudgetSessions}
          data-office-total-cost-usd={realtime.totalCostUsd.toFixed(6)}
          data-office-total-budget-usd={realtime.totalBudgetUsd.toFixed(6)}
          data-office-total-duration-ms={Math.round(realtime.totalDurationMs)}
          data-office-cross-validation-validators={realtime.crossValidationValidators}
          data-office-routing-budget-panels={officeSignalPanelCount}
          data-office-isolated-sessions={realtime.isolatedSessions}
          data-office-removed-worktrees={realtime.removedWorktrees}
          data-office-workspace-changed-files={realtime.workspaceChangedFiles}
          data-office-workspace-insertions={realtime.workspaceInsertions}
          data-office-workspace-deletions={realtime.workspaceDeletions}
          data-office-git-tracked-sessions={realtime.gitTrackedSessions}
          data-office-git-dirty-sessions={realtime.gitDirtySessions}
          data-office-git-errored-sessions={realtime.gitErroredSessions}
          data-office-git-files={realtime.gitFiles}
          data-office-git-staged={realtime.gitStaged}
          data-office-git-unstaged={realtime.gitUnstaged}
          data-office-git-untracked={realtime.gitUntracked}
          data-office-walkers={semanticWalkers.length}
          data-office-away-sessions={awaySessionIds.size}
          data-office-desk-robots={deskRobotCount}
          data-office-visible-robots={deskRobotCount + awaySessionIds.size}
          data-office-one-robot-per-agent={deskRobotCount + awaySessionIds.size === ids.length ? 1 : 0}
          data-office-tea-walkers={teaWalkerCount}
          data-office-approval-walkers={approvalWalkerCount}
          data-office-restroom-walkers={restroomWalkerCount}
          data-office-dining-walkers={diningWalkerCount}
          data-office-facility-walkers={facilityWalkerCount}
          data-office-approval-stations={1}
          data-office-hydration-stations={1}
          data-office-restroom-stations={1}
          data-office-dining-stations={1}
          data-office-facility-fixtures={3}
          data-office-service-wayfinding={1}
          data-office-amenity-portals={2}
          data-office-facility-signals={4}
          data-office-clickable-facilities={OFFICE_FACILITY_SPECS.length}
          data-office-selected-facility={selectedFacility ?? ''}
          data-office-facility-hit-targets={JSON.stringify(facilityHitTargets)}
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
          data-office-humanoid-robot-silhouettes={deskRobotCount + awaySessionIds.size}
          data-office-humanoid-face-visors={deskRobotCount + awaySessionIds.size}
          data-office-humanoid-shell-panels={(deskRobotCount + awaySessionIds.size) * 10}
          data-office-humanoid-articulated-joints={(deskRobotCount + awaySessionIds.size) * 8}
          data-office-humanoid-back-shells={deskRobotCount + awaySessionIds.size}
          data-office-humanoid-neutral-shells={deskRobotCount + awaySessionIds.size}
          data-office-reference-robot-silhouettes={deskRobotCount + awaySessionIds.size}
          data-office-reference-robot-helmet-visors={deskRobotCount + awaySessionIds.size}
          data-office-reference-robot-shell-panels={(deskRobotCount + awaySessionIds.size) * 12}
          data-office-reference-robot-articulated-joints={(deskRobotCount + awaySessionIds.size) * 8}
          data-office-reference-robot-back-shells={deskRobotCount + awaySessionIds.size}
          data-office-reference-robot-neutral-shells={deskRobotCount + awaySessionIds.size}
          data-office-fault-beacons={activitySummary.error}
          data-office-maintenance-units={activitySummary.error}
          data-office-diagnostic-beams={activitySummary.error * 2}
          data-office-fault-response-rigs={activitySummary.error}
          data-office-fault-hit-targets={JSON.stringify(faultHitTargets)}
          data-office-incident-camera={JSON.stringify(incidentCamera)}
          data-office-incident-camera-available={primaryFaultTarget ? 1 : 0}
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
          data-office-camera-presets={CAMERA_PRESETS.length}
          data-office-active-camera-preset={cameraPreset}
          data-office-workstation-hit-targets={JSON.stringify(workstationHitTargets)}
          data-office-walker-hit-targets={JSON.stringify(walkerHitTargets)}
          data-office-ops-backplane={1}
          data-office-data-trunks={1}
          data-office-workstation-branches={Math.max(4, ids.length)}
          data-office-subject-framing={1}
          data-office-3d-optimization-complete={officeOptimizationComplete ? 1 : 0}
          data-office-quality-requested={office.qualityMode}
          data-office-quality-effective={renderQuality.resolvedTier}
          data-office-quality-dpr-maximum={qualityDprMaximum}
          data-office-quality-shadows={renderQuality.profile.shadows ? 1 : 0}
          data-office-quality-contact-shadows={renderQuality.profile.contactShadows}
          data-office-quality-contact-shadow-frames={
            Number.isFinite(renderQuality.profile.contactShadowFrames)
              ? renderQuality.profile.contactShadowFrames
              : -1
          }
          data-office-quality-contact-shadow-resolution={renderQuality.profile.contactShadowResolution}
          data-office-quality-auto-transitions={renderQuality.autoTransitions}
          data-office-render-active={renderQuality.renderActive ? 1 : 0}
          data-office-render-paused={renderQuality.renderActive ? 0 : 1}
          data-office-frame-loop={renderQuality.renderActive ? 'manual' : 'paused'}
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
              <span>{t('officeMetricFailed')}</span>
              <strong>{activitySummary.error}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricPackets')}</span>
              <strong>{officeModel.packets.length}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricRouted')}</span>
              <strong>{realtime.routedSessions}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricFailover')}</span>
              <strong>{realtime.failoverSessions}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricCost')}</span>
              <strong>{moneyShort(realtime.totalCostUsd)}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricWorkspace')}</span>
              <strong>{realtime.workspaceChangedFiles}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricGit')}</span>
              <strong>{realtime.gitDirtySessions}</strong>
            </div>
            <div className="office-metric">
              <span>{t('officeMetricIsolated')}</span>
              <strong>{realtime.isolatedSessions}</strong>
            </div>
          </div>
          <div className="office-camera-strip no-drag" data-office-camera-preset-controls={CAMERA_PRESETS.length}>
            {CAMERA_PRESETS.map((preset) => (
              <button
                key={preset}
                className={`office-camera-button ${cameraPreset === preset ? 'active' : ''}`}
                onClick={() => selectCameraPreset(preset)}
              >
                {t(`officePreset${preset[0].toUpperCase()}${preset.slice(1)}`)}
              </button>
            ))}
          </div>
          {cameraPreset !== 'facilities' && activeOfficeSession && activeOfficeId && activeOfficeActivity && (
            <div className="office-selection-panel no-drag" data-office-selection-panel={activeOfficeId}>
              <div className="office-selection-kicker">{t('officeSelectedAgent')}</div>
              <div className="office-selection-title">{activeOfficeSession.meta.title}</div>
              <div className="office-selection-meta">
                <span>{t(ACTIVITY_LABEL_KEYS[activeOfficeActivity])}</span>
                <span>{activeOfficeSession.meta.model || '-'}</span>
              </div>
              {activeOfficeSignal && (
                <div className="office-signal-list">
                  {activeOfficeSignal.routing && (
                    <>
                      <div>
                        <span>{t('officeRouting')}</span>
                        <strong title={activeOfficeSignal.routing.reason}>
                          {activeOfficeSignal.routing.providerName ?? activeOfficeSignal.routing.providerId} /{' '}
                          {activeOfficeSignal.routing.model}
                        </strong>
                      </div>
                      <div>
                        <span>{t('officeRoutingBasis')}</span>
                        <strong title={activeOfficeSignal.routing.reason}>
                          {activeOfficeSignal.routing.basis ?? activeOfficeSignal.routing.reason}
                        </strong>
                      </div>
                      {activeOfficeSignal.routing.strategy && (
                        <div>
                          <span>{t('routingStrategy')}</span>
                          <strong>{t(routingStrategyKey(activeOfficeSignal.routing.strategy))}</strong>
                        </div>
                      )}
                    </>
                  )}
                  {activeOfficeSignal.failover && (
                    <div>
                      <span>{t('officeFailover')}</span>
                      <strong>
                        {activeOfficeSignal.failover.fromName} → {activeOfficeSignal.failover.toName}
                      </strong>
                    </div>
                  )}
                  {activeOfficeSignal.keyFailover && (
                    <div>
                      <span>{t('officeKeyFailover')}</span>
                      <strong title={activeOfficeSignal.keyFailover.reason}>
                        {activeOfficeSignal.keyFailover.fromKeyLabel} → {activeOfficeSignal.keyFailover.toKeyLabel}
                      </strong>
                    </div>
                  )}
                  <div>
                    <span>{t('officeBudget')}</span>
                    <strong>
                      {moneyShort(activeOfficeSignal.budget.costUsd)}
                      {activeOfficeSignal.budget.budgetUsd ? ` / ${moneyShort(activeOfficeSignal.budget.budgetUsd)}` : ''}
                    </strong>
                  </div>
                  <div>
                    <span>{t('officeDuration')}</span>
                    <strong>{durationShort(activeOfficeSignal.budget.latestDurationMs)}</strong>
                  </div>
                  <div>
                    <span>{t('officeWorkspace')}</span>
                    <strong>
                      {activeOfficeSignal.workspace.gitOk === false
                        ? 'git error'
                        : activeOfficeSignal.workspace.gitBranch ||
                          (activeOfficeSignal.workspace.isolated ? activeOfficeSignal.workspace.branch || 'worktree' : 'main')}
                      {activeOfficeSignal.workspace.worktreeState === 'removed' ? ' · removed' : ''}
                    </strong>
                  </div>
                  <div>
                    <span>{t('officeFiles')}</span>
                    <strong>{workspaceChangeShort(activeOfficeSignal.workspace)}</strong>
                  </div>
                </div>
              )}
              <button className="btn btn-primary btn-sm" onClick={() => focus(activeOfficeId)}>
                {t('officeOpenSession')}
              </button>
            </div>
          )}
          {cameraPreset === 'facilities' && selectedFacilitySpec && (
            <div className="office-facility-panel no-drag" data-office-facility-panel={selectedFacilitySpec.key}>
              <div className="office-selection-kicker">{t('officeSelectedFacility')}</div>
              <div className="office-selection-title">{t(selectedFacilitySpec.labelKey)}</div>
              <div className="office-selection-meta">
                <span>{t(selectedFacilitySpec.statusKey)}</span>
              </div>
            </div>
          )}
          <Canvas
            shadows={renderQuality.profile.shadows}
            camera={{ position: OFFICE_CAMERA_POSITION, fov: OFFICE_CAMERA_FOV, near: 0.1, far: 100 }}
            dpr={renderQuality.profile.dpr}
            frameloop="never"
            resize={{ offsetSize: true }}
            onCreated={({ camera }) => {
              camera.lookAt(...OFFICE_CAMERA_TARGET)
              camera.updateProjectionMatrix()
            }}
          >
          <color attach="background" args={[scene.bg]} />
          <OfficePerformanceProbe />
          <OfficeFrameDriver active={renderQuality.renderActive} onFrame={handleOfficeFrame} />
          <fog attach="fog" args={[scene.bg, 18, 42]} />
          <ambientLight intensity={isLight ? 0.98 : 1.05} />
          <directionalLight
            position={[5.5, 10, 7.5]}
            intensity={isLight ? 1.45 : 1.72}
            color={isLight ? '#ffffff' : '#fff7ed'}
            castShadow={renderQuality.profile.shadows}
            shadow-mapSize={[
              Math.max(256, renderQuality.profile.shadowMapSize),
              Math.max(256, renderQuality.profile.shadowMapSize)
            ]}
          />
          <directionalLight
            position={[-6, 5.5, 7]}
            intensity={isLight ? 0.5 : renderQuality.profile.shadows ? 0.92 : 1.05}
            color={!isLight && !renderQuality.profile.shadows ? '#c9e5ff' : '#d9ecff'}
          />
          {/* 顶部聚光,强化中心舞台感 */}
          <spotLight position={[0, 9, 6]} angle={0.78} penumbra={0.82} intensity={isLight ? 0.58 : 1.28} />
          {/* 中央暖色补光,提亮工位区,驱散 night 家具阴影 */}
          <pointLight position={[0, 4.5, 0]} intensity={isLight ? 0.36 : 1.02} distance={26} color={isLight ? '#f3f5f6' : '#dce7f2'} />
          <hemisphereLight args={[isLight ? '#f3f5f6' : '#aebfd0', '#303843', isLight ? 0.48 : 0.7]} />
          {/* 不可见工位补光:只提亮机器人/桌面,不增加任何会挡镜头的实体灯具。 */}
          <pointLight position={[0, 2.8, 1.8]} intensity={isLight ? 0.46 : 1.42} distance={15} color={isLight ? '#f3f5f6' : '#eef6ff'} />
          {/* 补一盏跟随状态色调的点光,增强氛围 */}
          <pointLight position={[0, 3, 4]} intensity={isLight ? 0.22 : 0.34} color={isLight ? '#f3f5f6' : '#3c4658'} />

          {/* 富场景背景层:地板/墙/落地窗/家具/休息区/会议桌/白板/机架/茶水角 */}
          {!sceneDetailEnabled && (
            <OfficeBootScene
              ids={ids}
              positions={positions}
              activeId={activeOfficeId}
              lightMode={isLight}
              onSelect={selectOfficeSession}
              onOpen={focus}
            />
          )}
          {robotAssetsEnabled && (
            <Suspense fallback={null}>
              <OfficeScene lightMode={isLight} />
            </Suspense>
          )}
          {sceneDetailEnabled && (
            <>
              {ids.map((id, i) => (
                <Suspense key={id} fallback={null}>
                  <WorkstationPro
                    sessionId={id}
                    position={positions[i]}
                    active={id === activeOfficeId}
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
                    loadRobotAssets={robotAssetsEnabled}
                    operatorAway={awaySessionIds.has(id)}
                    currentTask={officeModel.sessions[id]?.currentTask}
                    taskStats={officeModel.sessions[id]?.taskStats}
                    sessionSignal={officeModel.sessions[id]?.signal}
                    onSelect={() => selectOfficeSession(id)}
                    onOpen={() => focus(id)}
                  />
                </Suspense>
              ))}
              <Suspense fallback={null}>
                <group scale={WALKER_VISUAL_SCALE}>
                  <AgentWalkers
                    specs={presentedWalkerSpecs}
                    activeSessionId={activeOfficeId}
                    loadRobotAssets={robotAssetsEnabled}
                    onAwayChange={handleWalkerAwayChange}
                    onSelect={selectOfficeSession}
                    onOpen={focus}
                  />
                </group>
              </Suspense>
              {robotAssetsEnabled && (
                <FacilityHotspots
                  specs={OFFICE_FACILITY_SPECS}
                  activeKey={selectedFacility}
                  onSelect={selectFacility}
                />
              )}
              {robotAssetsEnabled && renderQuality.profile.contactShadows !== 'off' && (
                <OfficeContactShadows
                  key={`${renderQuality.resolvedTier}-${ids.length}`}
                  lightMode={isLight}
                  mode={renderQuality.profile.contactShadows}
                  frames={renderQuality.profile.contactShadowFrames}
                  resolution={renderQuality.profile.contactShadowResolution}
                />
              )}
            </>
          )}

          <CameraRig
            position={cameraPose.position}
            target={cameraPose.target}
            auto={false}
            minDistance={cameraMinDistance}
          />

          </Canvas>
        </div>
      )}
    </div>
  )
}
