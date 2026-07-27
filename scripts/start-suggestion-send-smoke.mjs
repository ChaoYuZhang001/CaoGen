import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-start-suggestion-send-'))
const require = createRequire(import.meta.url)

try {
  const source = readFileSync(path.join(repoRoot, 'src/renderer/src/store/start-suggestion-send.ts'), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const modulePath = path.join(tempRoot, 'start-suggestion-send.cjs')
  writeFileSync(modulePath, output, 'utf8')
  const { sendStartSuggestionMessage } = require(modulePath)
  const suggestion = { id: 'verify-build', prompt: 'run the build' }

  const rejected = harness(async () => {
    throw new Error('engine rejected the suggestion')
  })
  await sendStartSuggestionMessage(rejected.store, suggestion)
  assertEqual(rejected.state.workbench.startSuggestionsError, 'engine rejected the suggestion')
  assertEqual(Object.keys(rejected.state.workbench.ignoredStartSuggestions).length, 0)

  const acceptedDeferred = deferred()
  const accepted = harness(() => acceptedDeferred.promise)
  const acceptedSend = sendStartSuggestionMessage(accepted.store, suggestion)
  accepted.state.activeId = 'session-b'
  acceptedDeferred.resolve()
  await acceptedSend
  assertEqual(accepted.state.workbench.ignoredStartSuggestions['session-a:verify-build'], true)
  assertEqual(accepted.state.workbench.ignoredStartSuggestions['session-b:verify-build'], undefined)

  const rejectedDeferred = deferred()
  const staleFailure = harness(() => rejectedDeferred.promise)
  const rejectedSend = sendStartSuggestionMessage(staleFailure.store, suggestion)
  staleFailure.state.activeId = 'session-b'
  rejectedDeferred.reject(new Error('old session failed'))
  await rejectedSend
  assertEqual(staleFailure.state.workbench.startSuggestionsError, undefined)

  console.log('start suggestion send smoke: PASS')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function harness(sendMessage) {
  const state = {
    activeId: 'session-a',
    sendMessage,
    workbench: { ignoredStartSuggestions: {}, startSuggestionsError: undefined }
  }
  return {
    state,
    store: {
      getState: () => state,
      setState(update) {
        const next = typeof update === 'function' ? update(state) : update
        Object.assign(state, next)
      }
    }
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
