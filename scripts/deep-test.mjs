#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const outRoot = path.join(repoRoot, 'test-results', 'caogen-deep')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = path.join(outRoot, runId)

mkdirSync(runDir, { recursive: true })

const commands = [
  { name: 'typecheck', ...commandSpec('npm', ['run', 'typecheck']), category: 'static' },
  { name: 'build', ...commandSpec('npm', ['run', 'build']), category: 'build' },
  { name: 'P0/P1/P2 contract smoke', command: 'node', args: ['scripts/p0-p1-p2-contract-smoke.mjs'], category: 'smoke' },
  { name: 'integration core', command: 'node', args: ['scripts/integration-test.cjs'], category: 'integration' },
  { name: 'integration modules', command: 'node', args: ['scripts/integration-test-2.cjs'], category: 'integration' },
  { name: 'integration wired modules', command: 'node', args: ['scripts/integration-test-3.cjs'], category: 'integration' },
  { name: 'taskDag smoke', command: 'node', args: ['scripts/task-dag-smoke.cjs'], category: 'smoke' },
  { name: 'taskDag recovery smoke', command: 'node', args: ['scripts/task-dag-recovery-smoke.cjs'], category: 'smoke' },
  { name: 'attachmentOps smoke', command: 'node', args: ['scripts/attachment-ops-smoke.mjs'], category: 'smoke' },
  { name: 'browserAnnotations smoke', command: 'node', args: ['scripts/browser-annotations-smoke.mjs'], category: 'smoke' },
  { name: 'checkpointRestorePlan smoke', command: 'node', args: ['scripts/checkpoint-restore-plan-smoke.mjs'], category: 'smoke' },
  { name: 'fileOps smoke', command: 'node', args: ['scripts/file-ops-smoke.mjs'], category: 'smoke' },
  { name: 'searchReplace/view smoke', command: 'node', args: ['scripts/search-replace-smoke.mjs'], category: 'smoke' },
  { name: 'indexer smoke', command: 'node', args: ['scripts/indexer-smoke.mjs'], category: 'smoke' },
  { name: 'context loader smoke', command: 'node', args: ['scripts/context-loader-smoke.mjs'], category: 'smoke' },
  { name: 'sandbox permission smoke', command: 'node', args: ['scripts/p0-004-sandbox-permission-smoke.mjs'], category: 'smoke' },
  { name: 'gui permission smoke', command: 'node', args: ['scripts/gui-permission-smoke.mjs'], category: 'smoke' },
  { name: 'gui windows smoke', command: 'node', args: ['scripts/gui-windows-smoke.mjs'], category: 'smoke' },
  { name: 'gui macos smoke', command: 'node', args: ['scripts/gui-macos-smoke.mjs'], category: 'smoke' },
  { name: 'gui nutjs smoke', command: 'node', args: ['scripts/gui-nutjs-smoke.mjs'], category: 'smoke' },
  { name: 'task snapshot smoke', command: 'node', args: ['scripts/task-snapshot-smoke.mjs'], category: 'smoke' },
  { name: 'git tools smoke', command: 'node', args: ['scripts/git-tools-smoke.mjs'], category: 'smoke' },
  { name: 'context compressor smoke', command: 'node', args: ['scripts/context-compressor-smoke.mjs'], category: 'smoke' },
  { name: 'memoryStore smoke', command: 'node', args: ['scripts/memory-store-smoke.mjs'], category: 'smoke' },
  { name: 'layeredMemory smoke', command: 'node', args: ['scripts/layered-memory-smoke.mjs'], category: 'smoke' },
  { name: 'memorySuggestion e2e', command: 'node', args: ['scripts/memory-suggestion-e2e.mjs'], category: 'ui' },
  { name: 'pluginRegistry smoke', command: 'node', args: ['scripts/plugin-registry-smoke.mjs'], category: 'smoke' },
  { name: 'skillManager smoke', command: 'node', args: ['scripts/skill-manager-smoke.mjs'], category: 'smoke' },
  { name: 'skillLearner smoke', command: 'node', args: ['scripts/skill-learner-smoke.mjs'], category: 'smoke' },
  { name: 'autoSkillReview smoke', command: 'node', args: ['scripts/auto-skill-review-smoke.mjs'], category: 'smoke' },
  { name: 'skillOptimizer smoke', command: 'node', args: ['scripts/skill-optimizer-smoke.mjs'], category: 'smoke' },
  { name: 'skillInvocation smoke', command: 'node', args: ['scripts/skill-invocation-smoke.mjs'], category: 'smoke' },
  { name: 'mcpClient smoke', command: 'node', args: ['scripts/mcp-client-smoke.mjs'], category: 'smoke' },
  { name: 'plugin slash smoke', command: 'node', args: ['scripts/plugin-slash-smoke.mjs'], category: 'smoke' },
  { name: 'previewOps smoke', command: 'node', args: ['scripts/preview-ops-smoke.mjs'], category: 'smoke' },
  { name: 'previewUtils smoke', command: 'node', args: ['scripts/preview-utils-smoke.mjs'], category: 'smoke' },
  { name: 'previewAnnotations smoke', command: 'node', args: ['scripts/preview-annotations-smoke.mjs'], category: 'smoke' },
  { name: 'routineStore smoke', command: 'node', args: ['scripts/routine-store-smoke.mjs'], category: 'smoke' },
  { name: 'routineRunner smoke', command: 'node', args: ['scripts/routine-runner-smoke.mjs'], category: 'smoke' },
  { name: 'openai P1 tools smoke', command: 'node', args: ['scripts/openai-p1-tools-smoke.mjs'], category: 'smoke' },
  { name: 'startSuggestions smoke', command: 'node', args: ['scripts/start-suggestions-smoke.mjs'], category: 'smoke' },
  { name: 'startSuggestions e2e', command: 'node', args: ['scripts/start-suggestions-e2e.mjs'], category: 'ui' },
  { name: 'transcriptRestore smoke', command: 'node', args: ['scripts/transcript-restore-smoke.mjs'], category: 'smoke' },
  { name: 'transcriptSearch smoke', command: 'node', args: ['scripts/transcript-search-smoke.mjs'], category: 'smoke' },
  { name: 'pluginInstall smoke', command: 'node', args: ['scripts/plugin-install-smoke.mjs'], category: 'smoke' },
  { name: 'modelStats smoke', command: 'node', args: ['scripts/model-stats-smoke.mjs'], category: 'smoke' },
  { name: 'modelRouter smoke', command: 'node', args: ['scripts/model-router-smoke.mjs'], category: 'smoke' },
  { name: 'modelOptimization smoke', command: 'node', args: ['scripts/model-optimization-smoke.mjs'], category: 'smoke' },
  { name: 'modelCrossValidation smoke', command: 'node', args: ['scripts/model-cross-validation-smoke.mjs'], category: 'smoke' },
  { name: 'chinaEcosystem smoke', command: 'node', args: ['scripts/china-ecosystem-smoke.mjs'], category: 'smoke' },
  { name: 'chinaModelProvider smoke', command: 'node', args: ['scripts/china-model-provider-smoke.mjs'], category: 'smoke' },
  { name: 'chinaRealNetwork smoke', command: 'node', args: ['scripts/china-real-network-smoke.mjs'], category: 'smoke' },
  { name: 'chinaToolCallParity smoke', command: 'node', args: ['scripts/china-tool-call-parity.mjs'], category: 'smoke' },
  { name: 'ideBridge smoke', command: 'node', args: ['scripts/ide-bridge-smoke.mjs'], category: 'smoke' },
  { name: 'openai P2 tools smoke', command: 'node', args: ['scripts/openai-p2-tools-smoke.mjs'], category: 'smoke' },
  { name: 'responses tools e2e', ...commandSpec('npx', ['electron', 'scripts/responses-tools-e2e.cjs']), category: 'system' },
  { name: 'history compress e2e', ...commandSpec('npx', ['electron', 'scripts/history-compress-e2e.cjs']), category: 'system' },
  { name: 'claude real e2e', ...commandSpec('npx', ['electron', 'scripts/claude-real-e2e.cjs']), category: 'system' },
  { name: 'worktreeMerge smoke', command: 'node', args: ['scripts/worktree-merge-smoke.mjs'], category: 'smoke' },
  { name: 'taskDag autoMerge e2e', ...commandSpec('npx', ['electron', 'scripts/task-dag-automerge-e2e.cjs']), category: 'system' },
  { name: 'Electron main IPC smoke', ...commandSpec('npx', ['electron', 'scripts/electron-smoke.cjs']), category: 'system' },
  { name: 'OpenAI mock e2e', command: 'node', args: ['scripts/openai-mock-e2e.mjs'], category: 'system' },
  { name: 'orchestration mock e2e', command: 'node', args: ['scripts/orchestration-mock-e2e.mjs'], category: 'ui' },
  { name: 'X1/S3 e2e', command: 'node', args: ['scripts/x1-s3-e2e.mjs'], category: 'ui' },
  { name: 'page operations smoke', command: 'node', args: ['scripts/page-operation-smoke.mjs'], category: 'ui' }
]

