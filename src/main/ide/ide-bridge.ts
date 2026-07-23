import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { CreateSessionOptions, SessionEventPayload, SessionMeta, SendMessagePayload } from '../../shared/types'

export const IDE_BRIDGE_PROTOCOL_VERSION = 1
export const IDE_BRIDGE_DEFAULT_HOST = '127.0.0.1'
export const IDE_BRIDGE_DEFAULT_PORT = 0

export type IdeBridgeRole = 'vscode' | 'jetbrains' | 'smoke'
export type IdeBridgeMessageType =
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

export interface IdeBridgeEnvelope<T extends IdeBridgeMessageType = IdeBridgeMessageType> {
  id?: string
  type: T
  payload?: unknown
}

export interface IdeBridgeHelloPayload {
  protocol: number
  client: string
  role: IdeBridgeRole
  token?: string
}

export interface IdeBridgeHelloOkPayload {
  protocol: number
  server: 'caogen-ide-bridge'
  connectionId: string
  capabilities: IdeBridgeCapability[]
}

export type IdeBridgeCapability =
  | 'sessions.list'
  | 'sessions.create'
  | 'sessions.send'
  | 'documents.sync'
  | 'session.event'

export interface IdeBridgeSessionsListResult {
  sessions: SessionMeta[]
}

export interface IdeBridgeCreateSessionPayload extends CreateSessionOptions {
  initialText?: string
}

export interface IdeBridgeSendPayload {
  sessionId: string
  message: string | SendMessagePayload
}

export interface IdeBridgeSendResult {
  ok: true
  sessionId: string
}

export interface IdeBridgeDocumentSyncPayload {
  sessionId: string
  snapshot: IdeBridgeDocumentSnapshot
}

export interface IdeBridgeDocumentSnapshot {
  kind: 'ide-sync-v1'
  source: IdeBridgeRole
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

export interface IdeBridgeDocumentSyncResult {
  ok: true
  sessionId: string
  uri: string
}

export interface IdeBridgeErrorPayload {
  code: string
  message: string
}

export interface IdeBridgeSessionPort {
  listSessions(): SessionMeta[]
  createSession(options: CreateSessionOptions): SessionMeta | Promise<SessionMeta>
  sendMessage(sessionId: string, message: string | SendMessagePayload): void
  syncDocument?(payload: IdeBridgeDocumentSyncPayload): void
  subscribeSessionEvents?(listener: (event: SessionEventPayload) => void): () => void
}

export interface IdeBridgeOptions {
  host?: string
  port?: number
  token?: string
  sessionPort: IdeBridgeSessionPort
}

export interface IdeBridgeStatus {
  enabled: boolean
  host: string
  port: number
  connections: number
}

export interface IdeBridgeServer {
  start(): Promise<IdeBridgeStatus>
  stop(): Promise<void>
  status(): IdeBridgeStatus
}

interface IdeBridgeConnection {
  id: string
  socket: Duplex
  authenticated: boolean
  pending: Promise<void>
}

type WebSocketOpcode = 0x1 | 0x8 | 0x9 | 0xa

interface WebSocketFrame {
  opcode: WebSocketOpcode
  payload: Buffer<ArrayBufferLike>
}

const TEXT_OPCODE: WebSocketOpcode = 0x1
const CLOSE_OPCODE: WebSocketOpcode = 0x8
const PING_OPCODE: WebSocketOpcode = 0x9
const PONG_OPCODE: WebSocketOpcode = 0xa
const MAX_FRAME_BYTES = 1024 * 1024

/**
 * IDE bridge 默认只构造控制器,不会监听端口。
 * 主线程必须显式调用 start(),旧桌面用户不会受到端口或后台服务影响。
 */
export function createIdeBridge(options: IdeBridgeOptions): IdeBridgeServer {
  return new LocalIdeBridge(options)
}

class LocalIdeBridge implements IdeBridgeServer {
  private readonly host: string
  private readonly requestedPort: number
  private readonly token?: string
  private readonly sessionPort: IdeBridgeSessionPort
  private readonly connections = new Map<string, IdeBridgeConnection>()
  private readonly documentSnapshots = new Map<string, IdeBridgeDocumentSyncPayload>()
  private server: Server | null = null
  private unsubscribeEvents: (() => void) | null = null
  private activePort = IDE_BRIDGE_DEFAULT_PORT

