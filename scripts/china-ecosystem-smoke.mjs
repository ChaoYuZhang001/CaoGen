import { createServer } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-china-ecosystem-'))
const outDir = path.join(tempRoot, 'compiled')

try {
  compile(
    [
      'src/main/notification/feishu.ts',
      'src/main/notification/dingtalk.ts',
      'src/main/notification/wecom.ts',
      'src/main/agent/tools/gitee-tools.ts'
    ],
    outDir
  )

  const feishu = await import(pathToFileURL(findCompiled(outDir, 'feishu.js')).href)
  const dingtalk = await import(pathToFileURL(findCompiled(outDir, 'dingtalk.js')).href)
  const wecom = await import(pathToFileURL(findCompiled(outDir, 'wecom.js')).href)
  const gitee = await import(pathToFileURL(findCompiled(outDir, 'gitee-tools.js')).href)
  const webhookServer = await startJsonServer()

  try {
    const feishuPayload = feishu.buildFeishuWebhookPayload({ title: '构建完成', text: '国产生态 smoke', linkUrl: 'https://example.test/run/1' })
    assertEqual(feishuPayload.msg_type, 'interactive')
    const feishuDryRun = await feishu.sendFeishuNotification({ title: '构建完成', text: 'dry-run' })
    assertEqual(feishuDryRun.ok, true)
    assertEqual(feishuDryRun.dryRun, true)
    assertEqual(feishuDryRun.sent, false)
    assertEqual(webhookServer.requests.length, 0)
    const feishuSent = await feishu.sendFeishuNotification(
      { title: '构建完成', text: 'send' },
      { webhookUrl: webhookServer.url, dryRun: false }
    )
    assertEqual(feishuSent.sent, true)
    assertEqual(webhookServer.requests.length, 1)
    assertEqual(webhookServer.requests[0].body.msg_type, 'text')

    const dingtalkPayload = dingtalk.buildDingTalkWebhookPayload({ title: '告警', text: '需要关注', atMobiles: ['13800000000'] })
    assertEqual(dingtalkPayload.msgtype, 'markdown')
    assertEqual(dingtalkPayload.at.atMobiles[0], '13800000000')
    const dingtalkDryRun = await dingtalk.sendDingTalkNotification(
      { title: '告警', text: 'dry-run' },
      { webhookUrl: webhookServer.url }
    )
    assertEqual(dingtalkDryRun.ok, true)
    assertEqual(dingtalkDryRun.dryRun, true)
    assertEqual(dingtalkDryRun.sent, false)
    const dingtalkSignedDryRun = await dingtalk.sendDingTalkNotification(
      { title: '告警', text: 'dry-run' },
      { webhookUrl: webhookServer.url, secret: 'secret-for-smoke' }
    )
    assertEqual(dingtalkSignedDryRun.ok, true)
    assertEqual(dingtalkSignedDryRun.dryRun, true)
    assert(dingtalkSignedDryRun.signedUrl.includes('timestamp='), 'DingTalk signed URL should include timestamp')
    assert(dingtalkSignedDryRun.signedUrl.includes('sign='), 'DingTalk signed URL should include sign')
    assert(!dingtalkSignedDryRun.signedUrl.includes('%25'), 'DingTalk sign should not be double-encoded')

    const wecomPayload = wecom.buildWeComWebhookPayload({ title: '任务', text: '已完成', mentionedList: ['zhangsan'] })
    assertEqual(wecomPayload.msgtype, 'markdown')
    assert(wecomPayload.markdown.content.includes('<@zhangsan>'), '企微 markdown 应包含成员提醒')
    const wecomSent = await wecom.sendWeComNotification(
      { title: '任务', text: 'send' },
      { webhookUrl: webhookServer.url, dryRun: false }
    )
    assertEqual(wecomSent.sent, true)
    assertEqual(webhookServer.requests.length, 2)

    const prUrl = gitee.buildGiteePullRequestUrl({
      owner: 'open-source',
      repo: 'caogen',
      title: 'P2-004',
      head: 'feature/p2-004',
      base: 'main',
      body: '国产生态适配'
    })
    assert(prUrl.includes('gitee.com/open-source/caogen/pulls/new'), 'Gitee PR URL 路径错误')
    assert(prUrl.includes('pull_request%5Bhead%5D=feature%2Fp2-004'), 'Gitee PR URL 参数错误')

    const prRequest = gitee.buildGiteePullRequestApiRequest(
      { owner: 'open-source', repo: 'caogen.git', title: 'P2-004 PR', head: 'feature/p2-004', base: 'main', body: 'PR body' },
      { accessToken: 'token-for-smoke', baseApiUrl: webhookServer.url }
    )
    assertEqual(prRequest.url, `${webhookServer.url}/repos/open-source/caogen/pulls`)
    assertEqual(prRequest.body.head, 'feature/p2-004')
    assertEqual(prRequest.body.base, 'main')

    const issueRequest = gitee.buildGiteeIssueApiRequest(
      { owner: 'open-source', repo: 'caogen.git', title: '问题标题', body: '问题正文', labels: ['p2', '国产生态'] },
      { accessToken: 'token-for-smoke', baseApiUrl: webhookServer.url }
    )
    assertEqual(issueRequest.url, `${webhookServer.url}/repos/open-source/caogen/issues`)
    assertEqual(issueRequest.body.labels, 'p2,国产生态')
    const giteeDryRun = await gitee.sendGiteeIssue(
      { owner: 'open-source', repo: 'caogen', title: '问题标题' },
      { accessToken: 'token-for-smoke', baseApiUrl: webhookServer.url }
    )
    assertEqual(giteeDryRun.ok, true)
    assertEqual(giteeDryRun.dryRun, true)
    assertEqual(giteeDryRun.sent, false)
    const giteeSent = await gitee.sendGiteeIssue(
      { owner: 'open-source', repo: 'caogen', title: '问题标题' },
      { accessToken: 'token-for-smoke', baseApiUrl: webhookServer.url, dryRun: false }
    )
    assertEqual(giteeSent.sent, true)
    assertEqual(webhookServer.requests.length, 3)

    assertSkill('aliyun-yunxiao-devops')
    assertSkill('tencent-coding-devops')
    assertSkill('wechat-miniprogram')
    await assertChinaPlatformApiMocks(webhookServer)
    assertRealNetworkScript()
    assertPackageScript('test:china-real-network', 'scripts/china-real-network-smoke.mjs')
    assertPackageScript('test:china-tool-call-parity', 'scripts/china-tool-call-parity.mjs')

    console.log('china ecosystem smoke ok')
  } finally {
    await webhookServer.close()
  }
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

function startJsonServer() {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: raw ? JSON.parse(raw) : {}
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法启动本地 smoke server')
      const url = `http://127.0.0.1:${address.port}`
      resolve({
        url,
        requests,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

function assertEqual(actual, expected) {
  assert(actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertSkill(name) {
  const skillPath = path.join(repoRoot, '.caogen', 'skills', name, 'SKILL.md')
  assert(existsSync(skillPath), `missing China ecosystem skill: ${name}`)
  const text = readFileSync(skillPath, 'utf8')
  assert(text.includes('## Steps'), `skill ${name} must document Steps`)
  assert(text.includes('## Verification'), `skill ${name} must document Verification`)
}

function assertPackageScript(scriptName, expectedCommandPart) {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const command = packageJson?.scripts?.[scriptName]
  assert(typeof command === 'string' && command.includes(expectedCommandPart), `missing package script: ${scriptName}`)
}

function assertRealNetworkScript() {
  const text = readFileSync(path.join(repoRoot, 'scripts', 'china-real-network-smoke.mjs'), 'utf8')
  for (const marker of [
    'gitee_pull_request',
    'ALIYUN_YUNXIAO_API_URL',
    'TENCENT_CODING_API_URL',
    'WECHAT_MINIPROGRAM_API_URL',
    'requestConfiguredApi'
  ]) {
    assert(text.includes(marker), `china real-network smoke missing ${marker}`)
  }
}

async function assertChinaPlatformApiMocks(webhookServer) {
  const before = webhookServer.requests.length
  const output = await runNode([path.join(repoRoot, 'scripts', 'china-real-network-smoke.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAOGEN_CHINA_REAL_NETWORK: '1',
      CAOGEN_CHINA_REAL_NETWORK_REQUIRED_TARGETS: 'aliyun_yunxiao_api,tencent_coding_api,wechat_miniprogram_api',
      ALIYUN_YUNXIAO_API_URL: `${webhookServer.url}/aliyun/yunxiao`,
      ALIYUN_YUNXIAO_TOKEN: 'aliyun-token-for-smoke',
      ALIYUN_YUNXIAO_BODY: JSON.stringify({ source: 'caogen-smoke', target: 'aliyun' }),
      TENCENT_CODING_API_URL: `${webhookServer.url}/tencent/coding`,
      TENCENT_CODING_TOKEN: 'coding-token-for-smoke',
      TENCENT_CODING_BODY: JSON.stringify({ source: 'caogen-smoke', target: 'coding' }),
      WECHAT_MINIPROGRAM_API_URL: `${webhookServer.url}/wechat/miniprogram`,
      WECHAT_MINIPROGRAM_TOKEN: 'wechat-token-for-smoke',
      WECHAT_MINIPROGRAM_BODY: JSON.stringify({ source: 'caogen-smoke', target: 'wechat' })
    }
  })
  const report = JSON.parse(output.slice(output.indexOf('{')))
  assertEqual(report.status, 'passed')
  for (const target of ['aliyun_yunxiao_api', 'tencent_coding_api', 'wechat_miniprogram_api']) {
    const result = report.results.find((item) => item.name === target)
    assert(result?.status === 'pass', `local China API mock did not pass: ${target}`)
  }
  assertEqual(webhookServer.requests.length, before + 3)
  assert(webhookServer.requests.some((item) => item.url === '/aliyun/yunxiao'), 'missing Aliyun mock request')
  assert(webhookServer.requests.some((item) => item.url === '/tencent/coding'), 'missing Tencent Coding mock request')
  assert(webhookServer.requests.some((item) => item.url === '/wechat/miniprogram'), 'missing WeChat miniprogram mock request')
}

function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`node ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`))
      }
    })
  })
}
