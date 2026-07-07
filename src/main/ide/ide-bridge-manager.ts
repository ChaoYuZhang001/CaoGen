import { getSettings } from '../settings'
import { sessionManager } from '../sessionManager'
import { createIdeBridge, type IdeBridgeServer, type IdeBridgeStatus } from './ide-bridge'
import { syncIdeDocumentContext } from './ide-document-context'
import type { AppSettings, SessionEventPayload } from '../../shared/types'

interface BridgeRuntimeConfig {
  enabled: boolean
  host: string
  port: number
  token: string
}

let bridge: IdeBridgeServer | null = null
let activeConfig: BridgeRuntimeConfig | null = null

export function ideBridgeStatus(): IdeBridgeStatus {
  if (bridge) return bridge.status()
  const config = configFromSettings(getSettings())
  return {
    enabled: false,
    host: config.host,
    port: 0,
    connections: 0
  }
}

export async function syncIdeBridgeFromSettings(): Promise<IdeBridgeStatus> {
  const config = configFromSettings(getSettings())
  if (!config.enabled) {
    await stopIdeBridge()
    activeConfig = config
    return ideBridgeStatus()
  }

  if (bridge && activeConfig && sameConfig(activeConfig, config)) return bridge.status()

  await stopIdeBridge()
  bridge = createIdeBridge({
    host: config.host,
    port: config.port,
    token: config.token,
    sessionPort: {
      listSessions: () => sessionManager.list(),
      createSession: (options) => sessionManager.create(options),
      sendMessage: (sessionId, message) => {
        sessionManager.send(sessionId, message)
      },
      syncDocument: (payload) => syncIdeDocumentContext(payload),
      subscribeSessionEvents: (listener: (event: SessionEventPayload) => void) =>
        sessionManager.subscribe(listener)
    }
  })
  const status = await bridge.start()
  activeConfig = config
  return status
}

export async function stopIdeBridge(): Promise<void> {
  const current = bridge
  bridge = null
  if (current) await current.stop()
}

function configFromSettings(settings: AppSettings): BridgeRuntimeConfig {
  return {
    enabled: settings.ideBridgeEnabled === true,
    host: normalizeHost(settings.ideBridgeHost),
    port: normalizePort(settings.ideBridgePort),
    token: typeof settings.ideBridgeToken === 'string' ? settings.ideBridgeToken.trim() : ''
  }
}

function normalizeHost(value: string): string {
  const host = typeof value === 'string' ? value.trim() : ''
  return host || '127.0.0.1'
}

function normalizePort(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65535) return 17365
  return value
}

function sameConfig(left: BridgeRuntimeConfig, right: BridgeRuntimeConfig): boolean {
  return left.enabled === right.enabled && left.host === right.host && left.port === right.port && left.token === right.token
}
