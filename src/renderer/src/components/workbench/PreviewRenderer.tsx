import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  officePreviewUnit,
  parseOfficePreviewContent,
  type OfficePreviewModel,
  type OfficePreviewUnit
} from './officePreviewUtils'
import { parseCsv, prettyJson, searchTextPreview, truncate, type CsvDelimiter } from './previewUtils'

const Markdown = lazy(() => import('../Markdown'))

export type PreviewRendererType =
  | 'text'
  | 'markdown'
  | 'json'
  | 'csv'
  | 'html'
  | 'image'
  | 'pdf'
  | 'office'
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

export interface OfficeVisualPreviewValue {
  ok?: boolean
  path?: string
  dataUrl?: string
  previewUrl?: string
  width?: number
  height?: number
  source?: string
  fidelity?: string
  warning?: string
  error?: string
}

export interface OfficePreviewLabels {
  fidelity: string
  loading: string
  modeLabel: string
  nextUnit: string
  previousUnit: string
  structure: string
  thumbnailFidelity: string
  unitSelector: string
  unavailable: string
  visual: string
}

export interface PreviewRendererProps {
  preview?: PreviewRendererValue | null
  className?: string
  maxTextChars?: number
  maxCsvRows?: number
  officeVisual?: OfficeVisualPreviewValue | null
  officeVisualLoading?: boolean
  officeVisualError?: string
  officeLabels?: Partial<OfficePreviewLabels>
  onOfficeUnitChange?: (unit: OfficePreviewUnit | null) => void
}

const DEFAULT_OFFICE_LABELS: OfficePreviewLabels = {
  fidelity: 'System document preview; layout may differ from the original Office application.',
  loading: 'Generating system document preview…',
  modeLabel: 'Office preview mode',
  nextUnit: 'Next page or sheet',
  previousUnit: 'Previous page or sheet',
  structure: 'Structure',
  thumbnailFidelity: 'System first-page thumbnail; it does not represent the complete document layout.',
  unitSelector: 'Document page, sheet or slide',
  unavailable: 'Visual snapshot unavailable; showing structure view',
  visual: 'Visual'
}

export default function PreviewRenderer({
  preview,
  className,
  maxTextChars = 80_000,
  maxCsvRows = 200,
  officeVisual,
  officeVisualLoading = false,
  officeVisualError,
  officeLabels,
  onOfficeUnitChange
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
  const subtitle = path || stringValue(preview.mime)
  const content = contentAsText(preview.content)
  const title = previewTitle(type, content, maxTextChars)

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
        officeLabels={{ ...DEFAULT_OFFICE_LABELS, ...officeLabels }}
        officeVisual={officeVisual}
        officeVisualError={officeVisualError}
        officeVisualLoading={officeVisualLoading}
        onOfficeUnitChange={onOfficeUnitChange}
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
  officeLabels,
  officeVisual,
  officeVisualError,
  officeVisualLoading,
  onOfficeUnitChange,
  preview,
  type
}: {
  content: string
  maxCsvRows: number
  maxTextChars: number
  officeLabels: OfficePreviewLabels
  officeVisual?: OfficeVisualPreviewValue | null
  officeVisualError?: string
  officeVisualLoading: boolean
  onOfficeUnitChange?: (unit: OfficePreviewUnit | null) => void
  preview: PreviewRendererValue
  type: PreviewRendererType
}): React.JSX.Element {
  if (type === 'markdown') return <MarkdownPreview content={content} maxTextChars={maxTextChars} />
  if (type === 'json') return <JsonPreview content={content} maxTextChars={maxTextChars} />
  if (type === 'csv') return <CsvPreview content={content} maxRows={maxCsvRows} preview={preview} />
  if (type === 'html') return <HtmlPreview content={content} maxTextChars={maxTextChars} />
  if (type === 'image') return <ImagePreview preview={preview} />
  if (type === 'pdf') return <PdfPreview preview={preview} />
  if (type === 'office') {
    return (
      <OfficePreview
        key={stringValue(preview.path || preview.fullPath) || 'office-preview'}
        content={content}
        labels={officeLabels}
        maxTextChars={maxTextChars}
        onUnitChange={onOfficeUnitChange}
        visual={officeVisual}
        visualError={officeVisualError}
        visualLoading={officeVisualLoading}
      />
    )
  }
  if (type === 'text') return <TextPreview content={content} maxTextChars={maxTextChars} />
  return <UnknownPreview preview={preview} content={content} maxTextChars={maxTextChars} />
}

