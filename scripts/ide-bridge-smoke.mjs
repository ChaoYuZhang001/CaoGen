import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const bridgeSource = path.join(root, 'src/main/ide/ide-bridge.ts')
const bridgeManagerSource = path.join(root, 'src/main/ide/ide-bridge-manager.ts')
const ideDocumentContextSource = path.join(root, 'src/main/ide/ide-document-context.ts')
const agentSessionSource = path.join(root, 'src/main/agentSession.ts')
const openAiEngineSource = path.join(root, 'src/main/openaiEngine.ts')
const vscodeManifest = path.join(root, 'plugins/vscode/package.json')
const vscodeExtension = path.join(root, 'plugins/vscode/src/extension.ts')
const vscodeReadme = path.join(root, 'plugins/vscode/README.md')
const jetbrainsPlugin = path.join(root, 'plugins/jetbrains/src/main/resources/META-INF/plugin.xml')
const jetbrainsActions = path.join(root, 'plugins/jetbrains/src/main/kotlin/com/caogen/idebridge/ConnectBridgeAction.kt')
const jetbrainsClient = path.join(root, 'plugins/jetbrains/src/main/kotlin/com/caogen/idebridge/CaoGenBridgeClient.kt')
const jetbrainsReadme = path.join(root, 'plugins/jetbrains/README.md')

