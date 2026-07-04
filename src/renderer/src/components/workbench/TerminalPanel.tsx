import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { useT } from '../../i18n'

export default function TerminalPanel(): React.JSX.Element {
  const t = useT()
  const activeId = useStore((s) => s.activeId)
  const { terminal, terminalBuffer, terminalError, terminalLoading } = useStore((s) => s.workbench)
  const startTerminal = useStore((s) => s.startTerminal)
  const sendInput = useStore((s) => s.sendTerminalInput)
  const closeTerminal = useStore((s) => s.closeTerminal)
  const closePanel = useStore((s) => s.closeTerminalPanel)
  const [command, setCommand] = useState('')
  const scrollRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (activeId) void startTerminal()
  }, [activeId, startTerminal])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [terminalBuffer])

  const runCommand = async (): Promise<void> => {
    const text = command.trim()
    if (!text || !terminal || terminal.exit) return
    setCommand('')
    await sendInput(`${text}\n`)
  }

  return (
    <div className="terminal-panel">
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('terminalPanelTitle')}</div>
          <div className="workspace-diff-sub">
            {terminal ? `${terminal.backend} · ${terminal.cwd}` : t('terminalNotStarted')}
          </div>
        </div>
        <div className="workspace-diff-actions">
          <button className="btn btn-ghost btn-sm" disabled={terminalLoading} onClick={() => void startTerminal()}>
            {terminalLoading ? t('loadingDiff') : t('terminalRestart')}
          </button>
          {terminal && (
            <button className="btn btn-ghost btn-sm" onClick={() => void closeTerminal()}>
              {t('terminalStop')}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={closePanel}>
            {t('close')}
          </button>
        </div>
      </header>

      {terminalError && <div className="notice notice-error terminal-notice">{terminalError}</div>}
      {terminal?.fallbackReason && (
        <div className="notice notice-info terminal-notice">{terminal.fallbackReason}</div>
      )}

      <pre ref={scrollRef} className="terminal-output">
        {terminalBuffer || (terminalLoading ? t('terminalStarting') : t('terminalEmpty'))}
      </pre>

      <div className="terminal-input-row">
        <input
          className="input terminal-input"
          value={command}
          disabled={!terminal || Boolean(terminal.exit)}
          placeholder={terminal?.exit ? t('terminalExited') : t('terminalCommandPlaceholder')}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void runCommand()
            }
          }}
        />
        <button className="btn btn-primary" disabled={!command.trim() || !terminal || Boolean(terminal.exit)} onClick={() => void runCommand()}>
          {t('terminalRun')}
        </button>
      </div>
    </div>
  )
}
