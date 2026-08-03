# CaoGen 项目解读与官网优化报告

> 调研时间：2026-07-24
> 对象：github.com/ChaoYuZhang001/CaoGen（主项目）· caogen.dev（官网）· caogen-website（官网源码，本地仓库）

---

## 一、主项目 CaoGen 深度解读

### 1.1 定位

**厂商中立、本地优先的多模型 AI 工作桌面**（Vendor-neutral, local-first AI work desktop）：

- **BYOK**：用户自带 API Key，可配多 Provider、多 Key、自定义 Base URL、中转站、本地 OpenAI 兼容服务（DeepSeek / Kimi / GLM / Claude / OpenAI 等）。
- **可替换算力**：Provider 被视为可替换资源，按成本/速度/质量/健康度路由；额度、限流、服务端错误时自动走「备用 Key → 健康 Provider」的故障切换阶梯。
- **本地优先**：项目、会话、worktree、工具与审查流程都留在用户桌面。

一句话：**它卖的不是某个模型，而是"模型挂了任务不重来"的执行可靠性**。

### 1.2 当前已实现的核心能力（v0.1.6 Beta）

1. 多 Provider 接入与 BYOK 配置
2. 策略路由 + 自动故障切换
3. Git worktree 任务隔离：Diff 审查、冲突检查、导出/应用 patch、可丢弃
4. 内置工作台：终端、文件、编辑器、浏览器（批注/元素截图/错误观测）、Diff、Git，支持 HTML/MD/JSON/CSV/图片/PDF/Office 预览
5. 3D 办公区：工位状态来自真实会话数据（运行、审批、失败、成本、子任务、worktree/Git 信号），不做虚假动画
6. 33 个子 Agent 派发上限，MCP / Plugin / Skill 扩展体系

### 1.3 项目健康度

| 指标 | 数值 | 判断 |
|---|---|---|
| Star / Fork | 2 / 0 | 极早期，冷启动阶段 |
| Commits | 268 | 单人高强度开发 |
| 版本 | v0.1.6（macOS x64）/ v0.1.5（Windows） | 未到 1.0，安装包未签名/未公证 |
| P0 需求（共 64） | 21 已验证 / 17 部分 / 25 立项目标 / 1 仅基础 | 约 1/3 走完正式验收 |
| 协议 | AGPL-3.0 + 独立商业授权 | 双轨，商业化路径清晰 |

**突出优点**：文档体系异常完善（立项书、PRD、验收矩阵、STATUS、ROADMAP），且对「已实现 vs 目标」边界极其诚实——这是它最大的信任资产，官网也继承了这一风格。

**主要风险**：单人项目、社区为零、安装信任门槛（未签名）、平台覆盖不全（无 Apple Silicon 当前版、无 Linux 包）。

---

## 二、官网现状审计

### 2.1 工程架构（做得好的部分）

官网是独立 Vite 静态工程，工程质量在同类个人项目里属于高水平：

- **单一配置源**：全部文案在 `src/site-config.json`（48KB），中英文共享事实（版本号/链接）只存一份，构建期派生。
- **可视化配置台** `/admin/`：分类表单、校验、撤销、原子写入、20 份备份；只在 dev 模式工作，不回灌到生产包。
- **三层测试**：配置校验（版本号/URL/重复 ID/图片越界/模板引用）+ 配置传播 smoke + 渲染产物 HTML 断言。
- **产物轻量**：HTML 42KB、JS 13KB（Lucide 按需打包）、CSS 24KB；无前端框架，无运行时依赖。
- **无障碍**：skip-link、aria 标签、语义化 section 齐全。
- **内容策略**：「今日可用」与「1.0 愿景」严格分离，推广链接放下载之后并披露 `rel="sponsored"`——信任建设非常克制。

### 2.2 线上实测数据

