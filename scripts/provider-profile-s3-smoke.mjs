#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
process.env.NODE_PATH = [path.join(repoRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
require('node:module').Module._initPaths()

const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-provider-s3-'))
const outDir = path.join(tempRoot, 'compiled')
const userDataDir = path.join(tempRoot, 'user-data')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(repoRoot, 'test-results', 'provider-profile-s3', runId)
const checks = []
const providerCanary = ['s3', 'provider', 'secret', 'canary'].join('-')
const accessKeyCanary = ['S3', 'ACCESS', 'CANARY'].join('-')
const secretKeyCanary = ['s3', 'secret', 'key', 'canary'].join('-')
const sessionTokenCanary = ['s3', 'session', 'token', 'canary'].join('-')
const server = createS3Server(accessKeyCanary, sessionTokenCanary)

try {
  compile(outDir)
  installElectronStub(outDir, userDataDir)
  const endpoint = await server.listen()
  const sync = await import(pathToFileURL(findCompiled(outDir, 'providerProfileS3Sync.js')).href)
  const providers = await import(pathToFileURL(findCompiled(outDir, 'providers.js')).href)
  const alpha = providers.createProvider({
    name: 'S3 Alpha', baseUrl: 'https://provider.example/v1', engine: 'openai',
    openaiProtocol: 'chat', models: ['alpha-1'], token: providerCanary
  })

  const saved = sync.saveProviderProfileS3Config({
    endpoint, region: 'us-east-1', bucket: 'caogen-sync-test', prefix: 'profiles/default',
    forcePathStyle: true, accessKeyId: accessKeyCanary, secretAccessKey: secretKeyCanary,
    sessionToken: sessionTokenCanary, autoSyncEnabled: false, autoPullEnabled: false, autoSyncIntervalMinutes: 15
  })
  assert(saved.configured && saved.credentialsConfigured && saved.sessionTokenConfigured, 'S3 configuration reports encrypted credentials')
  assert(saved.accessKeyLabel.endsWith(accessKeyCanary.slice(-4)), 'S3 config returns only a masked Access Key label')
  const configPath = path.join(userDataDir, 'provider-profile-s3', 'config.json')
  const configRaw = readFileSync(configPath, 'utf8')
  assert(!configRaw.includes(accessKeyCanary) && !configRaw.includes(secretKeyCanary) && !configRaw.includes(sessionTokenCanary), 'S3 config excludes plaintext credentials')
  assert(!configRaw.includes(providerCanary), 'S3 config excludes Provider credentials')

  const connection = await sync.testProviderProfileS3Connection()
  assert(connection.ok, 'signed S3 connection test passes when current object is absent')
  assert(server.requests().some((item) => item.method === 'HEAD' && item.authorization.includes(`Credential=${accessKeyCanary}/`)), 'S3 requests use AWS SigV4 Access Key identity')
  assert(server.requests().some((item) => item.sessionToken === sessionTokenCanary), 'S3 requests carry the configured temporary session token')

  let preview = await sync.previewProviderProfileS3Sync()
  equal(preview.status.relation, 'remote_missing', 'empty S3 prefix starts remote_missing')
  const first = await sync.publishProviderProfileS3Sync(preview.previewId, false)
  equal(first.status.relation, 'in_sync', 'first S3 publish converges')
  assert(server.currentRaw() && !server.currentRaw().includes(providerCanary), 'S3 envelope excludes Provider API keys')
  assert(!server.currentRaw().includes(secretKeyCanary), 'S3 envelope excludes S3 credentials')
  equal(server.historyCount(), 1, 'first S3 publish creates immutable history')

  providers.updateProvider(alpha.id, { models: ['alpha-2'] })
  preview = await sync.previewProviderProfileS3Sync()
  equal(preview.status.relation, 'local_ahead', 'local edit is local_ahead')
  await sync.publishProviderProfileS3Sync(preview.previewId, false)
  equal(server.historyCount(), 2, 'second S3 publish appends history')
  assert(server.requests().some((item) => item.method === 'PUT' && item.ifMatch), 'S3 overwrite uses If-Match ETag CAS')

  server.mutateCurrentModel('alpha-remote')
  preview = await sync.previewProviderProfileS3Sync()
  equal(preview.status.relation, 'remote_ahead', 'remote-only S3 edit is remote_ahead')
  const remoteItem = preview.importPreview.items[0]
  const pulled = await sync.applyProviderProfileS3Sync(preview.previewId, [{ itemId: remoteItem.id, action: 'update' }])
  equal(pulled.status.relation, 'in_sync', 'S3 pull converges')
  equal(providers.listProviders()[0].models[0], 'alpha-remote', 'S3 remote Provider model is applied')

  providers.updateProvider(alpha.id, { models: ['alpha-local-diverged'] })
  server.mutateCurrentModel('alpha-remote-diverged')
  preview = await sync.previewProviderProfileS3Sync()
  assert(preview.requiresConflictChoice, 'independent S3 edits require explicit direction')
  await assertRejects(
    () => sync.publishProviderProfileS3Sync(preview.previewId, false),
    /unmerged|remote/i,
    'diverged S3 publish is rejected without explicit local choice'
  )
  equal((await sync.publishProviderProfileS3Sync(preview.previewId, true)).status.relation, 'in_sync', 'explicit local choice resolves S3 divergence')

  providers.updateProvider(alpha.id, { models: ['alpha-stale-local'] })
  preview = await sync.previewProviderProfileS3Sync()
  server.mutateCurrentModel('alpha-stale-remote')
  await assertRejects(
    () => sync.publishProviderProfileS3Sync(preview.previewId, true),
    /changed after preview/i,
    'S3 remote change after preview is rejected'
  )

  server.mutateCurrentModel('alpha-auto-base')
  providers.updateProvider(alpha.id, { models: ['alpha-auto-base'] })
  preview = await sync.previewProviderProfileS3Sync()
  const alignItem = preview.importPreview?.items[0]
  if (alignItem) await sync.applyProviderProfileS3Sync(preview.previewId, [{ itemId: alignItem.id, action: alignItem.defaultAction }])
  sync.saveProviderProfileS3Config({
    endpoint, region: 'us-east-1', bucket: 'caogen-sync-test', prefix: 'profiles/default',
    forcePathStyle: true, autoSyncEnabled: true, autoPullEnabled: true, autoSyncIntervalMinutes: 5
  })
  providers.updateProvider(alpha.id, { models: ['alpha-auto-local'] })
  equal(await sync.runProviderProfileS3AutoSync(Date.now() + 10 * 60_000), 'synced', 'S3 auto-sync safely publishes local_ahead')
  equal(readRemoteModel(server.currentRaw()), 'alpha-auto-local', 'S3 auto-sync published the local model')

  server.mutateCurrentModel('alpha-auto-remote')
  equal(await sync.runProviderProfileS3AutoSync(Date.now() + 20 * 60_000), 'synced', 'S3 auto-pull safely applies remote_ahead')
  equal(providers.listProviders()[0].models[0], 'alpha-auto-remote', 'S3 auto-pull applied the remote model')

  providers.updateProvider(alpha.id, { models: ['alpha-auto-diverged-local'] })
  server.mutateCurrentModel('alpha-auto-diverged-remote')
  const beforeAttention = server.currentRaw()
  equal(await sync.runProviderProfileS3AutoSync(Date.now() + 30 * 60_000), 'attention', 'S3 auto-sync stops on divergence')
  equal(server.currentRaw(), beforeAttention, 'S3 auto-sync never overwrites a diverged remote')

  const history = await sync.listProviderProfileS3History()
  assert(history.length >= 2 && history.length <= 20, 'S3 history lists a bounded set of immutable revisions')
  const historyPreview = await sync.previewProviderProfileS3History(history.at(-1).revisionId)
  assert(historyPreview.importPreview.items.length > 0, 'S3 history revision opens a Provider import preview')
  const restoredHistory = await sync.applyProviderProfileS3History(historyPreview.previewId, historyPreview.importPreview.items.map((item) => ({
    itemId: item.id, action: item.defaultAction
  })))
  assert(restoredHistory.updated + restoredHistory.created > 0, 'S3 history revision can be restored through the Profile apply boundary')

  const remoteBeforeRemoval = server.currentRaw()
  const removed = sync.removeProviderProfileS3Config()
  assert(!removed.configured && !existsSync(configPath), 'removing S3 clears only the local connection')
  equal(server.currentRaw(), remoteBeforeRemoval, 'removing S3 leaves remote objects unchanged')

  assertRejectsSync(() => sync.saveProviderProfileS3Config({
    endpoint: 'http://example.com', region: 'us-east-1', bucket: 'example', prefix: 'caogen-sync',
    forcePathStyle: true, accessKeyId: accessKeyCanary, secretAccessKey: secretKeyCanary,
    autoSyncEnabled: false, autoPullEnabled: false, autoSyncIntervalMinutes: 15
  }), /HTTPS/i, 'public HTTP S3 endpoints are rejected before network access')

  assert(!JSON.stringify(checks).includes(providerCanary), 'S3 evidence excludes Provider credential canary')
  assert(!JSON.stringify(checks).includes(secretKeyCanary), 'S3 evidence excludes secret credential canary')
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(), status: 'passed', pass: checks.length, total: checks.length, checks
  }, null, 2)}\n`)
  console.log(`provider profile S3 smoke ok: ${reportDir}`)
  console.log(`${checks.length}/${checks.length} checks passed`)
} finally {
  await server.close()
  rmSync(tempRoot, { recursive: true, force: true })
}

function createS3Server(expectedAccessKey, expectedSessionToken) {
  const files = new Map()
  const requestLog = []
  let instance
  const httpServer = createServer((request, response) => {
    void handleS3Request({ files, requestLog, expectedAccessKey, expectedSessionToken }, request, response)
      .catch(() => { response.writeHead(500); response.end() })
  })
  const currentKey = '/caogen-sync-test/profiles/default/provider-profile/v1/current.json'
  return {
    listen: () => new Promise((resolve) => httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address(); instance = `http://127.0.0.1:${address.port}`; resolve(instance)
    })),
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
    currentRaw: () => files.get(currentKey)?.raw ?? '',
    historyCount: () => [...files.keys()].filter((key) => key.includes('/history/')).length,
    requests: () => requestLog,
    mutateCurrentModel(model) {
      const current = files.get(currentKey)
      if (!current) throw new Error('current S3 envelope missing')
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
      files.set(currentKey, { raw, etag: etag(raw) })
    }
  }
}

