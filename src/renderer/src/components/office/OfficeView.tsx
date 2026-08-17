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
import { CONTROL_ROOM_LAYOUT } from './kit/controlRoomLayout'
import OfficeScene from './kit/OfficeScene'
import OfficePerformanceProbe from './kit/OfficePerformanceProbe'
import OfficeFrameDriver, { useOfficeRenderQuality } from './kit/OfficeRenderQuality'
import WorkstationPro from './kit/WorkstationPro'
import OfficeBootCharacter from './kit/OfficeBootCharacter'
import { vendorKeyFor } from './kit/VendorSkins'
import { providerLogoFor } from './kit/ProviderLogos'
import { buildOfficeModel, officeActivityForSessionId } from './model'
import type { OfficeRealtimeSummary, OfficeSessionActivity } from './model'
import OfficeFailoverSignals from './OfficeFailoverSignals'
import { useOfficeBootStages } from './useOfficeBootStages'
import type { OfficeContactShadowMode } from './quality'
import type { GitStatus, SchedulerStrategy } from '../../../../shared/types'
import type { MediaJobStatus, MediaStudioSnapshot } from '../../../../shared/media-types'
import type { ProjectWorkspace, WorkItem } from '../../../../shared/project-workspace-types'
import {
  resolveWatercolorRole,
  stableWatercolorRole,
  type WatercolorCharacterRole
} from '../../../../shared/watercolor-character'

export { prewarmOfficeGraphics } from './graphicsPrewarm'

/**
 * 把会话按网格铺开在房间中央空地(OfficeScene 家具占外围:
 * 前区 z≈+6~8 休息/会议、左右墙 x≈±9.5、四角盆栽)。
 * 网格限定在 x∈[-6,6]、z∈[-5,3] 的安全区,间距随数量自适应收紧,绝不越界撞家具。
 */
