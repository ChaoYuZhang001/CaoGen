#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-webdav-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-profile-webdav', runId)
const checks = []
const providerCanary = ['webdav', 'provider', 'secret', 'canary'].join('-')
const passwordCanary = ['webdav', 'password', 'secret', 'canary'].join('-')
const username = 'webdav-user'
const server = createWebDavServer(username, passwordCanary)

try {
  compile(outDir)
  installElectronStub(outDir, userDataDir)
  const address = await server.listen()
  const sync = await import(pathToFileURL(findCompiled(outDir, 'providerProfileWebDavSync.js')).href)
  const providers = await import(pathToFileURL(findCompiled(outDir, 'providers.js')).href)
  const alpha = providers.createProvider({
    name: 'WebDAV Alpha', baseUrl: 'https://provider.example/v1', engine: 'openai',
    openaiProtocol: 'chat', models: ['alpha-1'], token: providerCanary
  })

  const saved = sync.saveProviderProfileWebDavConfig({
    baseUrl: `${address}/dav`, username, password: passwordCanary, remotePath: 'caogen-sync/default',
    autoSyncEnabled: false, autoPullEnabled: false, autoSyncIntervalMinutes: 15
  })
  assert(saved.configured && saved.passwordConfigured, 'WebDAV configuration must report an encrypted password')
  equal(saved.endpointLabel, new URL(address).host, 'config view exposes only the endpoint label')
  const configPath = path.join(userDataDir, 'provider-profile-webdav', 'config.json')
  const configRaw = readFileSync(configPath, 'utf8')
  assert(!configRaw.includes(passwordCanary), 'WebDAV config must not contain the plaintext password')
  assert(!configRaw.includes(providerCanary), 'WebDAV config must not contain Provider credentials')

  const connection = await sync.testProviderProfileWebDavConnection()
  assert(connection.ok, 'PROPFIND and MKCOL connection test must pass')
  let preview = await sync.previewProviderProfileWebDavSync()
  equal(preview.status.relation, 'remote_missing', 'empty WebDAV starts remote_missing')
  const first = await sync.publishProviderProfileWebDavSync(preview.previewId, false)
  equal(first.status.relation, 'in_sync', 'first WebDAV publish converges')
  assert(server.currentRaw() && !server.currentRaw().includes(providerCanary), 'remote envelope excludes Provider API keys')
  assert(!server.currentRaw().includes(passwordCanary), 'remote envelope excludes WebDAV credentials')
  equal(server.historyCount(), 1, 'first publish creates an immutable history revision')

  providers.updateProvider(alpha.id, { models: ['alpha-2'] })
  preview = await sync.previewProviderProfileWebDavSync()
  equal(preview.status.relation, 'local_ahead', 'local edit is local_ahead')
  await sync.publishProviderProfileWebDavSync(preview.previewId, false)
  equal(server.historyCount(), 2, 'second publish appends history')
  assert(server.requests().some((item) => item.method === 'PUT' && item.ifMatch), 'remote overwrite uses If-Match ETag CAS')

  server.mutateCurrentModel('alpha-remote')
  preview = await sync.previewProviderProfileWebDavSync()
  equal(preview.status.relation, 'remote_ahead', 'remote-only edit is remote_ahead')
  const remoteItem = preview.importPreview.items[0]
  const pulled = await sync.applyProviderProfileWebDavSync(preview.previewId, [{ itemId: remoteItem.id, action: 'update' }])
  equal(pulled.status.relation, 'in_sync', 'remote pull converges')
  equal(providers.listProviders()[0].models[0], 'alpha-remote', 'remote Provider model is applied')

  providers.updateProvider(alpha.id, { models: ['alpha-local-diverged'] })
  server.mutateCurrentModel('alpha-remote-diverged')
  preview = await sync.previewProviderProfileWebDavSync()
  assert(preview.requiresConflictChoice, 'independent edits require explicit conflict direction')
  await assertRejects(
    () => sync.publishProviderProfileWebDavSync(preview.previewId, false),
    /unmerged|remote/i,
    'diverged publish is rejected without explicit local choice'
  )
  const resolved = await sync.publishProviderProfileWebDavSync(preview.previewId, true)
  equal(resolved.status.relation, 'in_sync', 'explicit local choice resolves divergence')

  providers.updateProvider(alpha.id, { models: ['alpha-stale-local'] })
  preview = await sync.previewProviderProfileWebDavSync()
  server.mutateCurrentModel('alpha-stale-remote')
  await assertRejects(
    () => sync.publishProviderProfileWebDavSync(preview.previewId, true),
    /changed after preview/i,
    'remote change after preview is rejected'
  )

  server.mutateCurrentModel('alpha-etag-base')
  providers.updateProvider(alpha.id, { models: ['alpha-etag-base'] })
  preview = await sync.previewProviderProfileWebDavSync()
  server.setOmitEtag(true)
  providers.updateProvider(alpha.id, { models: ['alpha-no-etag-local'] })
  preview = await sync.previewProviderProfileWebDavSync()
  await assertRejects(
    () => sync.publishProviderProfileWebDavSync(preview.previewId, false),
    /ETag/i,
    'overwrite is refused when the WebDAV server omits ETag'
  )
  server.setOmitEtag(false)

  server.mutateCurrentModel('alpha-auto-base')
  providers.updateProvider(alpha.id, { models: ['alpha-auto-base'] })
  preview = await sync.previewProviderProfileWebDavSync()
  const alignItem = preview.importPreview?.items[0]
  if (alignItem) await sync.applyProviderProfileWebDavSync(preview.previewId, [{ itemId: alignItem.id, action: alignItem.defaultAction }])
  sync.saveProviderProfileWebDavConfig({
    baseUrl: `${address}/dav`, username, remotePath: 'caogen-sync/default',
    autoSyncEnabled: true, autoPullEnabled: true, autoSyncIntervalMinutes: 5
  })
  providers.updateProvider(alpha.id, { models: ['alpha-auto-local'] })
  equal(await sync.runProviderProfileWebDavAutoSync(Date.now() + 10 * 60_000), 'synced', 'auto-sync safely publishes local_ahead')
  equal(readRemoteModel(server.currentRaw()), 'alpha-auto-local', 'auto-sync published the local model')

  server.mutateCurrentModel('alpha-auto-remote')
  equal(await sync.runProviderProfileWebDavAutoSync(Date.now() + 20 * 60_000), 'synced', 'auto-pull safely applies remote_ahead')
  equal(providers.listProviders()[0].models[0], 'alpha-auto-remote', 'auto-pull applied the remote model')

  providers.updateProvider(alpha.id, { models: ['alpha-auto-diverged-local'] })
  server.mutateCurrentModel('alpha-auto-diverged-remote')
  const beforeAttention = server.currentRaw()
  equal(await sync.runProviderProfileWebDavAutoSync(Date.now() + 30 * 60_000), 'attention', 'auto-sync stops on divergence')
  equal(server.currentRaw(), beforeAttention, 'auto-sync never overwrites a diverged remote')

  const history = await sync.listProviderProfileWebDavHistory()
  assert(history.length >= 2 && history.length <= 20, 'WebDAV history lists a bounded set of immutable revisions')
  const historyPreview = await sync.previewProviderProfileWebDavHistory(history.at(-1).revisionId)
  assert(historyPreview.importPreview.items.length > 0, 'WebDAV history revision opens a Provider import preview')
  const restoredHistory = await sync.applyProviderProfileWebDavHistory(historyPreview.previewId, historyPreview.importPreview.items.map((item) => ({
    itemId: item.id, action: item.defaultAction
  })))
  assert(restoredHistory.updated + restoredHistory.created > 0, 'WebDAV history revision can be restored through the Profile apply boundary')

  const remoteBeforeRemoval = server.currentRaw()
  const removed = sync.removeProviderProfileWebDavConfig()
  assert(!removed.configured && !existsSync(configPath), 'removing WebDAV clears only the local connection')
  equal(server.currentRaw(), remoteBeforeRemoval, 'removing the connection leaves remote data untouched')

  sync.saveProviderProfileWebDavConfig({
    baseUrl: 'http://example.com/dav', username: '', password: '', remotePath: 'caogen-sync',
    autoSyncEnabled: false, autoPullEnabled: false, autoSyncIntervalMinutes: 15
  })
  await assertRejects(
    () => sync.testProviderProfileWebDavConnection(),
    /HTTPS|rejected/i,
    'public HTTP WebDAV endpoints are rejected before network access'
  )

  assert(!JSON.stringify(checks).includes(providerCanary), 'evidence excludes Provider credential canary')
  assert(!JSON.stringify(checks).includes(passwordCanary), 'evidence excludes WebDAV password canary')
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(), status: 'passed', pass: checks.length, total: checks.length, checks
  }, null, 2)}\n`)
  console.log(`provider profile WebDAV smoke ok: ${reportDir}`)
  console.log(`${checks.length}/${checks.length} checks passed`)
} finally {
  await server.close()
  rmSync(tempRoot, { recursive: true, force: true })
}

function createWebDavServer(expectedUser, expectedPassword) {
  const files = new Map()
  const directories = new Set(['/dav/'])
  const requestLog = []
  const state = { files, directories, requestLog, omitEtag: false, expectedUser, expectedPassword }
  let instance
  const httpServer = createServer((request, response) => {
    void handleWebDavRequest(state, request, response).catch(() => { response.writeHead(500); response.end() })
  })
  return {
    listen: () => new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address(); instance = `http://127.0.0.1:${address.port}`; resolve(instance)
    })),
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
    currentRaw: () => files.get('/dav/caogen-sync/default/provider-profile/v1/current.json')?.raw ?? '',
    historyCount: () => [...files.keys()].filter((key) => key.includes('/history/')).length,
    requests: () => requestLog,
    setOmitEtag: (value) => { state.omitEtag = value },
    mutateCurrentModel(model) {
      const key = '/dav/caogen-sync/default/provider-profile/v1/current.json'
      const current = files.get(key)
      if (!current) throw new Error('current WebDAV envelope missing')
      const envelope = JSON.parse(current.raw)
      envelope.profile.providers[0].models = [model]
      envelope.profileDigest = digest(envelope.profile)
      envelope.parentRevisionId = envelope.revisionId
      envelope.revisionId = `remote-${Date.now()}-${Math.random().toString(16).slice(2)}`
      envelope.deviceId = 'remote-device'
      envelope.createdAt = new Date().toISOString()
      const { payloadDigest: _old, ...payload } = envelope
      envelope.payloadDigest = digest(payload)
      const raw = `${JSON.stringify(envelope, null, 2)}\n`
      files.set(key, { raw, etag: etag(raw) })
    }
  }
}

