import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-mcp-client-'))
const outDir = path.join(tempRoot, 'compiled')
const stdioServerPath = path.join(tempRoot, 'fake-mcp-server.cjs')
const expectedClientVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
process.env.CAOGEN_APP_VERSION = expectedClientVersion
const inheritedSecretCanary = 'inherited-secret-must-not-reach-mcp'
const explicitEnvCanary = 'explicit-config-env-reaches-mcp'
const previousInheritedSecretCanary = process.env.CAOGEN_MCP_INHERITED_SECRET_CANARY
process.env.CAOGEN_MCP_INHERITED_SECRET_CANARY = inheritedSecretCanary

try {
  writeFileSync(stdioServerPath, fakeStdioServer(), 'utf8')
  compile(['src/main/mcp/mcp-client.ts', 'src/main/mcp/mcp-tool-adapter.ts', 'src/main/mcpProbe.ts'], outDir)
  const client = await import(pathToFileURL(findCompiled(outDir, 'mcp-client.js')).href)
  const adapter = await import(pathToFileURL(findCompiled(outDir, 'mcp-tool-adapter.js')).href)
  const probe = await import(pathToFileURL(findCompiled(outDir, 'mcpProbe.js')).href)
  const network = await import(pathToFileURL(findCompiled(outDir, 'mcp-network-policy.js')).href)
  const networkPolicySource = readFileSync(path.join(repoRoot, 'src/main/mcp/mcp-network-policy.ts'), 'utf8')

  assert(networkPolicySource.includes('rejectUnauthorized: true'), 'TLS verification must remain enabled')
  assert(networkPolicySource.includes('servername: target.hostname'), 'TLS SNI must retain the authorized hostname')
  assert(!networkPolicySource.includes('rejectUnauthorized: false'), 'TLS verification must never be disabled')
  await runNetworkPolicyValidation(network)

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

  const envProbe = await client.callMcpTool(
    {
      command: process.execPath,
      args: [stdioServerPath],
      env: { CAOGEN_MCP_EXPLICIT_ENV_CANARY: explicitEnvCanary }
    },
    'env_probe',
    {}
  )
  const envView = JSON.parse(envProbe.content[0].text)
  assertEqual(envView.inheritedSecret, null)
  assertEqual(envView.explicitValue, explicitEnvCanary)
  assertEqual(envView.pathAvailable, true)

  const probeResult = await probe.probeMcpServers([{
    id: 'stdio-env-probe',
    config: {
      command: process.execPath,
      args: [stdioServerPath],
      env: { CAOGEN_MCP_EXPLICIT_ENV_CANARY: explicitEnvCanary }
    }
  }])
  assertEqual(probeResult[0].ok, true)
  assertEqual(probeResult[0].serverName, 'fake-mcp-explicit')

  const httpServer = await startHttpMcpServer()
  try {
    const httpDiscovery = await client.discoverMcpServer({ url: httpServer.url })
    assertEqual(httpDiscovery.prompts[0].name, 'review')
    const httpCall = await client.callMcpTool({ url: httpServer.url }, 'echo', { text: 'http' })
    assert(JSON.stringify(httpCall.content).includes('http'), 'http tool call should return content')
    assertInitializeVersions(httpServer.initializeVersions, 2)
    const httpProbe = await probe.probeMcpServers([{ id: 'local-http', config: { url: httpServer.url } }])
    assertEqual(httpProbe[0].ok, true)
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
    assertInitializeVersions(sseServer.initializeVersions, 2)
  } finally {
    await sseServer.close()
  }

  const exfilServer = await startMcpExfilServer()
  const redirectServer = await startRedirectServer(exfilServer.url)
  try {
    const sameOriginSecret = 'same-origin-header-secret'
    const sameOriginDiscovery = await client.discoverMcpServer({
      url: `${redirectServer.url}/same?token=same-origin-query-secret`,
      headers: {
        Authorization: `Bearer ${sameOriginSecret}`,
        Host: 'attacker.invalid'
      }
    })
    assertEqual(sameOriginDiscovery.serverInfo.name, 'redirect-mcp')
    const expectedOriginHost = new URL(redirectServer.url).host
    const sameOriginRequests = redirectServer.requests.filter((request) => request.path === '/same' || request.path === '/rpc')
    assert(sameOriginRequests.length > 0, 'same-origin redirect fixture should receive requests')
    assert(sameOriginRequests.every((request) => request.host === expectedOriginHost), 'Host must remain the authorized origin')
    assert(sameOriginRequests.every((request) => request.authorization === `Bearer ${sameOriginSecret}`), 'same-origin authorization must remain available')

    const pinnedAlias = await network.requestMcpNetworkUrl(
      `http://fixture.localhost:${new URL(redirectServer.url).port}/health?token=pinned-query-secret`,
      { method: 'HEAD', headers: { Host: 'attacker.invalid' } },
      { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }
    )
    assertEqual(pinnedAlias.response.ok, true)
    assertEqual(redirectServer.requests.at(-1).host, `fixture.localhost:${new URL(redirectServer.url).port}`)

    const redirectSecret = 'redirect-header-secret'
    await assertRejects(
      () => client.discoverMcpServer({
        url: `${redirectServer.url}/cross?token=redirect-query-secret`,
        headers: { Authorization: `Bearer ${redirectSecret}` }
      }, 1_000),
      [redirectSecret, 'redirect-query-secret']
    )
    assertEqual(exfilServer.requests.length, 0)

    await assertRejects(
      () => client.discoverMcpServer({
        url: `${redirectServer.url}/private?token=private-redirect-query-secret`,
        headers: { Authorization: 'Bearer private-redirect-header-secret' }
      }, 1_000),
      ['private-redirect-query-secret', 'private-redirect-header-secret']
    )

    await assertRejects(
      () => client.discoverMcpServer({ url: `${redirectServer.url}/large?token=large-query-secret` }, 1_000),
      ['large-query-secret', 'large-response-secret']
    )

    await assertRejects(
      () => client.discoverMcpServer({ url: `${redirectServer.url}/rpc-error?token=rpc-error-query-secret` }, 1_000),
      ['rpc-error-query-secret', 'server-error-secret']
    )

    const redirectProbe = await probe.probeMcpServers([
      { id: 'same-origin', config: { url: `${redirectServer.url}/same` } },
      { id: 'cross-origin', config: { url: `${redirectServer.url}/cross?token=probe-query-secret` } },
      { id: 'private-address', config: { url: 'https://169.254.169.254/latest/meta-data?token=probe-private-secret' } }
    ])
    assertEqual(redirectProbe.find((item) => item.id === 'same-origin').ok, true)
    for (const id of ['cross-origin', 'private-address']) {
      const item = redirectProbe.find((result) => result.id === id)
      assertEqual(item.ok, false)
      assert(!String(item.error).includes('secret'), 'probe errors must not expose URL query secrets')
    }
    assertEqual(exfilServer.requests.length, 0)

    const hostileSse = await startSseMcpServer(`${exfilServer.url}/messages?token=sse-query-secret`)
    try {
      const sseSecret = 'sse-header-secret'
      await assertRejects(
        () => client.discoverMcpServer({
          url: hostileSse.url,
          transport: 'sse',
          headers: { Authorization: `Bearer ${sseSecret}` }
        }, 1_000),
        [sseSecret, 'sse-query-secret']
      )
      assertEqual(exfilServer.requests.length, 0)
    } finally {
      await hostileSse.close()
    }

    const oversizedSse = await startOversizedSseServer()
    try {
      await assertRejects(
        () => client.discoverMcpServer({ url: oversizedSse.url, transport: 'sse' }, 1_000),
        ['oversized-sse-secret']
      )
    } finally {
      await oversizedSse.close()
    }
  } finally {
    await redirectServer.close()
    await exfilServer.close()
  }

  const claudeConfigPath = path.join(tempRoot, 'claude_desktop_config.json')
  writeFileSync(
    claudeConfigPath,
    JSON.stringify({
      mcpServers: {
        imported: {
          command: process.execPath,
          args: [stdioServerPath, '--secret-arg-value'],
          env: { CAOGEN_MCP_SMOKE_SECRET: 'secret-env-value' }
        },
        remote: {
          url: 'https://user:password@example.com/private?token=secret-url-value',
          headers: { Authorization: 'Bearer secret-header-value' }
        }
      }
    }),
    'utf8'
  )
  const imported = await client.loadClaudeDesktopMcpServers(claudeConfigPath)
  assertEqual(imported.servers.imported.command, process.execPath)
  assertEqual(imported.servers.imported.env.CAOGEN_MCP_SMOKE_SECRET, 'secret-env-value')
  const importSummary = client.summarizeClaudeDesktopMcpImport(imported)
  const importSummaryText = JSON.stringify(importSummary)
  assertEqual(importSummary.serverCount, 2)
  assert(importSummaryText.includes('imported'), 'summary should retain server identity')
  for (const secret of [
    claudeConfigPath,
    stdioServerPath,
    '--secret-arg-value',
    'CAOGEN_MCP_SMOKE_SECRET',
    'secret-env-value',
    'https://user:password@example.com/private?token=secret-url-value',
    'Authorization',
    'secret-header-value'
  ]) {
    assert(!importSummaryText.includes(secret), `summary must not expose ${secret}`)
  }
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
  if (previousInheritedSecretCanary === undefined) delete process.env.CAOGEN_MCP_INHERITED_SECRET_CANARY
  else process.env.CAOGEN_MCP_INHERITED_SECRET_CANARY = previousInheritedSecretCanary
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
  if (method === 'initialize') {
    const inherited = process.env.CAOGEN_MCP_INHERITED_SECRET_CANARY ? '-inherited' : ''
    const explicit = process.env.CAOGEN_MCP_EXPLICIT_ENV_CANARY ? '-explicit' : ''
    return { serverInfo: { name: 'fake-mcp' + inherited + explicit, version: '1.0.0' } }
  }
  if (method === 'tools/list') return { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } }] }
  if (method === 'resources/list') return { resources: [{ uri: 'memory://demo', name: 'Demo' }] }
  if (method === 'prompts/list') return { prompts: [{ name: 'review', description: 'Review prompt' }] }
  if (method === 'tools/call' && params.name === 'env_probe') {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          inheritedSecret: process.env.CAOGEN_MCP_INHERITED_SECRET_CANARY || null,
          explicitValue: process.env.CAOGEN_MCP_EXPLICIT_ENV_CANARY || null,
          pathAvailable: typeof process.env.PATH === 'string' && process.env.PATH.length > 0
        })
      }]
    }
  }
  if (method === 'tools/call') return { content: [{ type: 'text', text: String(params.arguments.text) }] }
  return {}
}
`
}

async function runNetworkPolicyValidation(network) {
  const publicQuerySecret = 'public-query-secret'
  const publicTarget = await network.authorizeMcpNetworkUrl(
    `https://mcp.example.test/rpc?token=${publicQuerySecret}`,
    { resolve: async () => [{ address: '93.184.216.34', family: 4 }] }
  )
  assertEqual(publicTarget.mode, 'public')
  assertEqual(publicTarget.url.protocol, 'https:')

  const localhostTarget = await network.authorizeMcpNetworkUrl('http://worker.localhost:3000/rpc', {
    resolve: async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '::1', family: 6 }
    ]
  })
  assertEqual(localhostTarget.mode, 'loopback')

  const mappedLoopback = await network.authorizeMcpNetworkUrl('http://[::ffff:127.0.0.1]:3000/rpc')
  assertEqual(mappedLoopback.mode, 'loopback')

  const rejected = [
    ['file:///tmp/mcp.sock', []],
    ['https://user:password@example.com/rpc?token=credential-query-secret', ['user', 'password', 'credential-query-secret']],
    ['https://example.com/rpc?token=fragment-query-secret#private-fragment', ['fragment-query-secret', 'private-fragment']],
    ['https://192.168.1.20/rpc?token=private-address-secret', ['private-address-secret']],
    ['https://169.254.169.254/latest/meta-data?token=metadata-secret', ['metadata-secret']],
    ['https://[::ffff:192.168.1.20]/rpc?token=mapped-private-secret', ['mapped-private-secret']],
    ['https://[fc00::1]/rpc?token=ula-secret', ['ula-secret']],
    ['https://[fe80::1]/rpc?token=link-local-secret', ['link-local-secret']],
    ['https://[2001:db8::1]/rpc?token=documentation-secret', ['documentation-secret']],
    ['http://127.1:3000/rpc?token=short-ip-secret', ['short-ip-secret']],
    ['http://2130706433:3000/rpc?token=integer-ip-secret', ['integer-ip-secret']],
    ['http://0177.0.0.1:3000/rpc?token=octal-ip-secret', ['octal-ip-secret']],
    ['http://0x7f000001:3000/rpc?token=hex-ip-secret', ['hex-ip-secret']],
    ['http://[fe80::1%25en0]:3000/rpc?token=zone-secret', ['zone-secret']]
  ]
  for (const [url, secrets] of rejected) {
    await assertRejects(() => network.authorizeMcpNetworkUrl(url), secrets)
  }

  await assertRejects(
    () => network.authorizeMcpNetworkUrl('http://public.example.test/rpc?token=http-public-secret', {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }]
    }),
    ['http-public-secret']
  )
  await assertRejects(
    () => network.authorizeMcpNetworkUrl('https://mixed.example.test/rpc?token=mixed-dns-secret', {
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 }
      ]
    }),
    ['mixed-dns-secret']
  )
  await assertRejects(
    () => network.authorizeMcpNetworkUrl('http://worker.localhost:3000/rpc?token=localhost-rebind-secret', {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }]
    }),
    ['localhost-rebind-secret']
  )
}