  constructor(options: IdeBridgeOptions) {
    this.host = normalizeHost(options.host)
    this.requestedPort = normalizePort(options.port)
    this.token = normalizeToken(options.token)
    this.sessionPort = options.sessionPort
  }

  async start(): Promise<IdeBridgeStatus> {
    if (this.server) return this.status()

    const server = createServer()
    server.on('upgrade', (request, socket) => this.handleUpgrade(request, socket))
    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        this.activePort = typeof address === 'object' && address ? address.port : this.requestedPort
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.requestedPort, this.host)
    })

    this.unsubscribeEvents = this.sessionPort.subscribeSessionEvents?.((event) => {
      this.broadcast({ type: 'session.event', payload: event })
    }) ?? null

    return this.status()
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return

    this.unsubscribeEvents?.()
    this.unsubscribeEvents = null
    for (const connection of this.connections.values()) {
      this.sendFrame(connection.socket, CLOSE_OPCODE, Buffer.alloc(0))
      connection.socket.destroy()
    }
    this.connections.clear()
    this.server = null

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.activePort = IDE_BRIDGE_DEFAULT_PORT
  }

  status(): IdeBridgeStatus {
    return {
      enabled: this.server !== null,
      host: this.host,
      port: this.server ? this.activePort : IDE_BRIDGE_DEFAULT_PORT,
      connections: this.connections.size
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex): void {
    if (request.url !== '/ide-bridge') {
      socket.destroy()
      return
    }

    const key = headerValue(request.headers['sec-websocket-key'])
    if (!key) {
      socket.destroy()
      return
    }

    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        ''
      ].join('\r\n')
    )

    const connection: IdeBridgeConnection = {
      id: randomBytes(8).toString('hex'),
      socket,
      authenticated: false,
      pending: Promise.resolve()
    }
    this.connections.set(connection.id, connection)

    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer<ArrayBufferLike>) => {
      pending = Buffer.concat([pending, chunk])
      pending = this.consumeFrames(connection, pending)
    })
    socket.on('close', () => this.connections.delete(connection.id))
    socket.on('error', () => this.connections.delete(connection.id))
  }

  private consumeFrames(
    connection: IdeBridgeConnection,
    input: Buffer<ArrayBufferLike>
  ): Buffer<ArrayBufferLike> {
    let offset = 0
    while (offset < input.length) {
      const parsed = parseFrame(input, offset)
      if (!parsed) break
      offset = parsed.nextOffset
      connection.pending = connection.pending.then(() => this.handleFrame(connection, parsed.frame))
    }
    return input.subarray(offset)
  }

  private async handleFrame(connection: IdeBridgeConnection, frame: WebSocketFrame): Promise<void> {
    if (frame.opcode === CLOSE_OPCODE) {
      connection.socket.end()
      return
    }
    if (frame.opcode === PING_OPCODE) {
      this.sendFrame(connection.socket, PONG_OPCODE, frame.payload)
      return
    }
    if (frame.opcode !== TEXT_OPCODE) return

    const envelope = parseEnvelope(frame.payload.toString('utf8'))
    if (!envelope) {
      this.sendError(connection, undefined, 'invalid_json', '无法解析 IDE bridge 消息')
      return
    }

    try {
      await this.handleEnvelope(connection, envelope)
    } catch (error) {
      this.sendError(connection, envelope.id, 'handler_failed', errorMessage(error))
    }
  }

  private async handleEnvelope(connection: IdeBridgeConnection, envelope: IdeBridgeEnvelope): Promise<void> {
    if (envelope.type === 'hello') {
      this.handleHello(connection, envelope)
      return
    }

    if (!connection.authenticated) {
      this.sendError(connection, envelope.id, 'unauthorized', '必须先完成 hello 握手')
      return
    }

    if (envelope.type === 'ping') {
      this.send(connection, { id: envelope.id, type: 'pong', payload: { at: Date.now() } })
      return
    }

    if (envelope.type === 'sessions.list') {
      const result: IdeBridgeSessionsListResult = { sessions: this.sessionPort.listSessions() }
      this.send(connection, { id: envelope.id, type: 'sessions.list.result', payload: result })
      return
    }

    if (envelope.type === 'sessions.create') {
      const payload = requireCreateSessionPayload(envelope.payload)
      const { initialText, ...options } = payload
      const meta = await this.sessionPort.createSession(options)
      if (typeof initialText === 'string' && initialText.trim()) {
        this.sessionPort.sendMessage(meta.id, { text: initialText.trim() })
      }
      this.send(connection, { id: envelope.id, type: 'sessions.create.result', payload: meta })
      return
    }

    if (envelope.type === 'sessions.send') {
      const payload = requireSendPayload(envelope.payload)
      this.sessionPort.sendMessage(payload.sessionId, payload.message)
      const result: IdeBridgeSendResult = { ok: true, sessionId: payload.sessionId }
      this.send(connection, { id: envelope.id, type: 'sessions.send.result', payload: result })
      return
    }

    if (envelope.type === 'documents.sync') {
      const payload = requireDocumentSyncPayload(envelope.payload)
      this.documentSnapshots.set(documentSnapshotKey(payload), payload)
      this.sessionPort.syncDocument?.(payload)
      const result: IdeBridgeDocumentSyncResult = {
        ok: true,
        sessionId: payload.sessionId,
        uri: payload.snapshot.uri
      }
      this.send(connection, { id: envelope.id, type: 'documents.sync.result', payload: result })
      return
    }

    this.sendError(connection, envelope.id, 'unknown_type', `未知 IDE bridge 消息类型: ${envelope.type}`)
  }

  private handleHello(connection: IdeBridgeConnection, envelope: IdeBridgeEnvelope): void {
    const hello = requireHelloPayload(envelope.payload)
    if (hello.protocol !== IDE_BRIDGE_PROTOCOL_VERSION) {
      this.sendError(connection, envelope.id, 'protocol_mismatch', 'IDE bridge 协议版本不匹配')
      return
    }
    if (!isTokenAccepted(this.token, hello.token)) {
      this.sendError(connection, envelope.id, 'bad_token', 'IDE bridge token 无效')
      return
    }

    connection.authenticated = true
    const payload: IdeBridgeHelloOkPayload = {
      protocol: IDE_BRIDGE_PROTOCOL_VERSION,
      server: 'caogen-ide-bridge',
      connectionId: connection.id,
      capabilities: ['sessions.list', 'sessions.create', 'sessions.send', 'documents.sync', 'session.event']
    }
    this.send(connection, { id: envelope.id, type: 'hello.ok', payload })
  }

  private broadcast(envelope: IdeBridgeEnvelope): void {
    for (const connection of this.connections.values()) {
      if (connection.authenticated) this.send(connection, envelope)
    }
  }

  private send(connection: IdeBridgeConnection, envelope: IdeBridgeEnvelope): void {
    this.sendFrame(connection.socket, TEXT_OPCODE, Buffer.from(JSON.stringify(envelope), 'utf8'))
  }

  private sendError(connection: IdeBridgeConnection, id: string | undefined, code: string, message: string): void {
    const payload: IdeBridgeErrorPayload = { code, message }
    this.send(connection, { id, type: 'error', payload })
  }

  private sendFrame(socket: Duplex, opcode: WebSocketOpcode, payload: Buffer<ArrayBufferLike>): void {
    socket.write(encodeFrame(opcode, payload, false))
  }
}