async function handleWebDavRequest(state, request, response) {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname
  if (!validBasicAuth(state, request.headers.authorization)) { response.writeHead(401); response.end(); return }
  const method = request.method ?? 'GET'
  state.requestLog.push({ method, path: pathname, ifMatch: request.headers['if-match'], ifNoneMatch: request.headers['if-none-match'] })
  if (method === 'PROPFIND') return handlePropfind(state, pathname, request.headers.depth, response)
  if (method === 'MKCOL') return handleMkcol(state, pathname, response)
  if (method === 'GET') return handleGet(state, pathname, response)
  if (method === 'PUT') return handlePut(state, pathname, request, response)
  response.writeHead(405); response.end()
}

function validBasicAuth(state, authorization) {
  return authorization === `Basic ${Buffer.from(`${state.expectedUser}:${state.expectedPassword}`).toString('base64')}`
}

function handlePropfind(state, pathname, depth, response) {
  if (!state.directories.has(withSlash(pathname))) { response.writeHead(404); response.end(); return }
  if (String(depth) !== '1') { response.writeHead(207); response.end(); return }
  const prefix = withSlash(pathname)
  const hrefs = [...state.files.keys()].filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
  const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${[prefix, ...hrefs].map((href) => `<d:response><d:href>${href}</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`
  response.writeHead(207, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) }); response.end(body)
}