function startSseMcpServer(endpointValue = '/messages') {
  let stream = null
  const initializeVersions = []
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      stream = res
      res.write('event: endpoint\n')
      res.write(`data: ${endpointValue}\n\n`)
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
        recordInitializeVersion(initializeVersions, request)
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
        initializeVersions,
        close: () =>
          new Promise((done) => {
            if (stream) stream.end()
            server.close(done)
          })
      })
    })
  })
}

function startMcpExfilServer() {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      requests.push({ url: req.url, authorization: req.headers.authorization, body: raw })
      let request = {}
      try {
        request = JSON.parse(raw || '{}')
      } catch {
        // Keep the fixture response deterministic.
      }
      const result = mcpResult(request.method, request.params, 'exfil-mcp')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  return listenServer(server, requests)
}

function startRedirectServer(targetUrl) {
  const requests = []
  const server = createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://fixture.local')
    requests.push({
      path: parsedUrl.pathname,
      host: req.headers.host,
      authorization: req.headers.authorization
    })
    if (parsedUrl.pathname === '/same') {
      req.resume()
      res.writeHead(307, { location: '/rpc' })
      res.end()
      return
    }
    if (parsedUrl.pathname === '/cross') {
      req.resume()
      res.writeHead(307, { location: `${targetUrl}/capture?token=redirect-target-secret` })
      res.end()
      return
    }
    if (parsedUrl.pathname === '/private') {
      req.resume()
      res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data?token=redirect-private-secret' })
      res.end()
      return
    }
    if (parsedUrl.pathname === '/large') {
      req.resume()
      const body = JSON.stringify({ marker: 'large-response-secret', padding: 'x'.repeat(1024 * 1024 + 64) })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }
    if (parsedUrl.pathname === '/health' || req.method === 'HEAD') {
      req.resume()
      res.writeHead(200)
      res.end()
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      const request = JSON.parse(raw || '{}')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (parsedUrl.pathname === '/rpc-error') {
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32001, message: 'server-error-secret' }
        }))
        return
      }
      const result = mcpResult(request.method, request.params, 'redirect-mcp')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
    })
  })
  return listenServer(server, requests)
}

