import * as vscode from 'vscode'

type BridgeRole = 'vscode'
type BridgeMessageType =
  | 'hello'
  | 'hello.ok'
  | 'ping'
  | 'pong'
  | 'error'
  | 'sessions.list'
  | 'sessions.list.result'
  | 'sessions.create'
  | 'sessions.create.result'
  | 'sessions.send'
  | 'sessions.send.result'
  | 'documents.sync'
  | 'documents.sync.result'
  | 'session.event'

interface BridgeEnvelope<T extends BridgeMessageType = BridgeMessageType> {
  id?: string
  type: T
  payload?: unknown
}

interface BridgeHelloPayload {
  protocol: 1
  client: string
  role: BridgeRole
  token?: string
}

interface BridgeSession {
  id: string
  title: string
  cwd: string
  status: string
}

interface BridgeSessionsListResult {
  sessions: BridgeSession[]
}

interface BridgeSessionEvent {
  sessionId?: string
  type?: string
  text?: string
}

interface BridgeHelloOkPayload {
  protocol: number
  server: string
  connectionId: string
  capabilities: string[]
}

type WebviewMessage =
  | { type: 'connect' }
  | { type: 'create'; text?: string }
  | { type: 'send'; text?: string }
  | { type: 'list' }
  | { type: 'diff' }
  | { type: 'apply' }
  | { type: 'merge' }
  | { type: 'openDesktop' }

interface PendingSelectionEdit {
  uri: vscode.Uri
  range: vscode.Range
  languageId: string
  originalText: string
  proposedText?: string
}

interface CreateSessionCommandOptions {
  title?: string
  initialText?: string
  skipPrompt?: boolean
}

interface SendSelectionCommandOptions {
  sessionId?: string
}

interface RequestSelectionEditCommandOptions {
  instruction?: string
  skipPrompt?: boolean
}

interface OpenDesktopCommandOptions {
  skipExternalOpen?: boolean
}

interface ChatViewSmokeSnapshot {
  viewId: 'caogen.chatView'
  hasInput: boolean
  hasSend: boolean
  hasMerge: boolean
  hasOpenDesktop: boolean
}

interface IdeSyncPosition {
  line: number
  character: number
}

interface IdeSyncSelection {
  start: IdeSyncPosition
  end: IdeSyncPosition
  active: IdeSyncPosition
  anchor: IdeSyncPosition
}

interface IdeSyncSnapshot {
  kind: 'ide-sync-v1'
  source: BridgeRole
  marker: string
  uri: string
  fsPath: string
  relativePath: string
  languageId: string
  version: number
  lineCount: number
  selection: IdeSyncSelection
  text: string
  truncated: boolean
  timestamp: string
}

let socket: WebSocket | null = null
let activeSessionId: string | null = null
let output: vscode.OutputChannel | null = null
let pendingSelectionEdit: PendingSelectionEdit | null = null
let bridgeCapabilities = new Set<string>()
let syncTimer: ReturnType<typeof setTimeout> | null = null
let syncSequence = 0
let lastSyncKey = ''
let chatViewResolveCount = 0
let chatViewSmokeCheckCount = 0
let diffPreviewCount = 0
let selectionApplyCount = 0
let desktopOpenRequestCount = 0
const pending = new Map<string, (message: BridgeEnvelope) => void>()
const sessionEventListeners = new Set<(event: BridgeSessionEvent) => void>()

const IDE_SYNC_MARKER = '[IDE_SYNC v1]'
const IDE_SYNC_DEBOUNCE_MS = 750
const IDE_SYNC_TEXT_LIMIT = 20_000

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('CaoGen Bridge')
  const chatViewProvider = new CaoGenChatViewProvider()
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider('caogen.chatView', chatViewProvider),
    vscode.commands.registerCommand('caogen.connectBridge', connectBridge),
    vscode.commands.registerCommand('caogen.createSession', createSessionFromWorkspace),
    vscode.commands.registerCommand('caogen.listSessions', listSessions),
    vscode.commands.registerCommand('caogen.sendSelection', sendSelection),
    vscode.commands.registerCommand('caogen.requestSelectionEdit', requestSelectionEdit),
    vscode.commands.registerCommand('caogen.previewSelectionDiff', previewSelectionDiff),
    vscode.commands.registerCommand('caogen.applySelectionEdit', applySelectionEdit),
    vscode.commands.registerCommand('caogen.previewAndApplySelectionEdit', previewAndApplySelectionEdit),
    vscode.commands.registerCommand('caogen.openDesktop', openDesktop),
    vscode.commands.registerCommand('caogen.toggleRealtimeSync', toggleRealtimeSync),
    vscode.commands.registerCommand('caogen.__smokeState', smokeState),
    vscode.commands.registerCommand('caogen.__smokeChatView', () => smokeChatView(chatViewProvider)),
    vscode.workspace.onDidChangeTextDocument((event) => scheduleDocumentSync(event.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => scheduleDocumentSync(editor?.document))
  )
}