assert(readFileSync(bridgeSource, 'utf8').includes('start(): Promise<IdeBridgeStatus>'), 'bridge must expose explicit start')
assert(readFileSync(bridgeSource, 'utf8').includes('默认只构造控制器'), 'bridge must document default-off behavior')
const vscodePackage = JSON.parse(readFileSync(vscodeManifest, 'utf8'))
assert(vscodePackage.contributes.commands.length >= 8, 'VS Code commands missing')
for (const command of [
  'caogen.connectBridge',
  'caogen.createSession',
  'caogen.listSessions',
  'caogen.sendSelection',
  'caogen.toggleRealtimeSync',
  'caogen.requestSelectionEdit',
  'caogen.previewSelectionDiff',
  'caogen.applySelectionEdit',
  'caogen.openDesktop'
]) {
  assert(vscodePackage.contributes.commands.some((item) => item.command === command), `${command} missing`)
}
assert(vscodePackage.contributes.configuration?.properties?.['caogen.realtimeSync']?.default === false, 'VS Code realtime sync must default off')
assert(vscodePackage.contributes.views?.caogen?.some((view) => view.id === 'caogen.chatView'), 'VS Code chat view missing')
const vscodeExtensionSource = readFileSync(vscodeExtension, 'utf8')
assert(vscodeExtensionSource.includes('connectBridge'), 'VS Code connect command path missing')
assert(vscodeExtensionSource.includes("'sessions.create'"), 'VS Code create session command missing')
assert(vscodeExtensionSource.includes("'sessions.list'"), 'VS Code list sessions command missing')
assert(vscodeExtensionSource.includes("'sessions.send'"), 'VS Code send selection command missing')
assert(vscodeExtensionSource.includes("'documents.sync'"), 'VS Code passive document sync command missing')
assert(vscodeExtensionSource.includes("'session.event'"), 'VS Code event handling missing')
assert(vscodeExtensionSource.includes('registerWebviewViewProvider'), 'VS Code side panel provider missing')
assert(vscodeExtensionSource.includes('toggleRealtimeSync'), 'VS Code realtime sync toggle missing')
assert(vscodeExtensionSource.includes('onDidChangeTextDocument'), 'VS Code document change sync listener missing')
assert(vscodeExtensionSource.includes('onDidChangeActiveTextEditor'), 'VS Code active editor sync listener missing')
assert(vscodeExtensionSource.includes("document.uri.scheme === 'file'"), 'VS Code realtime sync must be file-only')
assert(vscodeExtensionSource.includes('IDE_SYNC_MARKER'), 'VS Code realtime sync marker missing')
assert(vscodeExtensionSource.includes('IDE_SYNC_DEBOUNCE_MS'), 'VS Code realtime sync debounce missing')
assert(vscodeExtensionSource.includes('IDE_SYNC_TEXT_LIMIT'), 'VS Code realtime sync text limit missing')
assert(vscodeExtensionSource.includes('clearTimeout(syncTimer)'), 'VS Code realtime sync must debounce with clearTimeout')
assert(vscodeExtensionSource.includes('document.languageId'), 'VS Code realtime sync language id missing')
assert(vscodeExtensionSource.includes('document.version'), 'VS Code realtime sync document version missing')
assert(vscodeExtensionSource.includes('editor?.selection'), 'VS Code realtime sync selection capture missing')
assert(vscodeExtensionSource.includes("bridgeCapabilities.has('documents.sync')"), 'VS Code realtime sync must require documents.sync capability')
assert(vscodeExtensionSource.includes("type: 'documents.sync'"), 'VS Code realtime sync must use passive documents.sync')
assert(!vscodeExtensionSource.includes('message: { text: `${IDE_SYNC_MARKER}'), 'VS Code realtime sync must not fall back to sessions.send text')
assert(vscodeExtensionSource.includes('requestSelectionEdit'), 'VS Code selection edit path missing')
assert(vscodeExtensionSource.includes('vscode.diff'), 'VS Code diff preview path missing')
assert(vscodeExtensionSource.includes('applySelectionEdit'), 'VS Code apply edit path missing')
assert(vscodeExtensionSource.includes('openExternal'), 'VS Code open desktop path missing')
assert(readFileSync(vscodeReadme, 'utf8').includes('prototype-only'), 'VS Code prototype boundary missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.ConnectBridge'), 'JetBrains action missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.SendSelection'), 'JetBrains send selection action missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.ToggleRealtimeSync'), 'JetBrains realtime sync action missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.RequestSelectionEdit'), 'JetBrains edit action missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.PreviewSelectionDiff'), 'JetBrains diff preview action missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.ApplySelectionEdit'), 'JetBrains apply edit action missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.ShowEvents'), 'JetBrains events action missing')
assert(readFileSync(jetbrainsPlugin, 'utf8').includes('CaoGen.OpenDesktop'), 'JetBrains open desktop action missing')
const jetbrainsActionSource = readFileSync(jetbrainsActions, 'utf8')
assert(jetbrainsActionSource.includes('requestSessions()'), 'JetBrains list sessions request path missing')
assert(jetbrainsActionSource.includes('sendSelection(sessionId, selection)'), 'JetBrains send selection action path missing')
assert(jetbrainsActionSource.includes('ToggleRealtimeSyncAction'), 'JetBrains realtime sync toggle action missing')
assert(jetbrainsActionSource.includes('DocumentListener'), 'JetBrains document sync listener missing')
assert(jetbrainsActionSource.includes('documentChanged'), 'JetBrains document sync change hook missing')
assert(jetbrainsActionSource.includes('Executors.newSingleThreadScheduledExecutor'), 'JetBrains document sync debounce scheduler missing')
assert(jetbrainsActionSource.includes('syncFuture?.cancel(false)'), 'JetBrains document sync debounce cancellation missing')
assert(jetbrainsActionSource.includes('FileDocumentManager.getInstance().getFile'), 'JetBrains document sync file lookup missing')
assert(jetbrainsActionSource.includes('ApplicationManager.getApplication().runReadAction'), 'JetBrains document sync read action missing')
assert(jetbrainsActionSource.includes('addDocumentListener'), 'JetBrains document sync listener attach missing')
assert(jetbrainsActionSource.includes('removeDocumentListener'), 'JetBrains document sync listener detach missing')
assert(jetbrainsActionSource.includes('IDE_SYNC_MARKER'), 'JetBrains document sync marker missing')
assert(jetbrainsActionSource.includes('DiffManager.getInstance().showDiff'), 'JetBrains native diff preview path missing')
assert(jetbrainsActionSource.includes('WriteCommandAction.runWriteCommandAction'), 'JetBrains apply must use native undo command path')
assert(jetbrainsActionSource.includes('document.replaceString'), 'JetBrains apply must replace captured selection')
assert(jetbrainsActionSource.includes('BrowserUtil.browse("caogen://ide-bridge'), 'JetBrains desktop URI path missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('createSession'), 'JetBrains create session path missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('requestSessions'), 'JetBrains sessions.list path missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('sendSelection'), 'JetBrains sessions.send path missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('sendDocumentSnapshot'), 'JetBrains document snapshot send path missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('"type":"documents.sync"'), 'JetBrains document snapshot must use passive documents.sync protocol')
assert(!readFileSync(jetbrainsClient, 'utf8').includes('"type":"sessions.send","payload":{"sessionId":"${escapeJson(sessionId)}","message":{"text":"${escapeJson(snapshot'), 'JetBrains document sync must not use sessions.send text')
assert(readFileSync(jetbrainsClient, 'utf8').includes('jb-doc-sync-'), 'JetBrains document snapshot should use unique request ids')
assert(readFileSync(jetbrainsClient, 'utf8').includes('addSessionReadyListener'), 'JetBrains session-ready sync hook missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('requestSelectionEdit'), 'JetBrains selection edit path missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('session.event'), 'JetBrains event path missing')
assert(readFileSync(jetbrainsClient, 'utf8').includes('lastAssistantText'), 'JetBrains must capture latest assistant event text for apply/diff')
assert(readFileSync(jetbrainsClient, 'utf8').includes('.replace("\\n", "\\\\n")'), 'JetBrains JSON newline escaping missing')
assert(readFileSync(jetbrainsReadme, 'utf8').includes('prototype-only'), 'JetBrains prototype boundary missing')
const bridgeProtocolSource = readFileSync(bridgeSource, 'utf8')
for (const protocolMarker of [
  "'sessions.list'",
  "'sessions.create'",
  "'sessions.send'",
  "'documents.sync'",
  "'session.event'",
  "envelope.type === 'sessions.list'",
  "envelope.type === 'sessions.create'",
  "envelope.type === 'sessions.send'",
  "envelope.type === 'documents.sync'"
]) {
  assert(bridgeProtocolSource.includes(protocolMarker), `bridge protocol missing ${protocolMarker}`)
}
assert(bridgeProtocolSource.includes('syncDocument?(payload: IdeBridgeDocumentSyncPayload): void'), 'bridge session port must expose document sync hook')
assert(bridgeProtocolSource.includes('this.sessionPort.syncDocument?.(payload)'), 'bridge must forward passive documents.sync to document context')
assert(readFileSync(bridgeManagerSource, 'utf8').includes('syncIdeDocumentContext'), 'bridge manager must wire documents.sync into IDE document context')
const ideDocumentContextFile = readFileSync(ideDocumentContextSource, 'utf8')
assert(ideDocumentContextFile.includes('buildIdeDocumentContextPrompt'), 'IDE document context prompt builder missing')
assert(ideDocumentContextFile.includes('clearIdeDocumentContext'), 'IDE document context cleanup helper missing')
assert(readFileSync(agentSessionSource, 'utf8').includes('buildIdeDocumentContextPrompt(this.meta.id)'), 'Claude agent path must consume IDE document context')
assert(readFileSync(openAiEngineSource, 'utf8').includes('buildIdeDocumentContextPrompt(this.meta.id)'), 'OpenAI path must consume IDE document context')

const tempDir = path.join(os.tmpdir(), `caogen-ide-bridge-${process.pid}`)
mkdirSync(tempDir, { recursive: true })
const transpiled = ts.transpileModule(readFileSync(bridgeSource, 'utf8'), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
  }
}).outputText
const modulePath = path.join(tempDir, 'ide-bridge.mjs')
writeFileSync(modulePath, transpiled, 'utf8')
const contextTranspiled = ts.transpileModule(readFileSync(ideDocumentContextSource, 'utf8'), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove
  }
}).outputText
const contextModulePath = path.join(tempDir, 'ide-document-context.mjs')
writeFileSync(contextModulePath, contextTranspiled, 'utf8')