function previewTitle(type: PreviewRendererType, content: string, maxTextChars: number): string {
  if (type === 'office') {
    const model = parseOfficePreviewContent(truncate(content, maxTextChars))
    if (model.kind === 'word') return 'Word Preview'
    if (model.kind === 'excel') return 'Excel Preview'
    if (model.kind === 'powerpoint') return 'PowerPoint Preview'
    return 'Office Preview'
  }
  if (type === 'json') return 'JSON Preview'
  if (type === 'csv') return 'CSV Preview'
  if (type === 'pdf') return 'PDF Preview'
  return `${type.charAt(0).toUpperCase()}${type.slice(1)} Preview`
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
  const [query, setQuery] = useState('')
  const [matchesOnly, setMatchesOnly] = useState(false)
  const text = truncate(content, maxTextChars)
  const search = useMemo(() => searchTextPreview(text, query, { matchesOnly }), [matchesOnly, query, text])

  return (
    <>
      <div style={styles.textToolbar}>
        <input
          className="input"
          value={query}
          placeholder="Search content"
          style={styles.textSearchInput}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={matchesOnly ? styles.activeToggle : undefined}
          disabled={!query.trim()}
          aria-pressed={matchesOnly}
          onClick={() => setMatchesOnly((value) => !value)}
        >
          Matches
        </button>
        <span style={styles.tableSummary}>
          {search.query ? `${search.matchCount} matches` : `${search.lineCount} lines`}
        </span>
      </div>
      <pre style={styles.pre}>{search.text}</pre>
    </>
  )
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
      <TextPreview content={text} maxTextChars={maxTextChars} />
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
  const content = contentAsText(preview.content)

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
    <div style={styles.pdfWrap}>
      <object
        data={src}
        type="application/pdf"
        style={content ? styles.pdfObjectWithText : styles.pdfObject}
        aria-label={stringValue(preview.path) || 'PDF preview'}
      >
        <iframe src={src} style={styles.iframe} title={stringValue(preview.path) || 'PDF preview'} />
      </object>
      {content && (
        <section style={styles.pdfTextLayer}>
          <div style={styles.pdfTextTitle}>Text layer</div>
          <TextPreview content={content} maxTextChars={80_000} />
        </section>
      )}
    </div>
  )
}

