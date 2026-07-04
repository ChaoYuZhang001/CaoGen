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
  { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'], category: 'static' },
  { name: 'build', command: 'npm', args: ['run', 'build'], category: 'build' },
  { name: 'integration core', command: 'node', args: ['scripts/integration-test.cjs'], category: 'integration' },
  { name: 'integration modules', command: 'node', args: ['scripts/integration-test-2.cjs'], category: 'integration' },
  { name: 'attachmentOps smoke', command: 'node', args: ['scripts/attachment-ops-smoke.mjs'], category: 'smoke' },
  { name: 'browserAnnotations smoke', command: 'node', args: ['scripts/browser-annotations-smoke.mjs'], category: 'smoke' },
  { name: 'checkpointRestorePlan smoke', command: 'node', args: ['scripts/checkpoint-restore-plan-smoke.mjs'], category: 'smoke' },
  { name: 'fileOps smoke', command: 'node', args: ['scripts/file-ops-smoke.mjs'], category: 'smoke' },
  { name: 'memoryStore smoke', command: 'node', args: ['scripts/memory-store-smoke.mjs'], category: 'smoke' },
  { name: 'pluginRegistry smoke', command: 'node', args: ['scripts/plugin-registry-smoke.mjs'], category: 'smoke' },
  { name: 'previewOps smoke', command: 'node', args: ['scripts/preview-ops-smoke.mjs'], category: 'smoke' },
  { name: 'routineStore smoke', command: 'node', args: ['scripts/routine-store-smoke.mjs'], category: 'smoke' },
  { name: 'startSuggestions smoke', command: 'node', args: ['scripts/start-suggestions-smoke.mjs'], category: 'smoke' },
  { name: 'transcriptRestore smoke', command: 'node', args: ['scripts/transcript-restore-smoke.mjs'], category: 'smoke' },
  { name: 'worktreeMerge smoke', command: 'node', args: ['scripts/worktree-merge-smoke.mjs'], category: 'smoke' },
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
    recommendations.push('本轮自动化与页面操作深测全绿,可进入人工提测前的真实模型/API key E2E 验收。')
    recommendations.push('下一步应补预算闸门、逐 hunk diff、PDF 深渲染、浏览器截图批注和 worktree 合并 UI 的自动化断言。')
    return recommendations
  }
  for (const item of failed) {
    if (item.category === 'ui') {
      recommendations.push('页面操作 smoke 失败:优先查看截图与 JSON 报告,确认是否为选择器漂移、Electron 启动失败或真实 UI 回归。')
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

function escapePipe(value) {
  return String(value).replace(/\|/g, '\\|')
}