const startedAt = new Date().toISOString()
const results = []

for (const item of commands) {
  const result = await runCommand(item)
  results.push(result)
  const icon = result.status === 'pass' ? 'PASS' : 'FAIL'
  console.log(`[${icon}] ${item.name} (${result.durationMs}ms)`)
  if (result.status === 'fail') break
}

const finishedAt = new Date().toISOString()
const failed = results.filter((item) => item.status === 'fail')
const status = failed.length === 0 && results.length === commands.length ? 'pass' : 'fail'
const report = {
  runId,
  startedAt,
  finishedAt,
  status,
  repoRoot,
  runDir,
  results,
  missingCommands: commands.slice(results.length).map((item) => item.name),
  recommendations: buildRecommendations(results)
}

writeFileSync(path.join(runDir, 'deep-test-report.json'), JSON.stringify(report, null, 2))
writeFileSync(path.join(runDir, 'deep-test-report.md'), renderMarkdown(report))
writeFileSync(path.join(outRoot, 'latest.json'), JSON.stringify(report, null, 2))
writeFileSync(path.join(outRoot, 'latest.md'), renderMarkdown(report))

console.log(`deep test report: ${path.join(runDir, 'deep-test-report.md')}`)
process.exitCode = status === 'pass' ? 0 : 1