function OfficePreview({
  content,
  labels,
  maxTextChars,
  onUnitChange,
  visual,
  visualError,
  visualLoading
}: {
  content: string
  labels: OfficePreviewLabels
  maxTextChars: number
  onUnitChange?: (unit: OfficePreviewUnit | null) => void
  visual?: OfficeVisualPreviewValue | null
  visualError?: string
  visualLoading: boolean
}): React.JSX.Element {
  const model = useMemo(() => parseOfficePreviewContent(truncate(content, maxTextChars)), [content, maxTextChars])
  const [activeUnitIndex, setActiveUnitIndex] = useState(0)
  const unit = useMemo(() => officePreviewUnit(model, activeUnitIndex), [activeUnitIndex, model])
  const visualDocumentSource = visual?.ok === false ? '' : stringValue(visual?.previewUrl)
  const visualImageSource = visual?.ok === false ? '' : stringValue(visual?.dataUrl)
  const visualReady = Boolean(visualDocumentSource || visualImageSource)
  const visualFormat = visualDocumentSource ? 'document' : visualImageSource ? 'thumbnail' : 'none'
  const [visualContentLoaded, setVisualContentLoaded] = useState(false)
  const [selection, setSelection] = useState<'auto' | 'structure' | 'visual'>('auto')
  const activeMode =
    selection === 'auto' ? (visualReady ? 'visual' : 'structure') : selection === 'visual' && !visualReady ? 'structure' : selection
  const visualState = visualReady ? 'ready' : visualLoading ? 'loading' : visualError ? 'error' : 'idle'

  useEffect(() => {
    if (activeUnitIndex !== unit.index) setActiveUnitIndex(unit.index)
    onUnitChange?.(unit)
  }, [activeUnitIndex, onUnitChange, unit])

  useEffect(() => {
    setVisualContentLoaded(false)
  }, [visualDocumentSource, visualImageSource])

  return (
    <div
      data-office-preview-mode={activeMode}
      data-office-unit-index={unit.position}
      data-office-unit-kind={unit.kind}
      data-office-unit-title={unit.title}
      data-office-unit-total={unit.total}
      data-office-visual-fidelity={visual?.fidelity ?? ''}
      data-office-visual-format={visualFormat}
      data-office-visual-load-state={visualReady ? (visualContentLoaded ? 'loaded' : 'loading') : 'idle'}
      data-office-visual-state={visualState}
      style={styles.officePreviewRoot}
    >
      <div style={styles.officeModeToolbar}>
        <div aria-label={labels.modeLabel} role="tablist" style={styles.officeModeControl}>
          <button
            aria-selected={activeMode === 'visual'}
            className="btn btn-ghost btn-sm"
            data-office-preview-mode-option="visual"
            disabled={!visualReady}
            onClick={() => setSelection('visual')}
            role="tab"
            style={activeMode === 'visual' ? styles.officeModeActive : undefined}
            type="button"
          >
            {labels.visual}
          </button>
          <button
            aria-selected={activeMode === 'structure'}
            className="btn btn-ghost btn-sm"
            data-office-preview-mode-option="structure"
            onClick={() => setSelection('structure')}
            role="tab"
            style={activeMode === 'structure' ? styles.officeModeActive : undefined}
            type="button"
          >
            {labels.structure}
          </button>
        </div>
        {visualLoading && !visualReady && <span style={styles.officeVisualStatus}>{labels.loading}</span>}
      </div>

      {visualError && !visualReady && (
        <div className="notice notice-info" title={visualError}>
          {labels.unavailable}: {visualError}
        </div>
      )}
      {visual?.warning && visualReady && (
        <div className="notice notice-info" title={visual.warning}>
          {visual.warning}
        </div>
      )}

      {activeMode === 'visual' && visualReady ? (
        <figure style={styles.officeVisualFigure}>
          {visualDocumentSource ? (
            <iframe
              data-office-system-preview="document"
              onLoad={() => setVisualContentLoaded(true)}
              referrerPolicy="no-referrer"
              sandbox="allow-scripts"
              src={visualDocumentSource}
              style={styles.officeVisualFrame}
              title={visual?.path || 'Office system document preview'}
            />
          ) : (
            <img
              alt={visual?.path || 'Office first-page thumbnail'}
              data-office-system-preview="thumbnail"
              onLoad={() => setVisualContentLoaded(true)}
              src={visualImageSource}
              style={styles.officeVisualImage}
            />
          )}
          <figcaption style={styles.officeVisualCaption}>
            {visualDocumentSource ? labels.fidelity : labels.thumbnailFidelity}
          </figcaption>
        </figure>
      ) : (
        <OfficeStructurePreview
          labels={labels}
          model={model}
          onUnitIndexChange={setActiveUnitIndex}
          unit={unit}
        />
      )}
    </div>
  )
}

