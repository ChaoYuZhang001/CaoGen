import { lazy, Suspense, useMemo, useState, type CSSProperties } from 'react'
import { parseCsv, prettyJson, truncate, type CsvDelimiter } from './previewUtils'

const Markdown = lazy(() => import('../Markdown'))

export type PreviewRendererType =
  | 'text'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'html'
  | 'image'
  | 'pdf'
  | 'unknown'

export interface PreviewRendererValue {
  ok?: boolean
  error?: string
  path?: string
  type?: PreviewRendererType | string
  mode?: string
  mime?: string
  bytes?: number
  mtimeMs?: number
  content?: unknown
  src?: string
  url?: string
  dataUrl?: string
  previewUrl?: string
  fullPath?: string
  [key: string]: unknown
}

export interface PreviewRendererProps {
  preview?: PreviewRendererValue | null
  className?: string
  maxTextChars?: number
  maxCsvRows?: number
}

export default function PreviewRenderer({
  preview,
  className,
  maxTextChars = 80_000,
  maxCsvRows = 200
}: PreviewRendererProps): React.JSX.Element {
  if (!preview) {
    return (
      <Shell className={className} title="Preview" subtitle="">
        <div className="workspace-diff-empty">No preview selected</div>
      </Shell>
    )
  }

  if (preview.ok === false) {
    return (
      <Shell className={className} title="Preview failed" subtitle={stringValue(preview.path)}>
        <div className="notice notice-error workspace-diff-notice">
          {preview.error || 'Preview failed'}
        </div>
      </Shell>
    )
  }

  const type = normalizePreviewType(preview)
  const path = stringValue(preview.path || preview.fullPath)
  const title = `${type.toUpperCase()} Preview`
  const subtitle = path || stringValue(preview.mime)
  const content = contentAsText(preview.content)

  return (
    <Shell
      className={className}
      title={title}
      subtitle={subtitle}
      meta={<PreviewMeta preview={preview} type={type} />}
    >
      <PreviewBody
        content={content}
        maxCsvRows={maxCsvRows}
        maxTextChars={maxTextChars}
        preview={preview}
        type={type}
      />
    </Shell>
  )
}

function PreviewBody({
  content,
  maxCsvRows,
  maxTextChars,
  preview,
  type
}: {
  content: string
  maxCsvRows: number
  maxTextChars: number
  preview: PreviewRendererValue
  type: PreviewRendererType
}): React.JSX.Element {
  if (type === 'markdown') return <MarkdownPreview content={content} maxTextChars={maxTextChars} />
  if (type === 'json') return <JsonPreview content={content} maxTextChars={maxTextChars} />
  if (type === 'csv') return <CsvPreview content={content} maxRows={maxCsvRows} preview={preview} />
  if (type === 'html') return <HtmlPreview content={content} maxTextChars={maxTextChars} />
  if (type === 'image') return <ImagePreview preview={preview} />
  if (type === 'pdf') return <PdfPreview preview={preview} />
  if (type === 'text') return <TextPreview content={content} maxTextChars={maxTextChars} />
  return <UnknownPreview preview={preview} content={content} maxTextChars={maxTextChars} />
}

function Shell({
  children,
  className,
  meta,
  subtitle,
  title
}: {
  children: React.ReactNode
  className?: string
  meta?: React.ReactNode
  subtitle: string
  title: string
}): React.JSX.Element {
  return (
    <div className={['preview-renderer', className].filter(Boolean).join(' ')} style={styles.root}>
      <header className="workspace-diff-top">
        <div style={styles.headerText}>
          <div className="workspace-diff-title">{title}</div>
          <div className="workspace-diff-sub" title={subtitle}>
            {subtitle}
          </div>
        </div>
        {meta && <div style={styles.meta}>{meta}</div>}
      </header>
      <div style={styles.body}>{children}</div>
    </div>
  )
}

function PreviewMeta({
  preview,
  type
}: {
  preview: PreviewRendererValue
  type: PreviewRendererType
}): React.JSX.Element {
  const parts = [
    stringValue(preview.mime),
    formatBytes(numberValue(preview.bytes)),
    formatDate(numberValue(preview.mtimeMs))
  ].filter(Boolean)

  return (
    <>
      <span style={styles.badge}>{type}</span>
      {parts.map((part) => (
        <span key={part} style={styles.metaItem} title={part}>
          {part}
        </span>
      ))}
    </>
  )
}

function TextPreview({
  content,
  maxTextChars
}: {
  content: string
  maxTextChars: number
}): React.JSX.Element {
  const text = truncate(content, maxTextChars)
  return <pre style={styles.pre}>{text}</pre>
}

function MarkdownPreview({
  content,
  maxTextChars
}: {
  content: string
  maxTextChars: number
}): React.JSX.Element {
  const text = truncate(content, maxTextChars)
  return (
    <div style={styles.markdownWrap}>
      <Suspense fallback={<pre style={styles.pre}>{text}</pre>}>
        <Markdown text={text} />
      </Suspense>
    </div>
  )
}

