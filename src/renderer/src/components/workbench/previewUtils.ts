export interface TruncateOptions {
  suffix?: string
}

export interface PrettyJsonResult {
  ok: boolean
  text: string
  error?: string
}

export interface ParseCsvOptions {
  maxChars?: number
  maxRows?: number
  maxColumns?: number
  maxCellChars?: number
  delimiter?: CsvDelimiter
}

export interface ParsedCsv {
  rows: string[][]
  rowCount: number
  truncated: boolean
  error?: string
}

export type CsvDelimiter = ',' | '\t' | ';'

export interface SearchTextPreviewOptions {
  matchesOnly?: boolean
  maxMatchedLines?: number
}

export interface SearchTextPreviewResult {
  text: string
  query: string
  matchCount: number
  lineCount: number
  visibleLineCount: number
  truncated: boolean
}

export function truncate(value: string, maxChars = 20_000, options: TruncateOptions = {}): string {
  const limit = safePositiveInt(maxChars, 20_000)
  if (value.length <= limit) return value

  const suffix =
    options.suffix ?? `\n\n[truncated ${value.length - limit} characters]`
  return `${value.slice(0, limit)}${suffix}`
}

export function prettyJson(value: unknown, spaces = 2): PrettyJsonResult {
  const indent = safePositiveInt(spaces, 2)

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    const text = stringifyJson(parsed, indent)
    return { ok: true, text }
  } catch (err) {
    return {
      ok: false,
      text: typeof value === 'string' ? value : String(value),
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export function searchTextPreview(
  value: string,
  query: string,
  options: SearchTextPreviewOptions = {}
): SearchTextPreviewResult {
  const cleanQuery = query.trim()
  const lines = value.split(/\r?\n/)
  if (!cleanQuery) {
    return {
      text: value,
      query: '',
      matchCount: 0,
      lineCount: lines.length,
      visibleLineCount: lines.length,
      truncated: false
    }
  }

  const lowerQuery = cleanQuery.toLowerCase()
  const matchedLines: Array<{ index: number; text: string; count: number }> = []
  let matchCount = 0
  lines.forEach((line, index) => {
    const count = countOccurrences(line.toLowerCase(), lowerQuery)
    if (count > 0) {
      matchCount += count
      matchedLines.push({ index, text: line, count })
    }
  })

  if (!options.matchesOnly) {
    return {
      text: value,
      query: cleanQuery,
      matchCount,
      lineCount: lines.length,
      visibleLineCount: lines.length,
      truncated: false
    }
  }

  const maxMatchedLines = safePositiveInt(options.maxMatchedLines, 300)
  const visible = matchedLines.slice(0, maxMatchedLines)
  const body = visible.map((line) => `${line.index + 1}: ${line.text}`).join('\n')
  const truncated = matchedLines.length > visible.length
  const suffix = truncated ? `\n\n[truncated ${matchedLines.length - visible.length} matched lines]` : ''
  return {
    text: body ? `${body}${suffix}` : '[no matches]',
    query: cleanQuery,
    matchCount,
    lineCount: lines.length,
    visibleLineCount: visible.length,
    truncated
  }
}

export function parseCsv(value: string, options: ParseCsvOptions = {}): ParsedCsv {
  const maxChars = safePositiveInt(options.maxChars, 200_000)
  const maxRows = safePositiveInt(options.maxRows, 200)
  const maxColumns = safePositiveInt(options.maxColumns, 80)
  const maxCellChars = safePositiveInt(options.maxCellChars, 500)
  const source = value.length > maxChars ? value.slice(0, maxChars) : value
  const delimiter = options.delimiter ?? detectDelimiter(source)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let rowCount = 0
  let inQuotes = false
  let truncated = value.length > maxChars
  let error: string | undefined

  const pushCell = (): void => {
    if (row.length < maxColumns) {
      row.push(truncate(cell, maxCellChars, { suffix: '...' }))
    } else {
      truncated = true
    }
    cell = ''
  }

  const pushRow = (): void => {
    rowCount += 1
    if (rows.length < maxRows) {
      rows.push(row)
    } else {
      truncated = true
    }
    row = []
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        cell += char
      }
      continue
    }

    if (char === '"' && cell.length === 0) {
      inQuotes = true
      continue
    }

    if (char === delimiter) {
      pushCell()
      continue
    }

    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      pushCell()
      pushRow()
      continue
    }

    cell += char
  }

  if (inQuotes) {
    error = 'CSV ended inside a quoted field'
  }

  if (cell.length > 0 || row.length > 0 || (source.length > 0 && !endsWithLineBreak(source))) {
    pushCell()
    pushRow()
  }

  return { rows, rowCount, truncated, error }
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = 0
  while (index < value.length) {
    const found = value.indexOf(needle, index)
    if (found === -1) break
    count += 1
    index = found + needle.length
  }
  return count
}

function detectDelimiter(value: string): CsvDelimiter {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? ''
  const scores: Array<{ delimiter: CsvDelimiter; count: number }> = [
    { delimiter: ',', count: countChars(firstLine, ',') },
    { delimiter: '\t', count: countChars(firstLine, '\t') },
    { delimiter: ';', count: countChars(firstLine, ';') }
  ]
  return scores.sort((a, b) => b.count - a.count)[0]?.delimiter ?? ','
}

function countChars(value: string, needle: string): number {
  let count = 0
  for (const char of value) {
    if (char === needle) count += 1
  }
  return count
}

function stringifyJson(value: unknown, spaces: number): string {
  const seen = new WeakSet<object>()
  const text = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item.toString()}n`
      if (typeof item !== 'object' || item === null) return item
      if (seen.has(item)) return '[Circular]'
      seen.add(item)
      return item
    },
    spaces
  )

  return text === undefined ? String(value) : text
}

function safePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function endsWithLineBreak(value: string): boolean {
  return value.endsWith('\n') || value.endsWith('\r')
}
