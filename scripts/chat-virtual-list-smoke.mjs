#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const chatView = readFileSync(path.join(repoRoot, 'src/renderer/src/components/ChatView.tsx'), 'utf8')
const styles = readFileSync(path.join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')

assert(
  chatView.includes('const VIRTUAL_MESSAGE_THRESHOLD = 100'),
  'chat virtualization must only activate after 100 messages'
)
assert(chatView.includes('ResizeObserver'), 'virtual rows must use ResizeObserver for dynamic message heights')
assert(
  chatView.includes('window.requestAnimationFrame'),
  'scroll and bottom-stick updates must be requestAnimationFrame batched'
)
assert(
  chatView.includes('data-virtualized-messages="true"') &&
    chatView.includes('data-visible-messages={visibleItems.length}'),
  'virtual list must expose stable diagnostics attrs for UI smoke tests'
)
assert(
  chatView.indexOf('<MessageList') < chatView.indexOf('session.streamThinking') &&
    chatView.indexOf('<MessageList') < chatView.indexOf('session.streamText'),
  'streaming output must stay outside the virtualized completed-message list'
)
assert(
  styles.includes('.chat-virtual-list') && styles.includes('.chat-virtual-row'),
  'virtual list styles must be present'
)
assert(
  styles.includes('contain: layout style') && styles.includes('will-change: transform'),
  'virtual list styles must isolate layout and use transform positioning'
)

console.log('chat virtual list smoke ok')

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
