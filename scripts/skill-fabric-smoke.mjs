import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-skill-fabric-'))
const outDir = path.join(tempRoot, 'compiled')
const projectRoot = path.join(tempRoot, 'project')
const mcpServerPath = path.join(tempRoot, 'fake-fabric-mcp.cjs')

try {
  mkdirSync(path.join(projectRoot, '.caogen', 'skills', 'react-review'), { recursive: true })
  writeFileSync(
    path.join(projectRoot, '.caogen', 'skills', 'react-review', 'SKILL.md'),
    [
      '---',
      'name: React Review Workflow',
      'description: Review React components, props, accessibility, and verification commands.',
      'trigger: react review component accessibility',
      'tags: [react, review, accessibility]',
      '---',
      '',
      '# React Review Workflow',
      '',
      '## Steps',
      '1. Inspect component props and rendering branches.',
      '2. Check accessibility labels and keyboard behavior.',
      '3. Verify tests or typecheck cover the change.',
      '',
      '## Verification',
      '1. npm run typecheck',
      '2. npm run build'
    ].join('\n'),
    'utf8'
  )
  writeFileSync(mcpServerPath, fakeMcpServer(), 'utf8')

  compile(['src/main/skill/skill-fabric.ts'], outDir)
  const fabricModule = await import(pathToFileURL(findCompiled(outDir, 'skill-fabric.js')).href)
  const {
    SkillFabric,
    evaluateMcpPermission,
    mcpToolCapabilityId,
    skillCapabilityId
  } = fabricModule

  const deniedFabric = new SkillFabric({
    projectRoot,
    mcpServers: {
      workspace: {
        command: process.execPath,
        args: [mcpServerPath]
      }
    },
    mcpDiscoveryTimeoutMs: 3_000,
    now: () => Date.UTC(2026, 6, 7, 1, 0, 0)
  })

  const deniedView = await deniedFabric.refresh()
  const localSkill = deniedView.capabilities.find((item) => item.name === 'React Review Workflow')
  assert(localSkill, 'project skill should become a fabric capability')
  assertEqual(localSkill.status, 'available')
  assert(deniedView.lifecycle.some((item) => item.kind === 'mcpServer' && item.status === 'available'), 'MCP server should be discovered')
  const blockedTool = deniedView.capabilities.find((item) => item.id === mcpToolCapabilityId('workspace', 'read_project'))
  assert(blockedTool, 'MCP tool should become a fabric capability')
  assertEqual(blockedTool.status, 'blocked')

  const matches = await deniedFabric.match('review a React component and read project context through workspace MCP', {
    skillThreshold: 0.12,
    mcpThreshold: 0.12
  })
  assert(matches.some((match) => match.capability.id === localSkill.id), 'match should include relevant skill')
  assert(matches.some((match) => match.capability.id === blockedTool.id), 'match should include relevant MCP tool with blocked reason')

  const skillInvoke = await deniedFabric.invoke({
    capabilityId: localSkill.id,
    query: 'review this React component for accessibility'
  })
  assertEqual(skillInvoke.ok, true)
  assertEqual(skillInvoke.execution, 'prompt-only')
  assert(skillInvoke.output.includes('does not execute shell commands'), 'skill invocation must be prompt-only truth')
  assert(skillInvoke.output.includes('React Review Workflow'), 'skill prompt should include matched skill')

  const blockedInvoke = await deniedFabric.invoke({
    capabilityId: blockedTool.id,
    arguments: { path: 'src/App.tsx' }
  })
  assertEqual(blockedInvoke.ok, false)
  assertEqual(blockedInvoke.execution, 'blocked')
  assert(blockedInvoke.error.includes('requires explicit allow policy'), 'default MCP policy should deny tool calls')

  const allowedFabric = new SkillFabric({
    projectRoot,
    mcpServers: {
      workspace: {
        command: process.execPath,
        args: [mcpServerPath]
      }
    },
    mcpDiscoveryTimeoutMs: 3_000,
    mcpPermissionPolicy: {
      allowedTools: ['mcp__workspace__read_project']
    }
  })
  await allowedFabric.refresh()
  const allowedInvoke = await allowedFabric.invoke({
    kind: 'mcpTool',
    serverId: 'workspace',
    toolName: 'read_project',
    arguments: { path: 'src/App.tsx' }
  })
  assertEqual(allowedInvoke.ok, true)
  assertEqual(allowedInvoke.execution, 'tool-call')
  assert(allowedInvoke.output.includes('src/App.tsx'), 'allowed MCP tool call should return server content')

  const draft = allowedFabric.draftSkill({
    title: 'Fabric Generated Skill',
    taskSummary: 'Create a reusable Skill and verify it through the Skill Fabric smoke.',
    verification: ['node scripts/skill-fabric-smoke.mjs']
  })
  assertEqual(draft.ok, true)
  assert(draft.markdown.includes('Fabric Generated Skill'), 'fabric should expose skill drafting')

  const unsafe = allowedFabric.testSkill([
    '---',
    'name: Unsafe Fabric Skill',
    'description: Unsafe',
    '---',
    '',
    '## Steps',
    '- rm -rf /tmp/demo',
    '',
    '## Verification',
    '- echo done'
  ].join('\n'))
  assertEqual(unsafe.ok, false)
  assert(unsafe.diagnostics.some((item) => item.code === 'dangerous_command'), 'fabric skill test should report dangerous command')

  const mcpTest = await allowedFabric.testMcpServer('workspace')
  assertEqual(mcpTest.status, 'available')

  const skipped = await new SkillFabric({
    projectRoot,
    mcpServers: {
      workspace: {
        command: process.execPath,
        args: [mcpServerPath]
      }
    }
  }).refresh({ discoverMcp: false })
  assert(skipped.lifecycle.some((item) => item.kind === 'mcpServer' && item.status === 'configured'), 'refresh can record configured MCP without claiming discovery')

  assertEqual(evaluateMcpPermission({ deniedServers: ['workspace'], defaultToolCall: 'allow' }, 'workspace', 'read_project').allowed, false)
  assert(skillCapabilityId(localSkill.invocation.skillId) === localSkill.id, 'skill capability helper should be stable')

  console.log('skillFabric smoke ok')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function fakeMcpServer() {
  return `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const request = JSON.parse(line)
  const result = handle(request.method, request.params || {})
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})
function handle(method, params) {
  if (method === 'initialize') return { serverInfo: { name: 'fabric-mcp', version: '1.0.0' } }
  if (method === 'tools/list') {
    return {
      tools: [
        {
          name: 'read_project',
          description: 'Read project context for React review workflows.',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      ]
    }
  }
  if (method === 'resources/list') return { resources: [{ uri: 'project://summary', name: 'Project Summary' }] }
  if (method === 'prompts/list') return { prompts: [{ name: 'review-react', description: 'Review React code' }] }
  if (method === 'tools/call') {
    return {
      content: [
        {
          type: 'text',
          text: 'fabric read ' + String((params.arguments || {}).path || 'unknown')
        }
      ]
    }
  }
  return {}
}
`
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
  throw new Error(`compiled file not found: ${fileName}`)
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