export function deactivate(): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  socket?.close()
  socket = null
  output = null
  pending.clear()
}

async function connectBridge(): Promise<void> {
  const config = vscode.workspace.getConfiguration('caogen')
  const url = config.get<string>('bridgeUrl') ?? 'ws://127.0.0.1:17365/ide-bridge'
  const token = config.get<string>('bridgeToken') ?? ''

  socket?.close()
  socket = new WebSocket(url)
  socket.addEventListener('message', (event) => handleMessage(event.data))
  socket.addEventListener('close', () => {
    socket = null
    activeSessionId = null
    bridgeCapabilities = new Set()
    lastSyncKey = ''
  })

  await waitForOpen(socket)
  const payload: BridgeHelloPayload = {
    protocol: 1,
    client: `vscode:${vscode.version}`,
    role: 'vscode',
    ...(token.trim() ? { token: token.trim() } : {})
  }
  const hello = await request({ type: 'hello', payload })
  bridgeCapabilities = parseBridgeCapabilities(hello.payload)
  vscode.window.showInformationMessage('CaoGen bridge connected')
}

async function createSessionFromWorkspace(options?: CreateSessionCommandOptions): Promise<BridgeSession | undefined> {
  await ensureConnected()
  const cwd = getWorkspaceCwd()
  const title = options?.title ?? (options?.skipPrompt === true
    ? 'IDE Session'
    : await vscode.window.showInputBox({
        prompt: 'CaoGen session title',
        value: vscode.workspace.name ? `IDE: ${vscode.workspace.name}` : 'IDE Session'
      }))
  if (title === undefined) return

  const editor = vscode.window.activeTextEditor
  const initialText = options?.initialText ?? selectedText(editor)
  const response = await request({
    type: 'sessions.create',
    payload: {
      cwd,
      title: title.trim() || 'IDE Session',
      initialText: initialText ? `来自 VS Code 选区:\n\n${initialText}` : undefined
    }
  })
  const session = response.payload
  if (!isBridgeSession(session)) throw new Error('CaoGen sessions.create 响应格式无效')
  activeSessionId = session.id
  scheduleDocumentSync(editor?.document)
  vscode.window.showInformationMessage(`CaoGen session ready: ${session.title || session.id}`)
  return session
}

async function createSession(initialText?: string): Promise<BridgeSession> {
  await ensureConnected()
  const cwd = getWorkspaceCwd()
  const response = await request({
    type: 'sessions.create',
    payload: {
      cwd,
      title: vscode.workspace.name ? `IDE: ${vscode.workspace.name}` : 'IDE Session',
      initialText
    }
  })
  const session = response.payload
  if (!isBridgeSession(session)) throw new Error('CaoGen sessions.create 响应格式无效')
  activeSessionId = session.id
  scheduleDocumentSync(vscode.window.activeTextEditor?.document)
  return session
}

async function listSessions(): Promise<void> {
  await ensureConnected()
  const response = await request({ type: 'sessions.list' })
  const payload = response.payload
  if (!isSessionsListResult(payload)) throw new Error('CaoGen sessions.list 响应格式无效')

  const picked = await vscode.window.showQuickPick(
    payload.sessions.map((session) => ({
      label: session.title || session.id,
      description: session.status,
      detail: session.cwd,
      session
    })),
    { placeHolder: 'Select CaoGen session' }
  )
  if (picked) {
    activeSessionId = picked.session.id
    scheduleDocumentSync(vscode.window.activeTextEditor?.document)
  }
}

