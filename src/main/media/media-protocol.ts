import { app, net, protocol } from 'electron'
import { lstat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { getPersistedArtifactLifecycle } from '../task/artifact-lifecycle-api'
import { artifactBlobPath } from '../task/artifact-lifecycle-content'

export const MEDIA_SCHEME = 'caogen-media'
let privilegesRegistered = false
let handlerRegistered = false

export function registerMediaProtocolPrivileges(): void {
  if (privilegesRegistered || app.isReady()) return
  protocol.registerSchemesAsPrivileged([{
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }])
  privilegesRegistered = true
}

export function registerMediaProtocol(): void {
  if (handlerRegistered) return
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'artifact') return new Response('Not found', { status: 404 })
      const artifactId = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!artifactId || artifactId.length > 256) return new Response('Bad request', { status: 400 })
      const rootDir = app.getPath('userData')
      const lifecycle = await getPersistedArtifactLifecycle(artifactId, rootDir)
      if (!lifecycle || lifecycle.kind !== 'custom') return new Response('Not found', { status: 404 })
      const filePath = lifecycle.storageKind === 'source_ref'
        ? lifecycle.sourceRef
        : lifecycle.blobRef ? artifactBlobPath(rootDir, lifecycle.digest) : undefined
      if (!filePath) return new Response('Not found', { status: 404 })
      const state = await lstat(filePath)
      if (!state.isFile() || state.isSymbolicLink() || state.size !== lifecycle.sizeBytes) {
        return new Response('Unavailable', { status: 409 })
      }
      const headers = new Headers(request.headers)
      headers.set('Cache-Control', 'private, no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      return net.fetch(pathToFileURL(filePath).toString(), { method: request.method, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  handlerRegistered = true
}