function normalizeHost(host: string | undefined): string {
  const clean = host?.trim()
  return clean || IDE_BRIDGE_DEFAULT_HOST
}

function normalizePort(port: number | undefined): number {
  if (port === undefined) return IDE_BRIDGE_DEFAULT_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('IDE bridge 端口无效')
  return port
}

function normalizeToken(token: string | undefined): string | undefined {
  const clean = token?.trim()
  return clean || undefined
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseEnvelope(text: string): IdeBridgeEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return null
  return {
    id: typeof parsed.id === 'string' ? parsed.id : undefined,
    type: parsed.type as IdeBridgeMessageType,
    payload: parsed.payload
  }
}

function requireHelloPayload(value: unknown): IdeBridgeHelloPayload {
  if (!isRecord(value)) throw new Error('hello payload 必须是对象')
  if (value.protocol !== IDE_BRIDGE_PROTOCOL_VERSION) {
    throw new Error('hello payload 缺少正确协议版本')
  }
  if (typeof value.client !== 'string' || !value.client.trim()) throw new Error('hello payload 缺少 client')
  if (value.role !== 'vscode' && value.role !== 'jetbrains' && value.role !== 'smoke') {
    throw new Error('hello payload role 无效')
  }
  return {
    protocol: value.protocol,
    client: value.client,
    role: value.role,
    token: typeof value.token === 'string' ? value.token : undefined
  }
}

