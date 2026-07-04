import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 厂商图标抓取与本地缓存。
 *
 * 为什么要缓存到本地:渲染层受 CSP(img-src)限制,直接引用厂商外链
 * (如 deepseek.com/favicon.ico)在打包版会被拦;且外链不稳定。故由主进程
 * 用 Electron net 抓取,存到 userData/vendor-icons,再经 caogen-icon:// 协议
 * 喂给渲染层的头顶浮标(2D <img>,不贴到 3D 几何体上,避免糊)。
 *
 * 商标说明:仅作"用户所配厂商的本地标识"缓存,不重分发、不内置商标图形。
 */

const MAX_ICON_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 8000
const ALLOWED_CONTENT = /^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp|svg\+xml)/i

/** 内置厂商 → 官方图标 URL(自建网关用户可在 Provider 里自定义覆盖) */
export const BUILTIN_ICON_URLS: Record<string, string> = {
  deepseek: 'https://www.deepseek.com/favicon.ico',
  openai: 'https://openai.com/favicon.ico',
  anthropic: 'https://www.anthropic.com/favicon.ico',
  google: 'https://www.google.com/favicon.ico',
  gemini: 'https://www.gemini.com/favicon.ico',
  kimi: 'https://kimi.moonshot.cn/favicon.ico',
  moonshot: 'https://www.moonshot.cn/favicon.ico',
  zhipu: 'https://www.bigmodel.cn/favicon.ico',
  qwen: 'https://tongyi.aliyun.com/favicon.ico',
  mistral: 'https://mistral.ai/favicon.ico',
  grok: 'https://x.ai/favicon.ico'
}

function iconsDir(): string {
  return join(app.getPath('userData'), 'vendor-icons')
}

function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24)
}

function extFromContentType(ct: string): string {
  if (/svg/i.test(ct)) return 'svg'
  if (/png/i.test(ct)) return 'png'
  if (/jpeg/i.test(ct)) return 'jpg'
  if (/gif/i.test(ct)) return 'gif'
  if (/webp/i.test(ct)) return 'webp'
  return 'ico'
}

/** 已缓存则返回本地文件路径;否则返回 null(不触发抓取) */
export function cachedIconPath(url: string): string | null {
  if (!url) return null
  const key = cacheKey(url)
  try {
    for (const name of ['png', 'ico', 'jpg', 'gif', 'webp', 'svg'].map((e) => `${key}.${e}`)) {
      const p = join(iconsDir(), name)
      if (existsSync(p)) return p
    }
  } catch {
    // ignore
  }
  return null
}

/** 抓取图标并缓存,返回本地路径;失败返回 null(静默,由调用方回退 emoji) */
export async function fetchAndCacheIcon(url: string): Promise<string | null> {
  if (!url || !/^https:\/\//i.test(url)) return null
  const existing = cachedIconPath(url)
  if (existing) return existing
  return new Promise((resolve) => {
    let settled = false
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    const timer = setTimeout(() => done(null), FETCH_TIMEOUT_MS)
    try {
      const req = net.request({ method: 'GET', url })
      const chunks: Buffer[] = []
      let total = 0
      req.on('response', (res) => {
        const status = res.statusCode ?? 0
        const ct = String(res.headers['content-type'] ?? '')
        if (status < 200 || status >= 300 || !ALLOWED_CONTENT.test(ct)) {
          clearTimeout(timer)
          res.on('data', () => {})
          done(null)
          return
        }
        res.on('data', (c: Buffer) => {
          total += c.length
          if (total > MAX_ICON_BYTES) {
            clearTimeout(timer)
            done(null)
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          clearTimeout(timer)
          if (chunks.length === 0) return done(null)
          try {
            mkdirSync(iconsDir(), { recursive: true })
            const path = join(iconsDir(), `${cacheKey(url)}.${extFromContentType(ct)}`)
            writeFileSync(path, Buffer.concat(chunks))
            done(path)
          } catch {
            done(null)
          }
        })
      })
      req.on('error', () => {
        clearTimeout(timer)
        done(null)
      })
      req.end()
    } catch {
      clearTimeout(timer)
      done(null)
    }
  })
}

/** 读取缓存图标为 data URL(渲染层 <img> 直接用,彻底绕开 CSP/协议注册) */
export function iconDataUrl(url: string): string | null {
  const path = cachedIconPath(url)
  if (!path) return null
  try {
    const buf = readFileSync(path)
    const ext = path.slice(path.lastIndexOf('.') + 1)
    const mime =
      ext === 'svg'
        ? 'image/svg+xml'
        : ext === 'png'
          ? 'image/png'
          : ext === 'jpg'
            ? 'image/jpeg'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'webp'
                ? 'image/webp'
                : 'image/x-icon'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