const { createIdeBridge } = await import(pathToFileUrl(modulePath))
const {
  buildIdeDocumentContextPrompt,
  clearIdeDocumentContext,
  listIdeDocumentContext,
  syncIdeDocumentContext
} = await import(pathToFileUrl(contextModulePath))

const events = new Set()
const created = []
const sent = []
const syncedDocuments = []
const bridge = createIdeBridge({
  host: '127.0.0.1',
  port: 0,
  token: 'smoke-token',
  sessionPort: {
    listSessions() {
      return created
    },
    createSession(options) {
      const meta = {
        id: `session-${created.length + 1}`,
        title: options.title ?? 'IDE Smoke',
        cwd: options.cwd,
        model: options.model ?? '',
        providerId: options.providerId ?? '',
        permissionMode: options.permissionMode ?? 'default',
        status: 'idle',
        costUsd: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        contextTokens: 0,
        createdAt: Date.now()
      }
      created.push(meta)
      return meta
    },
    sendMessage(sessionId, message) {
      sent.push({ sessionId, message })
    },
    syncDocument(payload) {
      syncedDocuments.push(payload)
      syncIdeDocumentContext(payload)
    },
    subscribeSessionEvents(listener) {
      events.add(listener)
      return () => events.delete(listener)
    }
  }
})

