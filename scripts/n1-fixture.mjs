#!/usr/bin/env node
/**
 * N1 迁移演练 fixture 生成器:在临时目录里造出一个"典型竞品深度用户"的资产集
 * (Codex + Cursor + Cline + Aider 的 rules/MCP/约定文件),供 N1 30 分钟迁移
 * 实测的被测项目。只写临时目录,不碰真实工具配置。
 *
 * 运行: node scripts/n1-fixture.mjs [目标目录]
 *   缺省在 ~/caogen-n1-drill 生成(可重复运行,幂等覆盖)。
 * 输出:项目路径 + 资产清单,照 docs/N1-MIGRATION-DRILL.md 走。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const target = process.argv[2] || join(homedir(), 'caogen-n1-drill')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

// 一个最小可跑的真实项目(让 @文件 / 改代码 / 审 diff / 提交 有真东西可操作)
mkdirSync(join(target, 'src'), { recursive: true })
writeFileSync(
  join(target, 'package.json'),
  JSON.stringify({ name: 'n1-drill-app', version: '0.1.0', scripts: { test: 'node src/sum.test.js' } }, null, 2)
)
writeFileSync(
  join(target, 'src', 'sum.js'),
  '// 有意留个 bug:应为 a + b\nexport function sum(a, b) {\n  return a - b\n}\n'
)
writeFileSync(
  join(target, 'src', 'sum.test.js'),
  "import { sum } from './sum.js'\nif (sum(2, 3) !== 5) { console.error('FAIL: sum(2,3) 应为 5'); process.exit(1) }\nconsole.log('ok')\n"
)
writeFileSync(join(target, 'README.md'), '# N1 Drill App\n\n一个用于 CaoGen 迁移演练的最小项目。src/sum.js 里有一个待修的 bug。\n')

// ---- Codex 资产 ----
writeFileSync(
  join(target, 'AGENTS.md'),
  '# 项目约定(Codex)\n\n- 用 ES modules\n- 所有函数写单元测试\n- 提交信息用中文,首行 ≤ 50 字\n'
)

// ---- Cursor 资产 ----
mkdirSync(join(target, '.cursor', 'rules'), { recursive: true })
writeFileSync(join(target, '.cursorrules'), '优先用纯函数;避免引入新依赖,除非必要。')
writeFileSync(
  join(target, '.cursor', 'rules', 'style.mdc'),
  '---\ndescription: 代码风格\n---\n单引号、无分号、2 空格缩进。'
)
writeFileSync(
  join(target, '.cursor', 'mcp.json'),
  JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] } } }, null, 2)
)

// ---- Cline 资产 ----
writeFileSync(join(target, '.clinerules'), '修改前先读文件;改完跑 npm test 验证。')
mkdirSync(join(target, '.cline'), { recursive: true })
writeFileSync(
  join(target, '.cline', 'mcp.json'),
  JSON.stringify({ mcpServers: { git: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-git'] } } }, null, 2)
)

// ---- Aider 资产 ----
writeFileSync(join(target, 'CONVENTIONS.md'), '# Aider 约定\n\n- 小步提交\n- 每次只改一个关注点\n')

console.log('N1 迁移演练 fixture 已生成:')
console.log('  项目目录:', target)
console.log('  竞品资产:AGENTS.md(Codex) / .cursorrules + .cursor/rules/*.mdc + .cursor/mcp.json(Cursor)')
console.log('           / .clinerules + .cline/mcp.json(Cline) / CONVENTIONS.md(Aider)')
console.log('  待修 bug:src/sum.js 的 sum() 用了减法,应为加法(npm test 会失败)')
console.log('\n照 docs/N1-MIGRATION-DRILL.md 计时走一遍。')