async function handleS3Request(state, request, response) {
  const url = new URL(request.url, 'http://127.0.0.1')
  const pathname = url.pathname
  const authorization = String(request.headers.authorization ?? '')
  const sessionToken = String(request.headers['x-amz-security-token'] ?? '')
  state.requestLog.push({
    method: request.method ?? 'GET', path: pathname, authorization, sessionToken,
    ifMatch: request.headers['if-match'], ifNoneMatch: request.headers['if-none-match']
  })
  if (!authorization.includes(`Credential=${state.expectedAccessKey}/`) || sessionToken !== state.expectedSessionToken) {
    return xmlError(response, 403, 'SignatureDoesNotMatch')
  }
  if (request.method === 'HEAD') return headObject(state, pathname, response)
  if (request.method === 'GET' && url.searchParams.get('list-type') === '2') return listObjects(state, url, response)
  if (request.method === 'GET') return getObject(state, pathname, response)
  if (request.method === 'PUT') return putObject(state, pathname, request, response)
  return xmlError(response, 405, 'MethodNotAllowed')
}

function listObjects(state, url, response) {
  const prefix = url.searchParams.get('prefix') ?? ''
  const bucketPrefix = '/caogen-sync-test/'
  const objects = [...state.files.entries()]
    .filter(([pathname]) => pathname.startsWith(bucketPrefix) && pathname.slice(bucketPrefix.length).startsWith(prefix))
  const contents = objects.map(([pathname, file]) => {
    const key = pathname.slice(bucketPrefix.length)
    return `<Contents><Key>${xmlEscape(key)}</Key><LastModified>${new Date().toISOString()}</LastModified><ETag>${xmlEscape(file.etag)}</ETag><Size>${Buffer.byteLength(file.raw)}</Size><StorageClass>STANDARD</StorageClass></Contents>`
  }).join('')
  const body = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>caogen-sync-test</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${objects.length}</KeyCount><MaxKeys>50</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
  response.writeHead(200, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) }); response.end(body)
}