function handleMkcol(state, pathname, response) {
  const target = withSlash(pathname)
  if (state.directories.has(target)) { response.writeHead(405); response.end(); return }
  state.directories.add(target); response.writeHead(201); response.end()
}

function handleGet(state, pathname, response) {
  const file = state.files.get(pathname)
  if (!file) { response.writeHead(404); response.end(); return }
  response.writeHead(200, {
    'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(file.raw),
    ...(state.omitEtag ? {} : { ETag: file.etag })
  })
  response.end(file.raw)
}

async function handlePut(state, pathname, request, response) {
  const raw = await readBody(request)
  const previous = state.files.get(pathname)
  if (request.headers['if-none-match'] === '*' && previous) { response.writeHead(412); response.end(); return }
  if (request.headers['if-match'] && request.headers['if-match'] !== previous?.etag) { response.writeHead(412); response.end(); return }
  state.files.set(pathname, { raw, etag: etag(raw) })
  response.writeHead(previous ? 204 : 201); response.end()
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    request.on('data', (chunk) => { size += chunk.length; if (size > 5 * 1024 * 1024) reject(new Error('request too large')); else chunks.push(chunk) })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function withSlash(value) { return value.endsWith('/') ? value : `${value}/` }
function etag(raw) { return `"${createHash('sha256').update(raw).digest('hex')}"` }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function readRemoteModel(raw) { return JSON.parse(raw).profile.providers[0].models[0] }

function compile(outDirPath) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerProfileWebDavSync.ts', '--outDir', outDirPath,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(compiledRoot, dataRoot) {
  const electronRoot = path.join(compiledRoot, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true }); mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0-webdav-smoke', main: 'index.js' }))
  writeFileSync(path.join(electronRoot, 'index.js'), `'use strict'\nmodule.exports = { app: { getPath(name) { if (name !== 'userData') throw new Error('unsupported path'); return ${JSON.stringify(dataRoot)} } }, safeStorage: { isEncryptionAvailable() { return true }, encryptString(value) { return Buffer.from('protected:' + value, 'utf8') }, decryptString(value) { const raw = Buffer.from(value).toString('utf8'); return raw.slice('protected:'.length) }, getSelectedStorageBackend() { return 'keychain' } } }\n`)
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) { try { return findCompiled(full, fileName) } catch { /* continue */ } }
    else if (entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function assert(condition, message) { if (!condition) throw new Error(message); checks.push(message) }
function equal(actual, expected, message) { assert(Object.is(actual, expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`) }
async function assertRejects(action, pattern, message) {
  let error; try { await action() } catch (caught) { error = caught }
  assert(error instanceof Error && pattern.test(error.message), message)
}
