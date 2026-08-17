import {
  ArrowRight, Bug, ChevronDown, ChevronRight, CornerDownRight, CornerUpRight,
  Pause, Play, Plus, RefreshCw, Square, Trash2
} from 'lucide-react'
import { useState } from 'react'
import type { ProjectDebugState, ProjectDebugVariable } from '../../../../shared/types'
import { useT } from '../../i18n'
import { useProjectDebugger } from './useProjectDebugger'

export default function DebugPanel(): React.JSX.Element {
  const t = useT()
  const debug = useProjectDebugger()
  const [breakpointPath, setBreakpointPath] = useState('')
  const [breakpointLine, setBreakpointLine] = useState('1')
  const active = isActive(debug.state.status)

  const addBreakpoint = (): void => {
    const line = Number(breakpointLine)
    debug.addBreakpoint(breakpointPath, line)
    if (breakpointPath.trim() && Number.isSafeInteger(line) && line > 0) setBreakpointLine(String(line + 1))
  }

  return (
    <div className="debug-panel" data-project-debug-panel>
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('projectDebugTitle')}</div>
          <div className="workspace-diff-sub">{t('projectDebugSubtitle')}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('projectDebugRefresh')}
          title={t('projectDebugRefresh')} disabled={!debug.activeId || debug.loading || active}
          onClick={() => void debug.refresh()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </header>

      {debug.error && <div className="notice notice-error debug-panel-notice" role="alert">{debug.error}</div>}
      <div className="debug-panel-body">
        <DebugSetup
          active={active}
          breakpointLine={breakpointLine}
          breakpointPath={breakpointPath}
          debug={debug}
          onAddBreakpoint={addBreakpoint}
          onBreakpointLineChange={setBreakpointLine}
          onBreakpointPathChange={setBreakpointPath}
        />
        <DebugRuntime debug={debug} />
      </div>
    </div>
  )
}

type ProjectDebuggerView = ReturnType<typeof useProjectDebugger>

