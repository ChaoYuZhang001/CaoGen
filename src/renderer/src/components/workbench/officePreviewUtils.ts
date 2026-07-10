export type OfficePreviewKind = 'word' | 'excel' | 'powerpoint' | 'unknown'

export interface OfficePreviewSection {
  title: string
  body: string
  rows: string[][]
}

export interface OfficePreviewModel {
  kind: OfficePreviewKind
  title: string
  sections: OfficePreviewSection[]
}

export type OfficePreviewUnitKind = 'document' | 'page' | 'sheet' | 'slide'

export interface OfficePreviewUnit {
  index: number
  position: number
  total: number
  kind: OfficePreviewUnitKind
  title: string
  body: string
  rows: string[][]
  content: string
  quote: string
}

export function parseOfficePreviewContent(content: string): OfficePreviewModel {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line))
  const title = firstHeadingIndex >= 0 ? lines[firstHeadingIndex].replace(/^#\s+/, '').trim() : 'Office Document'
  const kind = officeKindFromTitle(title)
  const bodyLines = firstHeadingIndex >= 0 ? lines.slice(firstHeadingIndex + 1) : lines
  const sections = splitSections(bodyLines).map((section) => ({
    ...section,
    rows: kind === 'excel' ? parseTabRows(section.body) : []
  }))
  if (sections.length > 0) return { kind, title, sections }
  const body = bodyLines.join('\n').trim()
  return {
    kind,
    title,
    sections: [{ title, body, rows: kind === 'excel' ? parseTabRows(body) : [] }]
  }
}

export function officePreviewUnit(model: OfficePreviewModel, requestedIndex: number): OfficePreviewUnit {
  const total = Math.max(1, model.sections.length)
  const index = Math.min(total - 1, Math.max(0, Math.floor(requestedIndex)))
  const section = model.sections[index] ?? { title: model.title, body: '', rows: [] }
  const kind = officeUnitKind(model)
  const title = section.title || model.title
  const body = section.body.trim()
  const heading = title === model.title ? `# ${model.title}` : `# ${model.title}\n\n## ${title}`
  return {
    index,
    position: index + 1,
    total,
    kind,
    title,
    body,
    rows: section.rows,
    content: `${heading}\n\n${body || '未提取到可读文本'}`,
    quote: compactQuote(body)
  }
}

function splitSections(lines: string[]): OfficePreviewSection[] {
  const sections: OfficePreviewSection[] = []
  let currentTitle = ''
  let currentLines: string[] = []
  const flush = (): void => {
    const body = currentLines.join('\n').trim()
    if (!currentTitle && !body) return
    sections.push({
      title: currentTitle || 'Content',
      body,
      rows: []
    })
  }
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      currentTitle = heading[1]
      currentLines = []
      continue
    }
    currentLines.push(line)
  }
  flush()
  return sections
}

function parseTabRows(body: string): string[][] {
  return body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.split('\t').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
}

function officeKindFromTitle(title: string): OfficePreviewKind {
  const normalized = title.toLowerCase()
  if (normalized.includes('excel') || normalized.includes('workbook')) return 'excel'
  if (normalized.includes('powerpoint') || normalized.includes('presentation')) return 'powerpoint'
  if (normalized.includes('word')) return 'word'
  return 'unknown'
}

function officeUnitKind(model: OfficePreviewModel): OfficePreviewUnitKind {
  if (model.kind === 'excel') return 'sheet'
  if (model.kind === 'powerpoint') return 'slide'
  if (model.kind === 'word' && model.sections.length > 1) return 'page'
  return 'document'
}

function compactQuote(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > 280 ? `${clean.slice(0, 277)}...` : clean
}