| 检测项 | 实测结果 | 判定 |
|---|---|---|
| 首页 TTFB（国内访问） | **1.8–2.2s**（/en/ 达 2.9s） | 差，静态站应 <300ms |
| HTML 缓存 | `cf-cache-status: DYNAMIC`，`max-age=0, must-revalidate` | 每访客回源，边缘缓存未生效 |
| 带 hash 静态资源 | `max-age=14400, must-revalidate`，cf-cache MISS/REVALIDATED | 应为 `max-age=31536000, immutable` |
| hero 图（office.png） | **435KB PNG**，2640×1720，无 WebP/srcset/fetchpriority | LCP 严重超标 |
| 品牌 icon | **264KB PNG**，以 36/48/56/64px 显示 4 次 | 浪费 ~260KB × N |
| robots.txt | **内容损坏**：Cloudflare content-signal 注释后拼接了整页首页 HTML | 无效文件 |
| sitemap.xml | **返回首页 HTML（HTTP 200）** | 假 sitemap，误导搜索引擎 |
| og:image | 相对路径 `/product/office.png` | 社交分享卡片不生效 |
| Twitter Card | 无 | 缺失 |
| 安全响应头 | 无 CSP / HSTS / X-Frame-Options / Permissions-Policy；HTML 带 `Access-Control-Allow-Origin: *` | 基本裸奔 + 多余 CORS |
| canonical / hreflang | 中英 x-default 齐全 | 好 |
| JSON-LD | SoftwareApplication 完整 | 好 |
| /vision 跳转 | 308 → /vision/ | 正常，但内链应直接用尾斜杠 |
| 邮箱混淆 | Cloudflare 把页脚 mailto 改写为 `[email protected]` | 商务联系方式受损 |
| 官网源码同步 | 本地仓库无 vision 页源码，线上却有 /vision/ 与 /en/vision/ | **部署产物领先于仓库，有失控风险** |

### 2.3 内容与转化现状

- 页面结构：Hero → 厂商中立论点 → 8 项今日能力 → 真实界面双视图 → 进展快照 → 开源信任 → 四步上手 → 下载 → 第三方推荐 → FAQ → 页脚，另有 /vision/ 与 /docs/ 手册、/en/ 英文版。
- Hero 主 CTA 是「看真实界面」（页内锚点），下载只是第三个文字链接。
- 下载按钮指向 GitHub Release **tag 页面**而非直接的 dmg/exe 资产，用户需再点一次。
- Hero 区悬挂 GitHub stars 徽章（当前显示 2 stars），并外链 img.shields.io。
- 无演示视频/GIF；3D 办公区是最大视觉差异点但只有静态截图。
- 无社区入口（Discord / 微信群 / QQ 群）、无订阅渠道、无站内反馈。
- 无任何访问统计，无法衡量下载转化。
- 文档仅中文，无英文手册；无博客/Changelog 内容页。

---

## 三、优化方向（按优先级）

### P0 — 影响收录与首屏体验的硬伤（建议 1 周内修完）

**1. 修复 robots.txt 与 sitemap.xml**
- 部署一个真正的 `public/robots.txt`（`Allow: /` + `Sitemap: https://caogen.dev/sitemap.xml`），并排查 Cloudflare content-signal 注入与回源 404 兜底混叠的问题——当前文件是非法的。
- 构建期生成真实 `sitemap.xml`（4 个 URL：/、/en/、/vision/、/docs/ 及其英文版），现在是「返回首页的 200 假 sitemap」，比没有更糟。

**2. 修复 og:image 与社交卡片**
- `og:image` 改绝对 URL（`https://caogen.dev/product/office.png`，配置里已有 canonicalUrl 可拼接）。
- 补 Twitter Card（`summary_large_image`）。
- 给 FAQ 区加 `FAQPage` JSON-LD，争取富媒体搜索结果。

**3. 图片瘦身（预计首屏减重 80%+）**
- office/workspace 截图转 **WebP + PNG fallback**，hero 加 `fetchpriority="high"` 与 `loading="eager"`，其余视图 `loading="lazy"`；补 `srcset`（1280/1920/2640 三档）。
- 264KB 的品牌 icon 替换为多尺寸小图（如 72/128px WebP/PNG，<10KB）。
- 预期 LCP 从 ~3s+ 降至 1.5s 内（图片减 400KB+，配合缓存）。

**4. 边缘缓存与安全头**
- 带 hash 的 `/assets/*`：`Cache-Control: public, max-age=31536000, immutable`。
- HTML：Cloudflare Cache Rule 做边缘缓存（静态站可 `cache everything` + 短 TTL，部署后自动 purge），目标 TTFB <300ms。
- 补安全头：`Strict-Transport-Security`、`Content-Security-Policy`（至少 `default-src 'self'; img-src 'self' https://img.shields.io`）、`X-Frame-Options: DENY`、`Permissions-Policy`；移除 HTML 上多余的 `Access-Control-Allow-Origin: *`。
- 关掉 Cloudflare Email Obfuscation（或页脚改用表单/图片邮箱），恢复真实商务邮箱展示。