function requireCreateSessionPayload(value: unknown): IdeBridgeCreateSessionPayload {
  if (!isRecord(value)) throw new Error('sessions.create payload 必须是对象')
  if (typeof value.cwd !== 'string') throw new Error('sessions.create 缺少 cwd')
  return {
    cwd: value.cwd,
    parentSessionId: optionalString(value.parentSessionId),
    orchestrationId: optionalString(value.orchestrationId),
    childTaskId: optionalString(value.childTaskId),
    childRole: optionalString(value.childRole),
    isolated: optionalBoolean(value.isolated),
    model: optionalString(value.model),
    providerId: optionalString(value.providerId),
    budgetUsd: optionalFiniteNumber(value.budgetUsd),
    resumeSessionAt: optionalString(value.resumeSessionAt),
    engine: optionalEngine(value.engine),
    permissionMode: optionalPermissionMode(value.permissionMode),
    resumeSdkSessionId: optionalString(value.resumeSdkSessionId),
    title: optionalString(value.title),
    initialText: optionalString(value.initialText)
  }
}

function requireSendPayload(value: unknown): IdeBridgeSendPayload {
  if (!isRecord(value)) throw new Error('sessions.send payload 必须是对象')
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) throw new Error('sessions.send 缺少 sessionId')
  const message = normalizeMessage(value.message)
  if (!message) throw new Error('sessions.send 缺少 message')
  return { sessionId: value.sessionId, message }
}

function requireDocumentSyncPayload(value: unknown): IdeBridgeDocumentSyncPayload {
  if (!isRecord(value)) throw new Error('documents.sync payload must be an object')
  if (typeof value.sessionId !== 'string' || !value.sessionId.trim()) throw new Error('documents.sync missing sessionId')
  if (!isRecord(value.snapshot)) throw new Error('documents.sync missing snapshot')
  const snapshot = requireDocumentSnapshot(value.snapshot)
  return { sessionId: value.sessionId.trim(), snapshot }
}

function requireDocumentSnapshot(value: Record<string, unknown>): IdeBridgeDocumentSnapshot {
  if (value.kind !== 'ide-sync-v1') throw new Error('documents.sync snapshot kind must be ide-sync-v1')
  if (value.source !== 'vscode' && value.source !== 'jetbrains' && value.source !== 'smoke') {
    throw new Error('documents.sync snapshot source is invalid')
  }
  if (typeof value.uri !== 'string' || !value.uri.trim()) throw new Error('documents.sync snapshot missing uri')
  if (typeof value.text !== 'string') throw new Error('documents.sync snapshot missing text')
  return {
    kind: 'ide-sync-v1',
    source: value.source,
    uri: value.uri.trim(),
    fsPath: optionalString(value.fsPath),
    relativePath: optionalString(value.relativePath),
    languageId: optionalString(value.languageId),
    version: optionalFiniteNumber(value.version),
    lineCount: optionalFiniteNumber(value.lineCount),
    selection: value.selection,
    text: value.text,
    truncated: optionalBoolean(value.truncated),
    timestamp: optionalString(value.timestamp)
  }
}