function JsonPreview({
  content,
  maxTextChars
}: {
  content: string
  maxTextChars: number
}): React.JSX.Element {
  const pretty = useMemo(() => prettyJson(content), [content])
  const text = truncate(pretty.text, maxTextChars)

  return (
    <>
      {!pretty.ok && (
        <div className="notice notice-error" style={styles.inlineNotice}>
          Invalid JSON: {pretty.error}
        </div>
      )}
      <pre style={styles.pre}>{text}</pre>
    </>
  )
}

function CsvPreview({
  content,
  maxRows,
  preview
}: {
  content: string
  maxRows: number
  preview: PreviewRendererValue
}): React.JSX.Element {
  const [filterText, setFilterText] = useState('')
  const delimiter = useMemo(() => previewDelimiter(preview), [preview])
  const parsed = useMemo(() => parseCsv(content, { maxRows, delimiter }), [content, delimiter, maxRows])
  const visibleRows = useMemo(() => filterCsvRows(parsed.rows, filterText), [filterText, parsed.rows])

  if (parsed.rows.length === 0) {
    return (
      <div className="workspace-diff-empty">
        {parsed.error ? `CSV parse warning: ${parsed.error}` : 'CSV has no rows'}
      </div>
    )
  }

  return (
    <>
      {parsed.error && (
        <div className="notice notice-error" style={styles.inlineNotice}>
          CSV parse warning: {parsed.error}
        </div>
      )}
      {parsed.truncated && (
        <div className="notice notice-info" style={styles.inlineNotice}>
          Showing {parsed.rows.length} of {parsed.rowCount} parsed rows.
        </div>
      )}
      <div style={styles.tableToolbar}>
        <input
          className="input"
          value={filterText}
          placeholder="Filter rows"
          style={styles.tableFilter}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <span style={styles.tableSummary}>
          {visibleRows.length} / {parsed.rows.length} rows
        </span>
      </div>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => {
                  const Cell = rowIndex === 0 ? 'th' : 'td'
                  return (
                    <Cell key={cellIndex} style={rowIndex === 0 ? styles.th : styles.td}>
                      {cell}
                    </Cell>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function filterCsvRows(rows: string[][], filterText: string): string[][] {
  const query = filterText.trim().toLowerCase()
  if (!query) return rows
  const header = rows[0]
  const body = rows.slice(1).filter((row) => row.some((cell) => cell.toLowerCase().includes(query)))
  return header ? [header, ...body] : body
}

function previewDelimiter(preview: PreviewRendererValue): CsvDelimiter {
  const mime = stringValue(preview.mime).toLowerCase()
  const path = stringValue(preview.path || preview.fullPath).toLowerCase()
  if (mime.includes('tab-separated') || path.endsWith('.tsv')) return '\t'
  if (mime.includes('semicolon-separated')) return ';'
  return ','
}

function HtmlPreview({
  content,
  maxTextChars
}: {
  content: string
  maxTextChars: number
}): React.JSX.Element {
  const html = truncate(content, maxTextChars)
  return <iframe sandbox="" srcDoc={html} style={styles.iframe} title="HTML preview" />
}

function ImagePreview({ preview }: { preview: PreviewRendererValue }): React.JSX.Element {
  const src = resolveAssetSource(preview)

  if (!src) {
    return (
      <div style={styles.placeholder}>
        <strong>Image preview source unavailable</strong>
        <span>{stringValue(preview.path || preview.fullPath) || 'No image URL was provided.'}</span>
      </div>
    )
  }

  return (
    <div style={styles.imageWrap}>
      <img alt={stringValue(preview.path) || 'Image preview'} src={src} style={styles.image} />
    </div>
  )
}

function PdfPreview({ preview }: { preview: PreviewRendererValue }): React.JSX.Element {
  const src = resolveAssetSource(preview)

  if (!src) {
    return (
      <div style={styles.placeholder}>
        <strong>PDF preview source unavailable</strong>
        <span>{stringValue(preview.path || preview.fullPath) || 'No PDF URL was provided.'}</span>
        <span>{metadataLine(preview)}</span>
      </div>
    )
  }

  return (
    <object data={src} type="application/pdf" style={styles.pdfObject} aria-label={stringValue(preview.path) || 'PDF preview'}>
      <iframe src={src} style={styles.iframe} title={stringValue(preview.path) || 'PDF preview'} />
    </object>
  )
}

function UnknownPreview({
  content,
  maxTextChars,
  preview
}: {
  content: string
  maxTextChars: number
  preview: PreviewRendererValue
}): React.JSX.Element {
  const text = truncate(content, maxTextChars)
  return (
    <div style={styles.placeholder}>
      <strong>Unsupported preview type</strong>
      <span>{stringValue(preview.path || preview.fullPath) || stringValue(preview.mime) || 'Unknown file'}</span>
      {text && <pre style={styles.pre}>{text}</pre>}
    </div>
  )
}

function normalizePreviewType(preview: PreviewRendererValue): PreviewRendererType {
  const rawType = stringValue(preview.type).toLowerCase()
  if (rawType === 'md') return 'markdown'
  if (rawType === 'jpeg' || rawType === 'jpg' || rawType === 'png' || rawType === 'gif' || rawType === 'webp') {
    return 'image'
  }
  if (isPreviewType(rawType)) return rawType

  const mime = stringValue(preview.mime).toLowerCase()
  if (mime.includes('markdown')) return 'markdown'
  if (mime.includes('json')) return 'json'
  if (mime.includes('csv')) return 'csv'
  if (mime.includes('html')) return 'html'
  if (mime.startsWith('image/')) return 'image'
  if (mime.includes('pdf')) return 'pdf'
  if (mime.startsWith('text/')) return 'text'

  const extension = stringValue(preview.path || preview.fullPath).split('.').pop()?.toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'json') return 'json'
  if (extension === 'csv') return 'csv'
  if (extension === 'htm' || extension === 'html') return 'html'
  if (extension === 'pdf') return 'pdf'
  if (extension && ['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension)) return 'image'
  if (extension && ['log', 'text', 'txt'].includes(extension)) return 'text'

  return 'unknown'
}

function isPreviewType(value: string): value is PreviewRendererType {
  return ['text', 'markdown', 'json', 'csv', 'html', 'image', 'pdf', 'unknown'].includes(value)
}

function contentAsText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  return prettyJson(value).text
}

function resolveAssetSource(preview: PreviewRendererValue): string {
  const direct =
    stringValue(preview.src) ||
    stringValue(preview.url) ||
    stringValue(preview.dataUrl) ||
    stringValue(preview.previewUrl)
  if (direct) return direct
  return localFileUrl(stringValue(preview.fullPath))
}

function localFileUrl(value: string): string {
  if (!value) return ''
  if (/^(data|blob|https?|file):/i.test(value)) return value
  if (value.startsWith('/')) return `file://${encodeURI(value)}`
  if (/^[A-Za-z]:[\\/]/.test(value)) return `file:///${encodeURI(value.replace(/\\/g, '/'))}`
  return ''
}

function metadataLine(preview: PreviewRendererValue): string {
  return [
    stringValue(preview.mime),
    formatBytes(numberValue(preview.bytes)),
    formatDate(numberValue(preview.mtimeMs))
  ]
    .filter(Boolean)
    .join(' | ')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) return ''
  const date = new Date(mtimeMs)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

const styles = {
  root: {
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg)'
  },
  headerText: {
    minWidth: 0
  },
  meta: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
    minWidth: 0,
    maxWidth: '50%'
  },
  badge: {
    padding: '2px 7px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--bg-input)',
    color: 'var(--accent)',
    fontFamily: 'var(--mono)',
    fontSize: 10,
    textTransform: 'uppercase'
  },
  metaItem: {
    minWidth: 0,
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text-dim)',
    fontFamily: 'var(--mono)',
    fontSize: 11
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: 12
  },
  pre: {
    margin: 0,
    padding: 12,
    minHeight: 0,
    overflow: 'auto',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg-input)',
    color: 'var(--text)',
    fontFamily: 'var(--mono)',
    fontSize: 12,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  markdownWrap: {
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg-input)'
  },
  inlineNotice: {
    marginBottom: 10
  },
  tableToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  },
  tableFilter: {
    flex: '1 1 220px',
    minWidth: 0,
    maxWidth: 360
  },
  tableSummary: {
    color: 'var(--text-dim)',
    fontFamily: 'var(--mono)',
    fontSize: 11,
    whiteSpace: 'nowrap'
  },
  tableWrap: {
    overflow: 'auto',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg-input)'
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12
  },
  th: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    padding: '7px 9px',
    borderBottom: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--text)',
    fontWeight: 700,
    textAlign: 'left',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  td: {
    padding: '7px 9px',
    borderBottom: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    color: 'var(--text)',
    textAlign: 'left',
    verticalAlign: 'top',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  iframe: {
    width: '100%',
    height: '100%',
    minHeight: 360,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: '#fff'
  },
  imageWrap: {
    height: '100%',
    minHeight: 280,
    display: 'grid',
    placeItems: 'center',
    overflow: 'auto',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg-input)'
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain'
  },
  pdfObject: {
    width: '100%',
    height: '100%',
    minHeight: 520,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: '#fff'
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 14,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg-input)',
    color: 'var(--text-dim)',
    fontSize: 12
  }
} satisfies Record<string, CSSProperties>