function DebugSetup({
  active,
  breakpointLine,
  breakpointPath,
  debug,
  onAddBreakpoint,
  onBreakpointLineChange,
  onBreakpointPathChange
}: {
  active: boolean
  breakpointLine: string
  breakpointPath: string
  debug: ProjectDebuggerView
  onAddBreakpoint: () => void
  onBreakpointLineChange: (value: string) => void
  onBreakpointPathChange: (value: string) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <section className="debug-setup" aria-label={t('projectDebugTargets')}>
      <div className="debug-setup-column">
        <div className="test-section-label">{t('projectDebugTargets')}</div>
        {!debug.activeId && <DebugEmpty text={t('projectDebugNoSession')} />}
        {debug.activeId && debug.loading && <DebugEmpty text={t('projectDebugLoading')} />}
        {debug.activeId && !debug.loading && debug.targets.length === 0 && <DebugEmpty text={t('projectDebugNoTargets')} />}
        <div className="debug-target-list">
          {debug.targets.map((target) => (
            <div className="debug-target-row" key={target.id} data-project-debug-target={target.runtime}>
              <button type="button" className="debug-target-copy" disabled={active}
                onClick={() => { onBreakpointPathChange(target.relativePath); void debug.launch(target) }}>
                <strong>{target.label}</strong>
                <span>{target.relativePath} · {target.runtime}</span>
              </button>
              <button type="button" className="btn btn-ghost btn-icon-sm"
                aria-label={`${t('projectDebugStart')}: ${target.label}`} title={t('projectDebugStart')}
                disabled={active || debug.pending} onClick={() => void debug.launch(target)}>
                <Play size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="debug-setup-column debug-breakpoints">
        <div className="test-section-label">{t('projectDebugBreakpoints')}</div>
        <form className="debug-breakpoint-form" onSubmit={(event) => { event.preventDefault(); onAddBreakpoint() }}>
          <input aria-label={t('projectDebugBreakpointPath')} placeholder={t('projectDebugBreakpointPath')}
            value={breakpointPath} disabled={active} onChange={(event) => onBreakpointPathChange(event.target.value)} />
          <input className="debug-line-input" aria-label={t('projectDebugBreakpointLine')} type="number" min="1"
            value={breakpointLine} disabled={active} onChange={(event) => onBreakpointLineChange(event.target.value)} />
          <button type="submit" className="btn btn-ghost btn-icon-sm" aria-label={t('projectDebugAddBreakpoint')}
            title={t('projectDebugAddBreakpoint')} disabled={active || !breakpointPath.trim()} onClick={onAddBreakpoint}>
            <Plus size={14} aria-hidden="true" />
          </button>
        </form>
        {debug.breakpoints.length === 0 && <DebugEmpty text={t('projectDebugNoBreakpoints')} />}
        <div className="debug-breakpoint-list">
          {debug.breakpoints.map((breakpoint, index) => (
            <div className="debug-breakpoint-row" key={`${breakpoint.path}:${breakpoint.line}`}>
              <span><strong>{breakpoint.path}</strong>:{breakpoint.line}</span>
              <button type="button" className="btn btn-ghost btn-icon-sm" aria-label={t('projectDebugRemoveBreakpoint')}
                title={t('projectDebugRemoveBreakpoint')} disabled={active} onClick={() => debug.removeBreakpoint(index)}>
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function DebugRuntime({ debug }: { debug: ProjectDebuggerView }): React.JSX.Element {
  const t = useT()
  const paused = debug.state.status === 'paused'
  return (
    <section className="debug-runtime" aria-label={t('projectDebugSession')}>
      <DebugControls state={debug.state} pending={debug.pending} onControl={(action) => void debug.control(action)} />
      {debug.state.status === 'idle' && <DebugEmpty icon text={t('projectDebugIdle')} />}
      {debug.state.status !== 'idle' && (
        <div className="debug-runtime-content">
          <div className="debug-inspector">
            <div className="debug-stack">
              <div className="test-section-label">{t('projectDebugCallStack')}</div>
              {debug.state.frames.length === 0 && <DebugEmpty text={paused ? t('projectDebugNoFrames') : t('projectDebugRunning')} />}
              <div className="debug-stack-list">
                {debug.state.frames.map((frame) => (
                  <button type="button" key={frame.id} className={frame.id === debug.state.selectedFrameId ? 'debug-frame-selected' : ''}
                    onClick={() => void debug.selectFrame(frame.id)}>
                    <strong>{frame.name}</strong>
                    <span>{frame.location ? `${frame.location.path}:${frame.location.line}` : t('projectDebugRuntimeFrame')}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="debug-variables">
              <div className="test-section-label">{t('projectDebugVariables')}</div>
              {debug.state.scopes.length === 0 && <DebugEmpty text={paused ? t('projectDebugNoVariables') : t('projectDebugPauseForVariables')} />}
              <div className="debug-scope-list">
                {debug.state.scopes.map((scope, index) => (
                  <details open={index < 2} key={`${scope.name}:${index}`}>
                    <summary>{scope.name}</summary>
                    {scope.variables.map((variable) => (
                      <DebugVariableRow key={`${variable.name}:${variable.id ?? variable.value}`} variable={variable} sessionId={debug.activeId ?? ''} />
                    ))}
                  </details>
                ))}
              </div>
            </div>
          </div>
          <div className="debug-output-section">
            <div className="test-section-label">{t('projectDebugOutput')}</div>
            <pre className="debug-output">{combinedOutput(debug.state) || t('projectDebugNoOutput')}</pre>
          </div>
        </div>
      )}
    </section>
  )
}

function DebugControls(props: {
  state: ProjectDebugState
  pending: boolean
  onControl(action: 'continue' | 'pause' | 'step-over' | 'step-into' | 'step-out' | 'stop'): void
}): React.JSX.Element {
  const t = useT()
  const paused = props.state.status === 'paused'
  const running = props.state.status === 'running' || props.state.status === 'starting'
  const active = paused || running
  const controls = [
    { action: paused ? 'continue' : 'pause', label: paused ? t('projectDebugContinue') : t('projectDebugPause'), icon: paused ? Play : Pause, disabled: !active || props.state.status === 'starting' },
    { action: 'step-over', label: t('projectDebugStepOver'), icon: ArrowRight, disabled: !paused },
    { action: 'step-into', label: t('projectDebugStepInto'), icon: CornerDownRight, disabled: !paused },
    { action: 'step-out', label: t('projectDebugStepOut'), icon: CornerUpRight, disabled: !paused },
    { action: 'stop', label: t('projectDebugStop'), icon: Square, disabled: !active }
  ] as const
  return (
    <div className="debug-control-bar">
      <span className={`debug-status debug-status-${props.state.status}`} data-project-debug-status={props.state.status}>
        {t(`projectDebugStatus_${props.state.status}`)}
      </span>
      <span className="debug-target-active">{props.state.targetLabel}</span>
      <div className="debug-control-actions">
        {controls.map(({ action, label, icon: Icon, disabled }) => (
          <button type="button" className="btn btn-ghost btn-icon-sm" key={action} aria-label={label} title={label}
            disabled={props.pending || disabled} onClick={() => props.onControl(action)}>
            <Icon size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  )
}

function DebugVariableRow({ variable, sessionId }: { variable: ProjectDebugVariable; sessionId: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<ProjectDebugVariable[] | null>(null)
  const toggle = async (): Promise<void> => {
    if (!variable.expandable || !variable.id) return
    if (!expanded && !children) {
      try { setChildren(await window.agentDesk.expandProjectDebugVariable(sessionId, variable.id)) } catch { setChildren([]) }
    }
    setExpanded((value) => !value)
  }
  return (
    <div className="debug-variable-tree">
      <button type="button" className="debug-variable-row" disabled={!variable.expandable} onClick={() => void toggle()}>
        <span className="debug-variable-chevron">
          {variable.expandable && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <strong>{variable.name}</strong>
        <span className="debug-variable-value">{variable.value}</span>
        <em>{variable.type}</em>
      </button>
      {expanded && children && (
        <div className="debug-variable-children">
          {children.map((child) => <DebugVariableRow key={`${child.name}:${child.id ?? child.value}`} variable={child} sessionId={sessionId} />)}
        </div>
      )}
    </div>
  )
}

function DebugEmpty({ text, icon = false }: { text: string; icon?: boolean }): React.JSX.Element {
  return <div className="test-empty">{icon && <Bug size={18} aria-hidden="true" />}<span>{text}</span></div>
}

function isActive(status: ProjectDebugState['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'paused'
}

function combinedOutput(state: ProjectDebugState): string {
  return [state.stdout, state.stderr, state.error].filter(Boolean).join('\n').trim()
}
