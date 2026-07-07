import * as vscode from 'vscode'

const EXTENSION_ID = 'caogen.caogen-vscode-bridge'
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

declare const require: (id: string) => unknown
declare const process: { env: Record<string, string | undefined> }

interface NetModule {
  createServer(handler: (socket: TcpSocket) => void): TcpServer
}

interface CryptoModule {
  createHash(algorithm: 'sha1'): HashBuilder
}

interface FsModule {
  writeFileSync(file: string, content: string, encoding: 'utf8'): void
}

interface HashBuilder {
  update(value: string): HashBuilder
  digest(encoding: 'base64'): string
}

interface TcpServer {
  listen(port: number, host: string, callback: () => void): void
  address(): { port: number } | string | null
  close(callback?: () => void): void
}

interface TcpSocket {
  on(event: 'data', callback: (chunk: Uint8Array) => void): void
  write(chunk: string | Uint8Array): void
  destroy(): void
}

interface BridgeEnvelope {
  id?: string
  type?: string
  payload?: unknown
}

interface BridgeSession {
  id: string
  title: string
  cwd: string
  status: string
}

interface MockBridge {
  url: string
  messages: BridgeEnvelope[]
  waitForHello(): Promise<void>
  waitForType(type: string, occurrence?: number): Promise<BridgeEnvelope>
  close(): Promise<void>
}

interface SmokeState {
  chatViewResolveCount?: number
  chatViewSmokeCheckCount?: number
  diffPreviewCount?: number
  selectionApplyCount?: number
  desktopOpenRequestCount?: number
  pendingSelectionEditReady?: boolean
  realtimeSyncEnabled?: boolean
  bridgeConnected?: boolean
}

interface ChatViewSmokeSnapshot {
  viewId: 'caogen.chatView'
  hasInput: boolean
  hasSend: boolean
  hasMerge: boolean
  hasOpenDesktop: boolean
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  assert(Boolean(extension), `missing extension ${EXTENSION_ID}`)
  await extension?.activate()
  assert(extension?.isActive === true, 'extension must activate in VS Code Extension Host')

  const commands = await vscode.commands.getCommands(true)
  for (const command of [
    'caogen.connectBridge',
    'caogen.createSession',
    'caogen.listSessions',
    'caogen.sendSelection',
    'caogen.requestSelectionEdit',
    'caogen.previewSelectionDiff',
    'caogen.applySelectionEdit',
    'caogen.previewAndApplySelectionEdit',
    'caogen.openDesktop',
    'caogen.toggleRealtimeSync'
  ]) {
    assert(commands.includes(command), `missing command ${command}`)
  }

  await focusCaoGenSidebar()
  const sidebarState = await getSmokeState()
  assert(
    numberField(sidebarState, 'chatViewResolveCount') >= 1 || numberField(sidebarState, 'chatViewSmokeCheckCount') >= 1,
    'CaoGen sidebar view must resolve or pass provider smoke in the Extension Host'
  )

  const config = vscode.workspace.getConfiguration('caogen')
  const before = config.get<boolean>('realtimeSync') ?? false
  await vscode.commands.executeCommand('caogen.toggleRealtimeSync')
  const after = vscode.workspace.getConfiguration('caogen').get<boolean>('realtimeSync') ?? false
  assert(after !== before, 'toggleRealtimeSync must update workspace configuration')
  await vscode.commands.executeCommand('caogen.toggleRealtimeSync')