function documentSnapshotKey(payload: IdeBridgeDocumentSyncPayload): string {
  return `${payload.sessionId}:${payload.snapshot.source}:${payload.snapshot.uri}`
}

function normalizeMessage(value: unknown): string | SendMessagePayload | null {
  if (typeof value === 'string' && value.trim()) return value
  if (!isRecord(value)) return null
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (!text) return null
  return { text }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalEngine(value: unknown): CreateSessionOptions['engine'] {
  if (value === 'claude' || value === 'anthropic' || value === 'openai') return value
  return undefined
}

function optionalPermissionMode(value: unknown): CreateSessionOptions['permissionMode'] {
  if (value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions') {
    return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTokenAccepted(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected) return true
  if (!actual) return false
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(actual)
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseFrame(
  buffer: Buffer<ArrayBufferLike>,
  offset: number
): { frame: WebSocketFrame; nextOffset: number } | null {
  if (buffer.length - offset < 2) return null
  const first = buffer[offset]
  const second = buffer[offset + 1]
  const opcode = first & 0x0f
  const masked = (second & 0x80) === 0x80
  let length = second & 0x7f
  let cursor = offset + 2

  if (length === 126) {
    if (buffer.length - cursor < 2) return null
    length = buffer.readUInt16BE(cursor)
    cursor += 2
  } else if (length === 127) {
    if (buffer.length - cursor < 8) return null
    const bigLength = buffer.readBigUInt64BE(cursor)
    if (bigLength > BigInt(MAX_FRAME_BYTES)) throw new Error('IDE bridge frame 过大')
    length = Number(bigLength)
    cursor += 8
  }

  if (length > MAX_FRAME_BYTES) throw new Error('IDE bridge frame 过大')
  const maskBytes = masked ? 4 : 0
  if (buffer.length - cursor < maskBytes + length) return null

  const mask = masked ? buffer.subarray(cursor, cursor + 4) : null
  cursor += maskBytes
  const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
  cursor += length

  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index] ^ mask[index % 4]
    }
  }

  if (opcode !== TEXT_OPCODE && opcode !== CLOSE_OPCODE && opcode !== PING_OPCODE && opcode !== PONG_OPCODE) {
    return { frame: { opcode: CLOSE_OPCODE, payload: Buffer.alloc(0) }, nextOffset: cursor }
  }
  return { frame: { opcode, payload }, nextOffset: cursor }
}

function encodeFrame(
  opcode: WebSocketOpcode,
  payload: Buffer<ArrayBufferLike>,
  masked: boolean
): Buffer<ArrayBufferLike> {
  const length = payload.length
  const extended = length >= 126 ? (length <= 65535 ? 2 : 8) : 0
  const maskBytes = masked ? 4 : 0
  const frame = Buffer.alloc(2 + extended + maskBytes + length)
  frame[0] = 0x80 | opcode
  frame[1] = masked ? 0x80 : 0
  let cursor = 2

  if (extended === 0) {
    frame[1] |= length
  } else if (extended === 2) {
    frame[1] |= 126
    frame.writeUInt16BE(length, cursor)
    cursor += 2
  } else {
    frame[1] |= 127
    frame.writeBigUInt64BE(BigInt(length), cursor)
    cursor += 8
  }

  const mask = masked ? randomBytes(4) : null
  if (mask) {
    mask.copy(frame, cursor)
    cursor += 4
  }

  for (let index = 0; index < payload.length; index += 1) {
    frame[cursor + index] = mask ? payload[index] ^ mask[index % 4] : payload[index]
  }
  return frame
}
