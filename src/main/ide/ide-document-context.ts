export type IdeDocumentContextSource = 'vscode' | 'jetbrains' | 'smoke'

export interface IdeDocumentContextSnapshot {
  sessionId: string
  source: IdeDocumentContextSource
  uri: string
  fsPath?: string
  relativePath?: string
  languageId?: string
  version?: number
  lineCount?: number
  selection?: unknown
  text: string
  truncated?: boolean
  timestamp?: string
  updatedAt: number
}

export interface IdeDocumentContextSyncPayload {
  sessionId: string
  snapshot: {
    source: IdeDocumentContextSource
    uri: string
    fsPath?: string
    relativePath?: string
    languageId?: string
    version?: number
    lineCount?: number
    selection?: unknown
    text: string
    truncated?: boolean
    timestamp?: string
  }
}

const MAX_DOCUMENTS_PER_SESSION = 8
const DEFAULT_PROMPT_DOCUMENT_LIMIT = 3
const DEFAULT_PROMPT_CHAR_LIMIT = 12_000
const MAX_STORED_TEXT_CHARS = 40_000

const documentsBySession = new Map<string, Map<string, IdeDocumentContextSnapshot>>()

export function syncIdeDocumentContext(payload: IdeDocumentContextSyncPayload): void {
  const sessionId = payload.sessionId.trim()
  const uri = payload.snapshot.uri.trim()
  if (!sessionId || !uri) return

  const sessionDocuments = documentsBySession.get(sessionId) ?? new Map<string, IdeDocumentContextSnapshot>()
  const snapshot: IdeDocumentContextSnapshot = {
    sessionId,
    source: payload.snapshot.source,
    uri,
    fsPath: optionalString(payload.snapshot.fsPath),
    relativePath: optionalString(payload.snapshot.relativePath),
    languageId: optionalString(payload.snapshot.languageId),
    version: payload.snapshot.version,
    lineCount: payload.snapshot.lineCount,
    selection: payload.snapshot.selection,
    text: clipStoredText(payload.snapshot.text),
    truncated: payload.snapshot.truncated === true || payload.snapshot.text.length > MAX_STORED_TEXT_CHARS,
    timestamp: optionalString(payload.snapshot.timestamp),
    updatedAt: Date.now()
  }
  sessionDocuments.set(documentKey(snapshot), snapshot)
  pruneSessionDocuments(sessionDocuments)
  documentsBySession.set(sessionId, sessionDocuments)
}

export function listIdeDocumentContext(
  sessionId: string,
  limit = DEFAULT_PROMPT_DOCUMENT_LIMIT
): IdeDocumentContextSnapshot[] {
  const sessionDocuments = documentsBySession.get(sessionId.trim())
  if (!sessionDocuments || limit <= 0) return []
  return Array.from(sessionDocuments.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
}

export function buildIdeDocumentContextPrompt(
  sessionId: string,
  maxChars = DEFAULT_PROMPT_CHAR_LIMIT
): string {
  const documents = listIdeDocumentContext(sessionId)
  if (documents.length === 0 || maxChars <= 0) return ''

  const header = '## IDE 实时同步上下文\n以下内容来自已授权 IDE 的被动同步，仅作为当前打开文件参考。'
  const chunks: string[] = [header]
  let usedChars = header.length

  for (const snapshot of documents) {
    const metadata = [
      `文件: ${snapshot.relativePath ?? snapshot.fsPath ?? snapshot.uri}`,
      `来源: ${snapshot.source}`,
      snapshot.languageId ? `语言: ${snapshot.languageId}` : '',
      typeof snapshot.version === 'number' ? `版本: ${snapshot.version}` : '',
      typeof snapshot.lineCount === 'number' ? `行数: ${snapshot.lineCount}` : '',
      formatSelection(snapshot.selection),
      snapshot.truncated ? '状态: IDE 侧已截断' : ''
    ]
      .filter(Boolean)
      .join('\n')
    const language = normalizeFenceLanguage(snapshot.languageId)
    const wrapperChars = metadata.length + language.length + '\n```'.length * 2 + '\n'.length * 4 + 64
    const remainingChars = maxChars - usedChars - wrapperChars
    if (remainingChars <= 0) break

    const text = clipPromptText(snapshot.text, remainingChars)
    const chunk = `${metadata}\n\`\`\`${language}\n${text}\n\`\`\``
    chunks.push(chunk)
    usedChars += chunk.length
    if (usedChars >= maxChars) break
  }

  return chunks.length > 1 ? chunks.join('\n\n') : ''
}

export function clearIdeDocumentContext(sessionId?: string): void {
  const normalizedSessionId = sessionId?.trim()
  if (normalizedSessionId) {
    documentsBySession.delete(normalizedSessionId)
    return
  }
  documentsBySession.clear()
}

function pruneSessionDocuments(sessionDocuments: Map<string, IdeDocumentContextSnapshot>): void {
  if (sessionDocuments.size <= MAX_DOCUMENTS_PER_SESSION) return
  const overflow = Array.from(sessionDocuments.entries())
    .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
    .slice(0, sessionDocuments.size - MAX_DOCUMENTS_PER_SESSION)
  for (const [key] of overflow) sessionDocuments.delete(key)
}

function documentKey(snapshot: Pick<IdeDocumentContextSnapshot, 'source' | 'uri'>): string {
  return `${snapshot.source}:${snapshot.uri}`
}

function optionalString(value: string | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || undefined
}

function clipStoredText(text: string): string {
  if (text.length <= MAX_STORED_TEXT_CHARS) return text
  return text.slice(0, MAX_STORED_TEXT_CHARS)
}

function clipPromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 32))}\n...（IDE 同步上下文已截断）`
}

function normalizeFenceLanguage(languageId: string | undefined): string {
  if (!languageId) return ''
  return /^[a-zA-Z0-9_+.-]+$/.test(languageId) ? languageId : ''
}

function formatSelection(selection: unknown): string {
  if (selection === undefined || selection === null) return ''
  try {
    const text = JSON.stringify(selection)
    if (!text) return ''
    return `选区: ${text.length > 240 ? `${text.slice(0, 237)}...` : text}`
  } catch {
    return ''
  }
}