async function sendSelection(options?: SendSelectionCommandOptions): Promise<void> {
  await ensureConnected()
  if (options?.sessionId) activeSessionId = options.sessionId
  if (!activeSessionId) await listSessions()
  if (!activeSessionId) return

  const editor = vscode.window.activeTextEditor
  const selection = selectedText(editor)
  if (!selection) {
    vscode.window.showWarningMessage('No selected text to send to CaoGen')
    return
  }

  await request({
    type: 'sessions.send',
    payload: {
      sessionId: activeSessionId,
      message: {
        text: `来自 VS Code 选区:\n\n${selection}`
      }
    }
  })
}

async function requestSelectionEdit(options?: RequestSelectionEditCommandOptions): Promise<boolean> {
  await ensureConnected()
  if (!activeSessionId) await listSessions()
  if (!activeSessionId) return false

  const editor = vscode.window.activeTextEditor
  const selection = selectedText(editor)
  if (!editor || !selection) {
    vscode.window.showWarningMessage('No selected text to edit with CaoGen')
    return false
  }
  const instruction = options?.instruction ?? (options?.skipPrompt === true
    ? 'Refactor this selection and keep behavior unchanged.'
    : await vscode.window.showInputBox({
        prompt: 'CaoGen edit instruction',
        value: 'Refactor this selection and keep behavior unchanged.'
      }))
  if (instruction === undefined) return false
  pendingSelectionEdit = {
    uri: editor.document.uri,
    range: editor.selection,
    languageId: editor.document.languageId,
    originalText: selection
  }
  await request({
    type: 'sessions.send',
    payload: {
      sessionId: activeSessionId,
      message: {
        text: [
          '来自 VS Code 选区的修改请求。',
          '请只返回完整替换后的选区代码；如无法安全修改，请说明原因。',
          '',
          `修改要求: ${instruction.trim() || '保持行为不变并改进质量'}`,
          '',
          '```',
          selection,
          '```'
        ].join('\n')
      }
    }
  })
  vscode.window.showInformationMessage('CaoGen edit request sent; use preview/apply after the response arrives.')
  return true
}

async function previewSelectionDiff(): Promise<void> {
  const edit = pendingSelectionEdit
  if (!edit?.proposedText) {
    vscode.window.showWarningMessage('No CaoGen selection edit proposal is ready')
    return
  }
  const document = await vscode.workspace.openTextDocument(edit.uri)
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length))
  const original = document.getText()
  const start = document.offsetAt(edit.range.start)
  const end = document.offsetAt(edit.range.end)
  const proposedFullText = `${original.slice(0, start)}${edit.proposedText}${original.slice(end)}`
  const proposedDocument = await vscode.workspace.openTextDocument({
    content: proposedFullText,
    language: edit.languageId
  })
  await vscode.commands.executeCommand(
    'vscode.diff',
    document.uri,
    proposedDocument.uri,
    `CaoGen Diff: ${vscode.workspace.asRelativePath(document.uri)}`,
    { preview: true, selection: fullRange }
  )
  diffPreviewCount += 1
}

async function applySelectionEdit(): Promise<void> {
  const edit = pendingSelectionEdit
  if (!edit?.proposedText) {
    vscode.window.showWarningMessage('No CaoGen selection edit proposal is ready')
    return
  }
  const document = await vscode.workspace.openTextDocument(edit.uri)
  const editor = await vscode.window.showTextDocument(document)
  const applied = await editor.edit((builder) => {
    builder.replace(edit.range, edit.proposedText ?? '')
  })
  if (!applied) throw new Error('CaoGen selection edit could not be applied')
  selectionApplyCount += 1
  pendingSelectionEdit = null
}

async function previewAndApplySelectionEdit(): Promise<void> {
  await previewSelectionDiff()
  await applySelectionEdit()
}

async function openDesktop(options?: OpenDesktopCommandOptions): Promise<string> {
  const cwd = encodeURIComponent(getWorkspaceCwd())
  const uri = `caogen://ide-bridge?cwd=${cwd}`
  desktopOpenRequestCount += 1
  if (options?.skipExternalOpen !== true) await vscode.env.openExternal(vscode.Uri.parse(uri))
  return uri
}

