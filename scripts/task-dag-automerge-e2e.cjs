/**
 * DAG auto-merge E2E:
 * - Starts the real Electron main process and IPC surface.
 * - Uses a local mock OpenAI Responses endpoint, so no real key/network is needed.
 * - Dispatches a DAG with two independent child agents in managed worktrees.
 * - Each child really calls write_file; SessionManager then completes the DAG and runs autoMerge.
 * - Verifies task-dag-update carries autoMerge and that patches landed in the source repo.
 */
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, ipcMain } = require('electron')

const repoOut = path.resolve(__dirname, '..', 'out', 'main')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caogen-dag-automerge-'))
const tmpUserData = path.join(tempRoot, 'user-data')
const projectDir = path.join(tempRoot, 'repo')

process.env.CAOGEN_USER_DATA_DIR = tmpUserData
process.env.CAOGEN_MAX_INFLIGHT = '2'

const results = []
const requests = []
let server
let finalExitCode = 1

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` - ${String(detail).slice(0, 180)}` : ''}`)
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

async function invoke(channel, ...args) {
  const map = ipcMain._invokeHandlers
  if (!map || !map.has(channel)) throw new Error(`IPC channel not registered: ${channel}`)
  return map.get(channel)({}, ...args)
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function classifyRequest(parsed) {
  const raw = JSON.stringify(parsed)
  const hasToolOutput = raw.includes('function_call_output')
  const previous = typeof parsed.previous_response_id === 'string' ? parsed.previous_response_id : ''
  if (previous.includes('call_alpha')) return 'alpha-output'
  if (previous.includes('call_beta')) return 'beta-output'
  if (raw.includes('TASK_WRITE_ALPHA')) return hasToolOutput ? 'alpha-output' : 'alpha-call'
  if (raw.includes('TASK_WRITE_BETA')) return hasToolOutput ? 'beta-output' : 'beta-call'
  if (raw.includes('DAG') || raw.includes('auto merge')) return 'parent-summary'
  return hasToolOutput ? 'generic-output' : 'generic'
}

function toolCall(callId, fileName, content) {
  const item = {
    type: 'function_call',
    call_id: callId,
    name: 'write_file',
    arguments: JSON.stringify({ path: fileName, content })
  }
  return [
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `${callId}_response`, usage: { input_tokens: 16, output_tokens: 6 } } }
  ]
}

function textResponse(id, text) {
  return [
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 5 } } }
  ]
}

function startMockServer() {
  server = http.createServer((req, res) => {
    if (!req.url.endsWith('/v1/responses')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        // keep parsed empty; the request will fall into generic response
      }
      const kind = classifyRequest(parsed)
      requests.push(kind)
      if (kind === 'alpha-call') {
        sse(res, toolCall('call_alpha', 'alpha.txt', 'alpha from dag auto merge\n'))
      } else if (kind === 'beta-call') {
        sse(res, toolCall('call_beta', 'beta.txt', 'beta from dag auto merge\n'))
      } else if (kind === 'alpha-output') {
        sse(res, textResponse('alpha_done', 'alpha child completed'))
      } else if (kind === 'beta-output') {
        sse(res, textResponse('beta_done', 'beta child completed'))
      } else {
        sse(res, textResponse('parent_done', 'parent received dag summary'))
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function initProjectRepo() {
  fs.mkdirSync(projectDir, { recursive: true })
  git(projectDir, ['init'])
  git(projectDir, ['config', 'user.email', 'dag-automerge@example.test'])
  git(projectDir, ['config', 'user.name', 'DAG AutoMerge E2E'])
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# DAG auto merge e2e\n', 'utf8')
  git(projectDir, ['add', 'README.md'])
  git(projectDir, ['commit', '-m', 'initial'])
}

function makeDag() {
  return {
    id: `dag-automerge-${Date.now()}`,
    title: 'DAG auto merge e2e',
    source: 'auto merge integration e2e',
    complexity: 'multi',
    createdAt: Date.now(),
    tasks: [
      {
        id: 'write-alpha',
        title: 'Write alpha',
        description: 'Write alpha.txt in an isolated worktree.',
        dependencies: [],
        role: 'backend',
        prompt: 'TASK_WRITE_ALPHA: create alpha.txt'
      },
      {
        id: 'write-beta',
        title: 'Write beta',
        description: 'Write beta.txt in an isolated worktree.',
        dependencies: [],
        role: 'frontend',
        prompt: 'TASK_WRITE_BETA: create beta.txt'
      }
    ]
  }
}

async function waitForAutoMerge(parentSessionId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  let latestUpdate = null
  while (Date.now() < deadline) {
    const entries = await invoke('sessions:transcript', parentSessionId)
    const updates = entries
      .map((entry) => entry.event)
      .filter((event) => event && event.kind === 'task-dag-update')
      .map((event) => event.execution)
    latestUpdate = updates[updates.length - 1] ?? latestUpdate
    const withAutoMerge = updates.find((execution) => execution.autoMerge)
    if (withAutoMerge) return withAutoMerge
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`timed out waiting for autoMerge; latest=${JSON.stringify(latestUpdate)}`)
}

async function run() {
  const port = await startMockServer()
  initProjectRepo()

  require(path.join(repoOut, 'index.js'))
  await new Promise((resolve) => setTimeout(resolve, 900))

  const provider = await invoke('providers:create', {
    name: 'mock-dag-automerge',
    baseUrl: `http://127.0.0.1:${port}`,
    models: ['mock-dag'],
    openaiProtocol: 'responses',
    token: 'mock-key'
  })
  const parent = await invoke('sessions:create', {
    cwd: projectDir,
    engine: 'openai',
    providerId: provider.id,
    model: 'mock-dag',
    isolated: false,
    permissionMode: 'bypassPermissions'
  })
  check('created OpenAI parent session', parent && parent.engine === 'openai', parent?.id)

  const dispatch = await invoke('sessions:dispatchTaskDag', parent.id, {
    dag: makeDag(),
    cwd: projectDir,
    isolated: true,
    engine: 'openai',
    providerId: provider.id,
    model: 'mock-dag',
    permissionMode: 'bypassPermissions',
    maxRetries: 0,
    taskTimeoutMs: 15000,
    autoMerge: true,
    verificationCommand: 'git diff --name-only -- alpha.txt beta.txt'
  })
  check('DAG launched two child sessions', dispatch.children.length === 2, `children=${dispatch.children.length}`)
  check(
    'child sessions use managed worktrees',
    dispatch.children.every((child) => child.meta.worktreePath && samePath(child.meta.repoRoot, projectDir)),
    dispatch.children.map((child) => `${child.meta.repoRoot} -> ${child.meta.worktreePath}`).join(', ')
  )

  const finalExecution = await waitForAutoMerge(parent.id)
  const autoMerge = finalExecution.autoMerge
  console.log(`autoMerge detail: ${JSON.stringify(autoMerge, null, 2)}`)
  check('DAG reached success before autoMerge', finalExecution.status === 'success', finalExecution.status)
  check('autoMerge status is success', autoMerge && autoMerge.status === 'success', autoMerge?.status)
  check('autoMerge merged both entries', autoMerge && autoMerge.mergedCount === 2, `merged=${autoMerge?.mergedCount}`)
  check('autoMerge verification passed', autoMerge?.verification?.status === 'passed', autoMerge?.verification?.status)
  check('source repo has alpha file', normalizeText(readText(path.join(projectDir, 'alpha.txt'))) === 'alpha from dag auto merge\n')
  check('source repo has beta file', normalizeText(readText(path.join(projectDir, 'beta.txt'))) === 'beta from dag auto merge\n')
  check('mock saw both child tool loops', requests.includes('alpha-output') && requests.includes('beta-output'), requests.join(', '))

  await invoke('sessions:close', parent.id)
  await new Promise((resolve) => setTimeout(resolve, 300))
  finalExitCode = results.every((result) => result.ok) ? 0 : 1
  finish(finalExitCode)
}

function finish(code) {
  const pass = results.filter((result) => result.ok).length
  console.log(`\ntask-dag-automerge e2e: ${pass}/${results.length} passed`)
  try {
    server?.close()
  } catch {
    // best effort
  }
  if (code === 0) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    } catch (err) {
      console.warn(`cleanup skipped: ${err.message}`)
    }
  } else {
    console.warn(`debug artifacts preserved: ${tempRoot}`)
  }
  app.exit(code)
}

app.whenReady().then(() => run().catch((err) => {
  console.error(err)
  finalExitCode = 1
  finish(1)
}))

function samePath(left, right) {
  if (!left || !right) return false
  return canonicalPath(left).toLowerCase() === canonicalPath(right).toLowerCase()
}

function canonicalPath(value) {
  const resolved = path.resolve(value)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function normalizeText(text) {
  return text.replace(/\r\n/g, '\n')
}
