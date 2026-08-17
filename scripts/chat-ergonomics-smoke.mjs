#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-chat-ergonomics-'))
const outDir = path.join(tempRoot, 'compiled')
const checks = []

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--lib', 'ES2022,DOM',
    '--skipLibCheck',
    'src/renderer/src/store/composer-draft-persistence.ts',
    'src/renderer/src/store/session-close-state.ts',
    'src/renderer/src/store/session-transcript-hydrator.ts',
    'src/renderer/src/env.d.ts'
  ], { cwd: repoRoot, stdio: 'inherit' })
  const persistence = await import(pathToFileURL(findCompiled(outDir, 'composer-draft-persistence.js')).href)
  const sessionClose = await import(pathToFileURL(findCompiled(outDir, 'session-close-state.js')).href)
  const transcriptHydration = await import(pathToFileURL(findCompiled(outDir, 'session-transcript-hydrator.js')).href)
  const storage = memoryStorage()

  equal(persistence.readComposerDraft(storage, 'alpha'), '', 'missing draft reads empty')
  persistence.writeComposerDraft(storage, 'alpha', 'alpha draft', 10)
  persistence.writeComposerDraft(storage, 'beta', 'beta draft', 20)
  equal(persistence.readComposerDraft(storage, 'alpha'), 'alpha draft', 'first session draft is isolated')
  equal(persistence.readComposerDraft(storage, 'beta'), 'beta draft', 'second session draft is isolated')
  persistence.writeComposerDraft(storage, 'alpha', '', 30)
  equal(persistence.readComposerDraft(storage, 'alpha'), '', 'empty draft is removed')
  equal(persistence.readComposerDraft(storage, 'beta'), 'beta draft', 'clearing one session preserves another')

  storage.setItem('caogen.composer-drafts.v1', '{broken')
  equal(persistence.readComposerDraft(storage, 'beta'), '', 'malformed storage fails closed')
  storage.setItem('caogen.composer-drafts.v1', JSON.stringify({ version: 2, drafts: { beta: { text: 'stale', updatedAt: 1 } } }))
  equal(persistence.readComposerDraft(storage, 'beta'), '', 'unknown storage version fails closed')

  persistence.writeComposerDraft(storage, 'long', 'x'.repeat(200_010), 40)
  equal(persistence.readComposerDraft(storage, 'long').length, 200_000, 'draft length is bounded')
  for (let index = 0; index < 55; index += 1) {
    persistence.writeComposerDraft(storage, `session-${index}`, `draft-${index}`, 100 + index)
  }
  const stored = JSON.parse(storage.getItem('caogen.composer-drafts.v1'))
  equal(Object.keys(stored.drafts).length, 50, 'draft count is bounded')
  equal(persistence.readComposerDraft(storage, 'session-54'), 'draft-54', 'newest draft survives pruning')
  equal(persistence.readComposerDraft(storage, 'session-0'), '', 'oldest draft is pruned')
  assert.doesNotThrow(() => persistence.writeComposerDraft(throwingStorage(), 'safe', 'draft'), 'storage failures never block typing')
  checks.push('storage failures never block typing')

  const beforeClose = {
    sessions: { alpha: { title: 'Alpha' }, beta: { title: 'Beta' } },
    order: ['alpha', 'beta'],
    activeId: 'beta',
    showNewSession: false,
    newSessionProjectId: 'project-1',
    showTaskRecovery: true,
    view: 'office'
  }
  const closing = sessionClose.captureClosingSession(beforeClose, 'beta')
  const removed = { ...beforeClose, ...sessionClose.removeClosingSession(beforeClose, 'beta', closing.wasActive) }
  equal(removed.activeId, 'alpha', 'active close immediately selects another editable session')
  const restored = {
    ...removed,
    ...sessionClose.restoreClosingSession(removed, 'beta', closing, (_id, session) => session)
  }
  assert.deepEqual(restored, beforeClose, 'failed active close restores session order and complete UI state')
  checks.push('failed active close restores session order and complete UI state')

  const transcriptRequests = []
  globalThis.window = {
    agentDesk: {
      getTranscript: (sessionId) => {
        transcriptRequests.push(sessionId)
        return Promise.resolve([{ seq: transcriptRequests.length, event: { kind: 'status', status: 'idle' } }])
      }
    }
  }
  const hydrator = new transcriptHydration.SessionTranscriptHydrator()
  const firstTranscript = hydrator.load('selected')
  equal(hydrator.load('selected'), firstTranscript, 'concurrent transcript hydration shares one request')
  await firstTranscript
  await hydrator.load('selected')
  equal(transcriptRequests.filter((id) => id === 'selected').length, 2, 'settled transcript hydration releases its cache')
  const hydratedIds = []
  await hydrator.hydrateEager([
    { id: 'selected', status: 'idle' },
    { id: 'running', status: 'running' },
    { id: 'starting', status: 'starting' },
    { id: 'dormant', status: 'idle' }
  ], 'selected', {
    listPendingPermissions: async () => [],
    apply: (meta) => hydratedIds.push(meta.id)
  })
  assert.deepEqual(hydratedIds.sort(), ['running', 'selected', 'starting'],
    'cold start hydrates only selected or active transcripts')
  checks.push('cold start hydrates only selected or active transcripts')
  const permissions = transcriptHydration.mergeHydratedSessionPermissions(
    { pendingPermissions: [{ requestId: 'known' }] },
    [{ requestId: 'known' }, { requestId: 'new' }]
  )
  assert.deepEqual(permissions.pendingPermissions.map((item) => item.requestId), ['known', 'new'],
    'pending permission hydration remains idempotent')
  checks.push('pending permission hydration remains idempotent')

  const composer = readFileSync('src/renderer/src/components/Composer.tsx', 'utf8')
  const autosize = readFileSync('src/renderer/src/components/useAutosizeTextarea.ts', 'utf8')
  const disclosure = readFileSync('src/renderer/src/components/DisclosureChevron.tsx', 'utf8')
  const headerIcons = readFileSync('src/renderer/src/components/ChatHeaderIcons.tsx', 'utf8')
  const hook = readFileSync('src/renderer/src/components/composer/useSessionComposerDraft.ts', 'utf8')
  const message = readFileSync('src/renderer/src/components/MessageItem.tsx', 'utf8')
  const markdown = readFileSync('src/renderer/src/components/Markdown.tsx', 'utf8')
  const copy = readFileSync('src/renderer/src/components/CopyButton.tsx', 'utf8')
  const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
  const chatView = readFileSync('src/renderer/src/components/ChatView.tsx', 'utf8')
  const sidebar = readFileSync('src/renderer/src/components/Sidebar.tsx', 'utf8')
  const openai = readFileSync('src/main/openaiEngine.ts', 'utf8')
  const anthropic = readFileSync('src/main/anthropicEngine.ts', 'utf8')
  const checkpoint = readFileSync('src/main/provider-chat-checkpoint.ts', 'utf8')
  const store = readFileSync('src/renderer/src/store.ts', 'utf8')
  const welcomeProjection = readFileSync(
    'src/renderer/src/components/experience/welcome-session-projection.ts',
    'utf8'
  )

  check('Composer draft is keyed by active session', composer.includes('useSessionComposerDraft(activeId)') && hook.includes('draft.sessionId === sessionId'))
  check('Composer height follows controlled text and viewport changes',
    composer.includes('useAutosizeTextarea(textareaRef, text)') &&
      autosize.includes("element.style.height = '0px'") &&
      autosize.includes("element.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden'"))
  check('Composer send and settings controls use the shared Lucide icon system',
    composer.includes('<ArrowUp') && headerIcons.includes('settings: Settings') &&
      !composer.includes("uploadingAttachment ? '…' : '↑'"))
  check('expand and collapse affordances share one disclosure component',
    disclosure.includes('<ChevronRight') && disclosure.includes("expanded ? 'is-expanded' : ''") &&
      sidebar.includes('<DisclosureChevron') && !sidebar.includes("collapsed ? '▸' : '▾'"))
  check('active session close leaves the renderer on an immediately editable surface',
    store.indexOf('set((s) => removeClosingSession', store.indexOf('async closeSession(id)')) <
      store.indexOf('await window.agentDesk.closeSession(id)', store.indexOf('async closeSession(id)')))
  check('cold start hydrates only visible or running transcripts and loads others on selection',
    store.includes('transcriptHydrator.hydrateEager(metas, initialActiveId') &&
      store.includes('void transcriptHydrator.load(id).then((transcript) =>'))
  check('accepted sends clear the persisted session draft', composer.includes("setText('')") && hook.includes('writeComposerDraft(storage, sessionId, next)'))
  check('user and assistant messages expose copy actions', (message.match(/kind="message"/g) ?? []).length === 2)
  check('assistant copy excludes thinking and tool blocks', message.includes("filter((block) => block.type === 'text')"))
  check('Markdown code blocks expose a dedicated copy action', markdown.includes('kind="code"') && markdown.includes('nodeText(children)'))
  check('copy action has explicit success and failure states', copy.includes("'copied'") && copy.includes("'failed'") && copy.includes('navigator.clipboard.writeText'))
  check('message actions are keyboard and touch discoverable', styles.includes(':focus-within .message-actions') && styles.includes('@media (hover: none)'))
  check('message action motion respects reduced-motion preference', styles.includes('.message-actions {\n    transition: none;'))
  check('OpenAI and Anthropic emit scoped chat checkpoints',
    openai.includes("scope: 'chat'") && anthropic.includes("scope: 'chat'"))
  check('message revision restores the checkpoint scope instead of forcing file rewind',
    chatView.includes('revision.restoreMode, true') && chatView.includes('revision.restoreMode, false'))
  check('chat-only checkpoint restore stays out of the visible message stream',
    store.includes("if (ev.mode === 'chat') return s"))
  check('checkpoint user messages expose a localized branch action',
    message.includes('data-message-action="fork"') && message.includes("t('forkFromMessage')") &&
      message.includes('<GitBranch'))
  check('message branch opens a checkpoint-bound Welcome draft without restoring the source',
    store.includes('forkFromCheckpoint(checkpointId, sourceText)') &&
      store.includes('forkCheckpointId: normalizedCheckpointId') &&
      !store.includes("forkFromCheckpoint(checkpointId, sourceText) {\n    const restored"))
  check('Welcome forwards both fork identities to Session creation',
    welcomeProjection.includes('forkFromSdkSessionId: draft.forkFromSdkSessionId') &&
      welcomeProjection.includes('forkCheckpointId: draft.forkCheckpointId'))
  check('provider chat restore fails closed across external effects',
    checkpoint.includes("'tool-start'") && checkpoint.includes("'permission-request'") &&
      checkpoint.includes("'subagent-result'") && checkpoint.includes('crossesExternalEffects'))

  console.log(`chat ergonomics smoke ok: ${checks.length}/${checks.length} checks passed`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value))
  }
}

function throwingStorage() {
  return {
    get length() { return 0 }, clear() {}, getItem() { return null }, key() { return null }, removeItem() {},
    setItem() { throw new Error('quota') }
  }
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      try { return findCompiled(full, fileName) } catch { /* keep searching */ }
    } else if (entry.isFile() && entry.name === fileName) return full
  }
  throw new Error(`compiled ${fileName} not found`)
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message)
  checks.push(message)
}

function check(message, condition) {
  assert.equal(Boolean(condition), true, message)
  checks.push(message)
}