function OfficeStructurePreview({
  labels,
  model,
  onUnitIndexChange,
  unit
}: {
  labels: OfficePreviewLabels
  model: OfficePreviewModel
  onUnitIndexChange: (index: number) => void
  unit: OfficePreviewUnit
}): React.JSX.Element {
  const section = model.sections[unit.index] ?? { title: unit.title, body: unit.body, rows: unit.rows }
  const navigation = (
    <div data-office-unit-navigation="1" style={styles.officeUnitNavigation}>
      <button
        aria-label={labels.previousUnit}
        className="btn btn-ghost btn-sm"
        data-office-unit-action="previous"
        disabled={unit.index <= 0}
        onClick={() => onUnitIndexChange(unit.index - 1)}
        title={labels.previousUnit}
        type="button"
      >
        &lt;
      </button>
      <select
        aria-label={labels.unitSelector}
        className="input"
        data-office-unit-selector="1"
        onChange={(event) => onUnitIndexChange(Number(event.target.value))}
        style={styles.officeUnitSelect}
        value={unit.index}
      >
        {model.sections.map((item, index) => (
          <option key={`${item.title}-${index}`} value={index}>
            {index + 1}. {item.title}
          </option>
        ))}
      </select>
      <span data-office-unit-position="1" style={styles.officeUnitPosition}>
        {unit.position} / {unit.total}
      </span>
      <button
        aria-label={labels.nextUnit}
        className="btn btn-ghost btn-sm"
        data-office-unit-action="next"
        disabled={unit.index >= unit.total - 1}
        onClick={() => onUnitIndexChange(unit.index + 1)}
        title={labels.nextUnit}
        type="button"
      >
        &gt;
      </button>
    </div>
  )

  if (model.kind === 'excel') {
    return (
      <div style={styles.officeStack}>
        {navigation}
        <section key={`${section.title}-${unit.index}`} style={styles.officeSection}>
          <div style={styles.officeSectionHead}>
            <strong>{section.title}</strong>
            <span style={styles.tableSummary}>{section.rows.length} rows</span>
          </div>
          {section.rows.length > 0 ? (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <tbody>
                  {section.rows.map((row, rowIndex) => (
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
          ) : (
            <div className="workspace-diff-empty">{section.body || 'Empty sheet'}</div>
          )}
        </section>
      </div>
    )
  }
  if (model.kind === 'powerpoint') {
    return (
      <div style={styles.officeStack}>
        {navigation}
        <section key={`${section.title}-${unit.index}`} style={styles.officeSlide}>
          <div style={styles.officeSlideNumber}>{section.title}</div>
          <pre style={styles.officeSlideText}>{section.body}</pre>
        </section>
      </div>
    )
  }
  return (
    <div style={styles.officeDocument}>
      {navigation}
      <section key={`${section.title}-${unit.index}`} style={styles.officeDocSection}>
        {section.title !== model.title && <strong>{section.title}</strong>}
        <pre style={styles.pre}>{section.body}</pre>
      </section>
    </div>
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
  if (mime.includes('wordprocessingml') || mime.includes('spreadsheetml') || mime.includes('presentationml')) return 'office'
  if (mime.startsWith('text/')) return 'text'

  const extension = stringValue(preview.path || preview.fullPath).split('.').pop()?.toLowerCase()
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'json') return 'json'
  if (extension === 'csv') return 'csv'
  if (extension === 'htm' || extension === 'html') return 'html'
  if (extension === 'pdf') return 'pdf'
  if (extension && ['docx', 'pptx', 'xlsx'].includes(extension)) return 'office'
  if (extension && ['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(extension)) return 'image'
  if (extension && ['log', 'text', 'txt'].includes(extension)) return 'text'

  return 'unknown'
}

function isPreviewType(value: string): value is PreviewRendererType {
  return ['text', 'markdown', 'json', 'csv', 'html', 'image', 'pdf', 'office', 'unknown'].includes(value)
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
  textToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  },
  textSearchInput: {
    flex: '1 1 220px',
    minWidth: 0,
    maxWidth: 380
  },
  activeToggle: {
    borderColor: 'var(--accent)',
    color: 'var(--accent)'
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
  pdfWrap: {
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  pdfObjectWithText: {
    width: '100%',
    height: '58vh',
    minHeight: 360,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: '#fff'
  },
  pdfTextLayer: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0
  },
  pdfTextTitle: {
    marginBottom: 8,
    color: 'var(--text)',
    fontSize: 12,
    fontWeight: 700
  },
  officeStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minHeight: 0
  },
  officePreviewRoot: {
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 10
  },
  officeModeToolbar: {
    minHeight: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10
  },
  officeModeControl: {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 2,
    border: '1px solid var(--border)',
    borderRadius: 7,
    background: 'var(--bg-input)'
  },
  officeModeActive: {
    borderColor: 'var(--border-strong)',
    background: 'var(--bg-card)',
    color: 'var(--text)'
  },
  officeVisualStatus: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text-dim)',
    fontSize: 11
  },
  officeVisualFigure: {
    minHeight: 0,
    flex: 1,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: '#fff'
  },
  officeVisualFrame: {
    display: 'block',
    width: '100%',
    minHeight: 520,
    flex: 1,
    border: 0,
    background: '#fff'
  },
  officeVisualImage: {
    display: 'block',
    maxWidth: '100%',
    maxHeight: 'calc(100vh - 270px)',
    objectFit: 'contain'
  },
  officeVisualCaption: {
    width: '100%',
    color: '#4c5563',
    fontSize: 11,
    textAlign: 'center'
  },
  officeUnitNavigation: {
    minWidth: 0,
    minHeight: 34,
    display: 'grid',
    gridTemplateColumns: '32px minmax(120px, 1fr) auto 32px',
    alignItems: 'center',
    gap: 6
  },
  officeUnitSelect: {
    minWidth: 0,
    width: '100%',
    height: 30,
    padding: '3px 8px',
    fontSize: 12
  },
  officeUnitPosition: {
    minWidth: 42,
    color: 'var(--text-dim)',
    fontSize: 11,
    textAlign: 'center',
    whiteSpace: 'nowrap'
  },
  officeSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    minHeight: 0
  },
  officeSectionHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: 'var(--text)',
    fontSize: 13
  },
  officeSlide: {
    minHeight: 120,
    padding: 14,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--bg-input)'
  },
  officeSlideNumber: {
    marginBottom: 10,
    color: 'var(--text-dim)',
    fontSize: 12,
    fontWeight: 700
  },
  officeSlideText: {
    margin: 0,
    color: 'var(--text)',
    fontFamily: 'inherit',
    fontSize: 15,
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  officeDocument: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12
  },
  officeDocSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
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
