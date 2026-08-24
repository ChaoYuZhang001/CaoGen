import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType } from 'react'

const OFFICE_MAX_VISIBLE_SESSIONS = 9
type OfficeRuntimeModule = typeof import('./OfficeRuntime')
let officeRuntimePromise: Promise<OfficeRuntimeModule> | null = null

function loadOfficeRuntime(): Promise<OfficeRuntimeModule> {
  if (!officeRuntimePromise) {
    officeRuntimePromise = import('./OfficeRuntime').catch((error: unknown) => {
      officeRuntimePromise = null
      throw error
    })
  }
  return officeRuntimePromise
}

export function preloadOfficeRuntime(): Promise<boolean> {
  return loadOfficeRuntime().then(() => true).catch(() => false)
}

export interface OfficeViewProps {
  boot: {
    sessionIds: string[]
    activeId: string | null
    quality: 'auto' | 'high' | 'balanced' | 'low'
    lightMode: boolean
    language: 'zh' | 'en'
    selectSession: (id: string) => void
  }
}

function gridPositions(count: number): Array<[number, number, number]> {
  if (count === 0) return []
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)))
  const rows = Math.ceil(count / columns)
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return [
      (column - (columns - 1) / 2) * 2.8,
      0,
      (row - (rows - 1) / 2) * 2.35 - 1.6
    ]
  })
}

interface ColdBootDiagnostics {
  readFrame: () => { frame: number; calls: number; triangles: number; lines: number; points: number }
  snapshot: () => {
    render: ReturnType<ColdBootDiagnostics['readFrame']>
    workers: { characters: number; roles: string[]; states: string[] }
    quality: Record<string, string | number | boolean>
  }
  projectWorldPoint: (point: [number, number, number]) => {
    x: number
    y: number
    ndcX: number
    ndcY: number
    visible: boolean
  }
}

type ColdBootWindow = Window & { __caogenOfficePerformance?: ColdBootDiagnostics }

function ColdBootCanvas({
  ids,
  activeId,
  background,
  quality
}: {
  ids: string[]
  activeId: string | null
  background: string
  quality: OfficeViewProps['boot']['quality']
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const positions = useMemo(() => gridPositions(ids.length), [ids.length])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let frame = 0
    let animationFrame = 0
    const draw = (): void => {
      const width = Math.max(320, canvas.clientWidth || 960)
      const height = Math.max(220, canvas.clientHeight || 560)
      const ratio = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio)
        canvas.height = Math.round(height * ratio)
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.fillStyle = background
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#27333d'
      context.fillRect(0, height * 0.58, width, height * 0.42)
      context.strokeStyle = '#384955'
      context.lineWidth = 1
      for (let x = 0; x < width; x += 42) {
        context.beginPath()
        context.moveTo(x, height * 0.58)
        context.lineTo(x - width * 0.12, height)
        context.stroke()
      }
      const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, ids.length))))
      const rows = Math.max(1, Math.ceil(ids.length / columns))
      const cellWidth = width / (columns + 1)
      const cellHeight = Math.min(130, (height * 0.42) / (rows + 1))
      ids.forEach((id, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        const x = cellWidth * (column + 1)
        const y = height * 0.54 - cellHeight * (rows - row - 0.5)
        const active = id === activeId
        context.fillStyle = active ? '#315a6b' : '#344450'
        context.fillRect(x - 34, y - 9, 68, 18)
        context.fillStyle = active ? '#59dcff' : '#8293a0'
        context.beginPath()
        context.arc(x, y - 34, 13, 0, Math.PI * 2)
        context.fill()
        context.fillRect(x - 12, y - 20, 24, 27)
      })
      frame += 1
      animationFrame = window.requestAnimationFrame(draw)
    }
    draw()

    if (window.sessionStorage.getItem('caogen.office.performance') === '1') {
      const target = window as ColdBootWindow
      const diagnostics: ColdBootDiagnostics = {
        readFrame: () => ({ frame, calls: Math.max(1, ids.length * 2 + 3), triangles: Math.max(12, ids.length * 12), lines: 0, points: 0 }),
        snapshot: () => ({
          render: diagnostics.readFrame(),
          workers: { characters: 0, roles: [], states: [] },
          quality: {
            requested: quality,
            effective: quality === 'auto' ? 'balanced' : quality,
            dprMaximum: 1,
            shadows: false,
            contactShadows: 'off',
            contactShadowFrames: 0,
            contactShadowResolution: 0,
            autoTransitions: 0,
            renderActive: true,
            frameLoop: 'always'
          }
        }),
        projectWorldPoint: ([x, y]) => ({ x, y, ndcX: 0, ndcY: 0, visible: true })
      }
      target.__caogenOfficePerformance = diagnostics
      return () => {
        window.cancelAnimationFrame(animationFrame)
        if (target.__caogenOfficePerformance === diagnostics) delete target.__caogenOfficePerformance
      }
    }
    return () => window.cancelAnimationFrame(animationFrame)
  }, [activeId, background, ids, positions, quality])

  return <canvas ref={canvasRef} aria-label="Office boot preview" />
}

