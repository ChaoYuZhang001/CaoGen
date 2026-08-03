# CaoGen 官网优化方案（可执行版）

> 2026-07-25 · 配套审计报告见 `caogen-website-optimization-report.md`
> 代码位置：`/Users/apple/agent-desk/caogen-website/`（Vite 静态站 → Cloudflare Pages）
> 原则：不动文案与视觉体系，只修技术硬伤、转化路径与运维流程。

---

## 0. 基线与目标

| 指标 | 实测基线（07-24） | 目标 |
|---|---|---|
| 首页 TTFB（国内） | 1.8–2.2s | <500ms |
| 首屏图片负载 | ~700KB（hero 435KB + icon 264KB） | <150KB |
| robots.txt | 非法文件（注释 + 首页 HTML 混叠） | 合法 + 声明 sitemap |
| sitemap.xml | 返回首页 HTML 的假 200 | 真实 XML，6+ URL |
| og:image | 相对路径，分享卡片失效 | 绝对 URL，Facebook/Twitter 调试器通过 |
| 安全头 | 仅 nosniff + referrer-policy | CSP / HSTS / frame-ancestors 齐全 |
| hash 静态资源缓存 | 4h + must-revalidate | 1 年 immutable |
| 下载转化 | 不可测量 | 有点击统计与漏斗 |

---

## 1. P0：技术硬伤修复（第 1 周，总工作量约 1 天）

### 1.1 og:image 绝对化 + 补 Twitter Card（10 分钟）

**改动 1**：`src/site-config.json`

```json
"ogImage": "https://caogen.dev/product/office-cover.png"
```

（顺道做一张 1200×630 专用分享图 `public/product/office-cover.png`，比直接拿 2640px 截图效果好。英文版 `en.ogImage` 同步。）

**改动 2**：`index.html`、`en/index.html`、`docs/index.html` 三个模板的 `<head>` 追加：

```html
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{{seo.title}}" />
<meta name="twitter:description" content="{{seo.ogDescription}}" />
<meta name="twitter:image" content="{{seo.ogImage}}" />
```

**验证**：`curl -s https://caogen.dev/ | grep -o 'og:image[^>]*'` 输出绝对 URL；Facebook Sharing Debugger 与 Twitter Card Validator 抓取成功。

### 1.2 修复 robots.txt 与 sitemap.xml（20 分钟）

**新增 `public/robots.txt`**（构建后落在 dist 根）：

```text
User-agent: *
Allow: /
Disallow: /admin/

Sitemap: https://caogen.dev/sitemap.xml
```

**新增 `public/sitemap.xml`**：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://caogen.dev/</loc><changefreq>weekly</changefreq></url>
  <url><loc>https://caogen.dev/en/</loc><changefreq>weekly</changefreq></url>
  <url><loc>https://caogen.dev/vision/</loc><changefreq>monthly</changefreq></url>
  <url><loc>https://caogen.dev/en/vision/</loc><changefreq>monthly</changefreq></url>
  <url><loc>https://caogen.dev/docs/</loc><changefreq>weekly</changefreq></url>
</urlset>
```

**Cloudflare 侧排查**：当前 robots.txt 尾部拼接了整页 HTML，疑似 Cloudflare「Content Signals / AI Audit」托管 robots 功能与源站 404 兜底混叠。部署真实文件后若仍被覆盖，到 Cloudflare 控制台关闭该域的托管 robots.txt 注入。

**验证**：`curl -s https://caogen.dev/robots.txt | file -` 为纯文本；`curl -s https://caogen.dev/sitemap.xml | head -3` 为 XML。

### 1.3 缓存与安全头（30 分钟）

**新增 `public/_headers`**（Cloudflare Pages 原生支持）：

```text
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/product/*
  Cache-Control: public, max-age=604800, stale-while-revalidate=86400

/brand/*
  Cache-Control: public, max-age=604800, stale-while-revalidate=86400

/
  Cache-Control: public, max-age=300, must-revalidate

/*
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Referrer-Policy: strict-origin-when-cross-origin
```

注意两点：

1. 当前 HTML 响应带多余的 `Access-Control-Allow-Origin: *`，需找到来源（Cloudflare Transform Rule 或源站配置）并移除。
2. CSP 里的 `script-src 'self'` 生效前提是撤掉 shields.io 外链徽章（见 1.5）；若暂保留，先加 `https://img.shields.io` 到 `img-src` 过渡。
3. 实测 HTML 是 `cf-cache-status: DYNAMIC`，说明当前可能不是 Pages 托管或缓存规则未生效——先在 Pages 项目里确认部署来源，`_headers` 只在 Pages 生效；若是其他源站+橙云代理，改用 Cache Rules（Eligible for cache → Edge TTL 5 分钟）。

