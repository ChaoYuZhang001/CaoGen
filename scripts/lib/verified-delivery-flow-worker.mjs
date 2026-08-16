#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'

// Fresh workers are a JSON-line protocol. Keep incidental module/runtime logs
// off stdout so a parent process can always parse the final response.
for (const method of ['debug', 'info', 'log', 'warn', 'error']) {
  console[method] = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`)
}

const rawPayload = process.argv[2]

try {
  if (!rawPayload) throw new Error('worker payload is required')
  const payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'))
  const { runVerifiedDeliveryAction } = await import('./verified-delivery-flow-actions.mjs')
  const result = await runVerifiedDeliveryAction(payload)
  if (payload.crashAfterCommit === true) {
    writeSync(1, JSON.stringify({ ok: true, checkpoint: 'after_commit' }))
    process.kill(process.pid, 'SIGKILL')
  }
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  if (process.env.CAOGEN_VERIFIED_DELIVERY_DEBUG === '1') {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  }
  process.stdout.write(JSON.stringify({
    ok: false,
    failure: sanitizedFailure(error)
  }))
  process.exitCode = 1
}

function sanitizedFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'VERIFIED_DELIVERY_WORKER_FAILED'
  const material = error instanceof Error ? error.stack ?? error.message : String(error)
  return {
    code,
    fingerprint: createHash('sha256').update(material).digest('hex')
  }
}
