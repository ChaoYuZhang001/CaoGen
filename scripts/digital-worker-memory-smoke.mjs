#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(path.join(process.cwd(), 'src/main/digital-worker/worker-memory.ts'), 'utf8')
assert.match(source, /memoryNamespace === worker\.memoryNamespace/)
assert.match(source, /record\.scope === 'worker'/)
assert.match(source, /record\.status === 'active'/)
assert.match(source, /Only active DigitalWorkers may learn/)
assert.match(source, /DigitalWorker memory is unavailable for non-active Worker/)
assert.match(source, /createTrustedUserLearningDecision/)
console.log('digital worker memory smoke ok')