**验证**：`curl -sI https://caogen.dev/assets/main-*.js | grep -i cache-control` 为 1 年 immutable；securityheaders.com 扫描评级 ≥A。

### 1.4 图片管线（半天，收益最大）

**新增 `scripts/optimize-images.mjs`**（`npm i -D sharp`），一次生成多尺寸 WebP + 压缩 PNG fallback 到 `public/product/` 与 `public/brand/`：

- `office.png / workspace.png`（2640px 原图保留）→ 1280 / 1920 两档 WebP + 1920 压缩 PNG
- `caogen-icon.png`（264KB）→ 72 / 128 / 256px 三档 PNG（各 <15KB），favicon 用 128px

**模板改动**：

`index.html` hero 图（LCP 元素）：

```html
<img class="hero-media"
     src="/product/office-1920.png"
     srcset="/product/office-1280.webp 1280w, /product/office-1920.webp 1920w, /product/office.png 2640w"
     sizes="100vw"
     fetchpriority="high" decoding="async"
     width="{{hero.imageWidth}}" height="{{hero.imageHeight}}"
     alt="{{hero.backgroundAlt}}" />
```

`vite.config.js` 的 `renderProductFigure`：输出同样带 srcset 的 img，并加 `loading="lazy"`；officeStory 图同理（below fold，lazy）。

配置扩展：`product.views[].srcset`、`hero.srcset` 字段，校验脚本 `site-config-validation.mjs` 同步加字段检查。

**验证**：`npm run build` 后 `dist/product/` 含 WebP；Lighthouse LCP <2.5s；首屏图片传输 <150KB。

### 1.5 撤下 hero 的 GitHub stars 徽章（5 分钟）

当前徽章展示「2 stars」，弱社会证明反而减分，且是 CSP 收紧的障碍。

- `index.html` 中 `.github-stars` 整块从 hero 移除；star 数 ≥100 后再加回，或改放页脚（页脚不受 CSP img-src 限制影响可留 shields）。
- 连带收益：首屏少一个第三方请求。

### 1.6 Cloudflare 控制台设置清单（15 分钟）

- **Scrape Shield → Email Obfuscation：关闭**。它正把页脚商务邮箱改写成 `[email protected]` 并劫持 mailto 链接（该邮箱本就公开，无需保护）。
- **SSL/TLS → Edge Certificates → HSTS**：开启（与 `_headers` 二选一，避免重复）。
- **Rules → Transform Rules**：检查是否存在添加 `Access-Control-Allow-Origin` 的规则，有则删。
- **Speed → Early Hints**：开启（免费提速）。

### 1.7 把本次发现固化进冒烟测试（1 小时）

`scripts/rendered-html-smoke.mjs` 增加断言：

- `og:image` 必须以 `https://` 开头
- `dist/robots.txt` 存在且不含 `<html`
- `dist/sitemap.xml` 存在且以 `<?xml` 开头
- `dist/_headers` 存在
- hero img 含 `fetchpriority="high"`

---

## 2. P1：转化路径（第 2–4 周）

### 2.1 下载 CTA 前置 + OS 识别（半天）

**配置扩展**（`src/site-config.json` 的 `release`）：

```json
"assets": {
  "macosX64": { "url": "https://github.com/ChaoYuZhang001/CaoGen/releases/download/v0.1.6/CaoGen-0.1.6-x64.dmg", "label": "下载 macOS 版" },
  "windowsX64": { "url": "https://github.com/ChaoYuZhang001/CaoGen/releases/download/v0.1.5/CaoGen-Setup-0.1.5.exe", "label": "下载 Windows 版" }
}
```

（文件名以 Release 实际资产为准；同时把 SHA256 放进配置并在下载区展示。）

**hero 主 CTA 调整**：primaryCta 由「看真实界面」改为「下载 v0.1.6」，href 指向 `#download` 锚点或直接资产链接；「看真实界面」降为 secondary。

**`src/main.js` 增加 OS 识别**（约 20 行）：读取 `navigator.userAgent`，把下载区主按钮的 label/href 替换为对应平台资产，无法识别时保持现状；Windows 用户额外提示「当前 Windows 版为 v0.1.5」。

### 2.2 未签名安装引导前置（1 小时）

下载按钮下方加一行说明 + 折叠图示：macOS「右键 → 打开」三步图、Windows SmartScreen「仍要运行」；附 SHA256 校验命令（`shasum -a 256`）。把 FAQ 里同类问题链接到此处。

### 2.3 演示视频（半天 + 录制）

- 录 30–45 秒真实任务视频：3D 办公区中一个任务从下发 → 子 Agent 拆分 → worktree → Diff 审查全过程。
- 规格：H.264 MP4（主）+ WebM，≤2MB，720p，静音循环。
- hero 下方或替换 product 区静态图：`<video autoplay muted loop playsinline poster="/product/office-poster.webp">`，并配 `prefers-reduced-motion` 时回退为静态 poster。