async function toggleRealtimeSync(): Promise<void> {
  const config = vscode.workspace.getConfiguration('caogen')
  const next = !(config.get<boolean>('realtimeSync') ?? false)
  await config.update('realtimeSync', next, vscode.ConfigurationTarget.Workspace)
  if (next) scheduleDocumentSync(vscode.window.activeTextEditor?.document)
  vscode.window.showInformationMessage(`CaoGen realtime sync ${next ? 'enabled' : 'disabled'}`)
}

async function sendChatText(text: string): Promise<void> {
  await ensureConnected()
  if (!activeSessionId) await createSession()
  if (!activeSessionId) throw new Error('CaoGen session is not ready')
  await request({
    type: 'sessions.send',
    payload: {
      sessionId: activeSessionId,
      message: { text }
    }
  })
}

async function ensureConnected(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) return
  await connectBridge()
}

function waitForOpen(target: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    target.addEventListener('open', () => resolve(), { once: true })
    target.addEventListener('error', () => reject(new Error('CaoGen bridge connection failed')), { once: true })
  })
}

function request(message: Omit<BridgeEnvelope, 'id'>): Promise<BridgeEnvelope> {
  const id = crypto.randomUUID()
  const target = socket
  if (!target || target.readyState !== WebSocket.OPEN) throw new Error('CaoGen bridge is not connected')

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('CaoGen bridge request timed out'))
    }, 10_000)
    pending.set(id, (response) => {
      clearTimeout(timer)
      if (response.type === 'error') reject(new Error(errorText(response.payload)))
      else resolve(response)
    })
    target.send(JSON.stringify({ ...message, id }))
  })
}

function scheduleDocumentSync(document: vscode.TextDocument | undefined): void {
  if (!document || !shouldSyncDocument(document)) return
  if (syncTimer) clearTimeout(syncTimer)
  const sequence = ++syncSequence
  syncTimer = setTimeout(() => {
    syncTimer = null
    void sendDocumentSync(document, sequence)
  }, IDE_SYNC_DEBOUNCE_MS)
}

async function sendDocumentSync(document: vscode.TextDocument, sequence: number): Promise<void> {
  if (sequence !== syncSequence || !shouldSyncDocument(document) || !activeSessionId) return
  const snapshot = buildIdeSyncSnapshot(document)
  const syncKey = `${activeSessionId}:${snapshot.uri}:${snapshot.version}:${snapshot.selection.active.line}:${snapshot.selection.active.character}:${snapshot.text.length}`
  if (syncKey === lastSyncKey) return
  lastSyncKey = syncKey
  try {
    await request({
      type: 'documents.sync',
      payload: {
        sessionId: activeSessionId,
        snapshot
      }
    })
  } catch (error) {
    output?.appendLine(`[ide-sync] ${error instanceof Error ? error.message : String(error)}`)
  }
}

function shouldSyncDocument(document: vscode.TextDocument): boolean {
  if (!(vscode.workspace.getConfiguration('caogen').get<boolean>('realtimeSync') ?? false)) return false
  if (!activeSessionId || socket?.readyState !== WebSocket.OPEN) return false
  if (!bridgeCapabilities.has('documents.sync')) return false
  const editor = vscode.window.activeTextEditor
  return editor?.document === document && document.uri.scheme === 'file' && !document.isUntitled
}

function buildIdeSyncSnapshot(document: vscode.TextDocument): IdeSyncSnapshot {
  const fullText = document.getText()
  const text = fullText.length > IDE_SYNC_TEXT_LIMIT ? fullText.slice(0, IDE_SYNC_TEXT_LIMIT) : fullText
  const editor = vscode.window.activeTextEditor
  const selection = editor?.selection ?? new vscode.Selection(0, 0, 0, 0)
  return {
    kind: 'ide-sync-v1',
    source: 'vscode',
    marker: IDE_SYNC_MARKER,
    uri: document.uri.toString(),
    fsPath: document.uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    version: document.version,
    lineCount: document.lineCount,
    selection: {
      start: positionToSync(selection.start),
      end: positionToSync(selection.end),
      active: positionToSync(selection.active),
      anchor: positionToSync(selection.anchor)
    },
    text,
    truncated: fullText.length > IDE_SYNC_TEXT_LIMIT,
    timestamp: new Date().toISOString()
  }
}

function positionToSync(position: vscode.Position): IdeSyncPosition {
  return { line: position.line, character: position.character }
}