function headObject(state, pathname, response) {
  const file = state.files.get(pathname)
  if (!file) { response.writeHead(404); response.end(); return }
  response.writeHead(200, { ETag: file.etag, 'Content-Length': Buffer.byteLength(file.raw) }); response.end()
}

function getObject(state, pathname, response) {
  const file = state.files.get(pathname)
  if (!file) return xmlError(response, 404, 'NoSuchKey')
  response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(file.raw), ETag: file.etag })
  response.end(file.raw)
}

async function putObject(state, pathname, request, response) {
  const raw = await readBody(request)
  const previous = state.files.get(pathname)
  if (request.headers['if-none-match'] === '*' && previous) return xmlError(response, 412, 'PreconditionFailed')
  if (request.headers['if-match'] && request.headers['if-match'] !== previous?.etag) return xmlError(response, 412, 'PreconditionFailed')
  state.files.set(pathname, { raw, etag: etag(raw) })
  response.writeHead(200, { ETag: etag(raw) }); response.end()
}

function xmlError(response, status, code) {
  const body = `<Error><Code>${code}</Code><Message>${code}</Message><RequestId>local</RequestId></Error>`
  response.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) }); response.end(body)
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    request.on('data', (chunk) => { size += chunk.length; if (size > 5 * 1024 * 1024) reject(new Error('request too large')); else chunks.push(chunk) })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function etag(raw) { return `"${createHash('sha256').update(raw).digest('hex')}"` }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function readRemoteModel(raw) { return JSON.parse(raw).profile.providers[0].models[0] }

function compile(outDirPath) {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/provider/providerProfileS3Sync.ts', '--outDir', outDirPath,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function installElectronStub(compiledRoot, dataRoot) {
  const electronRoot = path.join(compiledRoot, 'node_modules', 'electron')
  mkdirSync(electronRoot, { recursive: true }); mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path.join(electronRoot, 'package.json'), JSON.stringify({ name: 'electron', version: '0.0.0-s3-smoke', main: 'index.js' }))
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
function assertRejectsSync(action, pattern, message) {
  let error; try { action() } catch (caught) { error = caught }
  assert(error instanceof Error && pattern.test(error.message), message)
}