function gridPositions(count: number, teamPhoto = false): Array<[number, number, number]> {
  if (count === 0) return []
  if (teamPhoto) {
    const columns = Math.min(8, Math.max(1, count))
    return Array.from({ length: count }, (_, index) => {
      const row = Math.floor(index / columns)
      const itemsInRow = Math.min(columns, count - row * columns)
      const column = index % columns
      return [(column - (itemsInRow - 1) / 2) * 1.85, 0, -1.2 + row * 2.3]
    })
  }
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

const ASSISTANT_STOPS: Array<[number, number, number]> = [CONTROL_ROOM_LAYOUT.assistant.approach]
const ASSISTANT_LOOK_AT = CONTROL_ROOM_LAYOUT.assistant.lookAt
const APPROVAL_STOPS: Array<[number, number, number]> = [CONTROL_ROOM_LAYOUT.approvalApproach]
const APPROVAL_LOOK_AT: [number, number, number] = [CONTROL_ROOM_LAYOUT.approval[0], 0.82, CONTROL_ROOM_LAYOUT.approval[2]]
const PROJECT_STOPS: Array<[number, number, number]> = [CONTROL_ROOM_LAYOUT.project.approach]
const PROJECT_LOOK_AT = CONTROL_ROOM_LAYOUT.project.lookAt
const VIDEO_STOPS: Array<[number, number, number]> = [CONTROL_ROOM_LAYOUT.video.approach]
const VIDEO_LOOK_AT = CONTROL_ROOM_LAYOUT.video.lookAt
const OFFICE_CAMERA_POSITION = CONTROL_ROOM_LAYOUT.overview.position
const OFFICE_CAMERA_TARGET = CONTROL_ROOM_LAYOUT.overview.target
const OFFICE_CAMERA_FOV = CONTROL_ROOM_LAYOUT.overview.fov
const WALKER_VISUAL_SCALE = 1.18
const DEFAULT_OFFICE_SETTINGS = {
  qualityMode: 'auto' as const, showBadges: true, liveliness: 1, catEars: false,
  spaceTheme: 'control-room' as const, outfitPalette: 'role-default' as const,
  hairStyle: 'role-default' as const, teamLayout: 'grid' as const
}
const OFFICE_CONTACT_SHADOW_POSITION: [number, number, number] = [0, 0.02, 0]
type CameraPreset = 'overview' | 'agent' | 'facilities' | 'incidents'
type OfficeBusinessView = 'all' | 'assistant' | 'project' | 'video'
const CAMERA_PRESETS: CameraPreset[] = ['overview', 'agent', 'facilities', 'incidents']
const BUSINESS_VIEWS: OfficeBusinessView[] = ['all', 'assistant', 'project', 'video']

const EMPTY_MEDIA_SNAPSHOT: MediaStudioSnapshot = {
  schemaVersion: 12,
  revision: 0,
  productions: [],
  jobs: [],
  providers: [],
  projectStorage: [],
  snapshotDigest: ''
}

interface MediaOperationalSummary {
  productions: number
  jobs: number
  running: number
  failed: number
  waitingReconciliation: number
  succeeded: number
  estimatedUsd: number
  actualUsd: number
}

interface ProjectOperationalSummary {
  projects: number
  workItems: number
  running: number
  approvals: number
  blocked: number
  failed: number
}

const RUNNING_MEDIA_STATUSES = new Set<MediaJobStatus>(['requested', 'submitting', 'running', 'downloading'])

function summarizeMedia(snapshot: MediaStudioSnapshot): MediaOperationalSummary {
  return snapshot.jobs.reduce<MediaOperationalSummary>((summary, job) => {
    summary.jobs += 1
    if (RUNNING_MEDIA_STATUSES.has(job.status)) summary.running += 1
    if (job.status === 'failed') summary.failed += 1
    if (job.status === 'waiting_reconciliation') summary.waitingReconciliation += 1
    if (job.status === 'succeeded') summary.succeeded += 1
    summary.estimatedUsd += job.cost.estimatedUsd
    summary.actualUsd += job.cost.actualUsd ?? 0
    return summary
  }, {
    productions: snapshot.productions.length,
    jobs: 0,
    running: 0,
    failed: 0,
    waitingReconciliation: 0,
    succeeded: 0,
    estimatedUsd: 0,
    actualUsd: 0
  })
}

function summarizeProjects(projects: ProjectWorkspace[], workItems: WorkItem[]): ProjectOperationalSummary {
  return workItems.reduce<ProjectOperationalSummary>((summary, item) => {
    summary.workItems += 1
    if (item.status === 'running' || item.status === 'verifying') summary.running += 1
    if (item.status === 'waiting_approval') summary.approvals += 1
    if (item.status === 'blocked') summary.blocked += 1
    if (item.status === 'failed') summary.failed += 1
    return summary
  }, {
    projects: projects.filter((project) => project.status === 'active').length,
    workItems: 0,
    running: 0,
    approvals: 0,
    blocked: 0,
    failed: 0
  })
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
  showCharacters,
  interactive,
  onSelect,
  onOpen
}: {
  ids: string[]
  positions: Array<[number, number, number]>
  activeId: string | null
  lightMode: boolean
  showCharacters: boolean
  interactive: boolean
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
        return (
          <group
            key={id}
            name="office-boot-workstation"
            position={position}
            userData={{ officeBootWorkstation: true, officeRobotSessionId: id }}
            {...(interactive
              ? {
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation()
                    onSelect(id)
                  },
                  onDoubleClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation()
                    onOpen(id)
                  }
                }
              : {})}
          >
            <mesh position={[0, 0.04, 0.08]}>
              <boxGeometry args={[2.05, 0.08, 1.66]} />
              <meshBasicMaterial color={lightMode ? '#89969e' : '#182029'} />
            </mesh>
            <mesh position={[0, 0.62, -0.34]}>
              <boxGeometry args={[1.45, 0.08, 0.62]} />
              <meshBasicMaterial color={lightMode ? '#65737d' : '#303a45'} />
            </mesh>
            {showCharacters && <OfficeBootCharacter sessionId={id} active={id === activeId} />}
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
  const experienceMode = useStore((s) => s.experienceMode)
  const setExperienceMode = useStore((s) => s.setExperienceMode)
  const initialBusinessViewRef = useRef<OfficeFacilityKey>(
    experienceMode === 'studio' ? 'project' : experienceMode === 'video' ? 'video' : 'assistant'
  )
  const [businessView, setBusinessView] = useState<OfficeBusinessView>(initialBusinessViewRef.current)
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('facilities')
  const [selectedFacility, setSelectedFacility] = useState<OfficeFacilityKey | null>(initialBusinessViewRef.current)
  const officeHitRef = useRef({ seq: 0, kind: '', id: '' })
  const [officeGitStatusBySession, setOfficeGitStatusBySession] = useState<Record<string, GitStatus | undefined>>({})
  const [watercolorRoleByWorkerId, setWatercolorRoleByWorkerId] = useState<Record<string, WatercolorCharacterRole>>({})
  const [mediaSnapshot, setMediaSnapshot] = useState<MediaStudioSnapshot>(EMPTY_MEDIA_SNAPSHOT)
  const [projectSnapshot, setProjectSnapshot] = useState<{ projects: ProjectWorkspace[]; workItems: WorkItem[] }>({ projects: [], workItems: [] })
  const [operationalDataReady, setOperationalDataReady] = useState(false)
  const operationalRefreshSequence = useRef(0)
  const renderQuality = useOfficeRenderQuality(office.qualityMode)
  const qualityDprMaximum = Array.isArray(renderQuality.profile.dpr) ? renderQuality.profile.dpr[1] : renderQuality.profile.dpr
  const { bootCharactersEnabled, sceneDetailEnabled, sceneAssetsEnabled, handleOfficeFrame } =
    useOfficeBootStages(renderQuality.recordFrame)

  // 办公区场景色随主题切换
  const isLight = themePref === 'light' || (themePref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches)
  const scene = office.spaceTheme === 'creative-studio'
    ? (isLight ? { bg: '#dce4df' } : { bg: '#26312f' })
    : office.spaceTheme === 'quiet-library'
      ? (isLight ? { bg: '#deddd7' } : { bg: '#292a28' })
      : (isLight ? { bg: '#d8dde0' } : { bg: '#1c2024' })

  const ids = order.filter((id) => sessions[id])
  const visibleIds = businessView === 'video'
    ? []
    : businessView === 'project'
      ? ids.filter((id) => Boolean(sessions[id]?.meta.workspaceId || sessions[id]?.meta.projectId || sessions[id]?.meta.workItemId))
      : businessView === 'assistant'
        ? ids.filter((id) => !sessions[id]?.meta.workspaceId && !sessions[id]?.meta.projectId && !sessions[id]?.meta.workItemId)
        : ids
  const visibleIdsKey = visibleIds.join('\0')
  const assignedWorkerIdsKey = visibleIds
    .map((id) => sessions[id]?.meta.digitalWorkerBinding)
    .filter((binding) => binding?.kind === 'assigned')
    .map((binding) => binding.workerId)
    .sort()
    .join('\0')
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined' || !assignedWorkerIdsKey) {
      setWatercolorRoleByWorkerId({})
      return
    }
    let cancelled = false
    void Promise.all([
      window.agentDesk.listDigitalWorkers({ includeRetired: true }),
      window.agentDesk.listDigitalWorkerRoleTemplates()
    ]).then(([workers, roles]) => {
      if (cancelled) return
      const roleById = new Map(roles.map((role) => [role.id, role]))
      const next: Record<string, WatercolorCharacterRole> = {}
      for (const worker of workers) {
        next[worker.id] = resolveWatercolorRole(worker, roleById.get(worker.roleTemplateId)).role
      }
      setWatercolorRoleByWorkerId(next)
    }).catch((error) => {
      if (!cancelled) console.error('[agent-desk] Failed to load watercolor DigitalWorker identities', error)
    })
    return () => { cancelled = true }
  }, [assignedWorkerIdsKey])
  const positions = gridPositions(visibleIds.length, office.teamLayout === 'team-photo')
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      const sequence = ++operationalRefreshSequence.current
      try {
        const [media, projects, workItems] = await Promise.all([
          window.agentDesk.getMediaStudio(),
          window.agentDesk.listProjectWorkspaces({ includeArchived: true }),
          window.agentDesk.listProjectWorkItems()
        ])
        if (!cancelled && sequence === operationalRefreshSequence.current) {
          setMediaSnapshot(media)
          setProjectSnapshot({ projects, workItems })
        }
      } catch (error) {
        if (!cancelled) console.error('[agent-desk] Failed to load CaoGen Control Room operations', error)
      } finally {
        if (!cancelled && sequence === operationalRefreshSequence.current) setOperationalDataReady(true)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    const refreshOnFocus = (): void => { void refresh() }
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshOnFocus)
    }
  }, [])
  useEffect(() => {
    if (typeof window.agentDesk === 'undefined') return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      if (visibleIds.length === 0) {
        if (!cancelled) setOfficeGitStatusBySession({})
        return
      }
      const entries = await Promise.all(
        visibleIds.map(async (id) => {
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
  }, [visibleIdsKey])
  const officeModel = useMemo(
    () => buildOfficeModel(visibleIds, sessions, officeGitStatusBySession),
    [visibleIds, sessions, officeGitStatusBySession]
  )
  const realtime = officeModel.realtime
  const subagentPacketCount = officeModel.packets.filter((packet) => packet.toolName === 'Subagent').length
  const officeSignalPanelCount = visibleIds.filter((id) => {
    const signal = officeModel.sessions[id]?.signal
    return Boolean(
      signal?.routing ||
      signal?.failover ||
      signal?.keyFailover ||
      signal?.modelFailover ||
      signal?.workspace.gitOk !== undefined ||
      signal?.workspace.isolated ||
      signal?.workspace.changedFiles ||
      signal?.budget.budgetUsd ||
      signal?.budget.costUsd
    )
  }).length
  const activitySummary = useMemo(
    () =>
      visibleIds.reduce(
        (acc, id) => {
          acc.total += 1
          acc[officeActivityForSessionId(id, sessions)] += 1
          return acc
        },
        { total: 0, idle: 0, working: 0, awaiting: 0, completed: 0, error: 0 }
      ),
    [visibleIds, sessions]
  )
  const mediaSummary = useMemo(() => summarizeMedia(mediaSnapshot), [mediaSnapshot])
  const projectSummary = useMemo(
    () => summarizeProjects(projectSnapshot.projects, projectSnapshot.workItems),
    [projectSnapshot]
  )
  const assistantSessionCount = ids.filter((id) =>
    !sessions[id]?.meta.workspaceId && !sessions[id]?.meta.projectId && !sessions[id]?.meta.workItemId
  ).length
  const projectSessionCount = ids.length - assistantSessionCount
  const totalIncidentCount = activitySummary.error + projectSummary.blocked + projectSummary.failed + mediaSummary.failed + mediaSummary.waitingReconciliation
  const hasAnyOperations = ids.length > 0 || projectSummary.projects > 0 || projectSummary.workItems > 0 || mediaSummary.productions > 0 || mediaSummary.jobs > 0

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
  const sessionLogoSpecs = visibleIds.map((id) => {
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

    visibleIds.forEach((id, i) => {
      const session = sessions[id]
      const position = positions[i]
      if (!session || !position) return
      const activity = officeActivityForSessionId(session.meta.id, sessions)
      const home: [number, number, number] = [position[0], 0, position[2] + 0.64]
      const homeLookAt: [number, number, number] = [position[0], 0, position[2] - 0.48]
      const providerName = providerNameOf(session.meta.providerId)
      const providerBaseUrl = providerBaseUrlOf(session.meta.providerId)
      const modelName = session.meta.model
      const binding = session.meta.digitalWorkerBinding
      const watercolorRole = binding?.kind === 'assigned'
        ? watercolorRoleByWorkerId[binding.workerId] ?? stableWatercolorRole(binding.workerId)
        : stableWatercolorRole(id)

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
          watercolorRole,
          phase: 8.4 + awaiting.length * 4.5,
          departureDelay: 0
        })
      } else if (activity === 'idle') {
        const target = ASSISTANT_STOPS[idle.length % ASSISTANT_STOPS.length]
        idle.push({
          id: `${id}:assistant`,
          sessionId: id,
          home,
          homeLookAt,
          target,
          targetLookAt: ASSISTANT_LOOK_AT,
          reason: 'assistant',
          providerName,
          providerBaseUrl,
          modelName,
          watercolorRole,
          phase: 8.4 + idle.length * 5.15,
          holdAtTarget: true,
          departureDelay: 0.4
        })
      } else if (activity === 'completed') {
        const reason = completedFacility.length % 2 === 0 ? 'video' : 'project'
        const target =
          reason === 'video'
            ? VIDEO_STOPS[completedFacility.length % VIDEO_STOPS.length]
            : PROJECT_STOPS[completedFacility.length % PROJECT_STOPS.length]
        completedFacility.push({
          id: `${id}:${reason}`,
          sessionId: id,
          home,
          homeLookAt,
          target,
          targetLookAt: reason === 'video' ? VIDEO_LOOK_AT : PROJECT_LOOK_AT,
          reason,
          providerName,
          providerBaseUrl,
          modelName,
          watercolorRole,
          phase: 8.4 + completedFacility.length * 4.85,
          holdAtTarget: true,
          departureDelay: 2.2 + completedFacility.length * 1.4
        })
      }
    })

    return [...awaiting.slice(0, 1), ...idle.slice(0, 1), ...completedFacility.slice(0, 2)]
  }, [visibleIds, positions, sessions, providers, watercolorRoleByWorkerId])
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
  const assistantWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'assistant').length
  const approvalWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'approval').length
  const projectWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'project').length
  const videoWalkerCount = semanticWalkers.filter((spec) => spec.reason === 'video').length
  const facilityWalkerCount = assistantWalkerCount + projectWalkerCount + videoWalkerCount
  const deskRobotCount = Math.max(0, visibleIds.length - awaySessionIds.size)
  const activeOfficeId = activeId && visibleIds.includes(activeId) ? activeId : (visibleIds[0] ?? null)
  const presentedWalkerSpecs = useMemo(
    () =>
      cameraPreset === 'agent' && activeOfficeId
        ? walkerRenderSpecs.filter((spec) => spec.sessionId !== activeOfficeId)
        : walkerRenderSpecs,
    [activeOfficeId, cameraPreset, walkerRenderSpecs]
  )
  const activeOfficeIndex = activeOfficeId ? visibleIds.indexOf(activeOfficeId) : -1
  const activeOfficeSession = activeOfficeId ? sessions[activeOfficeId] : undefined
  const activeOfficeActivity = activeOfficeSession ? officeActivityForSessionId(activeOfficeSession.meta.id, sessions) : undefined
  const activeOfficeSignal = activeOfficeId ? officeModel.sessions[activeOfficeId]?.signal : undefined
  const faultHitTargets = visibleIds
    .map((id, i) => ({
      id,
      activity: officeActivityForSessionId(id, sessions),
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
  const selectedFacilitySpec = selectedFacility ? OFFICE_FACILITY_SPECS.find((spec) => spec.key === selectedFacility) : undefined
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
  const cameraMinDistance = cameraPreset === 'overview' || (cameraPreset === 'facilities' && !selectedFacilitySpec) ? 5.5 : 2.6
  const workstationHitTargets = visibleIds.map((id, i) => ({
    id,
    x: positions[i]?.[0] ?? 0,
    y: 0.78,
    z: (positions[i]?.[2] ?? 0) + 0.08
  }))
  const walkerHitTargets = semanticWalkers.map((spec) => ({
    id: spec.sessionId,
    reason: spec.reason,
    x: spec.target[0],
    y: 1.27,
    z: spec.target[2]
  }))
  const facilityHitTargets = OFFICE_FACILITY_SPECS.map((spec) => ({
    id: spec.key,
    x: spec.hit[0],
    y: spec.hit[1],
    z: spec.hit[2]
  }))
  const officeOptimizationComplete =
    (visibleIds.length > 0 || hasAnyOperations) &&
    deskRobotCount + awaySessionIds.size === visibleIds.length &&
    OFFICE_FACILITY_SPECS.length === 3 &&
    CAMERA_PRESETS.length === 4 &&
    knownLogoCount >= visibleIds.length &&
    logoAssetCount >= visibleIds.length &&
    cnLogoAssetCount >= cnSessionCount &&
    abstractLogoFallbacks === 0 &&
    semanticWalkers.length === approvalWalkerCount + facilityWalkerCount &&
    facilityHitTargets.length === 3 &&
    activitySummary.error === faultHitTargets.length

  const selectOfficeSession = (id: string, kind: 'workstation' | 'walker' = 'workstation'): void => {
    officeHitRef.current = { seq: officeHitRef.current.seq + 1, kind, id }
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
    officeHitRef.current = { seq: officeHitRef.current.seq + 1, kind: 'facility', id: key }
    setSelectedFacility(key)
    setCameraPreset('facilities')
  }
  const selectBusinessView = (nextView: OfficeBusinessView): void => {
    setBusinessView(nextView)
    if (nextView === 'all') {
      setSelectedFacility(null)
      setCameraPreset('overview')
      return
    }
    setSelectedFacility(nextView)
    setCameraPreset('facilities')
  }
  const focus = (id: string): void => {
    selectSession(id)
    setView('list')
  }
  const returnToWorkspace = (): void => {
    setExperienceMode(experienceMode)
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
          <button className="btn btn-primary" onClick={returnToWorkspace}>
            {t('officeReturnWorkspace')}
          </button>
        </div>
      </div>

      {hydrated && operationalDataReady && !hasAnyOperations ? (
        <div className="office-empty">
          <div className="office-empty-inner">
            <div className="office-empty-mark">CAOGEN</div>
            <p>{t('officeEmpty')}</p>
            <button className="btn btn-primary" onClick={() => setShowNewSession(true)}>
              {t('newSession')}
            </button>
          </div>
        </div>
      ) : (
        <div
          className="office-canvas-wrap"
          data-office-business-view={businessView}
          data-office-return-mode={experienceMode}
          data-office-sessions={visibleIds.length}
          data-office-assistant-sessions={assistantSessionCount}
          data-office-project-sessions={projectSessionCount}
          data-office-projects={projectSummary.projects}
          data-office-work-items={projectSummary.workItems}
          data-office-running-work-items={projectSummary.running}
          data-office-project-approvals={projectSummary.approvals}
          data-office-blocked-work-items={projectSummary.blocked}
          data-office-failed-work-items={projectSummary.failed}
          data-office-video-productions={mediaSummary.productions}
          data-office-media-jobs={mediaSummary.jobs}
          data-office-running-media-jobs={mediaSummary.running}
          data-office-failed-media-jobs={mediaSummary.failed}
          data-office-reconciliation-media-jobs={mediaSummary.waitingReconciliation}
          data-office-succeeded-media-jobs={mediaSummary.succeeded}
          data-office-media-estimated-cost-usd={mediaSummary.estimatedUsd.toFixed(6)}
          data-office-media-actual-cost-usd={mediaSummary.actualUsd.toFixed(6)}
          data-office-total-incidents={totalIncidentCount}
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
          data-office-desk-workers={deskRobotCount} data-office-visible-digital-workers={deskRobotCount + awaySessionIds.size}
          data-office-one-digital-worker-per-agent={deskRobotCount + awaySessionIds.size === visibleIds.length ? 1 : 0}
          data-office-desk-robots={0} data-office-visible-robots={0} data-office-one-robot-per-agent={0}
          data-office-watercolor-characters={0} data-office-one-watercolor-character-per-agent={0}
          data-office-articulated-characters={visibleIds.length} data-office-grounded-character-rigs={visibleIds.length}
          data-office-low-poly-digital-workers={visibleIds.length} data-office-human-proportion-workers={visibleIds.length}
          data-office-role-accented-workers={visibleIds.length} data-office-camera-facing-character-sprites={0}
          data-office-assistant-walkers={assistantWalkerCount}
          data-office-approval-walkers={approvalWalkerCount}
          data-office-project-walkers={projectWalkerCount}
          data-office-video-walkers={videoWalkerCount}
          data-office-facility-walkers={facilityWalkerCount}
          data-office-approval-stations={1}
          data-office-assistant-stations={1}
          data-office-project-stations={1}
          data-office-video-stations={1}
          data-office-command-stations={1}
          data-office-artifact-vaults={1}
          data-office-render-racks={1}
          data-office-facility-fixtures={3}
          data-office-service-wayfinding={0}
          data-office-amenity-portals={0}
          data-office-facility-signals={3}
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
          data-office-screen-panels={visibleIds.length * 2 + 6}
          data-office-walker-routes={semanticWalkers.length}
          data-office-sightline-safe={1}
          data-office-cutaway-walls={1}
          data-office-overhead-fixtures-hidden={1}
          data-office-side-glass-cutaway={1}
          data-office-wall-occluders={0}
          data-office-long-light-occluders={0}
          data-office-presentation-backdrop={1}
          data-office-industrial-robots={0} data-office-humanoid-robot-silhouettes={0}
          data-office-humanoid-face-visors={0}
          data-office-humanoid-shell-panels={0}
          data-office-humanoid-articulated-joints={visibleIds.length * 8}
          data-office-humanoid-back-shells={0}
          data-office-humanoid-neutral-shells={0}
          data-office-reference-robot-silhouettes={0}
          data-office-reference-robot-helmet-visors={0}
          data-office-reference-robot-shell-panels={0}
          data-office-reference-robot-articulated-joints={0}
          data-office-reference-robot-back-shells={0}
          data-office-reference-robot-neutral-shells={0}
          data-office-fault-beacons={activitySummary.error}
          data-office-maintenance-units={activitySummary.error}
          data-office-diagnostic-beams={activitySummary.error * 2}
          data-office-fault-response-rigs={activitySummary.error}
          data-office-fault-hit-targets={JSON.stringify(faultHitTargets)}
          data-office-incident-camera={JSON.stringify(incidentCamera)}
          data-office-incident-camera-available={primaryFaultTarget ? 1 : 0}
          data-office-provider-skin-panels={visibleIds.length + semanticWalkers.length}
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
          data-office-clickable-workstations={visibleIds.length}
          data-office-clickable-walkers={semanticWalkers.length}
          data-office-selected-session={activeOfficeId ?? ''}
          data-office-selected-workstations={activeOfficeId ? 1 : 0}
          data-office-camera-presets={CAMERA_PRESETS.length}
          data-office-active-camera-preset={cameraPreset}
          data-office-last-hit-seq={officeHitRef.current.seq}
          data-office-last-hit-kind={officeHitRef.current.kind}
          data-office-last-hit-id={officeHitRef.current.id}
          data-office-workstation-hit-targets={JSON.stringify(workstationHitTargets)}
          data-office-walker-hit-targets={JSON.stringify(walkerHitTargets)}
          data-office-ops-backplane={1}
          data-office-data-trunks={1}
          data-office-workstation-branches={Math.max(4, visibleIds.length)}
          data-office-subject-framing={1}
          data-office-3d-optimization-complete={officeOptimizationComplete ? 1 : 0}
          data-office-quality-requested={office.qualityMode}
          data-office-space-theme={office.spaceTheme}
          data-office-outfit-palette={office.outfitPalette}
          data-office-hair-style={office.hairStyle}
          data-office-team-layout={office.teamLayout}
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
          data-office-scene-assets-ready={sceneAssetsEnabled ? 1 : 0}
        >
          <OfficeBusinessSwitcher value={businessView} onChange={selectBusinessView} />
          <OfficeCommandStrip
            businessView={businessView}
            activity={activitySummary}
            packetCount={officeModel.packets.length}
            realtime={realtime}
            projects={projectSummary}
            media={mediaSummary}
          />
          <div className="office-camera-strip no-drag" data-office-camera-preset-controls={CAMERA_PRESETS.length}>
            {CAMERA_PRESETS.map((preset) => (
              <button
                key={preset}
                className={`office-camera-button ${cameraPreset === preset ? 'active' : ''}`}
                data-office-camera-preset={preset}
                aria-label={t(`officePreset${preset[0].toUpperCase()}${preset.slice(1)}`)}
                aria-pressed={cameraPreset === preset}
                title={t(`officePreset${preset[0].toUpperCase()}${preset.slice(1)}`)}
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
                  <OfficeFailoverSignals signal={activeOfficeSignal} />
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
              <button
                className="btn btn-primary btn-sm"
                aria-label={t('officeOpenSession')}
                title={t('officeOpenSession')}
                onClick={() => focus(activeOfficeId)}
              >
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
            camera={{ position: cameraPose.position, fov: OFFICE_CAMERA_FOV, near: 0.1, far: 100 }}
            dpr={renderQuality.profile.dpr}
            frameloop="never"
            resize={{ offsetSize: true }}
            onCreated={({ camera }) => {
              camera.lookAt(...cameraPose.target)
              camera.updateProjectionMatrix()
            }}
          >
          <color attach="background" args={[scene.bg]} />
          <OfficePerformanceProbe />
          <OfficeFrameDriver active={renderQuality.renderActive} onFrame={handleOfficeFrame} />
          <fog attach="fog" args={[scene.bg, 18, 42]} />
          <ambientLight intensity={isLight ? 0.98 : 1.16} />
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
          {/* 不可见工位补光:只提亮水墨员工和桌面,不增加遮挡镜头的实体灯具。 */}
          <pointLight position={[0, 2.8, 1.8]} intensity={isLight ? 0.46 : 1.62} distance={15} color={isLight ? '#f3f5f6' : '#eef6ff'} />
          {/* 补一盏跟随状态色调的点光,增强氛围 */}
          <pointLight position={[0, 3, 4]} intensity={isLight ? 0.22 : 0.34} color={isLight ? '#f3f5f6' : '#3c4658'} />

          {/* 共享业务控制室:建筑外壳、中央总控、三类业务设备、审批、资产与算力设施。 */}
          {!sceneDetailEnabled && (
            <OfficeBootScene
              ids={visibleIds}
              positions={positions}
              activeId={activeOfficeId}
              lightMode={isLight}
              showCharacters={bootCharactersEnabled}
              interactive={cameraPreset !== 'facilities'}
              onSelect={selectOfficeSession}
              onOpen={focus}
            />
          )}
          {sceneAssetsEnabled && (
            <Suspense fallback={null}>
              <OfficeScene
                lightMode={isLight}
                signals={{
                  assistant: assistantSessionCount,
                  project: projectSummary.workItems + projectSessionCount,
                  video: mediaSummary.jobs || mediaSummary.productions,
                  incidents: totalIncidentCount
                }}
              />
            </Suspense>
          )}
          {sceneDetailEnabled && (
            <>
              {visibleIds.map((id, i) => (
                <Suspense key={id} fallback={null}>
                  <WorkstationPro
                    sessionId={id}
                    position={positions[i]}
                    active={id === activeOfficeId}
                    activity={officeActivityForSessionId(id, sessions)}
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
                    watercolorRole={
                      sessions[id].meta.digitalWorkerBinding?.kind === 'assigned'
                        ? watercolorRoleByWorkerId[sessions[id].meta.digitalWorkerBinding.workerId]
                          ?? stableWatercolorRole(sessions[id].meta.digitalWorkerBinding.workerId)
                        : stableWatercolorRole(id)
                    }
                    watercolorState={officeModel.sessions[id]?.characterState}
                    outfitPalette={office.outfitPalette}
                    hairStyle={office.hairStyle}
                    operatorAway={awaySessionIds.has(id)}
                    currentTask={officeModel.sessions[id]?.currentTask}
                    taskStats={officeModel.sessions[id]?.taskStats}
                    sessionSignal={officeModel.sessions[id]?.signal}
                    interactive={cameraPreset !== 'facilities'}
                    onSelect={() => selectOfficeSession(id, 'workstation')}
                    onOpen={() => focus(id)}
                  />
                </Suspense>
              ))}
              <Suspense fallback={null}>
                <group scale={WALKER_VISUAL_SCALE}>
                  <AgentWalkers
                    specs={presentedWalkerSpecs}
                    activeSessionId={activeOfficeId}
                    onAwayChange={handleWalkerAwayChange}
                    onSelect={(id) => selectOfficeSession(id, 'walker')}
                    onOpen={focus}
                  />
                </group>
              </Suspense>
              {sceneAssetsEnabled && (
                <FacilityHotspots
                  specs={OFFICE_FACILITY_SPECS}
                  activeKey={selectedFacility}
                  interactive={cameraPreset === 'facilities'}
                  onSelect={selectFacility}
                />
              )}
              {sceneAssetsEnabled && renderQuality.profile.contactShadows !== 'off' && (
                <OfficeContactShadows
                  key={`${renderQuality.resolvedTier}-${visibleIds.length}`}
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
            minDistance={cameraMinDistance} onSettledChange={(settled) => document.querySelector('.office-canvas-wrap')?.setAttribute('data-office-camera-settled', settled ? '1' : '0')}
          />

          </Canvas>
        </div>
      )}
    </div>
  )
}

type OfficeActivitySummary = Record<OfficeSessionActivity, number> & { total: number }

function OfficeBusinessSwitcher({ value, onChange }: {
  value: OfficeBusinessView
  onChange: (view: OfficeBusinessView) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="office-business-strip no-drag" role="group" aria-label={t('officeBusinessViews')}>
      {BUSINESS_VIEWS.map((view) => (
        <button
          key={view}
          type="button"
          className={`office-business-button ${value === view ? 'active' : ''}`}
          aria-pressed={value === view}
          data-office-business-view-option={view}
          onClick={() => onChange(view)}
        >
          {t(`officeBusiness${view[0].toUpperCase()}${view.slice(1)}`)}
        </button>
      ))}
    </div>
  )
}

function OfficeCommandStrip({ businessView, activity, packetCount, realtime, projects, media }: {
  businessView: OfficeBusinessView
  activity: OfficeActivitySummary
  packetCount: number
  realtime: OfficeRealtimeSummary
  projects: ProjectOperationalSummary
  media: MediaOperationalSummary
}): React.JSX.Element {
  const t = useT()
  const assistantMetrics: Array<[string, string | number]> = [
    ['officeMetricSessions', activity.total], ['officeMetricWorking', activity.working],
    ['officeMetricAwaiting', activity.awaiting], ['officeMetricCompleted', activity.completed],
    ['officeMetricFailed', activity.error], ['officeMetricCost', moneyShort(realtime.totalCostUsd)]
  ]
  const projectMetrics: Array<[string, string | number]> = [
    ['officeMetricProjects', projects.projects], ['officeMetricWorkItems', projects.workItems],
    ['officeMetricWorking', projects.running], ['officeMetricAwaiting', projects.approvals],
    ['officeMetricBlocked', projects.blocked], ['officeMetricFailed', projects.failed]
  ]
  const videoMetrics: Array<[string, string | number]> = [
    ['officeMetricProductions', media.productions], ['officeMetricMediaJobs', media.jobs],
    ['officeMetricWorking', media.running], ['officeMetricReconciliation', media.waitingReconciliation],
    ['officeMetricFailed', media.failed],
    ['officeMetricMediaCost', `${moneyShort(media.actualUsd)} / ${moneyShort(media.estimatedUsd)}`]
  ]
  const operationsMetrics: Array<[string, string | number]> = [
    ['officeMetricPackets', packetCount], ['officeMetricRouted', realtime.routedSessions],
    ['officeMetricFailover', realtime.failoverSessions], ['officeMetricWorkspace', realtime.workspaceChangedFiles],
    ['officeMetricGit', realtime.gitDirtySessions], ['officeMetricIsolated', realtime.isolatedSessions]
  ]
  const metrics = businessView === 'assistant'
    ? assistantMetrics
    : businessView === 'project'
      ? projectMetrics
      : businessView === 'video'
        ? videoMetrics
        : [
            ['officeMetricSessions', activity.total],
            ['officeMetricWorkItems', projects.workItems],
            ['officeMetricMediaJobs', media.jobs],
            ['officeMetricWorking', activity.working + projects.running + media.running],
            ['officeMetricAwaiting', activity.awaiting + projects.approvals],
            ['officeMetricFailed', activity.error + projects.failed + media.failed + media.waitingReconciliation],
            ...operationsMetrics
          ] as Array<[string, string | number]>
  return <div className="office-command-strip no-drag">
    {metrics.map(([label, value], index) => <div className="office-metric" key={`${label}:${index}`}><span>{t(label)}</span><strong>{value}</strong></div>)}
  </div>
}
