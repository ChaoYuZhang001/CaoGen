const OUTPUT_MAX_CHARS = 24_000
const OUTPUT_MAX_LINES = 1_000

export function clipToolOutput(text: string): string {
  return clipChars(clipLines(text))
}

function clipLines(text: string): string {
  const lines = text.split(/\r?\n/)
  if (lines.length <= OUTPUT_MAX_LINES) return text
  const headCount = Math.ceil(OUTPUT_MAX_LINES / 2)
  const tailCount = Math.floor(OUTPUT_MAX_LINES / 2)
  return [
    ...lines.slice(0, headCount),
    `[输出截断:共 ${lines.length} 行,仅保留前 ${headCount} 行和后 ${tailCount} 行]`,
    ...lines.slice(-tailCount)
  ].join('\n')
}

function clipChars(text: string): string {
  if (text.length <= OUTPUT_MAX_CHARS) return text
  const headChars = Math.ceil(OUTPUT_MAX_CHARS / 2)
  const tailChars = Math.floor(OUTPUT_MAX_CHARS / 2)
  return [
    text.slice(0, headChars),
    `[输出截断:共 ${text.length} 字符,仅保留开头 ${headChars} 字符和结尾 ${tailChars} 字符]`,
    text.slice(-tailChars)
  ].join('\n')
}
