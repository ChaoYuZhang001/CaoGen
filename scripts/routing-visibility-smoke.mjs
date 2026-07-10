import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const repoRoot = process.cwd()
const require = createRequire(import.meta.url)
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-routing-visibility-'))
const reportRoot = path.join(repoRoot, 'test-results', 'routing-visibility')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportDir = path.join(reportRoot, runId)
let finalStatus = 'failed'
let finalError = null

try {
  const esbuild = require('esbuild')
  const bundlePath = path.join(tempRoot, 'message-item.cjs')
  esbuild.buildSync({
    entryPoints: [path.join(repoRoot, 'src/renderer/src/components/MessageItem.tsx')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/server']
  })
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tempRoot, 'node_modules'), 'dir')

  const module = require(bundlePath)
  const MessageItem = module.default?.default ?? module.default
  assert(MessageItem, 'MessageItem should bundle for server rendering')

  const html = renderToStaticMarkup(
    React.createElement(MessageItem, {
      item: {
        id: 'route-visibility',
        kind: 'routing',
        providerId: 'provider-a',
        providerName: 'Provider A',
        model: 'fast-model',
        reason: 'Drive=Core；智能调度选择 Provider A/fast-model；任务=coding+review；策略=speed',
        decision: {
          providerId: 'provider-a',
          providerName: 'Provider A',
          model: 'fast-model',
          strategy: 'speed',
          taskKinds: ['coding', 'review'],
          riskLevel: 'high',
          candidateCount: 4,
          score: 88,
          reliability: 0.96,
          estimatedCostUsd: 0.03,
          latencyEmaMs: 480,
          remainingBudgetUsd: 0.2,
          manualOverrideApplied: true,
          selectionReason: '速度优先评分最优',
          selectedReasons: ['能力匹配 48.0', '可靠性 0.96', '估算成本 $0.0300', '延迟档 fast', '历史延迟 EMA 480ms'],
          budgetDowngraded: true,
          switchedProvider: true,
          warnings: ['手动覆盖命中预算上限，已按硬预算尝试降级。'],
          alternatives: [
            {
              providerId: 'provider-b',
              providerName: 'Provider B',
              model: 'strong-model',
              score: 81,
              reliability: 0.92,
              estimatedCostUsd: 0.01,
              latencyEmaMs: 260
            }
          ],
          createdAt: Date.now()
        },
        crossValidationPlan: {
          enabled: true,
          primary: { providerId: 'provider-a', providerName: 'Provider A', model: 'fast-model' },
          validators: [{ providerId: 'provider-b', providerName: 'Provider B', model: 'strong-model' }],
          policy: 'review-primary',
          reason: '高风险任务已生成异质模型复核计划。'
        }
      },
      toolResults: {},
      runningTools: {}
    })
  )

  assert(html.includes('data-routing-provider="provider-a"'), 'routing note should expose provider id')
  assert(html.includes('data-routing-decision="structured"'), 'routing note should expose structured decision state')
  assert(html.includes('Provider A') && html.includes('fast-model'), 'routing summary should show provider and model')
  assert(html.includes('查看调度详情'), 'routing note should expose expandable details')
  assert(html.includes('速度优先'), 'routing details should show speed strategy')
  assert(html.includes('延迟档 fast') && html.includes('历史延迟 EMA 480ms'), 'speed routing details should explain latency inputs')
  assert(html.includes('代码') && html.includes('审查'), 'routing details should show inferred tasks')
  assert(html.includes('候选模型') && html.includes('4'), 'routing details should show candidate count')
  assert(html.includes('预算降级') && html.includes('跨厂商'), 'routing summary should show critical decision badges')
  assert(html.includes('Provider B') && html.includes('strong-model'), 'routing details should show alternatives')
  assert(html.includes('预算上限'), 'routing details should show warnings')

  const storeSource = readFileSync(path.join(repoRoot, 'src/renderer/src/store.ts'), 'utf8')
  assert(storeSource.includes('providerId: ev.providerId'), 'renderer store must preserve routing provider id')
  assert(storeSource.includes('decision: ev.decision'), 'renderer store must preserve structured routing decision')

  const officeSource = readFileSync(path.join(repoRoot, 'src/renderer/src/components/office/OfficeView.tsx'), 'utf8')
  assert(officeSource.includes('activeOfficeSignal.routing.providerName'), '3D office should show routed provider name')
  assert(officeSource.includes('activeOfficeSignal.routing.strategy'), '3D office should show the effective routing strategy')
  assert(officeSource.includes('activeOfficeSignal.routing.basis'), '3D office should show routing basis')

  finalStatus = 'passed'
  console.log(`routing visibility smoke ok: ${reportDir}`)
} catch (error) {
  finalError = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  mkdirSync(reportDir, { recursive: true })
  const report = {
    runId,
    status: finalStatus,
    error: finalError,
    coverage: [
      'renderer store preserves provider and structured decision',
      'chat routing note renders provider, model, strategy, tasks, budget, alternatives, and warnings',
      '3D office exposes routed provider and selection basis'
    ],
    generatedAt: new Date().toISOString()
  }
  writeFileSync(path.join(reportDir, 'routing-visibility-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
  rmSync(tempRoot, { recursive: true, force: true })
}

function assert(condition, message = 'assertion failed') {
  if (!condition) throw new Error(message)
}
