import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.venv',
  '__pycache__',
  '.idea',
  '.vscode'
])
const MAX_RESULTS = 40
const MAX_SCAN = 8000

/**
 * 列出 cwd 下与 query 模糊匹配的文件相对路径,供 @ 引用补全。
 * 跳过依赖/构建目录;广度优先扫描并封顶,避免大仓卡死。
 */
export function suggestFiles(cwd: string, query: string): string[] {
  if (!cwd) return []
  const q = query.toLowerCase().trim()
  const results: string[] = []
  let scanned = 0
  // 广度优先:浅层文件优先出现,更符合直觉
  const queue: string[] = [cwd]
  while (queue.length > 0 && scanned < MAX_SCAN && results.length < MAX_RESULTS * 4) {
    const dir = queue.shift() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) queue.push(full)
      } else if (e.isFile()) {
        scanned++
        const rel = relative(cwd, full)
        if (!q || rel.toLowerCase().includes(q) || fuzzyMatch(rel.toLowerCase(), q)) {
          results.push(rel.split(sep).join('/'))
        }
      }
    }
  }
  // 短路径优先(更接近根、更可能是目标)
  results.sort((a, b) => a.length - b.length)
  return results.slice(0, MAX_RESULTS)
}

/** 简单子序列模糊匹配:q 的字符按序出现在 target 中 */
function fuzzyMatch(target: string, q: string): boolean {
  if (!q) return true
  let i = 0
  for (let j = 0; j < target.length && i < q.length; j++) {
    if (target[j] === q[i]) i++
  }
  return i === q.length
}

const MAX_FILE_CHARS = 40_000

/**
 * 读取被 @ 引用的文件内容,拼成注入到消息的上下文块。
 * 超长截断;越界/不存在的路径静默跳过(不泄露 cwd 外内容)。
 */
export function readReferencedFiles(cwd: string, relPaths: string[]): string {
  if (relPaths.length === 0) return ''
  const blocks: string[] = []
  const seen = new Set<string>()
  for (const rel of relPaths) {
    if (seen.has(rel)) continue
    seen.add(rel)
    const full = join(cwd, rel)
    // 防目录穿越:必须仍在 cwd 内
    if (!full.startsWith(cwd)) continue
    try {
      if (!statSync(full).isFile()) continue
      let text = readFileSync(full, 'utf8')
      let note = ''
      if (text.length > MAX_FILE_CHARS) {
        text = text.slice(0, MAX_FILE_CHARS)
        note = `\n… [截断,文件更长]`
      }
      blocks.push(`===== ${rel} =====\n${text}${note}`)
    } catch {
      // 读不了就跳过
    }
  }
  if (blocks.length === 0) return ''
  return `\n\n[用户引用的文件内容]\n${blocks.join('\n\n')}`
}