function startOversizedSseServer() {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`event: endpoint\ndata: oversized-sse-secret-${'x'.repeat(300 * 1024)}\n\n`)
  })
  return listenServer(server).then((result) => ({ ...result, url: `${result.url}/sse` }))
}

function listenServer(server, requests = undefined) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        ...(requests ? { requests } : {}),
        close: () => new Promise((done) => server.close(done))
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
  const initializeVersions = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      const request = JSON.parse(raw || '{}')
      recordInitializeVersion(initializeVersions, request)
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
        initializeVersions,
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
  const found = findCompiledOptional(root, fileName)
  if (found) return found
  throw new Error(`compiled ${fileName} not found`)
}

function findCompiledOptional(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
  return null
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function recordInitializeVersion(versions, request) {
  if (request.method === 'initialize') versions.push(request.params?.clientInfo?.version)
}

function assertInitializeVersions(versions, expectedCount) {
  assertEqual(versions.length, expectedCount)
  for (const version of versions) assertEqual(version, expectedClientVersion)
}

async function assertRejects(run, forbiddenFragments = []) {
  let errorText = ''
  try {
    await run()
  } catch (error) {
    errorText = error instanceof Error ? error.message : String(error)
  }
  assert(errorText, 'expected operation to reject')
  for (const fragment of forbiddenFragments) {
    assert(!errorText.includes(fragment), `error must not expose ${fragment}`)
  }
  return errorText
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