  const bridge = await startMockBridge()
  try {
    await config.update('bridgeUrl', bridge.url, vscode.ConfigurationTarget.Workspace)
    await config.update('realtimeSync', true, vscode.ConfigurationTarget.Workspace)
    const editor = await openWorkspaceSample()
    editor.selection = new vscode.Selection(editor.document.lineAt(0).range.start, editor.document.lineAt(0).range.end)

    await vscode.commands.executeCommand('caogen.connectBridge')
    await bridge.waitForHello()
    assert(bridge.messages.some((message) => message.type === 'hello'), 'connectBridge must send hello over WebSocket')

    const session = await vscode.commands.executeCommand<BridgeSession | undefined>('caogen.createSession', {
      title: 'Extension Host Smoke',
      skipPrompt: true
    })
    assert(isBridgeSession(session), 'createSession command must return a bridge session')
    await bridge.waitForType('sessions.create')
    await bridge.waitForType('documents.sync')
    const syncState = await getSmokeState()
    assert(syncState.realtimeSyncEnabled === true, 'realtime sync must remain enabled during document sync smoke')

    await vscode.commands.executeCommand('caogen.sendSelection')
    const sent = await bridge.waitForType('sessions.send')
    assert(JSON.stringify(sent.payload).includes('export'), 'sendSelection must include selected editor text')
    const editRequested = await vscode.commands.executeCommand<boolean>('caogen.requestSelectionEdit', {
      instruction: 'Replace true with false.',
      skipPrompt: true
    })
    assert(editRequested === true, 'requestSelectionEdit must return true when edit request is sent')
    const editMessage = await bridge.waitForType('sessions.send', 2)
    assert(payloadText(editMessage.payload).includes('Replace true with false.'), 'edit request must include instruction')
    await waitForSmokeState((state) => state.pendingSelectionEditReady === true, 'selection edit proposal was not captured')
    await vscode.commands.executeCommand('caogen.previewAndApplySelectionEdit')
    await waitForDocumentText(editor.document, 'export const caogen = false\n')
    const desktopUri = await vscode.commands.executeCommand<string>('caogen.openDesktop', { skipExternalOpen: true })
    assert(desktopUri.startsWith('caogen://ide-bridge?cwd='), 'openDesktop must return CaoGen desktop URI in smoke mode')
    const finalState = await getSmokeState()
    assert(numberField(finalState, 'diffPreviewCount') >= 1, 'one-click Diff merge must preview a VS Code diff')
    assert(numberField(finalState, 'selectionApplyCount') >= 1, 'one-click Diff merge must apply the selected-code edit')
    assert(numberField(finalState, 'desktopOpenRequestCount') >= 1, 'openDesktop must be observed by the smoke marker')
    writeMarker(bridge.messages, finalState)
  } finally {
    await config.update('realtimeSync', false, vscode.ConfigurationTarget.Workspace)
    await bridge.close()
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function focusCaoGenSidebar(): Promise<void> {
  const commands = await vscode.commands.getCommands(true)
  const focusCommands = [
    'workbench.view.extension.caogen',
    'caogen.chatView.focus',
    'workbench.action.focusSideBar'
  ].filter((command) => commands.includes(command))
  assert(focusCommands.includes('caogen.chatView.focus') || focusCommands.includes('workbench.view.extension.caogen'), 'missing CaoGen sidebar focus command')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const command of focusCommands) await vscode.commands.executeCommand(command)
    const state = await waitForSmokeState(
      (candidate) => numberField(candidate, 'chatViewResolveCount') >= 1,
      'CaoGen sidebar view did not resolve',
      3_000
    ).catch(() => undefined)
    if (state) return
  }
  if (commands.includes('caogen.__smokeChatView')) {
    const snapshot = await vscode.commands.executeCommand<unknown>('caogen.__smokeChatView')
    assert(isChatViewSmokeSnapshot(snapshot), 'CaoGen sidebar provider smoke snapshot is invalid')
    return
  }
  throw new Error('CaoGen sidebar view did not resolve')
}

async function getSmokeState(): Promise<SmokeState> {
  const value = await vscode.commands.executeCommand<unknown>('caogen.__smokeState')
  assert(isRecord(value), 'caogen.__smokeState must return an object')
  return value as SmokeState
}

async function waitForSmokeState(predicate: (state: SmokeState) => boolean, message: string, timeoutMs = 10_000): Promise<SmokeState> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = await getSmokeState()
    if (predicate(state)) return state
    await sleep(100)
  }
  throw new Error(message)
}

function numberField(record: SmokeState, key: keyof SmokeState): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function requireModule<T>(id: string): T {
  return require(id) as T
}