function smokeState(): Record<string, unknown> {
  return {
    chatViewResolveCount,
    chatViewSmokeCheckCount,
    diffPreviewCount,
    selectionApplyCount,
    desktopOpenRequestCount,
    activeSessionId,
    pendingSelectionEditReady: Boolean(pendingSelectionEdit?.proposedText),
    realtimeSyncEnabled: vscode.workspace.getConfiguration('caogen').get<boolean>('realtimeSync') ?? false,
    bridgeConnected: socket?.readyState === WebSocket.OPEN,
    bridgeCapabilities: [...bridgeCapabilities]
  }
}

function smokeChatView(provider: CaoGenChatViewProvider): ChatViewSmokeSnapshot {
  chatViewSmokeCheckCount += 1
  return provider.smokeSnapshot()
}

function handleMessage(data: unknown): void {
  if (typeof data !== 'string') return
  const envelope = parseEnvelope(data)
  if (!envelope) return
  if (envelope.id) {
    const resolver = pending.get(envelope.id)
    if (resolver) {
      pending.delete(envelope.id)
      resolver(envelope)
    }
    return
  }
  if (envelope.type === 'session.event') {
    handleSessionEvent(envelope.payload)
  }
}

function parseEnvelope(text: string): BridgeEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return null
    return {
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      type: parsed.type as BridgeMessageType,
      payload: parsed.payload
    }
  } catch {
    return null
  }
}

function isSessionsListResult(value: unknown): value is BridgeSessionsListResult {
  return isRecord(value) && Array.isArray(value.sessions)
}

function isBridgeSession(value: unknown): value is BridgeSession {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.status === 'string'
}

function parseBridgeCapabilities(value: unknown): Set<string> {
  if (!isRecord(value) || !Array.isArray(value.capabilities)) return new Set()
  return new Set(value.capabilities.filter((item): item is string => typeof item === 'string'))
}

function selectedText(editor: vscode.TextEditor | undefined): string {
  return editor?.document.getText(editor.selection).trim() ?? ''
}

function getWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]
  return folder?.uri.fsPath ?? process.cwd()
}

function handleSessionEvent(value: unknown): void {
  if (!isRecord(value)) return
  const event: BridgeSessionEvent = {
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    text: typeof value.text === 'string' ? value.text : undefined
  }
  const sessionLabel = event.sessionId ? ` ${event.sessionId}` : ''
  output?.appendLine(`[session.event${sessionLabel}] ${event.type ?? 'update'}${event.text ? ` ${event.text}` : ''}`)
  if (event.text && isAssistantEvent(event.type) && pendingSelectionEdit) {
    pendingSelectionEdit = {
      ...pendingSelectionEdit,
      proposedText: extractCodeProposal(event.text)
    }
  }
  for (const listener of sessionEventListeners) listener(event)
}

function errorText(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') return value.message
  return 'CaoGen bridge request failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAssistantEvent(type: string | undefined): boolean {
  if (!type) return true
  return type.includes('assistant') || type.includes('turn-result') || type.includes('message')
}

function extractCodeProposal(text: string): string {
  const fence = /```[A-Za-z0-9_-]*\s*\n([\s\S]*?)```/.exec(text)
  return (fence?.[1] ?? text).trim()
}

