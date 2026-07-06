import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * 插件本地安装 / 卸载(P5.9 治理下半场)。
 * - 安装:把本地目录整体复制到 <pluginsRoot>/<name>(路径牢笼,拒绝逃逸);
 *   仅接受形似插件的目录(plugin.json / .codex-plugin/plugin.json / SKILL.md / *.md agent 定义)。
 * - 卸载:不做破坏性删除 —— 移入 <pluginsRoot>/.trash/<name>-<时间戳>,可手工恢复。
 * - 市场/网络分发不在本版范围,只做本地目录安装(UI 已如实标注)。
 * pluginsRoot 由调用方注入(生产为 ~/.claude/plugins),便于独立冒烟测试。
 */

export interface PluginInstallResult {
  ok: boolean
  installedPath?: string
  name?: string
  error?: string
}

export interface PluginUninstallResult {
  ok: boolean
  trashedTo?: string
  error?: string
}

const MAX_COPY_BYTES = 200 * 1024 * 1024 // 单插件 200MB 上限,防误选巨型目录

/** 目录是否"形似插件":有 manifest / SKILL.md / 顶层 agent .md */
function looksLikePlugin(dir: string): boolean {
  if (existsSync(join(dir, 'plugin.json'))) return true
  if (existsSync(join(dir, '.codex-plugin', 'plugin.json'))) return true
  if (existsSync(join(dir, 'SKILL.md'))) return true
  try {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    return readdirSync(dir).some((f) => f.endsWith('.md'))
  } catch {
    return false
  }
}

/** 从 manifest 取安装名;退回目录名。清洗成安全的单段目录名。 */
function installName(sourceDir: string): string {
  let name = basename(sourceDir)
  for (const manifestPath of [join(sourceDir, 'plugin.json'), join(sourceDir, '.codex-plugin', 'plugin.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        name = parsed.name.trim()
        break
      }
    } catch {
      // manifest 缺失/损坏:用目录名
    }
  }
  return (
    name
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/\.{2,}/g, '-') // 连续点一律压平,杜绝 '..' 形态
      .replace(/^[.-]+/, '')
      .slice(0, 80) || 'plugin'
  )
}

/** 路径牢笼:target 必须在 root 内(且不是 root 本身) */
function insideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function dirSizeBytes(dir: string, budget: number): number {
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  let total = 0
  const stack = [dir]
  while (stack.length > 0 && total <= budget) {
    const cur = stack.pop() as string
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        stack.push(p)
      } else if (e.isFile()) {
        try {
          total += statSync(p).size
        } catch {
          // 读不了的文件跳过
        }
      }
    }
  }
  return total
}

export function installLocalPlugin(
  sourceDir: string,
  pluginsRoot: string,
  opts: { overwrite?: boolean } = {}
): PluginInstallResult {
  try {
    if (!sourceDir || !existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
      return { ok: false, error: '请选择一个存在的目录' }
    }
    if (!looksLikePlugin(sourceDir)) {
      return { ok: false, error: '该目录不像插件:需要 plugin.json / SKILL.md / agent .md 之一' }
    }
    const size = dirSizeBytes(sourceDir, MAX_COPY_BYTES)
    if (size > MAX_COPY_BYTES) {
      return { ok: false, error: `目录过大(>200MB),拒绝安装以防误选` }
    }
    const name = installName(sourceDir)
    const target = join(pluginsRoot, name)
    if (!insideRoot(pluginsRoot, target)) {
      return { ok: false, error: `安装名不合法:${name}` }
    }
    if (resolve(sourceDir) === resolve(target)) {
      return { ok: false, error: '源目录已在插件目录内,无需安装' }
    }
    if (existsSync(target)) {
      if (!opts.overwrite) return { ok: false, error: `已存在同名插件 ${name};确认覆盖后重试` }
      // 覆盖前先把旧版挪进回收站(与卸载同路径,可恢复)
      const trashed = uninstallPlugin(target, pluginsRoot)
      if (!trashed.ok) return { ok: false, error: `无法移除旧版:${trashed.error}` }
    }
    mkdirSync(pluginsRoot, { recursive: true })
    cpSync(sourceDir, target, { recursive: true, filter: (src) => !src.includes('/.git/') && !src.endsWith('/.git') })
    return { ok: true, installedPath: target, name }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function uninstallPlugin(targetPath: string, pluginsRoot: string): PluginUninstallResult {
  try {
    const target = resolve(targetPath)
    // 只允许卸载 pluginsRoot 直接子目录;.trash 自身不可"卸载"
    if (!insideRoot(pluginsRoot, target)) {
      return { ok: false, error: '只能卸载插件目录(~/.claude/plugins)内的插件' }
    }
    if (basename(target) === '.trash' || target.includes(`${join(resolve(pluginsRoot), '.trash')}`)) {
      return { ok: false, error: '回收站不可作为卸载对象' }
    }
    if (!existsSync(target)) return { ok: false, error: '插件目录不存在' }
    const trashDir = join(pluginsRoot, '.trash')
    mkdirSync(trashDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(trashDir, `${basename(target)}-${stamp}`)
    renameSync(target, dest)
    return { ok: true, trashedTo: dest }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
