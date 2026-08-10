const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { app, BrowserWindow, clipboard, ipcMain } = require('electron')

const repoRoot = path.resolve(__dirname, '..')
const userDataDir = requiredEnv('CAOGEN_PROVIDER_GATEWAY_USER_DATA')
const statePath = requiredEnv('CAOGEN_PROVIDER_GATEWAY_RESTART_STATE')
const expectedDigest = requiredEnv('CAOGEN_PROVIDER_GATEWAY_TOKEN_DIGEST')
process.env.CAOGEN_USER_DATA_DIR = userDataDir
const checks = []

async function run() {
  require(path.join(repoRoot, 'out', 'main', 'index.js'))
  await waitFor(() => ipcMain._invokeHandlers?.has('providers:gateway:status'), 12_000)
  const status = await waitFor(async () => {
    const current = await invoke('providers:gateway:status')
    return current.state === 'running' ? current : undefined
  }, 12_000)
  check('enabled gateway restarts on the persisted exact port', status.enabled && status.state === 'running')
  await invoke('providers:gateway:copy-token')
  const token = clipboard.readText()
  check('gateway token survives restart without rotation', crypto.createHash('sha256').update(token).digest('hex') === expectedDigest)
  const models = await requestJson(status.port, '/v1/models', token)
  check('restarted OpenAI catalog authenticates and restores only OpenAI routes',
    models.status === 200 && models.body.data.length === 3)

  const storeFile = path.join(userDataDir, 'private', 'provider-gateway.json')
  const rawStore = fs.readFileSync(storeFile, 'utf8')
  const store = JSON.parse(rawStore)
  check('persisted gateway credential is encrypted and never plaintext', store.credential.encryptedToken.startsWith('enc:')
    && !rawStore.includes(token) && store.enabled === true && store.port === status.port)

  const stopped = await invoke('providers:gateway:update', { enabled: false })
  check('gateway can be stopped after automatic restart', stopped.state === 'stopped' && stopped.enabled === false)
  fs.writeFileSync(statePath, `${JSON.stringify({ ok: true, pass: checks.length, total: checks.length, checks }, null, 2)}\n`)
  app.exit(0)
}

async function invoke(channel, ...args) {
  const handler = ipcMain._invokeHandlers?.get(channel)
  if (!handler) throw new Error(`IPC channel not registered: ${channel}`)
  const win = await waitForWindow()
  return handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args)
}
function waitForWindow() { return waitFor(() => BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()), 10_000) }
function requestJson(port, route, token) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, headers: { authorization: `Bearer ${token}` } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    request.on('error', reject)
    request.end()
  })
}
function waitFor(predicate, timeout) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try { const value = await predicate(); if (value) return resolve(value) } catch { /* startup race */ }
      if (Date.now() - started > timeout) return reject(new Error('provider gateway restart wait timed out'))
      setTimeout(() => void poll(), 50)
    }
    void poll()
  })
}
function check(name, condition) { checks.push({ name, status: condition ? 'pass' : 'fail' }); console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}`); if (!condition) throw new Error(name) }
function requiredEnv(name) { const value = process.env[name]; if (!value) throw new Error(`missing ${name}`); return value }

app.whenReady().then(() => run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  app.exit(1)
}))
