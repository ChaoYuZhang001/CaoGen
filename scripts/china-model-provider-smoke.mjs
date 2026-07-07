import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-china-model-provider-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compile(
    [
      'src/main/model/llm-providers/china-provider-adapter.ts',
      'src/main/sandbox/docker-sandbox.ts'
    ],
    outDir
  )

  const adapter = await import(pathToFileURL(findCompiled(outDir, 'china-provider-adapter.js')).href)
  const sandbox = await import(pathToFileURL(findCompiled(outDir, 'docker-sandbox.js')).href)

  const providerCases = [
    ['deepseek', { id: 'deepseek-chat', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }, 'deepseek-chat'],
    ['qwen', { id: 'aliyun-qwen', name: 'Qwen DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode' }, 'qwen-max'],
    ['kimi', { id: 'moonshot', name: 'Kimi', baseUrl: 'https://api.moonshot.cn' }, 'kimi-k2'],
    ['zhipu', { id: 'zhipu-glm', name: 'Zhipu GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, 'glm-4.5'],
    ['baichuan', { id: 'baichuan', name: 'Baichuan', baseUrl: 'https://api.baichuan-ai.com/v1' }, 'Baichuan4-Turbo'],
    ['doubao', { id: 'volcengine-ark', name: 'Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }, 'doubao-seed-1-6']
  ]
  for (const [family, provider, model] of providerCases) {
    assertEqual(adapter.detectChinaProviderFamily({ provider, model }), family)
  }

  const deepseekAdaptation = adapter.adaptChatCompletionRequest(
    {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      stream: true,
      stream_options: { include_usage: true }
    },
    { provider: { id: 'deepseek-chat', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }, model: 'deepseek-chat' }
  )
  assertEqual(deepseekAdaptation.family, 'deepseek')
  assertEqual(deepseekAdaptation.body.tool_choice, 'auto')
  assert(deepseekAdaptation.body.stream_options?.include_usage === true, 'deepseek should keep stream_options')

  const qwenAdaptation = adapter.adaptChatCompletionRequest(
    {
      model: 'qwen-max',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      stream: true,
      stream_options: { include_usage: true }
    },
    { provider: { id: 'aliyun-qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode' }, model: 'qwen-max' }
  )
  assertEqual(qwenAdaptation.family, 'qwen')
  assertEqual(qwenAdaptation.body.tool_choice, 'auto')
  assert(qwenAdaptation.body.stream_options?.include_usage === true, 'qwen should keep stream_options')
  assert(qwenAdaptation.promptAppend.includes('tool_calls'), 'prompt should mention structured tool calls')

  const kimiAdaptation = adapter.adaptChatCompletionRequest(
    {
      model: 'kimi-k2',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      stream: true,
      stream_options: { include_usage: true }
    },
    { provider: { id: 'moonshot', name: 'Kimi', baseUrl: 'https://api.moonshot.cn' }, model: 'kimi-k2' }
  )
  assertEqual(kimiAdaptation.family, 'kimi')
  assert(!('stream_options' in kimiAdaptation.body), 'kimi should remove stream_options')
  assert(kimiAdaptation.warnings.length > 0, 'kimi should report compatibility warning')

  const zhipuAdaptation = adapter.adaptChatCompletionRequest(
    {
      model: 'glm-4.5',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      stream: true,
      stream_options: { include_usage: true }
    },
    { provider: { id: 'zhipu-glm', name: 'Zhipu GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, model: 'glm-4.5' }
  )
  assertEqual(zhipuAdaptation.family, 'zhipu')
  assert(!('stream_options' in zhipuAdaptation.body), 'zhipu should remove stream_options')

  const baichuanAdaptation = adapter.adaptChatCompletionRequest(
    {
      model: 'Baichuan4-Turbo',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      stream: true,
      stream_options: { include_usage: true }
    },
    { provider: { id: 'baichuan', name: 'Baichuan', baseUrl: 'https://api.baichuan-ai.com/v1' }, model: 'Baichuan4-Turbo' }
  )
  assertEqual(baichuanAdaptation.family, 'baichuan')
  assert(!('stream_options' in baichuanAdaptation.body), 'baichuan should remove stream_options')

  const doubaoAdaptation = adapter.adaptChatCompletionRequest(
    {
      model: 'doubao-seed-1-6',
      messages: [{ role: 'user', content: 'test' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      stream: false
    },
    { provider: { id: 'volcengine-ark', name: 'Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }, model: 'doubao-seed-1-6' }
  )
  assertEqual(doubaoAdaptation.family, 'doubao')
  assertEqual(doubaoAdaptation.body.tool_choice, 'auto')
  assert(doubaoAdaptation.promptAppend.includes('doubao'), 'doubao prompt should identify provider family')

  const presetSource = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
  for (const presetKey of [
    "key: 'deepseek'",
    "key: 'kimi'",
    "key: 'glm'",
    "key: 'qwen'",
    "key: 'baichuan'",
    "key: 'doubao'"
  ]) {
    assert(presetSource.includes(presetKey), `provider preset missing ${presetKey}`)
  }

  const settingsSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8')
  for (const marker of [
    'draft.chinaEcosystemMirrorEnabled',
    "'chinaEcosystemMirrorEnabled'",
    "'chinaNpmRegistry'",
    "'chinaPipIndexUrl'",
    "'chinaDockerRegistryMirror'"
  ]) {
    assert(settingsSource.includes(marker), `china mirror settings UI missing ${marker}`)
  }

  const i18nSource = readFileSync(path.join(repoRoot, 'src/renderer/src/i18n.ts'), 'utf8')
  assert(i18nSource.includes('webhook notifications stay dry-run'), 'mirror hint must distinguish webhook dry-run boundary')

  const defaultEnv = await sandbox.runSandboxedCommand({
    command: envEchoCommand(),
    cwd: tempRoot,
    mode: 'standardSystem',
    timeoutMs: 10_000,
    maxBufferBytes: 128 * 1024,
    chinaMirrorEnabled: false,
    npmRegistry: 'https://registry.npmmirror.com'
  })
  assert(defaultEnv.ok, defaultEnv.output)
  assert(!defaultEnv.output.includes('https://registry.npmmirror.com'), 'mirror env should be disabled by default')

  const enabledEnv = await sandbox.runSandboxedCommand({
    command: envEchoCommand(),
    cwd: tempRoot,
    mode: 'standardSystem',
    timeoutMs: 10_000,
    maxBufferBytes: 128 * 1024,
    chinaMirrorEnabled: true,
    npmRegistry: 'https://registry.npmmirror.com',
    pipIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple'
  })
  assert(enabledEnv.ok, enabledEnv.output)
  assert(enabledEnv.output.includes('https://registry.npmmirror.com'), 'npm mirror env missing when enabled')
  assert(enabledEnv.output.includes('https://pypi.tuna.tsinghua.edu.cn/simple'), 'pip mirror env missing when enabled')
  const mirrorEnv = sandbox.buildChinaMirrorEnv({
    chinaMirrorEnabled: true,
    npmRegistry: 'https://registry.npmmirror.com',
    pipIndexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple'
  })
  assertEqual(mirrorEnv.NPM_CONFIG_REGISTRY, 'https://registry.npmmirror.com')
  assertEqual(mirrorEnv.PIP_INDEX_URL, 'https://pypi.tuna.tsinghua.edu.cn/simple')
  assertEqual(
    sandbox.resolveDockerImage('caogen-sandbox:latest', {
      chinaMirrorEnabled: true,
      dockerRegistryMirror: 'registry.cn-hangzhou.aliyuncs.com/caogen'
    }),
    'registry.cn-hangzhou.aliyuncs.com/caogen/caogen-sandbox:latest'
  )
  assertEqual(
    sandbox.resolveDockerImage('registry.example.com/caogen-sandbox:latest', {
      chinaMirrorEnabled: true,
      dockerRegistryMirror: 'registry.cn-hangzhou.aliyuncs.com/caogen'
    }),
    'registry.example.com/caogen-sandbox:latest'
  )
  assertEqual(
    sandbox.resolveDockerImage('caogen-sandbox:latest', {
      chinaMirrorEnabled: false,
      dockerRegistryMirror: 'registry.cn-hangzhou.aliyuncs.com/caogen'
    }),
    'caogen-sandbox:latest'
  )

  console.log('china model provider smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
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
      '--esModuleInterop',
      '--strict'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function findCompiled(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const found = findCompiledOptional(fullPath, fileName)
      if (found) return found
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath
    }
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function envEchoCommand() {
  if (process.platform === 'win32') return 'echo NPM=%NPM_CONFIG_REGISTRY%&& echo PIP=%PIP_INDEX_URL%'
  return 'printf "NPM=%s\\nPIP=%s\\n" "$NPM_CONFIG_REGISTRY" "$PIP_INDEX_URL"'
}