assert.equal(bridge.status().enabled, false, 'bridge must be disabled before explicit start')
const status = await bridge.start()
assert.equal(status.enabled, true, 'bridge should start explicitly')
assert(status.port > 0, 'ephemeral port should be assigned')

const badClient = await connectWebSocket(status.port)
await badClient.send({
  id: 'hello-bad',
  type: 'hello',
  payload: { protocol: 1, client: 'smoke', role: 'smoke', token: 'wrong-token' }
})
const badAuth = await badClient.read()
assert.equal(badAuth.type, 'error')
assert.equal(badAuth.payload.code, 'bad_token')
badClient.close()

const client = await connectWebSocket(status.port)
await client.send({
  id: 'hello-1',
  type: 'hello',
  payload: { protocol: 1, client: 'smoke', role: 'smoke', token: 'smoke-token' }
})
const helloOk = await client.read()
assert.equal(helloOk.type, 'hello.ok')
assert(helloOk.payload.capabilities.includes('documents.sync'), 'bridge must advertise passive document sync capability')

await client.send({ id: 'list-1', type: 'sessions.list' })
const emptyList = await client.read()
assert.equal(emptyList.type, 'sessions.list.result')
assert.equal(emptyList.payload.sessions.length, 0)

await client.send({
  id: 'create-1',
  type: 'sessions.create',
  payload: { cwd: root, title: 'Smoke Session', permissionMode: 'plan', initialText: 'hello from IDE' }
})
const createdResponse = await client.read()
assert.equal(createdResponse.type, 'sessions.create.result')
assert.equal(createdResponse.payload.title, 'Smoke Session')
assert.equal(sent.length, 1, 'initialText should be delivered through sendMessage')

await client.send({
  id: 'send-1',
  type: 'sessions.send',
  payload: { sessionId: createdResponse.payload.id, message: { text: 'follow-up' } }
})
assert.equal((await client.read()).type, 'sessions.send.result')
assert.equal(sent.length, 2)

await client.send({
  id: 'sync-1',
  type: 'documents.sync',
  payload: {
    sessionId: createdResponse.payload.id,
    snapshot: {
      kind: 'ide-sync-v1',
      source: 'smoke',
      uri: 'file:///tmp/smoke.ts',
      fsPath: '/tmp/smoke.ts',
      languageId: 'typescript',
      version: 1,
      lineCount: 1,
      selection: { start: 0, end: 15 },
      text: 'const ok = true',
      truncated: false,
      timestamp: new Date().toISOString()
    }
  }
})
const syncResponse = await client.read()
assert.equal(syncResponse.type, 'documents.sync.result')
assert.equal(syncResponse.payload.uri, 'file:///tmp/smoke.ts')
assert.equal(sent.length, 2, 'passive IDE document sync must not trigger a model turn')
assert.equal(syncedDocuments.length, 1, 'passive IDE document sync must reach document context hook')
assert.equal(listIdeDocumentContext(createdResponse.payload.id).length, 1, 'document context store must keep synced snapshot')
const ideContextPrompt = buildIdeDocumentContextPrompt(createdResponse.payload.id)
assert(ideContextPrompt.includes('## IDE 实时同步上下文'), 'document context prompt heading missing')
assert(ideContextPrompt.includes('const ok = true'), 'document context prompt must include synced text')
assert(ideContextPrompt.includes('选区: {"start":0,"end":15}'), 'document context prompt must preserve selection context')
clearIdeDocumentContext(createdResponse.payload.id)
assert.equal(listIdeDocumentContext(createdResponse.payload.id).length, 0, 'document context cleanup must clear session snapshots')