### P1 — 转化与增长（2–4 周）

**5. 重构首屏转化路径**
- 主 CTA 改为「下载 v0.1.6」（按 UA 识别 macOS/Windows，直接链到 dmg/exe 资产而非 tag 页），「看真实界面」降为次 CTA。
- star 数 <100 期间把 shields 徽章从 hero 撤下（弱社会证明反而减分），或改放页脚；同时消除对 img.shields.io 的第三方依赖（也利于 CSP 收紧）。

**6. 加演示视频**
- 录 30–60 秒 3D 办公区真实任务视频（ muted autoplay loop，WebM+MP4 <2MB），替换或补充 hero 静态图——这是把「真实状态可视化」卖点讲清楚的最短路径。

**7. 可量化的下载漏斗**
- 接入隐私友好统计（Plausible / Umami / Cloudflare Web Analytics 任选），至少追踪：下载点击、OS 分布、GitHub 出站、vision 页停留。

**8. 社区与留存入口**
- 页脚/下载区加微信群或 QQ 群二维码、GitHub Discussions 链接；早期 2 star 项目最缺的不是流量而是前 100 个真实用户反馈。

**9. 安装信任说明前置**
- 「未签名」目前藏在版本面板和 FAQ；建议在下载按钮旁用一行说明 + 图示（右键打开）直接消除 macOS Gatekeeper 拦截的流失，并给出 SHA256 校验命令。长期：签名/公证排上路线图并在官网承诺时间。

### P2 — 内容与长期建设（1–3 月）

**10. 内容获客**：把 Changelog 做成官网页面（每版本一页，中英），写 2–3 篇定位文（如「多模型故障切换实测」「BYOK 与厂商中立意味着什么」），瞄准 "多模型客户端 / BYOK AI desktop / Claude Code alternative" 等关键词；这是 0 预算项目最现实的 SEO 路径。

**11. 英文版补齐**：/en/docs/ 英文手册（海外用户是 BYOK 题材的天然受众）；文档站加搜索（Pagefind 即可，静态友好）。

**12. 对比页**：vs Cursor / Claude Code / Cherry Studio 的诚实对比表（延续「诚实」人设），帮助用户快速定位。

**13. 工程治理**
- **把 /vision/ 源码合回官网仓库**（当前线上页面无源码可溯，部署不可重现，是最大运维隐患）；GitHub 上 CaoGen-Website 为私有仓库，建议明确「私有开发 + 自动部署」流程或开源自托管。
- 部署流水线加一条 `npm run check` + 线上冒烟（curl 校验 robots/sitemap/og:image/缓存头），把本次发现的回归固化成测试。
- `rendered-html-smoke.mjs` 增加断言：og:image 必须为绝对 URL、robots/sitemap 非 HTML 兜底。

**14. 平台叙事**：Apple Silicon 版、Windows 追平 v0.1.6、Linux 包给出明确计划页——当前下载区对非 Intel-Mac 用户是死胡同。

---

## 四、建议落地顺序

| 周期 | 动作 | 预期收益 |
|---|---|---|
| 第 1 周 | P0 全部：robots/sitemap、og:image、图片 WebP+瘦身、缓存与安全头 | 可被正常收录；首屏减重 80%+；TTFB <300ms |
| 第 2–4 周 | 下载 CTA 前置 + OS 识别、演示视频、统计接入、社区入口、未签名引导 | 下载转化可测且提升；早期用户沉淀 |
| 第 2–3 月 | Changelog/博客内容、英文文档、对比页、vision 源码回仓 | 自然流量起步；运维可控 |

**核心判断**：官网的文案与信任策略（诚实、克制、证据导向）已经是同类项目里的上限，问题全部集中在**基础技术卫生**（缓存、图片、SEO 文件、安全头）和**转化路径**（下载藏得太深、无视频、无数据反馈）。这两类问题修复成本低、收益立竿见影，应优先于任何视觉改版。