### 2.4 统计接入（15 分钟）

选 **Cloudflare Web Analytics**（免费、隐私友好、与现有栈零集成成本），在模板 `<head>` 注入 beacon；自定义事件至少跟踪：下载按钮点击（按平台）、GitHub 出站、vision 页入口、推广卡点击。若后续要事件级分析再换 Plausible。

### 2.5 社区入口（1 小时）

下载区与页脚加：微信群/QQ 群二维码（`public/brand/community-qr.png`）、GitHub Discussions 链接。早期项目前 100 个真实用户反馈比流量重要。

---

## 3. P2：增长与工程治理（第 2–3 月）

### 3.1 vision 页源码回仓（最高优先级的 P2，半天）

**这是当前最大的运维隐患**：线上 `/vision/` 与 `/en/vision/` 有页面，但本仓库构建输入只有 `main / en / docs`（见 `vite.config.js` rollupOptions.input），vision 源码不在仓内，意味着部署不可重现、配置台也无法维护它。

行动：从线上产物反推重建 `vision/index.html` + `en/vision/index.html` 模板，内容并入 `site-config.json`（新增 `visionPage` 配置块），加入 rollupOptions.input 与冒烟测试；找不到原始源码时按线上 HTML 逆向，一次性补齐。

### 3.2 内容获客（持续）

- **Changelog 页**：每版本一页（`/changelog/v0.1.6/`），从 `release` 配置派生，中英双语——低成本新增可索引页面。
- **博客 2–3 篇定位文**：「多模型故障切换实测」「BYOK 与厂商中立意味着什么（对比平台托管）」「一个模型的钱跑五个模型」。目标关键词：多模型客户端、BYOK AI desktop、Claude Code alternative。
- **对比页**：vs Cursor / Claude Code / WorkBuddy 类平台托管产品的诚实对比表（延续「诚实」人设，不贬低对手）。

### 3.3 英文版补齐

- `content/docs/en/manual.md` 英文手册（海外用户是 BYOK 题材天然受众）。
- 文档站加 Pagefind 静态搜索（构建期索引，零服务端）。

### 3.4 部署流水线加固

- Pages 构建命令已是 `npm run check`，保持不变；在冒烟脚本里补 1.7 的断言后，本次发现的回归不会再溜出去。
- 每月跑一次线上巡检脚本（curl 校验 robots / sitemap / og:image / 缓存头 / 安全头），可做成本仓库的 `scripts/production-smoke.mjs`。

### 3.5 平台叙事补全

下载区对非 Intel-Mac 用户目前是死胡同。出一页 `/platforms/` 明确：Apple Silicon 计划、Windows 追平进度、Linux 源码构建指引链接——把「没有」变成「有计划」，降低跳出。

---

## 4. 排期总览

| 时间 | 项目 | 工作量 |
|---|---|---|
| 第 1 天 | 1.1 og/Twitter、1.2 robots/sitemap、1.5 撤徽章、1.6 CF 设置 | ~1.5h |
| 第 2 天 | 1.3 _headers 缓存与安全头 | ~1h（含 CSP 调试） |
| 第 3 天 | 1.4 图片管线 + 模板 srcset | ~4h |
| 第 4 天 | 1.7 冒烟断言 + 全量回归 + 上线验收 | ~2h |
| 第 2–3 周 | 2.1 下载 CTA、2.2 安装引导、2.4 统计、2.5 社区 | ~1.5 天 |
| 第 3–4 周 | 2.3 演示视频 | ~1 天 |
| 第 2 月起 | 3.1 vision 回仓 → 3.2 内容 → 3.3 英文 → 3.5 平台页 | 持续 |

## 5. 上线验收命令（一次贴完）

```bash
curl -s https://caogen.dev/robots.txt | head -5          # 纯文本，含 Sitemap 行
curl -s https://caogen.dev/sitemap.xml | head -3         # XML
curl -s https://caogen.dev/ | grep -o 'og:image[^>]*'    # 绝对 URL
curl -s https://caogen.dev/ | grep -c 'twitter:card'     # ≥1
curl -sI https://caogen.dev/assets/main-*.js | grep -i cache-control   # immutable
curl -sI https://caogen.dev/ | grep -iE 'strict-transport|content-security|x-frame'  # 三头齐全
curl -s -o /dev/null -w '%{time_starttransfer}\n' https://caogen.dev/  # <0.5s
```

全部通过后跑一遍 Lighthouse（目标：Performance ≥90 / SEO 100 / Best Practices ≥95），再用 Facebook Sharing Debugger 和 Twitter Card Validator 各抓一次。