class CaoGenChatViewProvider implements vscode.WebviewViewProvider {
  smokeSnapshot(): ChatViewSmokeSnapshot {
    const html = chatHtml()
    return {
      viewId: 'caogen.chatView',
      hasInput: html.includes('id="input"'),
      hasSend: html.includes('id="send"'),
      hasMerge: html.includes('id="merge"'),
      hasOpenDesktop: html.includes('id="openDesktop"')
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    chatViewResolveCount += 1
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = chatHtml()

    const listener = (event: BridgeSessionEvent): void => {
      void webviewView.webview.postMessage({ type: 'event', event })
    }
    sessionEventListeners.add(listener)
    webviewView.onDidDispose(() => sessionEventListeners.delete(listener))

    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleWebviewMessage(webviewView.webview, message)
    })
  }

  private async handleWebviewMessage(webview: vscode.Webview, raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw)
    if (!message) return
    try {
      if (message.type === 'connect') {
        await connectBridge()
        await webview.postMessage({ type: 'status', text: 'connected' })
      } else if (message.type === 'create') {
        const session = await createSession(message.text?.trim() || undefined)
        await webview.postMessage({ type: 'status', text: `session ${session.title || session.id}` })
      } else if (message.type === 'send') {
        const text = message.text?.trim()
        if (!text) return
        await sendChatText(text)
        await webview.postMessage({ type: 'echo', text })
      } else if (message.type === 'list') {
        await ensureConnected()
        const response = await request({ type: 'sessions.list' })
        await webview.postMessage({ type: 'sessions', payload: response.payload })
      } else if (message.type === 'diff') {
        await previewSelectionDiff()
        await webview.postMessage({ type: 'status', text: 'diff opened' })
      } else if (message.type === 'apply') {
        await applySelectionEdit()
        await webview.postMessage({ type: 'status', text: 'selection updated' })
      } else if (message.type === 'merge') {
        await previewAndApplySelectionEdit()
        await webview.postMessage({ type: 'status', text: 'diff merged' })
      } else if (message.type === 'openDesktop') {
        await openDesktop()
        await webview.postMessage({ type: 'status', text: 'desktop requested' })
      }
    } catch (error) {
      await webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }
}

function parseWebviewMessage(value: unknown): WebviewMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  if (value.type === 'connect') return { type: 'connect' }
  if (value.type === 'list') return { type: 'list' }
  if (value.type === 'diff') return { type: 'diff' }
  if (value.type === 'apply') return { type: 'apply' }
  if (value.type === 'merge') return { type: 'merge' }
  if (value.type === 'openDesktop') return { type: 'openDesktop' }
  if (value.type === 'create') {
    return { type: 'create', text: typeof value.text === 'string' ? value.text : undefined }
  }
  if (value.type === 'send') {
    return { type: 'send', text: typeof value.text === 'string' ? value.text : undefined }
  }
  return null
}

function chatHtml(): string {
  const nonce = crypto.randomUUID()
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    body { padding: 10px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .toolbar { display: flex; gap: 6px; margin-bottom: 8px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 8px; cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    textarea { width: 100%; box-sizing: border-box; min-height: 96px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    #log { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; white-space: pre-wrap; }
    .entry { border-left: 2px solid var(--vscode-sideBarTitle-foreground); padding-left: 8px; opacity: 0.95; }
    .error { border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="connect">Connect</button>
    <button id="create" class="secondary">New</button>
    <button id="list" class="secondary">List</button>
    <button id="openDesktop" class="secondary">Open</button>
  </div>
  <textarea id="input"></textarea>
  <div class="toolbar">
    <button id="send">Send</button>
    <button id="diff" class="secondary">Diff</button>
    <button id="merge" class="secondary">Merge</button>
    <button id="apply" class="secondary">Apply</button>
  </div>
  <div id="log"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('input');
    const log = document.getElementById('log');
    function append(text, cls) {
      const item = document.createElement('div');
      item.className = 'entry' + (cls ? ' ' + cls : '');
      item.textContent = text;
      log.prepend(item);
    }
    document.getElementById('connect').addEventListener('click', () => vscode.postMessage({ type: 'connect' }));
    document.getElementById('create').addEventListener('click', () => vscode.postMessage({ type: 'create', text: input.value }));
    document.getElementById('list').addEventListener('click', () => vscode.postMessage({ type: 'list' }));
    document.getElementById('openDesktop').addEventListener('click', () => vscode.postMessage({ type: 'openDesktop' }));
    document.getElementById('send').addEventListener('click', () => vscode.postMessage({ type: 'send', text: input.value }));
    document.getElementById('diff').addEventListener('click', () => vscode.postMessage({ type: 'diff' }));
    document.getElementById('merge').addEventListener('click', () => vscode.postMessage({ type: 'merge' }));
    document.getElementById('apply').addEventListener('click', () => vscode.postMessage({ type: 'apply' }));
    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'event') append('[event] ' + JSON.stringify(message.event));
      if (message.type === 'echo') append('[you] ' + message.text);
      if (message.type === 'status') append('[status] ' + message.text);
      if (message.type === 'sessions') append('[sessions] ' + JSON.stringify(message.payload));
      if (message.type === 'error') append('[error] ' + message.text, 'error');
    });
  </script>
</body>
</html>`
}
