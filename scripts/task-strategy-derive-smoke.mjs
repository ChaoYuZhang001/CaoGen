#!/usr/bin/env node
/**
 * QA 独立 smoke — 覆盖 AC-4(派生)/AC-7(迁移)/cross-validation 只读兜底。
 *
 * 现有 task-strategy-smoke.mjs 已覆盖 decideTaskStrategyTool 的 view/plan/execute
 * 拦截矩阵，但未覆盖 P0 新增的 derivePermissionModeFromStrategy / migrateLegacyPermissionMode
 * 以及 plan 档下 write_file/run_command/git_commit 的显式拒绝。本脚本补齐。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const outDir = mkdtempSync(path.join(tmpdir(), 'caogen-derive-smoke-'))

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      'src/main/task/task-strategy.ts',
      '--outDir', outDir,
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck'
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )

  const strategy = await import(pathToFileURL(path.join(outDir, 'main', 'task', 'task-strategy.js')).href)

  // ── AC-4: derivePermissionModeFromStrategy 派生映射 ──────────────────────
  assert.equal(
    strategy.derivePermissionModeFromStrategy('execute'), 'acceptEdits',
    'AC-4: execute 必须派生为 acceptEdits(编辑自动放行, 高危逐次询问)'
  )
  assert.equal(
    strategy.derivePermissionModeFromStrategy('view'), 'default',
    'AC-4: view 必须派生为 default(preflight 已拦截所有非只读工具)'
  )
  assert.equal(
    strategy.derivePermissionModeFromStrategy('plan'), 'default',
    'AC-4: plan 必须派生为 default(preflight 已拦截写操作, 旧 plan gate 分支已删)'
  )
  // driveMode 参数 P0 不参与派生(Q-6 决议), 传入任意值不影响结果
  assert.equal(
    strategy.derivePermissionModeFromStrategy('execute', 'spark'), 'acceptEdits',
    'AC-4: driveMode 不应影响派生(Q-6 决议)'
  )
  assert.equal(
    strategy.derivePermissionModeFromStrategy('execute', 'genesis'), 'acceptEdits',
    'AC-4: driveMode=genesis 也不应影响派生'
  )

  // ── AC-7: migrateLegacyPermissionMode 老会话迁移 ────────────────────────
  // 旧 bypassPermissions + taskStrategy=execute → acceptEdits + downgradedFromBypass=true
  {
    const r = strategy.migrateLegacyPermissionMode('bypassPermissions', 'execute')
    assert.equal(r.mode, 'acceptEdits', 'AC-7: bypassPermissions+execute → acceptEdits')
    assert.equal(r.downgradedFromBypass, true, 'AC-7: downgradedFromBypass 标记')
    assert.equal(r.migratedFromPlan, false, 'AC-7: 非 plan 迁移')
  }
  // 旧 plan + taskStrategy=plan → default + migratedFromPlan=true
  {
    const r = strategy.migrateLegacyPermissionMode('plan', 'plan')
    assert.equal(r.mode, 'default', 'AC-7: plan+plan → default')
    assert.equal(r.migratedFromPlan, true, 'AC-7: migratedFromPlan 标记')
    assert.equal(r.downgradedFromBypass, false, 'AC-7: 非 bypass 迁移')
  }
  // 旧 bypassPermissions + taskStrategy=view → default + downgradedFromBypass=true
  {
    const r = strategy.migrateLegacyPermissionMode('bypassPermissions', 'view')
    assert.equal(r.mode, 'default', 'AC-7: bypassPermissions+view → default(派生覆盖旧值)')
    assert.equal(r.downgradedFromBypass, true, 'AC-7: bypass 仍标记')
  }
  // 旧 default + taskStrategy=execute → acceptEdits, 无迁移标记
  {
    const r = strategy.migrateLegacyPermissionMode('default', 'execute')
    assert.equal(r.mode, 'acceptEdits', 'AC-7: default+execute → acceptEdits')
    assert.equal(r.downgradedFromBypass, false, 'AC-7: 非 bypass')
    assert.equal(r.migratedFromPlan, false, 'AC-7: 非 plan')
  }
  // undefined 旧值(全新会话场景) → 派生值, 无标记
  {
    const r = strategy.migrateLegacyPermissionMode(undefined, 'execute')
    assert.equal(r.mode, 'acceptEdits', 'AC-7: undefined+execute → acceptEdits')
    assert.equal(r.downgradedFromBypass, false)
    assert.equal(r.migratedFromPlan, false)
  }

  // ── cross-validation 只读兜底(安全铁律 §7.5) ──────────────────────────
  // cross-validation-runtime.ts 改用 taskStrategy:'plan' 后, 写工具必须被
  // decideTaskStrategyTool('plan',...) 在 preflight 层拒绝。
  // gate 的 mode==='plan' 分支已删, preflight 兜底失败 = 安全回归。
  for (const tool of ['write_file', 'run_command', 'git_commit', 'search_replace']) {
    const d = strategy.decideTaskStrategyTool('plan', tool, {})
    assert.equal(d.allow, false,
      `cross-validation 安全: plan 档必须拒绝 ${tool}(preflight 兜底只读保护)`)
    assert.ok(d.message, `plan/${tool} 拒绝须有说明文案`)
  }
  // plan 档仍放行 task_decompose(可生成 TaskPlan)
  assert.equal(
    strategy.decideTaskStrategyTool('plan', 'task_decompose', {}).allow, true,
    'AC-3: plan 档应放行 task_decompose(可生成 TaskPlan)'
  )
  // plan 档放行只读工具
  assert.equal(
    strategy.decideTaskStrategyTool('plan', 'read_file', {}).allow, true,
    'plan 档应放行只读工具 read_file'
  )

  // ── AC-2: view 档显式拒绝 write_file/run_command/git_commit ──────────
  for (const tool of ['write_file', 'run_command', 'git_commit']) {
    const d = strategy.decideTaskStrategyTool('view', tool, {})
    assert.equal(d.allow, false, `AC-2: view 档必须拒绝 ${tool}`)
  }

  // ── AC-3: plan 批准后仍不能执行写(plan 档不因批准而放行写) ──────────
  // decideTaskStrategyTool 是无状态的, 不看批准状态, plan 档始终拒绝写
  const writeInPlan = strategy.decideTaskStrategyTool('plan', 'write_file', { approved: true })
  assert.equal(writeInPlan.allow, false,
    'AC-3: plan 档即使有 approved 标记也拒绝 write_file(策略无状态, 批准不改变拦截)')

  console.log('task-strategy-derive-smoke: PASS')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