function writeMarker(messages: BridgeEnvelope[], state: SmokeState): void {
  const markerPath = process.env.CAOGEN_VSCODE_EXTENSION_HOST_MARKER
  if (!markerPath) return
  const fs = requireModule<FsModule>('node:fs')
  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        ok: true,
        helloCount: messages.filter((message) => message.type === 'hello').length,
        sessionCreateCount: messages.filter((message) => message.type === 'sessions.create').length,
        sessionSendCount: messages.filter((message) => message.type === 'sessions.send').length,
        documentSyncCount: messages.filter((message) => message.type === 'documents.sync').length,
        editRequestCount: messages.filter((message) => message.type === 'sessions.send' && payloadText(message.payload).includes('Replace true with false.')).length,
        commandsChecked: true,
        sidebarChecked: numberField(state, 'chatViewResolveCount') >= 1 || numberField(state, 'chatViewSmokeCheckCount') >= 1,
        sidebarResolveMode: numberField(state, 'chatViewResolveCount') >= 1 ? 'actual-view' : 'provider-smoke',
        bridgeChecked: true,
        selectionEditChecked: true,
        selectedCodeModificationChecked: true,
        oneClickDiffMergeChecked: numberField(state, 'diffPreviewCount') >= 1 && numberField(state, 'selectionApplyCount') >= 1,
        realtimeSyncChecked: messages.some((message) => message.type === 'documents.sync') && state.realtimeSyncEnabled === true,
        openDesktopChecked: numberField(state, 'desktopOpenRequestCount') >= 1,
        smokeState: state,
        sessionWorkflowChecked: messages.some((message) => message.type === 'sessions.create') &&
          messages.some((message) => message.type === 'sessions.send') &&
          messages.some((message) => message.type === 'documents.sync')
      },
      null,
      2
    ),
    'utf8'
  )
}

async function openWorkspaceSample(): Promise<vscode.TextEditor> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) throw new Error('workspace folder is required for VS Code Extension Host smoke')
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, 'sample.ts'))
  return vscode.window.showTextDocument(document)
}

function helloOk(id: string | undefined): BridgeEnvelope {
  return {
    id,
    type: 'hello.ok',
    payload: {
      protocol: 1,
      server: 'mock-vscode-extension-host',
      connectionId: 'extension-host-smoke',
      capabilities: ['documents.sync']
    }
  }
}

function sessionCreateResult(id: string | undefined): BridgeEnvelope {
  return {
    id,
    type: 'sessions.create.result',
    payload: {
      id: 'ide-smoke-session',
      title: 'Extension Host Smoke',
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      status: 'running'
    }
  }
}

