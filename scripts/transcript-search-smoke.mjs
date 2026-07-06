import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 会话全文搜索冒烟:独立编译 transcriptSearch.ts,造临时转录 JSONL,断言检索行为
const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-transcript-search-'))
const outDir = path.join(tempRoot, 'compiled')
const transcriptsDir = path.join(tempRoot, 'transcripts')

try {
  execFileSync(
    'npx',
    [
      'tsc',
      'src/main/transcriptSearch.ts',
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

  const compiledPath = [
    path.join(outDir, 'transcriptSearch.js'),
    path.join(outDir, 'main', 'transcriptSearch.js'),
    path.join(outDir, 'src', 'main', 'transcriptSearch.js')
  ].find((candidate) => existsSync(candidate))
  assert(compiledPath, 'compiled transcriptSearch.js should exist')
  const { searchTranscripts } = await import(pathToFileURL(compiledPath).href)

  mkdirSync(transcriptsDir, { recursive: true })

  // 会话 A:用户消息 + 助手 text 块都命中;含损坏行与 thinking 干扰块
  const lines = [
    JSON.stringify({ seq: 1, event: { kind: 'user-message', text: '帮我修复 Widget 渲染的 bug,大小写测试 WIDGET' } }),
    '{ broken json line',
    JSON.stringify({
      seq: 2,
      event: {
        kind: 'assistant-message',
        blocks: [
          { type: 'thinking', text: 'widget 只在 thinking 里不应命中本块' },
          { type: 'text', text: `${'前'.repeat(100)}widget 修好了${'后'.repeat(100)}` }
        ]
      }
    }),
    JSON.stringify({ seq: 3, event: { kind: 'tool-result', toolUseId: 'x', content: 'widget in tool result 不参与搜索', isError: false } }),
    JSON.stringify({ seq: 4, event: { kind: 'user-message', text: '再看看 widget 的样式' } }),
    JSON.stringify({ seq: 5, event: { kind: 'user-message', text: 'widget 第四次命中,应被 3 条上限截断' } })
  ]
  writeFileSync(path.join(transcriptsDir, 'sdk-a.jsonl'), lines.join('\n') + '\n')

  // 会话 B:无命中
  writeFileSync(
    path.join(transcriptsDir, 'sdk-b.jsonl'),
    JSON.stringify({ seq: 1, event: { kind: 'user-message', text: '完全无关的内容' } }) + '\n'
  )

  // 会话 C:超大文件应被跳过并给出 note(其中确有命中词也不读)
  writeFileSync(
    path.join(transcriptsDir, 'sdk-c.jsonl'),
    JSON.stringify({ seq: 1, event: { kind: 'user-message', text: 'widget '.padEnd(8192, 'x') } }) + '\n'
  )

  const sessions = [
    { sdkSessionId: 'sdk-a', title: '会话 A', cwd: '/tmp/a' },
    { sdkSessionId: 'sdk-b', title: '会话 B', cwd: '/tmp/b' },
    { sdkSessionId: 'sdk-c', title: '会话 C', cwd: '/tmp/c' },
    { sdkSessionId: 'sdk-missing', title: '无转录', cwd: '/tmp/d' }
  ]

  // 大小写不敏感命中 + 会话过滤(阈值 4KB:A/B 正常读,C 超限)
  const results = await searchTranscripts(transcriptsDir, sessions, 'WiDgEt', { maxFileBytes: 4096 })
  assertEqual(results.length, 2, 'A 命中 + C 超限 note,B/missing 不出现')

  const a = results.find((r) => r.sdkSessionId === 'sdk-a')
  assert(a, 'session A should hit')
  assertEqual(a.title, '会话 A')
  assertEqual(a.hits.length, 3, 'hits capped at 3 per session')
  assertEqual(a.hits[0].seq, 1)
  assertEqual(a.hits[0].role, 'user')
  assert(a.hits[0].snippet.includes('Widget'), 'snippet keeps original casing')
  assertEqual(a.hits[1].seq, 2)
  assertEqual(a.hits[1].role, 'assistant', 'assistant text block should hit')
  assert(a.hits[1].snippet.startsWith('…') && a.hits[1].snippet.endsWith('…'), 'long text snippet is trimmed with ellipsis')
  assert(a.hits[1].snippet.length <= 60 * 2 + 'widget 修好了'.length + 2, 'snippet stays around ±60 chars')
  assert(!a.hits.some((h) => h.seq === 3), 'tool-result must not be searched')

  const c = results.find((r) => r.sdkSessionId === 'sdk-c')
  assert(c, 'oversized session C should be reported')
  assertEqual(c.hits.length, 0)
  assert(c.note && c.note.includes('跳过'), 'oversized file carries a skip note')

  // 空查询返回空
  assertEqual((await searchTranscripts(transcriptsDir, sessions, '   ')).length, 0)

  // maxSessions 截断
  const capped = await searchTranscripts(transcriptsDir, sessions, 'widget', { maxSessions: 1 })
  assertEqual(capped.length, 1, 'maxSessions caps result count')
  assertEqual(capped[0].sdkSessionId, 'sdk-a')

  console.log('transcriptSearch smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, message) {
  assert(
    actual === expected,
    `${message ?? 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}
