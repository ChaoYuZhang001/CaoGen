#!/usr/bin/env node
/**
 * CaoGen 验收用 Anthropic 兼容 mock 网关(无需真实 API Key)。
 * 真 SDK 子进程可直连,故障可受控注入 —— 用于在真机上验证:
 * 流式输出、多轮、成本显示、模型列表拉取、跨厂商故障切换。
 *
 * 用法:node scripts/mock-gateway.mjs [端口=8399]
 * 配置 Provider baseUrl:
 *   http://127.0.0.1:8399/ok        → 永远成功(流式回显)
 *   http://127.0.0.1:8399/fail429   → 永远 429(触发故障切换)
 *   http://127.0.0.1:8399/fail403   → 永远 403 余额不足
 *   http://127.0.0.1:8399/flaky     → 前 2 次 429,之后成功(半恢复场景)
 * API Key 随便填(如 mock-key)。
 */
import http from 'node:http'

const port = Number(process.argv[2] || 8399)
let flakyCount = 0

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function errorBody(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type, message } }))
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function lastUserText(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue
    const c = msgs[i].content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
      if (t) return t
    }
  }
  return '(空)'
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/'
  const mode = url.includes('/fail429') ? '429' : url.includes('/fail403') ? '403' : url.includes('/flaky') ? 'flaky' : 'ok'
  console.log(`[mock] ${req.method} ${url} (${mode})`)

  // 模型列表(供"获取模型列表"按钮)
  if (url.endsWith('/v1/models')) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ data: [{ id: 'mock-sonnet' }, { id: 'mock-haiku' }] }))
  }

  if (!url.endsWith('/v1/messages') || req.method !== 'POST') {
    res.writeHead(404)
    return res.end('not found')
  }

  const body = await readBody(req)

  if (mode === '429') return errorBody(res, 429, 'rate_limit_error', 'mock: too many requests')
  if (mode === '403') return errorBody(res, 403, 'permission_error', 'mock: insufficient credit balance')
  if (mode === 'flaky' && flakyCount++ < 2) {
    return errorBody(res, 429, 'rate_limit_error', `mock flaky: attempt ${flakyCount}`)
  }

  const model = body.model || 'mock-sonnet'
  const echo = lastUserText(body).slice(0, 60)
  const reply = `【mock 网关】已收到:「${echo}」。这是无 Key 验收回复,链路(流式/成本/事件)真实。`

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  const msgId = 'msg_mock_' + Math.random().toString(36).slice(2, 10)
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 1 }
    }
  })
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const piece of reply.match(/.{1,8}/g) || []) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
    await new Promise((r) => setTimeout(r, 25))
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.ceil(reply.length / 3) }
  })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`CaoGen mock 网关已启动: http://127.0.0.1:${port}`)
  console.log('Provider baseUrl 可选: /ok  /fail429  /fail403  /flaky(前2次429后成功)')
})