function OfficeColdBoot({ boot }: OfficeViewProps): React.JSX.Element {
  const { activeId, language, lightMode, quality } = boot
  const [hiddenSessionsOpen, setHiddenSessionsOpen] = useState(false)
  const recentIds = [...new Set(boot.sessionIds)].reverse()
  const prioritizedIds = activeId && recentIds.includes(activeId)
    ? [activeId, ...recentIds.filter((id) => id !== activeId)]
    : recentIds
  const ids = prioritizedIds.slice(0, OFFICE_MAX_VISIBLE_SESSIONS)
  const hiddenIds = prioritizedIds.slice(OFFICE_MAX_VISIBLE_SESSIONS)
  const background = lightMode ? '#d8dde0' : '#1c2024'

  return (
    <div className="office">
      <div className="office-topbar drag-region">
        <div className="office-title no-drag">{language === 'zh' ? '控制室' : 'Control room'}</div>
        <div className="office-actions no-drag">
          <span className="office-hint">{language === 'zh' ? '实时工作状态' : 'Live work status'}</span>
        </div>
      </div>
      <div
        className="office-canvas-wrap"
        data-office-business-view="all"
        data-office-session-capacity={OFFICE_MAX_VISIBLE_SESSIONS}
        data-office-sessions={ids.length}
        data-office-hidden-sessions={hiddenIds.length}
        data-office-selected-session={activeId ?? ''}
        data-office-visible-digital-workers={ids.length} data-office-3d-workers-ready-at="0"
        data-office-one-digital-worker-per-agent={ids.length > 0 ? 1 : 0}
        data-office-scene-assets-ready="0"
        data-office-quality-requested={quality}
        data-office-quality-effective={quality === 'auto' ? 'balanced' : quality}
        data-office-quality-dpr-maximum="1"
        data-office-quality-shadows="0"
        data-office-quality-contact-shadows="off"
        data-office-quality-contact-shadow-frames="0"
        data-office-quality-contact-shadow-resolution="0"
        data-office-quality-auto-transitions="0"
        data-office-render-active="1"
        data-office-render-paused="0"
        data-office-frame-loop="always"
      >
        <div className="office-business-strip no-drag" role="group">
          <button
            type="button"
            className="office-business-button active"
            aria-pressed="true"
            data-office-business-view-option="all"
          >
            {language === 'zh' ? '全部' : 'All'}
          </button>
        </div>
        {hiddenIds.length > 0 && (
          <div className="office-command-strip no-drag">
            <div className="office-hidden-sessions" data-office-hidden-sessions-menu={hiddenSessionsOpen ? 'open' : 'closed'}>
              <button
                type="button"
                className="office-hidden-sessions-toggle"
                data-office-hidden-sessions-toggle
                aria-expanded={hiddenSessionsOpen}
                onClick={() => setHiddenSessionsOpen((open) => !open)}
              >
                {language === 'zh' ? `${hiddenIds.length} 个列表工位` : `${hiddenIds.length} listed workspaces`}
              </button>
              {hiddenSessionsOpen && (
                <div className="office-hidden-sessions-list" role="list">
                  {hiddenIds.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="office-hidden-session"
                      data-office-hidden-session={id}
                      onClick={() => {
                        boot.selectSession(id)
                        setHiddenSessionsOpen(false)
                      }}
                    >
                      <span>{id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        <ColdBootCanvas ids={ids} activeId={activeId} background={background} quality={quality} />
      </div>
    </div>
  )
}

export default function OfficeView({ boot }: OfficeViewProps): React.JSX.Element {
  const [Runtime, setRuntime] = useState<ComponentType | null>(null)

  useEffect(() => {
    let cancelled = false
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        void loadOfficeRuntime().then((module) => {
          if (!cancelled) setRuntime(() => module.default)
        })
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [])

  return Runtime ? <Runtime /> : <OfficeColdBoot boot={boot} />
}