async function startMockBridge(): Promise<MockBridge> {
  const net = requireModule<NetModule>('node:net')
  const crypto = requireModule<CryptoModule>('node:crypto')
  const messages: BridgeEnvelope[] = []
  let helloResolver: (() => void) | undefined
  const helloPromise = new Promise<void>((resolve) => {
    helloResolver = resolve
  })

  const server = net.createServer((socket) => {
    let handshaken = false
    socket.on('data', (chunk) => {
      if (!handshaken) {
        handshaken = true
        socket.write(webSocketHandshakeResponse(chunk, crypto))
        return
      }
      for (const text of decodeTextFrames(chunk)) {
        const envelope = parseEnvelope(text)
        if (!envelope) continue
        messages.push(envelope)
        if (envelope.type === 'hello') {
          socket.write(encodeTextFrame(JSON.stringify(helloOk(envelope.id))))
          helloResolver?.()
        } else if (envelope.type === 'sessions.create') {
          socket.write(encodeTextFrame(JSON.stringify(sessionCreateResult(envelope.id))))
        } else if (envelope.type === 'sessions.send') {
          socket.write(encodeTextFrame(JSON.stringify({ id: envelope.id, type: 'sessions.send.result', payload: { ok: true } })))
          if (payloadText(envelope.payload).includes('Replace true with false.')) {
            socket.write(encodeTextFrame(JSON.stringify(selectionEditEvent())))
          }
        } else if (envelope.type === 'documents.sync') {
          socket.write(encodeTextFrame(JSON.stringify({ id: envelope.id, type: 'documents.sync.result', payload: { ok: true } })))
        }
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock bridge did not expose a TCP port')

  return {
    url: `ws://127.0.0.1:${address.port}/ide-bridge`,
    messages,
    waitForHello: () => timeoutPromise(helloPromise, 10_000, 'mock bridge did not receive hello'),
    waitForType: (type, occurrence) => waitForEnvelope(messages, type, occurrence),
    close: () => new Promise<void>((resolve) => server.close(resolve))
  }
}

function webSocketHandshakeResponse(chunk: Uint8Array, crypto: CryptoModule): string {
  const request = new TextDecoder().decode(chunk)
  const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim()
  if (!key) throw new Error('missing Sec-WebSocket-Key')
  const accept = crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    ''
  ].join('\r\n')
}

function decodeTextFrames(chunk: Uint8Array): string[] {
  const out: string[] = []
  let offset = 0
  while (offset + 2 <= chunk.length) {
    offset += 1
    const second = chunk[offset++]
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    if (length === 126) {
      if (offset + 2 > chunk.length) break
      length = (chunk[offset] << 8) | chunk[offset + 1]
      offset += 2
    } else if (length === 127) {
      if (offset + 8 > chunk.length) break
      length = 0
      for (let i = 0; i < 8; i += 1) length = length * 256 + chunk[offset + i]
      offset += 8
    }
    const mask = masked ? chunk.slice(offset, offset + 4) : new Uint8Array()
    if (masked) offset += 4
    if (offset + length > chunk.length) break
    const payload = chunk.slice(offset, offset + length)
    offset += length
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i] ^ mask[i % 4]
    }
    out.push(new TextDecoder().decode(payload))
  }
  return out
}

function encodeTextFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text)
  const headerLength = payload.length < 126 ? 2 : 4
  const frame = new Uint8Array(headerLength + payload.length)
  frame[0] = 0x81
  if (payload.length < 126) {
    frame[1] = payload.length
  } else {
    frame[1] = 126
    frame[2] = (payload.length >> 8) & 0xff
    frame[3] = payload.length & 0xff
  }
  frame.set(payload, headerLength)
  return frame
}

function parseEnvelope(text: string): BridgeEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return null
    return {
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      type: typeof parsed.type === 'string' ? parsed.type : undefined,
      payload: parsed.payload
    }
  } catch {
    return null
  }
}

async function waitForEnvelope(messages: BridgeEnvelope[], type: string, occurrence = 1): Promise<BridgeEnvelope> {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    const found = messages.filter((message) => message.type === type)[occurrence - 1]
    if (found) return found
    await sleep(100)
  }
  throw new Error(`mock bridge did not receive ${type}`)
}

function selectionEditEvent(): BridgeEnvelope {
  return {
    type: 'session.event',
    payload: {
      sessionId: 'ide-smoke-session',
      type: 'assistant.message',
      text: '```ts\nexport const caogen = false\n```'
    }
  }
}

function payloadText(value: unknown): string {
  if (!isRecord(value)) return ''
  const message = value.message
  if (!isRecord(message)) return ''
  return typeof message.text === 'string' ? message.text : ''
}

async function waitForDocumentText(document: vscode.TextDocument, expected: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    if (document.getText() === expected) return
    await sleep(100)
  }
  throw new Error(`document text did not match expected content: ${document.getText()}`)
}

function isBridgeSession(value: unknown): value is BridgeSession {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.status === 'string'
}

function isChatViewSmokeSnapshot(value: unknown): value is ChatViewSmokeSnapshot {
  return isRecord(value) &&
    value.viewId === 'caogen.chatView' &&
    value.hasInput === true &&
    value.hasSend === true &&
    value.hasMerge === true &&
    value.hasOpenDesktop === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function timeoutPromise(promise: Promise<void>, timeoutMs: number, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
