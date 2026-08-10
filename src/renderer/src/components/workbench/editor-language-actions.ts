export interface EditorWordRange {
  start: number
  end: number
  word: string
}

export interface EditorLocation {
  line: number
  column: number
}

const IDENTIFIER = /[\p{L}\p{N}_$]/u

export function editorWordRange(content: string, offsetValue: number): EditorWordRange | null {
  const offset = Math.max(0, Math.min(Math.floor(offsetValue), content.length))
  let start = offset
  let end = offset
  while (start > 0 && IDENTIFIER.test(content[start - 1])) start -= 1
  while (end < content.length && IDENTIFIER.test(content[end])) end += 1
  const word = content.slice(start, end)
  return word ? { start, end, word } : null
}

export function replaceEditorWord(content: string, range: EditorWordRange, replacement: string): { content: string; caret: number } {
  const next = `${content.slice(0, range.start)}${replacement}${content.slice(range.end)}`
  return { content: next, caret: range.start + replacement.length }
}

export function editorOffsetForLocation(content: string, lineValue: number, columnValue: number): number {
  const lines = content.split('\n')
  const line = Math.max(1, Math.min(Math.floor(lineValue), lines.length))
  const preceding = lines.slice(0, line - 1)
  const base = preceding.reduce((total, item) => total + item.length + 1, 0)
  return Math.min(content.length, base + Math.max(0, Math.floor(columnValue) - 1))
}

export function editorLocationForOffset(content: string, offsetValue: number): EditorLocation {
  const offset = Math.max(0, Math.min(Math.floor(offsetValue), content.length))
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (content[index] !== '\n') continue
    line += 1
    lineStart = index + 1
  }
  return { line, column: offset - lineStart + 1 }
}
