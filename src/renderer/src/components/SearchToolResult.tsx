import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'

type SearchResultRecord = Record<string, unknown>

function parseSearchResult(content: string): SearchResultRecord | null {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as SearchResultRecord
  } catch {
    return null
  }
}

function searchResultRecords(value: unknown): SearchResultRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is SearchResultRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
}

function SearchCitation({ item, index }: { item: SearchResultRecord; index: number }): React.JSX.Element {
  const url = typeof item.url === 'string' ? item.url : ''
  const title = typeof item.title === 'string' && item.title.trim() ? item.title : url
  const summary = typeof item.summary === 'string' ? item.summary : ''
  const fetchedAt = typeof item.fetchedAt === 'number' && Number.isFinite(item.fetchedAt) ? item.fetchedAt : undefined
  const digest = typeof item.contentSha256 === 'string' ? item.contentSha256 : ''
  const evidenceId = typeof item.evidenceId === 'string' ? item.evidenceId : ''
  return (
    <li key={`${url}:${evidenceId || index}`}>
      {url ? <a href={url} target="_blank" rel="noreferrer">{title}</a> : <strong>{title}</strong>}
      {summary && <span>{summary}</span>}
      <small>
        {fetchedAt !== undefined && <time dateTime={new Date(fetchedAt).toISOString()}>抓取 {new Date(fetchedAt).toLocaleString()}</time>}
        {digest && <code>sha256:{digest.slice(0, 16)}</code>}
        {evidenceId && <code>Evidence {evidenceId.slice(-16)}</code>}
      </small>
    </li>
  )
}

const SEARCH_STATUS_LABELS: Record<string, string> = {
  success: '已找到已验证来源',
  no_results: '没有找到来源',
  timeout: '搜索超时',
  no_credentials: '没有可用的搜索凭据',
  egress_denied: '外发请求被安全策略拒绝',
  provider_failure: '搜索服务失败',
  unknown_result: '搜索结果无法确认'
}

function SearchResultActions({ content }: { content: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copyResult = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }
  const exportResult = (): void => {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `caogen-search-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return (
    <div className="tool-search-result-actions">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyResult()} data-search-result-copy>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {copied ? '已复制' : '复制结果'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={exportResult} data-search-result-export>
        <Download size={13} aria-hidden="true" />导出 JSON
      </button>
    </div>
  )
}

function SearchResultView({ content, parsed }: { content: string; parsed: SearchResultRecord }): React.JSX.Element {
  const ok = parsed.ok === true
  const status = typeof parsed.status === 'string' ? parsed.status : ok ? 'success' : 'unknown_result'
  const message = typeof parsed.message === 'string' ? parsed.message : ''
  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  const results = searchResultRecords(parsed.results)
  return (
    <div className={`tool-search-result ${ok ? 'is-success' : 'is-failure'}`} data-search-result-status={status}>
      <div className="tool-search-result-status">
        <strong>{ok ? '联网搜索完成' : '联网搜索未完成'}</strong>
        <span>{SEARCH_STATUS_LABELS[status] ?? '状态待确认'}</span>
      </div>
      {summary && <p className="tool-search-result-summary">{summary}</p>}
      {!ok && message && <p className="tool-search-result-message" role="alert">{message}</p>}
      {ok && results.length > 0 && (
        <ol className="tool-search-citations" aria-label="搜索来源">
          {results.map((item, index) => <SearchCitation key={`${String(item.url ?? '')}:${String(item.evidenceId ?? '')}:${index}`} item={item} index={index} />)}
        </ol>
      )}
      {ok && results.length === 0 && <p className="tool-search-result-message">没有可展示的已验证来源。</p>}
      <SearchResultActions content={content} />
      <details className="tool-search-raw">
        <summary>查看原始结果</summary>
        <pre className="code-block">{content}</pre>
      </details>
    </div>
  )
}

export default function SearchToolResult({ content }: { content: string }): React.JSX.Element {
  const parsed = parseSearchResult(content)
  return parsed ? <SearchResultView content={content} parsed={parsed} /> : <pre className="code-block">{content}</pre>
}