await client.send({
  id: 'sync-bad-kind',
  type: 'documents.sync',
  payload: {
    sessionId: createdResponse.payload.id,
    snapshot: { kind: 'wrong', source: 'smoke', uri: 'file:///tmp/smoke.ts', text: '' }
  }
})
const badSyncKind = await client.read()
assert.equal(badSyncKind.type, 'error')
assert.equal(badSyncKind.payload.code, 'handler_failed')

await client.send({
  id: 'sync-missing-uri',
  type: 'documents.sync',
  payload: {
    sessionId: createdResponse.payload.id,
    snapshot: { kind: 'ide-sync-v1', source: 'smoke', text: '' }
  }
})
const badSyncUri = await client.read()
assert.equal(badSyncUri.type, 'error')
assert.equal(badSyncUri.payload.code, 'handler_failed')
assert.equal(sent.length, 2, 'invalid passive IDE sync must not trigger a model turn')

for (const listener of events) {
  listener({ sessionId: createdResponse.payload.id, type: 'assistant.delta', text: 'event back to IDE' })
}
const eventResponse = await client.read()
assert.equal(eventResponse.type, 'session.event')
assert.equal(eventResponse.payload.sessionId, createdResponse.payload.id)
assert.equal(eventResponse.payload.text, 'event back to IDE')

client.close()
await bridge.stop()
assert.equal(bridge.status().enabled, false, 'bridge should stop cleanly')
rmSync(tempDir, { recursive: true, force: true })
console.log('ide-bridge-smoke: PASS')

function pathToFileUrl(filePath) {
  return `file:///${filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:')}`
}

function connectWebSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const key = randomBytes(16).toString('base64')
    let handshake = Buffer.alloc(0)
    const queued = []
    let frameBuffer = Buffer.alloc(0)

    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write([
        'GET /ide-bridge HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n'))
    })

    socket.on('data', (chunk) => {
      if (handshake !== null) {
        handshake = Buffer.concat([handshake, chunk])
        const split = handshake.indexOf('\r\n\r\n')
        if (split === -1) return
        const headers = handshake.subarray(0, split).toString('utf8')
        const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
        assert(headers.includes('101 Switching Protocols'), 'websocket upgrade failed')
        assert(headers.includes(expected), 'websocket accept key mismatch')
        frameBuffer = handshake.subarray(split + 4)
        handshake = null
        resolve(makeClient(socket, queued, () => frameBuffer, (next) => { frameBuffer = next }))
        return
      }
      frameBuffer = Buffer.concat([frameBuffer, chunk])
      const waiter = queued.shift()
      if (waiter) waiter()
    })
  })
}

function makeClient(socket, queued, getBuffer, setBuffer) {
  return {
    send(message) {
      socket.write(encodeClientFrame(Buffer.from(JSON.stringify(message), 'utf8')))
    },
    read() {
      return new Promise((resolve) => {
        const tryRead = () => {
          const parsed = readServerFrame(getBuffer())
          if (!parsed) {
            queued.push(tryRead)
            return
          }
          setBuffer(parsed.rest)
          resolve(JSON.parse(parsed.text))
        }
        tryRead()
      })
    },
    close() {
      socket.destroy()
    }
  }
}

function encodeClientFrame(payload) {
  const mask = randomBytes(4)
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.alloc(4)
  if (payload.length >= 126) {
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  }
  const body = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) body[index] = payload[index] ^ mask[index % 4]
  return Buffer.concat([header, mask, body])
}

function readServerFrame(buffer) {
  if (buffer.length < 2) return null
  const length = buffer[1] & 0x7f
  let cursor = 2
  let size = length
  if (length === 126) {
    if (buffer.length < 4) return null
    size = buffer.readUInt16BE(2)
    cursor = 4
  }
  if (buffer.length < cursor + size) return null
  return {
    text: buffer.subarray(cursor, cursor + size).toString('utf8'),
    rest: buffer.subarray(cursor + size)
  }
}