async function runCommand(item) {
  const started = Date.now()
  const outputPath = path.join(runDir, `${slug(item.name)}.log`)
  let stdout = ''
  let stderr = ''
  const child = spawn(item.command, item.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exit = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: 1, signal: null, error }))
    child.on('close', (code, signal) => resolve({ code, signal, error: null }))
  })
  const durationMs = Date.now() - started
  const output = [
    `$ ${item.command} ${item.args.join(' ')}`,
    '',
    stdout.trim(),
    stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  writeFileSync(outputPath, output)
  return {
    ...item,
    commandLine: `${item.command} ${item.args.join(' ')}`,
    status: exit.code === 0 ? 'pass' : 'fail',
    exitCode: exit.code,
    signal: exit.signal,
    durationMs,
    outputPath,
    summary: summarize(stdout, stderr, exit.error)
  }
}

function buildRecommendations(items) {
  const recommendations = []
  const failed = items.filter((item) => item.status === 'fail')
  if (failed.length === 0 && items.length === commands.length) {
    recommendations.push('本轮静态检查、构建、模块集成、真 Electron IPC、mock OpenAI 流式 E2E 与页面操作深测全绿。')
    recommendations.push('下一步应补真实 API key/真实 Claude SDK 提测,用于覆盖外部账号/额度/网络不确定性。')
    return recommendations
  }
  for (const item of failed) {
    if (item.category === 'ui') {
      recommendations.push('页面操作 smoke 失败:优先查看截图与 JSON 报告,确认是否为选择器漂移、Electron 启动失败或真实 UI 回归。')
    } else if (item.category === 'system') {
      recommendations.push('真 Electron/IPC 系统冒烟失败:优先确认 build 产物、Electron runtime 与 ipcMain handler 注册是否一致。')
    } else if (item.category === 'build' || item.category === 'static') {
      recommendations.push('编译/类型检查失败:阻断提测,先修复 TS/build 输出再跑后续 smoke。')
    } else {
      recommendations.push(`${item.name} 失败:从 ${item.outputPath} 定位模块级回归,修复后单跑该脚本再跑 test:deep。`)
    }
  }
  return [...new Set(recommendations)]
}

function renderMarkdown(report) {
  const lines = []
  lines.push(`# CaoGen Deep Test ${report.runId}`)
  lines.push('')
  lines.push(`- Status: ${report.status}`)
  lines.push(`- Started: ${report.startedAt}`)
  lines.push(`- Finished: ${report.finishedAt}`)
  lines.push(`- Repo: ${report.repoRoot}`)
  lines.push('')
  lines.push('| Check | Category | Status | Duration | Log |')
  lines.push('|---|---|---|---:|---|')
  for (const item of report.results) {
    lines.push(
      `| ${escapePipe(item.name)} | ${item.category} | ${item.status} | ${item.durationMs}ms | ${path.relative(report.repoRoot, item.outputPath)} |`
    )
  }
  if (report.missingCommands.length > 0) {
    lines.push('')
    lines.push(`Skipped after first failure: ${report.missingCommands.join(', ')}`)
  }
  lines.push('')
  lines.push('## Recommendations')
  for (const item of report.recommendations) lines.push(`- ${item}`)
  lines.push('')
  lines.push('## Latest Output Summaries')
  for (const item of report.results) {
    lines.push(`### ${item.name}`)
    lines.push('```text')
    lines.push(item.summary || '(no output)')
    lines.push('```')
  }
  lines.push('')
  return lines.join('\n')
}

function summarize(stdout, stderr, error) {
  if (error) return String(error.message || error)
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
  return lines.slice(-30).join('\n')
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'command'
}

function electronCommand() {
  if (process.env.ELECTRON_BIN) return process.env.ELECTRON_BIN
  return path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron'
  )
}

function commandSpec(command, args) {
  return process.platform === 'win32'
    ? { command: 'cmd', args: ['/c', command, ...args] }
    : { command, args }
}

function escapePipe(value) {
  return String(value).replace(/\|/g, '\\|')
}
