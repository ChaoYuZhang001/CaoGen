import { homedir } from 'node:os'
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { MigrationAsset, MigrationScan } from '../shared/types'

/**
 * D11 · 迁移向导:检测其他 Agent 的配置资产并一键导入。
 * 红线:只读扫描;导入前逐项确认;绝不修改来源工具的文件;CLAUDE.md 先备份。
 */

const PREVIEW_CHARS = 400

function readPreview(path: string): string {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
  } catch {
    return ''
  }
}

function fileAsset(agent: string, kind: MigrationAsset['kind'], path: string): MigrationAsset | null {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size === 0 || st.size > 512 * 1024) return null
    return { agent, kind, path, name: basename(path), preview: readPreview(path) }
  } catch {
    return null
  }
}

/** 目录下所有小文本文件(rules 目录场景) */
function dirAssets(agent: string, kind: MigrationAsset['kind'], dir: string): MigrationAsset[] {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .map((n) => fileAsset(agent, kind, join(dir, n)))
      .filter((a): a is MigrationAsset => a !== null)
      .slice(0, 20)
  } catch {
    return []
  }
}

/**
 * 扫描项目级 + 用户级的他家 Agent 资产。
 * 规则文件 → 可注入 CLAUDE.md;MCP 配置 → 可合并 .mcp.json。
 */
export function scanMigration(cwd: string): MigrationScan {
  const home = homedir()
  const assets: MigrationAsset[] = []
  const push = (a: MigrationAsset | null): void => {
    if (a) assets.push(a)
  }

  // ---- 项目级规则 ----
  push(fileAsset('Cursor', 'rules', join(cwd, '.cursorrules')))
  assets.push(...dirAssets('Cursor', 'rules', join(cwd, '.cursor', 'rules')))
  assets.push(...dirAssets('Windsurf', 'rules', join(cwd, '.windsurf', 'rules')))
  push(fileAsset('Windsurf', 'rules', join(cwd, '.windsurfrules')))
  push(fileAsset('Cline', 'rules', join(cwd, '.clinerules')))
  assets.push(...dirAssets('Cline', 'rules', join(cwd, '.clinerules.d')))
  push(fileAsset('Codex', 'rules', join(cwd, 'AGENTS.md')))
  push(fileAsset('Gemini CLI', 'rules', join(cwd, 'GEMINI.md')))
  push(fileAsset('GitHub Copilot', 'rules', join(cwd, '.github', 'copilot-instructions.md')))
  push(fileAsset('Aider', 'config', join(cwd, '.aider.conf.yml')))

  // ---- 项目级 MCP(他家格式) ----
  push(fileAsset('Cursor', 'mcp', join(cwd, '.cursor', 'mcp.json')))
  push(fileAsset('Windsurf', 'mcp', join(cwd, '.windsurf', 'mcp.json')))

  // ---- 用户级 ----
  push(fileAsset('Codex', 'rules', join(home, '.codex', 'AGENTS.md')))
  push(fileAsset('Codex', 'config', join(home, '.codex', 'config.toml')))
  push(fileAsset('Cursor', 'mcp', join(home, '.cursor', 'mcp.json')))
  push(fileAsset('Aider', 'config', join(home, '.aider.conf.yml')))
  push(fileAsset('Gemini CLI', 'rules', join(home, '.gemini', 'GEMINI.md')))

  // Claude Code 本家资产已被引擎原生继承,只作提示不需导入
  const claudeNative =
    existsSync(join(cwd, 'CLAUDE.md')) ||
    existsSync(join(cwd, '.claude')) ||
    existsSync(join(home, '.claude'))

  return { cwd, assets, claudeNative }
}

const IMPORT_BEGIN = '<!-- caogen:imported-begin'
const IMPORT_END = '<!-- caogen:imported-end -->'

/**
 * 把选中的规则资产注入项目 CLAUDE.md(带来源标注区块)。
 * 已有 CLAUDE.md 先备份 .bak;重复导入同一来源(路径相同)会跳过。
 * MCP 资产合并进项目 .mcp.json(同名 server 跳过)。
 * 返回人类可读的结果摘要。
 */
export function importAssets(cwd: string, paths: string[]): string {
  const scan = scanMigration(cwd)
  const chosen = scan.assets.filter((a) => paths.includes(a.path))
  if (chosen.length === 0) return '未选择任何资产'
  const done: string[] = []
  const skipped: string[] = []

  // ---- 规则/配置 → CLAUDE.md 区块 ----
  const rules = chosen.filter((a) => a.kind === 'rules' || a.kind === 'config')
  if (rules.length > 0) {
    const target = join(cwd, 'CLAUDE.md')
    let existing = ''
    if (existsSync(target)) {
      existing = readFileSync(target, 'utf8')
      const bak = `${target}.bak`
      if (!existsSync(bak)) copyFileSync(target, bak)
    }
    const blocks: string[] = []
    for (const a of rules) {
      if (existing.includes(`from:${a.path} `)) {
        skipped.push(`${a.name}(已导入过)`)
        continue
      }
      let body: string
      try {
        body = readFileSync(a.path, 'utf8').trim()
      } catch {
        skipped.push(`${a.name}(读取失败)`)
        continue
      }
      blocks.push(
        `\n${IMPORT_BEGIN} agent:${a.agent} from:${a.path} date:${new Date().toISOString().slice(0, 10)} -->\n` +
          `## 迁移导入:${a.agent} · ${a.name}\n\n${body}\n${IMPORT_END}\n`
      )
      done.push(`${a.name} → CLAUDE.md`)
    }
    if (blocks.length > 0) {
      if (!existing) {
        writeFileSync(target, `# 项目指引(CaoGen 迁移导入)\n${blocks.join('')}`)
      } else {
        appendFileSync(target, blocks.join(''))
      }
    }
  }

  // ---- MCP → .mcp.json 合并 ----
  const mcps = chosen.filter((a) => a.kind === 'mcp')
  if (mcps.length > 0) {
    const target = join(cwd, '.mcp.json')
    let current: { mcpServers: Record<string, unknown> } = { mcpServers: {} }
    try {
      if (existsSync(target)) {
        const parsed = JSON.parse(readFileSync(target, 'utf8'))
        if (parsed && typeof parsed === 'object') {
          current = { mcpServers: { ...(parsed.mcpServers ?? {}) }, ...parsed }
        }
      }
    } catch {
      skipped.push('.mcp.json 已存在但解析失败,跳过 MCP 合并')
    }
    for (const a of mcps) {
      try {
        const src = JSON.parse(readFileSync(a.path, 'utf8'))
        const servers = (src?.mcpServers ?? src?.servers ?? {}) as Record<string, unknown>
        let added = 0
        for (const [name, cfg] of Object.entries(servers)) {
          if (current.mcpServers[name]) {
            skipped.push(`MCP ${name}(同名已存在)`)
            continue
          }
          current.mcpServers[name] = cfg
          added++
        }
        if (added > 0) done.push(`${a.name} → .mcp.json(${added} 个 server)`)
      } catch {
        skipped.push(`${a.name}(MCP 解析失败)`)
      }
    }
    writeFileSync(target, JSON.stringify(current, null, 2))
  }

  const parts: string[] = []
  if (done.length > 0) parts.push(`已导入:${done.join('、')}`)
  if (skipped.length > 0) parts.push(`跳过:${skipped.join('、')}`)
  return parts.join('\n') || '没有可导入的内容'
}
