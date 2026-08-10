import { FlaskConical, Play, RefreshCw, Square } from 'lucide-react'
import type {
  ProjectTestRunResult
} from '../../../../shared/types'
import { useT } from '../../i18n'
import { useProjectTests, type ProjectTestOutputStream } from './useProjectTests'

export default function TestPanel(): React.JSX.Element {
  const t = useT()
  const tests = useProjectTests()

  return (
    <div className="test-panel" data-project-test-panel>
      <header className="workspace-diff-top">
        <div>
          <div className="workspace-diff-title">{t('projectTestsTitle')}</div>
          <div className="workspace-diff-sub">{t('projectTestsSubtitle')}</div>
        </div>
        <div className="workspace-diff-actions">
          <button
            type="button"
            className="btn btn-ghost btn-icon-sm"
            aria-label={t('projectTestsRefresh')}
            title={t('projectTestsRefresh')}
            disabled={!tests.activeId || tests.loading || tests.runningHere}
            onClick={() => void tests.refresh()}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          {tests.runningHere && (
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm"
              aria-label={t('projectTestsCancel')}
              title={t('projectTestsCancel')}
              disabled={tests.cancelPending}
              onClick={() => void tests.cancel()}
            >
              <Square size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {tests.error && <div className="notice notice-error test-panel-notice" role="alert">{tests.error}</div>}
      <div className="test-panel-body">
        <section className="test-command-section" aria-label={t('projectTestsCommands')}>
          <div className="test-section-label">{t('projectTestsCommands')}</div>
          {!tests.activeId && <TestEmpty icon text={t('projectTestsNoSession')} />}
          {tests.activeId && tests.loading && <TestEmpty icon text={t('projectTestsLoading')} />}
          {tests.activeId && !tests.loading && tests.commands.length === 0 && <TestEmpty icon text={t('projectTestsEmpty')} />}
          {tests.commands.length > 0 && (
            <div className="test-command-list">
              {tests.commands.map((command) => {
                const running = tests.runningCommandId === command.id
                return (
                  <div className="test-command-row" key={command.id} data-project-test-command={command.source}>
                    <div className="test-command-copy">
                      <strong>{command.label}</strong>
                      <span>{command.source}{command.default ? ` · ${t('projectTestsDefault')}` : ''}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-sm"
                      aria-label={`${t('projectTestsRun')}: ${command.label}`}
                      title={running ? t('projectTestsRunning') : t('projectTestsRun')}
                      disabled={Boolean(tests.runningCommandId)}
                      onClick={() => void tests.run(command)}
                    >
                      {running ? <RefreshCw className="test-spin" size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="test-result-section" aria-label={t('projectTestsOutput')}>
          <div className="test-section-label">{t('projectTestsOutput')}</div>
          {!tests.result && <TestEmpty text={t('projectTestsNoResult')} />}
          {tests.result && <TestResult result={tests.result} stream={tests.stream} onStream={tests.setStream} />}
        </section>
      </div>
    </div>
  )
}

function TestResult(props: {
  result: ProjectTestRunResult
  stream: ProjectTestOutputStream
  onStream(stream: ProjectTestOutputStream): void
}): React.JSX.Element {
  const t = useT()
  const { result, stream, onStream } = props
  const output = stream === 'stdout' ? result.stdout : result.stderr
  return (
    <div className="test-result" data-project-test-result={result.status}>
      <div className="test-result-summary">
        <span className={`test-status test-status-${result.status}`}>{t(`projectTestStatus_${result.status}`)}</span>
        <span>{t('projectTestsDuration')}: {formatDuration(result.durationMs)}</span>
        <span>{t('projectTestsExitCode')}: {result.exitCode ?? '-'}</span>
      </div>
      {result.evidenceId && (
        <div className="test-evidence" data-project-test-evidence>
          <span>{t('projectTestsEvidence')}</span>
          <code>{result.evidenceId}</code>
        </div>
      )}
      {result.evidenceError && (
        <div className="notice notice-error test-evidence-error" role="alert">
          <strong>{t('projectTestsEvidenceFailed')}</strong>
          <span>{result.evidenceError}</span>
        </div>
      )}
      <div className="test-output-tabs" role="tablist" aria-label={t('projectTestsOutput')}>
        {(['stdout', 'stderr'] as const).map((name) => (
          <button
            type="button"
            role="tab"
            aria-selected={stream === name}
            className={stream === name ? 'test-output-tab-active' : ''}
            key={name}
            onClick={() => onStream(name)}
          >
            {t(name === 'stdout' ? 'projectTestsStdout' : 'projectTestsStderr')}
          </button>
        ))}
      </div>
      <pre className="test-output">{output || t('projectTestsOutputEmpty')}</pre>
    </div>
  )
}

function TestEmpty({ text, icon = false }: { text: string; icon?: boolean }): React.JSX.Element {
  return (
    <div className="test-empty">
      {icon && <FlaskConical size={18} aria-hidden="true" />}
      <span>{text}</span>
    </div>
  )
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`
}
