import type { StudioResultSnapshot } from '../../../../shared/types'

const I18N = {
  zh: {
    title: '追溯视图（Artifact → Evidence → Acceptance）',
    noArtifact: '当前范围没有 canonical Artifact，无可追溯链路',
    evidence: '证据',
    acceptance: '验收',
    criteria: '标准',
    artifact: '产物',
    unknownEvidence: '未知 Evidence',
    unknownAcceptance: '未知 Acceptance'
  },
  en: {
    title: 'Traceability (Artifact → Evidence → Acceptance)',
    noArtifact: 'No canonical Artifact in this scope; nothing to trace',
    evidence: 'Evidence',
    acceptance: 'Acceptance',
    criteria: 'criteria',
    artifact: 'Artifact',
    unknownEvidence: 'Unknown evidence',
    unknownAcceptance: 'Unknown acceptance'
  }
}

/**
 * 跨实体追溯视图(P1-4):展示 Artifact → 验证它的 Evidence → 它满足的 Acceptance criterion。
 * 优先 mermaid,但本环境未集成 mermaid 运行时,降级为缩进树(架构 §8.4 已采纳此降级)。
 * 只读、不新增 IPC;点击条目可经 onDrill 跳转到对应 Tab。
 */
export function TraceabilityView({
  snapshot,
  language = 'zh',
  onDrill
}: {
  snapshot: StudioResultSnapshot
  language?: 'zh' | 'en'
  onDrill?: (kind: 'artifact' | 'evidence' | 'acceptance', id: string) => void
}): React.JSX.Element {
  const t = I18N[language]
  const evidenceById = new Map(snapshot.evidence.map((evidence) => [evidence.id, evidence]))
  const acceptanceById = new Map(snapshot.acceptances.map((acceptance) => [acceptance.id, acceptance]))

  if (snapshot.artifacts.length === 0) {
    return (
      <div className="studio-result-traceability" data-studio-result-traceability>
        <h3>{t.title}</h3>
        <div className="studio-result-muted">{t.noArtifact}</div>
      </div>
    )
  }

  return (
    <div className="studio-result-traceability" data-studio-result-traceability>
      <h3>{t.title}</h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 13 }}>
        {snapshot.artifacts.map((artifact) => (
          <li key={artifact.id} style={{ margin: '6px 0' }}>
            <button
              type="button"
              className="studio-result-trace-artifact"
              data-studio-result-trace-artifact={artifact.id}
              style={linkStyle}
              onClick={() => onDrill?.('artifact', artifact.id)}
            >
              {t.artifact}: {artifact.title} · v{artifact.version}
            </button>
            <ul style={{ listStyle: 'none', margin: '2px 0 2px 16px', padding: 0 }}>
              {artifact.evidenceIds.length === 0 ? (
                <li className="studio-result-muted" style={{ opacity: 0.7 }}>— {t.evidence}: {artifact.evidenceIds.length}</li>
              ) : (
                artifact.evidenceIds.map((evidenceId) => {
                  const evidence = evidenceById.get(evidenceId)
                  return (
                    <li key={evidenceId}>
                      <button
                        type="button"
                        className="studio-result-trace-evidence"
                        data-studio-result-trace-evidence={evidenceId}
                        style={linkStyle}
                        onClick={() => onDrill?.('evidence', evidenceId)}
                      >
                        {t.evidence}: {evidence?.title ?? t.unknownEvidence}
                        {evidence ? ` · ${evidence.kind ?? evidence.origin}${evidence.source ? ` / ${evidence.source}` : ''}` : ''}
                      </button>
                    </li>
                  )
                })
              )}
              {artifact.acceptanceIds.map((acceptanceId) => {
                const acceptance = acceptanceById.get(acceptanceId)
                return (
                  <li key={acceptanceId}>
                    <button
                      type="button"
                      className="studio-result-trace-acceptance"
                      data-studio-result-trace-acceptance={acceptanceId}
                      style={linkStyle}
                      onClick={() => onDrill?.('acceptance', acceptanceId)}
                    >
                      {t.acceptance}: {acceptance?.status ?? t.unknownAcceptance}
                      {acceptance ? ` · ${acceptance.criteria.length} ${t.criteria}` : ''}
                    </button>
                    {acceptance?.criteria.length ? (
                      <ul style={{ listStyle: 'none', margin: '2px 0 2px 16px', padding: 0 }}>
                        {acceptance.criteria.map((criterion, index) => (
                          <li key={index} className="studio-result-muted" style={{ opacity: 0.75 }}>
                            · {criterion}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: '#3b82f6',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'left'
}
