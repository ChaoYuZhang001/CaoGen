import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-mcp-client-'))
const outDir = path.join(tempRoot, 'compiled')
const stdioServerPath = path.join(tempRoot, 'fake-mcp-server.cjs')

try {
  writeFileSync(stdioServerPath, fakeStdioServer(), 'utf8')
  compile(['src/main/mcp/mcp-client.ts', 'src/main/mcp/mcp-tool-adapter.ts'], outDir)
  const client = await import(pathToFileURL(findCompiled(outDir, 'mcp-client.js')).href)
  const adapter = await import(pathToFileURL(findCompiled(outDir, 'mcp-tool-adapter.js')).href)

  const stdioDiscovery = await client.discoverMcpServer({
    command: process.execPath,
    args: [stdioServerPath]
  })
  assertEqual(stdioDiscovery.serverInfo.name, 'fake-mcp')
  assertEqual(stdioDiscovery.tools[0].name, 'echo')

  const stdioCall = await client.callMcpTool(
    { command: process.execPath, args: [stdioServerPath] },
    'echo',
    { text: 'hello' }
  )
  assert(JSON.stringify(stdioCall.content).includes('hello'), 'stdio tool call should return content')

  const httpServer = await startHttpMcpServer()
  try {
    const httpDiscovery = await client.discoverMcpServer({ url: httpServer.url })
    assertEqual(httpDiscovery.prompts[0].name, 'review')
    const httpCall = await client.callMcpTool({ url: httpServer.url }, 'echo', { text: 'http' })
    assert(JSON.stringify(httpCall.content).includes('http'), 'http tool call should return content')
  } finally {
    await httpServer.close()
  }

  const sseServer = await startSseMcpServer()
  try {
    const sseDiscovery = await client.discoverMcpServer({ url: sseServer.url, transport: 'sse' })
    assertEqual(sseDiscovery.serverInfo.name, 'sse-mcp')
    assertEqual(sseDiscovery.resources[0].uri, 'memory://sse')
    const sseCall = await client.callMcpTool({ url: sseServer.url, transport: 'sse' }, 'echo', { text: 'sse' })
    assert(JSON.stringify(sseCall.content).includes('sse'), 'sse tool call should return content')
  } finally {
    await sseServer.close()
  }

  const claudeConfigPath = path.join(tempRoot, 'claude_desktop_config.json')
  writeFileSync(
    claudeConfigPath,
    JSON.stringify({
      mcpServers: {
        imported: { command: process.execPath, args: [stdioServerPath], env: { CAOGEN_MCP_SMOKE: '1' } }
      }
    }),
    'utf8'
  )
  const imported = await client.loadClaudeDesktopMcpServers(claudeConfigPath)
  assertEqual(imported.servers.imported.command, process.execPath)
  assertEqual(imported.servers.imported.env.CAOGEN_MCP_SMOKE, '1')
  const templates = client.builtinMcpServerTemplates()
  assert(templates.filesystem.command === 'npx', 'built-in MCP templates should include filesystem')

  const tools = adapter.toCaoGenTools('demo', stdioDiscovery)
  assertEqual(tools[0].function.name, 'mcp__demo__echo')
  const runtime = adapter.createMcpToolRuntime({ demo: { command: process.execPath, args: [stdioServerPath] } })
  assert(runtime.canHandle('mcp__demo__echo'), 'runtime should route generated MCP tool name')
  const runtimeCall = await runtime.execute('mcp__demo__echo', { text: 'runtime' })
  assertEqual(runtimeCall.ok, true)
  assert(runtimeCall.output.includes('runtime'), 'runtime should call generated MCP tool')
  console.log('mcpClient smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function fakeStdioServer() {
  return `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  const result = handle(request.method, request.params)
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})
function handle(method, params) {
  if (method === 'initialize') return { serverInfo: { name: 'fake-mcp', version: '1.0.0' } }
  if (method === 'tools/list') return { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } }] }
  if (method === 'resources/list') return { resources: [{ uri: 'memory://demo', name: 'Demo' }] }
  if (method === 'prompts/list') return { prompts: [{ name: 'review', description: 'Review prompt' }] }
  if (method === 'tools/call') return { content: [{ type: 'text', text: String(params.arguments.text) }] }
  return {}
}
`
}

function startSseMcpServer() {
  let stream = null
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      stream = res
      res.write('event: endpoint\n')
      res.write('data: /messages\n\n')
      req.on('close', () => {
        if (stream === res) stream = null
      })
      return
    }

    if (req.method === 'POST' && req.url === '/messages') {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk.toString()
      })
      req.on('end', () => {
        const request = JSON.parse(raw || '{}')
        const result = mcpResult(request.method, request.params, 'sse-mcp')
        if (!stream) {
          res.writeHead(503)
          res.end()
          return
        }
        stream.write('event: message\n')
        stream.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`)
        res.writeHead(202)
        res.end()
      })
      return
    }

    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}/sse`,
        close: () =>
          new Promise((done) => {
            if (stream) stream.end()
            server.close(done)
          })
      })
    })
  })
}

function mcpResult(method, params, serverName) {
  if (method === 'initialize') return { serverInfo: { name: serverName, version: '1.0.0' } }
  if (method === 'tools/list') return { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } }] }
  if (method === 'resources/list') return { resources: [{ uri: `memory://${serverName === 'sse-mcp' ? 'sse' : 'http'}` }] }
  if (method === 'prompts/list') return { prompts: [{ name: 'review' }] }
  if (method === 'tools/call') return { content: [{ type: 'text', text: String(params.arguments.text) }] }
  return {}
}

function startHttpMcpServer() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      const request = JSON.parse(raw || '{}')
      const result = mcpResult(request.method, request.params, 'http-mcp')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

function compile(files, outDir) {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      ...files,
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
      '--skipLibCheck',
      '--esModuleInterop'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiled(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  throw new Error(`compiled ${fileName} not found`)
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
