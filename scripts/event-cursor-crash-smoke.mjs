import { execFileSync, fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const mode = process.argv[2]

if (mode === '--worker-crash' || mode === '--worker-resume') {
  await runWorker(mode)
} else {
  await runParent()
}

async function runParent() {
  const repoRoot = process.cwd()
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-event-cursor-crash-'))
  const outDir = path.join(tempRoot, 'compiled')
  const userData = path.join(tempRoot, 'userData')
  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        'src/main/transcript.ts',
        'src/main/checkpointRestorePlan.ts',
        '--outDir',
        outDir,
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--types',
        'node',
        '--skipLibCheck'
      ],
      { cwd: repoRoot, stdio: 'inherit' }
    )

    const electronDir = path.join(outDir, 'node_modules', 'electron')
    mkdirSync(electronDir, { recursive: true })
    writeFileSync(path.join(electronDir, 'index.js'), `export const app = { getPath: () => ${JSON.stringify(userData)} }\n`)
    writeFileSync(path.join(electronDir, 'package.json'), '{"type":"module"}\n')
    const compiledPath = findCompiledModule(outDir)

    const crashed = await forkWorker('--worker-crash', compiledPath)
    assertEqual(crashed.type, 'receipt-written')
    const receiptPath = path.join(userData, 'event-receipts', 'sdk-crash.jsonl')
    assert(existsSync(receiptPath), 'crashed worker must synchronously persist the event receipt')
    const afterCrash = readFileSync(receiptPath, 'utf8')
    assert(afterCrash.includes('permission-crash'), 'receipt should retain request identity')
    assert(!afterCrash.includes('DO_NOT_PERSIST'), 'receipt must not persist raw tool input')

    const resumed = await forkWorker('--worker-resume', compiledPath)
    assertEqual(resumed.type, 'resumed')
    assertEqual(resumed.seq, 51)
    assert(resumed.seq > crashed.seq, 'recovered cursor must advance past the crashed process')
    assert(resumed.eventId !== crashed.eventId, 'new event must not reuse the crashed event identity')
    assertEqual(resumed.streamId, crashed.streamId)

    const receipts = readFileSync(receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assertEqual(receipts.at(-1).seq, 51)
    assertEqual(new Set(receipts.map((receipt) => receipt.eventId)).size, receipts.length)
    console.log('event cursor crash smoke ok')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function runWorker(workerMode) {
  const compiledPath = process.env.CAOGEN_EVENT_CURSOR_COMPILED
  assert(compiledPath, 'worker requires CAOGEN_EVENT_CURSOR_COMPILED')
  const { TranscriptWriter } = await import(pathToFileURL(compiledPath).href)
  if (workerMode === '--worker-crash') {
    const writer = new TranscriptWriter()
    writer.next({ kind: 'init', sdkSessionId: 'sdk-crash' })
    const entry = writer.nextEntry({
      kind: 'permission-request',
      request: {
        requestId: 'permission-crash',
        toolUseId: 'tool-crash',
        toolName: 'bash',
        input: { command: 'echo DO_NOT_PERSIST' }
      }
    })
    process.send?.({
      type: 'receipt-written',
      seq: entry.seq,
      eventId: entry.eventId,
      streamId: entry.streamId
    })
    setInterval(() => undefined, 1000)
    return
  }

  const writer = new TranscriptWriter('sdk-crash', 50)
  const entry = writer.nextEntry({ kind: 'status', status: 'running' })
  process.send?.({
    type: 'resumed',
    seq: entry.seq,
    eventId: entry.eventId,
    streamId: entry.streamId
  })
}

function forkWorker(workerMode, compiledPath) {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [workerMode], {
      env: { ...process.env, CAOGEN_EVENT_CURSOR_COMPILED: compiledPath },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    let settled = false
    child.once('error', reject)
    child.on('message', (message) => {
      if (settled) return
      settled = true
      resolve(message)
      if (workerMode === '--worker-crash') {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      } else {
        child.disconnect()
      }
    })
    child.once('exit', (code, signal) => {
      if (!settled) reject(new Error(`worker exited before evidence: code=${code} signal=${signal}`))
    })
  })
}

function findCompiledModule(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledModule(fullPath)
      if (found) return found
    } else if (entry.isFile() && entry.name === 'transcript.js') {
      return fullPath
    }
  }
  throw new Error(`compiled transcript.js not found under ${root}`)
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
