const app = document.querySelector('.app');
const workspace = document.getElementById('workspace');
const inspector = document.getElementById('inspector');
const titleSection = document.getElementById('title-section');
const titlePage = document.getElementById('title-page');
const paletteBackdrop = document.getElementById('palette-backdrop');
const commandInput = document.getElementById('command-input');
const commandResults = document.getElementById('command-results');
const drawerBackdrop = document.getElementById('drawer-backdrop');
const detailDrawer = document.getElementById('detail-drawer');
const toastRegion = document.getElementById('toast-region');

const pageMeta = {
  home: { label: '总览', section: '工作台', icon: 'layout-dashboard', status: 'current', statusText: '当前能力' },
  assistant: { label: 'Assistant', section: '执行', icon: 'message-square-text', status: 'partial', statusText: '部分完成' },
  projects: { label: '项目', section: '组织', icon: 'folder-kanban', status: 'current', statusText: '当前能力' },
  work: { label: '目标与工作项', section: '组织', icon: 'list-checks', status: 'partial', statusText: '部分完成' },
  runs: { label: '运行与 Supervisor', section: '执行', icon: 'activity', status: 'partial', statusText: '部分完成' },
  delivery: { label: '产物与交付', section: '交付', icon: 'package-check', status: 'partial', statusText: '黄金工作流' },
  team: { label: '数字团队', section: '组织', icon: 'users', status: 'partial', statusText: '部分完成' },
  office: { label: '3D Office', section: '观察', icon: 'building-2', status: 'partial', statusText: '当前场景 / 目标角色' },
  routines: { label: 'Routines', section: '自动化', icon: 'calendar-clock', status: 'current', statusText: '当前能力' },
  resources: { label: '资源与工作台', section: '执行', icon: 'files', status: 'current', statusText: '当前能力' },
  extensions: { label: '插件、Skill 与 MCP', section: '能力', icon: 'blocks', status: 'current', statusText: '当前能力' },
  learning: { label: '记忆与学习', section: '能力', icon: 'brain-circuit', status: 'current', statusText: '审批生效' },
  routing: { label: 'Provider 与路由', section: '算力', icon: 'route', status: 'partial', statusText: '当前能力 / 恢复目标' },
  recovery: { label: '审计与恢复', section: '信任', icon: 'shield-check', status: 'partial', statusText: '部分完成' },
  settings: { label: '设置', section: '系统', icon: 'settings', status: 'current', statusText: '当前能力' }
};

let currentPage = location.hash.replace('#', '') || 'home';
let previousStudioPage = currentPage === 'assistant' ? 'home' : currentPage;

function icon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function statusPill(type, label) {
  return `<span class="status-pill ${type}">${label}</span>`;
}

function chip(label, type = 'neutral') {
  return `<span class="chip ${type}">${label}</span>`;
}

function button(label, iconName, classes = '', attrs = '') {
  return `<button class="button ${classes}" type="button" aria-label="${label}" ${attrs}>${iconName ? icon(iconName) : ''}<span>${label}</span></button>`;
}

function pageHeader(title, copy, actions = '', statusType, statusText) {
  return `<header class="page-header"><div class="page-title"><div class="title-row"><h1>${title}</h1>${statusPill(statusType, statusText)}</div><p>${copy}</p></div><div class="header-actions">${actions}</div></header>`;
}

function inspectorTemplate(title, statusType, statusText, sections) {
  return `<div class="inspector-head">${icon('panel-right')}<h2>${title}</h2></div><div class="inspector-content"><div class="inspector-section">${statusPill(statusType, statusText)}</div>${sections}</div>`;
}

function renderHome() {
  return `<div class="page-shell">
    ${pageHeader('交付控制台', '今天只看目标、阻塞、审批和可交付结果。', `${button('新建目标', 'plus', 'primary', 'data-open="new-goal"')}${button('继续最近任务', 'play', '', 'data-page="assistant"')}`, 'current', '当前能力')}
    <div class="notice warning">${icon('shield-alert')}<div><strong>1 个副作用结果未知，已停止自动重放</strong><small>数据库部署任务正在等待只读对账；其他运行不受影响。</small></div>${button('处理', 'arrow-right', '', 'data-page="recovery"')}</div>
    <section class="stat-strip" aria-label="项目关键指标">
      <div class="stat"><span>进行中目标</span><strong>3</strong><small>1 个阻塞</small></div>
      <div class="stat"><span>活跃运行</span><strong>4</strong><small>并发 4 / 8</small></div>
      <div class="stat"><span>待你审批</span><strong>2</strong><small>最高中风险</small></div>
      <div class="stat"><span>本月成本</span><strong>¥38.20</strong><small>/ ¥100</small></div>
    </section>
    <div class="grid wide-left">
      <section class="surface">
        <header class="surface-header"><h2>黄金工作流</h2><span>本地代码修复并交付 Diff / patch</span><span class="spacer"></span>${chip('4 / 7', 'info')}</header>
        <div class="surface-body">
          <div class="delivery-flow">
            <div class="flow-step complete"><strong>目标</strong><small>修复 OTP 节流</small></div><div class="flow-step complete"><strong>定位</strong><small>429 根因确认</small></div><div class="flow-step complete"><strong>修改</strong><small>3 个文件</small></div><div class="flow-step complete"><strong>测试</strong><small>7 / 7 通过</small></div><div class="flow-step active"><strong>审查</strong><small>等待你确认</small></div><div class="flow-step"><strong>验收</strong><small>2 项标准</small></div><div class="flow-step"><strong>交付</strong><small>Diff + patch</small></div>
          </div>
          <div class="metric-row"><span>当前工作项</span><strong>WI-104 · 审查代码变更</strong></div>
          <div class="metric-row"><span>执行身份</span><strong>开发员 / Run 24F7</strong></div>
          <div class="metric-row"><span>最新证据</span><strong class="mono">test:otp · exit 0 · 8b7d…e3</strong></div>
          <div class="metric-row"><span>下一动作</span><strong style="color:var(--amber)">批准进入 Acceptance</strong></div>
        </div>
        <footer class="surface-footer"><span>所有写入已进入 Effect Ledger</span>${button('打开交付中心', 'package-check', 'primary', 'data-page="delivery"')}</footer>
      </section>
      <section class="surface">
        <header class="surface-header"><h2>需要你处理</h2><span class="spacer"></span>${chip('2', 'warning')}</header>
        <div class="action-list">
          <button class="action-row" type="button" data-open="approval"><span class="action-icon">${icon('git-compare-arrows')}</span><span><strong>审查 3 个文件的 Diff</strong><small>开发员 · 中风险 · 12 分钟前</small></span>${icon('chevron-right')}</button>
          <button class="action-row" type="button" data-open="reconcile"><span class="action-icon">${icon('shield-question')}</span><span><strong>确认部署是否已执行</strong><small>运维员 · 结果未知 · 38 分钟前</small></span>${icon('chevron-right')}</button>
          <button class="action-row" type="button" data-page="learning"><span class="action-icon">${icon('brain-circuit')}</span><span><strong>2 条学习草稿待批准</strong><small>未批准内容不会进入提示词</small></span>${icon('chevron-right')}</button>
        </div>
      </section>
    </div>
    <div class="grid two" style="margin-top:14px">
      <section class="surface">
        <header class="surface-header"><h2>运行状态</h2><span class="spacer"></span><button class="button" type="button" data-page="runs">全部运行</button></header>
        <div class="table-wrap"><table class="data-table"><thead><tr><th>工作项</th><th>执行者</th><th>状态</th><th>耗时</th><th>成本</th></tr></thead><tbody>
          <tr><td><div class="cell-main">${icon('code-2')}<span><strong>修复 OTP 节流</strong><small>WI-102</small></span></div></td><td>开发员</td><td>${chip('执行中','info')}</td><td>06:42</td><td>¥0.41</td></tr>
          <tr><td><div class="cell-main">${icon('flask-conical')}<span><strong>回归测试</strong><small>WI-103</small></span></div></td><td>测试员</td><td>${chip('等待依赖','warning')}</td><td>—</td><td>—</td></tr>
          <tr><td><div class="cell-main">${icon('database')}<span><strong>部署数据库迁移</strong><small>WI-091</small></span></div></td><td>运维员</td><td>${chip('待对账','danger')}</td><td>18:24</td><td>¥0.68</td></tr>
        </tbody></table></div>
      </section>
      <section class="surface">
        <header class="surface-header"><h2>最新事件</h2><span class="spacer"></span><button class="button" type="button" data-page="recovery">审计日志</button></header>
        <div class="surface-body event-timeline">
          <div class="event"><time>14:22:18</time><span class="event-mark"></span><div class="event-body"><strong>测试证据已记录</strong><small>7 / 7 通过 · Artifact test-report</small></div></div>
          <div class="event"><time>14:21:44</time><span class="event-mark"></span><div class="event-body"><strong>跨 Provider 接管完成</strong><small>DeepSeek → Kimi · 同一信任域</small></div></div>
          <div class="event warning"><time>14:19:06</time><span class="event-mark"></span><div class="event-body"><strong>余额不足触发故障切换</strong><small>HTTP 402 · 原 Attempt 已关闭</small></div></div>
          <div class="event"><time>14:15:39</time><span class="event-mark"></span><div class="event-body"><strong>工作区隔离完成</strong><small class="mono">wt/otp-login · clean base</small></div></div>
        </div>
      </section>
    </div>
  </div>`;
}

function renderAssistant() {
  return `<div class="chat-layout">
    <header class="chat-head"><div><h1>修复手机号验证码登录</h1><p>Goal G-024 · 同一任务状态可无损切换至 Studio</p></div>${statusPill('partial','运行中')}${button('查看任务', 'list-checks', 'studio-only', 'data-page="work"')}${button('暂停', 'pause', '', 'data-toast="运行将在安全检查点暂停"')}</header>
    <div class="chat-thread">
      <article class="message user"><div class="message-body"><p>修复登录接口的 60 秒节流问题。先跑测试，再把 Diff 和 patch 给我，不要直接合并。</p></div></article>
      <article class="message"><span class="avatar avatar-dev">开</span><div class="message-body"><h3>开发员 <span style="color:var(--ink-3);font-weight:500">· 14:18</span></h3><p>已确认问题来自进程内节流状态在重启后丢失。我把计数迁移到现有持久层，并补了并发与重启测试。</p><div class="tool-line studio-only"><header>${icon('terminal')}<strong class="mono">npm test -- otp</strong><span class="spacer"></span>${chip('exit 0','success')}</header><pre>PASS test/otp.service.spec.ts\n+ 60 秒窗口内拒绝重复发送\n+ 重启后保留剩余窗口\nTests: 7 passed, 7 total</pre></div></div></article>
      <div class="notice warning" style="max-width:760px;margin:0 auto 20px">${icon('refresh-cw')}<div><strong>算力已自动接管，任务未中断</strong><small class="studio-only">DeepSeek-V3 余额不足 → 同信任域 Kimi-K2；上下文、Run 与工作项身份保持不变。</small><small class="assistant-only">任务已自动恢复，进度和文件没有丢失。</small></div></div>
      <article class="message"><span class="avatar avatar-test">验</span><div class="message-body"><h3>测试员 <span style="color:var(--ink-3);font-weight:500">· 14:22</span></h3><p>7 项测试全部通过，Diff 已准备好。按照你的要求，尚未合并或推送。</p><div class="approval-card"><h4>批准进入交付验收</h4><p>将冻结本轮 Diff、测试证据和 patch 摘要。此操作不会写入主分支。</p><div class="approval-actions">${button('查看 Diff', 'git-compare', '', 'data-page="delivery"')}${button('批准', 'check', 'primary', 'data-toast="已批准进入 Acceptance"')}</div></div></div></article>
    </div>
    <div class="composer"><div class="composer-box"><textarea aria-label="消息" placeholder="继续说明目标，或用 @ 引用文件…"></textarea><div class="composer-actions">${button('@ 文件', 'paperclip', '', 'data-toast="资源选择器已打开"')}<span class="studio-only">${button('wt/otp-login', 'git-branch', '', 'data-page="resources"')}</span><span class="spacer"></span><span class="studio-only">${chip('Kimi-K2 · 质量优先','info')}</span>${button('发送', 'arrow-up', 'primary', 'data-toast="原型消息已发送"')}</div></div></div>
  </div>`;
}

function renderProjects() {
  return `<div class="page-shell">
    ${pageHeader('项目', '项目是资源、规则、目标、任务、预算、权限、记忆和审计的统一边界。', `${button('导入本地项目','folder-input','')}${button('新建项目','plus','primary','data-open="new-project"')}`, 'current','当前能力')}
    <div class="notice success">${icon('hard-drive')}<div><strong>所有项目数据保存在本机</strong><small>删除项目关联不会删除源文件；永久删除前会显示完整影响范围。</small></div>${button('数据管理','database','', 'data-page="settings"')}</div>
    <section class="surface"><header class="surface-header"><div class="segmented"><button class="active">活跃 4</button><button>已归档 2</button><button>回收站 1</button></div><span class="spacer"></span>${button('筛选','sliders-horizontal','')}</header><div class="table-wrap"><table class="data-table"><thead><tr><th>项目</th><th>类型</th><th>活跃目标</th><th>运行</th><th>预算</th><th>更新时间</th><th>状态</th></tr></thead><tbody>
      <tr data-open="project-detail"><td><div class="cell-main"><span class="action-icon">${icon('code-2')}</span><span><strong>CaoGen Desktop</strong><small>3 个资源 · 1 个本地仓库</small></span></div></td><td>Software</td><td>2</td><td>4</td><td>¥38 / 100</td><td>刚刚</td><td>${chip('活跃','success')}</td></tr>
      <tr><td><div class="cell-main"><span class="action-icon">${icon('globe-2')}</span><span><strong>CaoGen Website</strong><small>2 个资源 · GitHub</small></span></div></td><td>OPC</td><td>1</td><td>0</td><td>¥12 / 50</td><td>2 小时前</td><td>${chip('活跃','success')}</td></tr>
      <tr><td><div class="cell-main"><span class="action-icon">${icon('microscope')}</span><span><strong>竞品研究</strong><small>12 个网页 · 4 份报告</small></span></div></td><td>Research</td><td>1</td><td>1</td><td>¥26 / 80</td><td>昨天</td><td>${chip('活跃','success')}</td></tr>
      <tr><td><div class="cell-main"><span class="action-icon">${icon('folder')}</span><span><strong>旧版迁移</strong><small>只读归档</small></span></div></td><td>Custom</td><td>0</td><td>0</td><td>—</td><td>7 天前</td><td>${chip('已归档','neutral')}</td></tr>
    </tbody></table></div></section>
    <div class="grid three" style="margin-top:14px">
      <section class="surface"><header class="surface-header"><h2>资源完整性</h2>${statusPill('current','已验证')}</header><div class="surface-body"><div class="metric-row"><span>稳定 Project ID</span><strong>正常</strong></div><div class="metric-row"><span>资源摘要</span><strong>3 / 3 匹配</strong></div><div class="metric-row"><span>最近备份</span><strong>4 分钟前</strong></div></div></section>
      <section class="surface"><header class="surface-header"><h2>项目规则</h2>${statusPill('current','当前能力')}</header><div class="surface-body"><div class="metric-row"><span>规则文件</span><strong class="mono">caogen.md</strong></div><div class="metric-row"><span>禁止路径</span><strong>4 条</strong></div><div class="metric-row"><span>验收命令</span><strong>3 条</strong></div></div></section>
      <section class="surface"><header class="surface-header"><h2>生命周期</h2>${statusPill('partial','部分完成')}</header><div class="surface-body"><div class="metric-row"><span>导出清单</span><strong>可用</strong></div><div class="metric-row"><span>统一保留策略</span><strong style="color:var(--amber)">待闭环</strong></div><div class="metric-row"><span>跨对象删除</span><strong style="color:var(--amber)">待闭环</strong></div></div></section>
    </div>
  </div>`;
}

function renderWork() {
  return `<div class="page-shell">
    ${pageHeader('目标与工作项', '围绕一个可验收结果组织计划、依赖、负责人和运行明细。', `${button('List','list','')}${button('Board','columns-3','primary')}${button('新建工作项','plus','', 'data-open="new-task"')}`, 'partial','部分完成')}
    <div class="surface" style="margin-bottom:14px"><div class="surface-body"><div class="grid wide-left"><div><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><strong>修复登录并交付 patch</strong>${chip('G-024','neutral')}${chip('执行中','info')}</div><div class="progress"><i style="width:68%"></i></div><div style="display:flex;justify-content:space-between;margin-top:6px;color:var(--ink-3);font-size:9px"><span>4 / 6 工作项完成</span><span>预算 ¥1.09 / 5.00 · 截止今天 18:00</span></div></div><div class="header-actions">${button('Goal Contract','scroll-text','', 'data-open="goal-contract"')}${button('DAG','git-fork','', 'data-toast="DAG 视图已切换"')}</div></div></div></div>
    <div class="task-board">
      <section class="board-column"><header class="board-heading"><strong>准备</strong><span>2</span></header><article class="task-card" data-open="task"><span class="priority">P1</span><h3>生成最终交付报告</h3><p>依赖测试与用户验收。</p><div class="task-meta">${icon('link')} 2 依赖 <span class="avatar avatar-ops">交</span></div></article><article class="task-card"><span class="priority">P2</span><h3>更新变更日志</h3><p>只记录本轮真实修改。</p><div class="task-meta">${icon('file-text')} 文档 <span class="avatar avatar-research">写</span></div></article></section>
      <section class="board-column running"><header class="board-heading"><strong>执行中</strong><span>1</span></header><article class="task-card" data-open="run"><span class="priority">P0</span>${chip('Run 24F7','info')}<h3>修复 OTP 节流持久化</h3><p>正在冻结测试证据和变更摘要。</p><div class="progress"><i style="width:82%"></i></div><div class="task-meta" style="margin-top:8px">06:42 · ¥0.41 <span class="avatar avatar-dev">开</span></div></article></section>
      <section class="board-column waiting"><header class="board-heading"><strong>等待</strong><span>2</span></header><article class="task-card" data-open="approval"><span class="priority">P0</span>${chip('待审批','warning')}<h3>审查 3 个文件的 Diff</h3><p>不会直接合并到主工作区。</p><div class="task-meta">12 分钟前 <span class="avatar avatar-test">验</span></div></article><article class="task-card"><span class="priority">P0</span>${chip('等待依赖','neutral')}<h3>执行完整回归测试</h3><p>依赖 WI-102 审查通过。</p><div class="task-meta">7 条命令 <span class="avatar avatar-test">测</span></div></article></section>
      <section class="board-column done"><header class="board-heading"><strong>完成</strong><span>3</span></header><article class="task-card"><span class="priority">P0</span>${chip('已验收','success')}<h3>复现 60 秒节流失效</h3><p>强杀重启后可稳定复现。</p><div class="task-meta">Evidence 4 <span class="avatar avatar-research">研</span></div></article><article class="task-card"><span class="priority">P1</span>${chip('已验收','success')}<h3>确认修改边界</h3><p>禁止修改鉴权协议与数据库 schema。</p><div class="task-meta">Acceptance rev 2 <span class="avatar avatar-test">审</span></div></article></section>
    </div>
  </div>`;
}

function renderRuns() {
  return `<div class="page-shell">
    ${pageHeader('运行与 Supervisor', '查看每个 WorkItem 的执行、Attempt、租约、控制状态和恢复边界。', `${button('暂停全部','pause','')}${button('运行策略','sliders-horizontal','', 'data-open="run-policy"')}`, 'partial','部分完成')}
    <section class="stat-strip"><div class="stat"><span>活跃</span><strong>4</strong><small>并发 4 / 8</small></div><div class="stat"><span>等待</span><strong>3</strong><small>审批 / 依赖</small></div><div class="stat"><span>需对账</span><strong>1</strong><small>已阻止重放</small></div><div class="stat"><span>今日成功率</span><strong>92%</strong><small>原型示例</small></div></section>
    <div class="grid wide-left">
      <section class="surface"><header class="surface-header"><div class="segmented"><button class="active">全部 8</button><button>活跃 4</button><button>等待 3</button><button>异常 1</button></div><span class="spacer"></span>${button('筛选','filter','')}</header><div class="table-wrap"><table class="data-table"><thead><tr><th>Run / 工作项</th><th>执行者</th><th>Attempt</th><th>状态</th><th>心跳</th><th>耗时</th></tr></thead><tbody>
        <tr data-open="run"><td><div class="cell-main">${icon('radio')}<span><strong>24F7 · 修复 OTP 节流</strong><small>WI-102 · wt/otp-login</small></span></div></td><td>开发员</td><td>2</td><td>${chip('执行中','info')}</td><td>3 秒前</td><td>06:42</td></tr>
        <tr><td><div class="cell-main">${icon('clock-3')}<span><strong>24F8 · 回归测试</strong><small>WI-103 · 依赖 WI-102</small></span></div></td><td>测试员</td><td>0</td><td>${chip('等待依赖','warning')}</td><td>—</td><td>—</td></tr>
        <tr data-open="reconcile"><td><div class="cell-main">${icon('shield-question')}<span><strong>23E1 · 数据库迁移</strong><small>WI-091 · Effect 结果未知</small></span></div></td><td>运维员</td><td>1</td><td>${chip('待对账','danger')}</td><td>38 分钟前</td><td>18:24</td></tr>
        <tr><td><div class="cell-main">${icon('check-circle-2')}<span><strong>22C8 · 根因分析</strong><small>WI-099 · Acceptance passed</small></span></div></td><td>研究员</td><td>1</td><td>${chip('已完成','success')}</td><td>—</td><td>04:13</td></tr>
      </tbody></table></div></section>
      <section class="surface"><header class="surface-header"><h2>Run 24F7</h2><span class="spacer"></span>${chip('lease 有效','success')}</header><div class="surface-body"><div class="metric-row"><span>状态</span><strong>executing</strong></div><div class="metric-row"><span>负责人</span><strong>开发员</strong></div><div class="metric-row"><span>租约</span><strong class="mono">lease-9c2 · f:18</strong></div><div class="metric-row"><span>Checkpoint</span><strong>14:22:17</strong></div><div class="metric-row"><span>当前 Attempt</span><strong>Kimi-K2 · #2</strong></div><div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap">${button('暂停','pause','')}${button('取消','square','danger')}${button('重新分配','user-round-cog','')}</div></div></section>
    </div>
  </div>`;
}

function renderDelivery() {
  return `<div class="page-shell">
    ${pageHeader('产物与交付', '把修改、测试、证据、风险和未完成项冻结为可检查的交付包。', `${button('导出 patch','download','primary','data-toast="Patch 导出任务已创建"')}${button('创建 PR','git-pull-request','', 'data-open="remote-delivery"')}`, 'partial','黄金工作流')}
    <div class="notice success">${icon('badge-check')}<div><strong>测试门禁已通过，等待最终验收</strong><small>7 / 7 测试通过；主工作区尚未修改，远端也没有副作用。</small></div>${button('批准交付','check','primary','data-open="final-acceptance"')}</div>
    <div class="delivery-flow" style="margin-bottom:14px"><div class="flow-step complete"><strong>目标</strong><small>G-024</small></div><div class="flow-step complete"><strong>工作项</strong><small>6 项</small></div><div class="flow-step complete"><strong>运行</strong><small>Run 24F7</small></div><div class="flow-step complete"><strong>产物</strong><small>4 项</small></div><div class="flow-step complete"><strong>证据</strong><small>9 条</small></div><div class="flow-step active"><strong>验收</strong><small>待批准</small></div><div class="flow-step waiting"><strong>交付</strong><small>Diff / patch</small></div></div>
    <div class="grid wide-left">
      <section class="surface"><header class="surface-header">${icon('git-compare')}<h2>代码变更</h2>${chip('+84 −19','success')}<span class="spacer"></span><div class="segmented"><button class="active">Diff</button><button>文件 3</button><button>提交</button></div></header>
        <div class="diff-view" style="height:430px"><div class="diff-file"><span>src/auth/otp.service.ts</span><span style="color:#8ed0ac">+38</span><span style="color:#e4938a">−9</span><span style="margin-left:auto">UTF-8</span></div><div class="diff-line hunk"><span class="line-no"></span><span></span><span>@@ -18,10 +18,21 @@ export class OtpService {</span></div><div class="diff-line"><span class="line-no">18</span><span> </span><span>constructor(private readonly store: OtpWindowStore) {}</span></div><div class="diff-line del"><span class="line-no">19</span><span>−</span><span>private readonly windows = new Map&lt;string, number&gt;();</span></div><div class="diff-line add"><span class="line-no">19</span><span>+</span><span>private readonly windowSeconds = 60;</span></div><div class="diff-line add"><span class="line-no">20</span><span>+</span><span>async send(phone: string): Promise&lt;OtpReceipt&gt; {</span></div><div class="diff-line add"><span class="line-no">21</span><span>+</span><span>  const window = await this.store.getWindow(phone);</span></div><div class="diff-line add"><span class="line-no">22</span><span>+</span><span>  if (window?.remaining &gt; 0) throw new TooManyRequestsException();</span></div><div class="diff-line add"><span class="line-no">23</span><span>+</span><span>  const receipt = await this.provider.send(phone);</span></div><div class="diff-line add"><span class="line-no">24</span><span>+</span><span>  await this.store.commitWindow(phone, this.windowSeconds);</span></div><div class="diff-line add"><span class="line-no">25</span><span>+</span><span>  return receipt;</span></div><div class="diff-line add"><span class="line-no">26</span><span>+</span><span>}</span></div><div class="diff-line hunk"><span class="line-no"></span><span></span><span>@@ -42,5 +53,12 @@ async verify(input: OtpInput) {</span></div><div class="diff-line add"><span class="line-no">53</span><span>+</span><span>await this.store.consumeWindow(input.phone);</span></div></div>
        <footer class="surface-footer"><span>Artifact code_patch · sha256 8b7d…e3</span><div>${button('逐 hunk 审查','scan-search','')}${button('接受全部','check','primary','data-toast="已接受当前 Diff"')}</div></footer>
      </section>
      <div class="grid"><section class="surface"><header class="surface-header"><h2>Acceptance</h2><span class="spacer"></span>${chip('2 / 3','warning')}</header><div class="surface-body"><div class="metric-row"><span>✓ 60 秒内拒绝重复发送</span><strong>${chip('通过','success')}</strong></div><div class="metric-row"><span>✓ 重启后保持窗口</span><strong>${chip('通过','success')}</strong></div><div class="metric-row"><span>○ 用户确认 Diff 范围</span><strong>${chip('待批准','warning')}</strong></div></div></section>
        <section class="surface"><header class="surface-header"><h2>交付包</h2><span class="spacer"></span>${chip('4 产物','info')}</header><div class="action-list"><button class="action-row" data-toast="Patch 预览已打开"><span class="action-icon">${icon('file-diff')}</span><span><strong>otp-throttle.patch</strong><small>12.8 KB · sha256 8b7d…e3</small></span>${icon('download')}</button><button class="action-row"><span class="action-icon">${icon('file-check-2')}</span><span><strong>test-report.json</strong><small>7 / 7 · exit 0</small></span>${icon('eye')}</button><button class="action-row"><span class="action-icon">${icon('scroll-text')}</span><span><strong>delivery-report.md</strong><small>范围、风险、成本、未完成项</small></span>${icon('eye')}</button><button class="action-row"><span class="action-icon">${icon('file-archive')}</span><span><strong>evidence-manifest.json</strong><small>9 条 Evidence · hash chain</small></span>${icon('eye')}</button></div></section></div>
    </div>
  </div>`;
}

function renderTeam() {
  const workers = [['研','研究员','avatar-research','资料检索、根因分析与来源核验','96%','¥4.20','12'],['策','策划员','avatar-ops','目标拆解、约束整理与计划变更','91%','¥2.84','8'],['开','开发员','avatar-dev','代码实现、测试与可回滚 patch','94%','¥8.12','19'],['验','审查员','avatar-test','Diff 审查、证据检查与验收','98%','¥3.76','15'],['设','设计员','avatar-design','界面方案、视觉资产与设计检查','88%','¥5.61','7'],['运','运维员','avatar-ops','发布、监控、回滚与外部副作用','90%','¥6.43','9']];
  return `<div class="page-shell">
    ${pageHeader('数字团队', '岗位身份与 Provider、模型解耦；每个岗位持有职责、权限、预算和验收策略。', `${button('岗位模板','library','')}${button('加入团队','user-plus','primary','data-open="hire-worker"')}`, 'partial','部分完成')}
    <div class="notice">${icon('info')}<div><strong>人物形象表达岗位，不表达模型品牌</strong><small>当前原型使用角色字标；水彩人物资产将在视觉样板通过后替换。</small></div>${statusPill('target','视觉目标')}</div>
    <div class="team-grid">${workers.map((w, index) => `<article class="worker-card" data-open="worker"><div class="worker-head"><span class="avatar ${w[2]}">${w[0]}</span><span><strong>${w[1]}</strong><small>${index === 5 ? '待对账' : index === 4 ? '空闲' : '活跃'} · Project scope</small></span><span style="margin-left:auto">${chip(index === 5 ? '注意' : '在岗', index === 5 ? 'warning' : 'success')}</span></div><p>${w[3]}</p><div class="worker-stats"><span><strong>${w[4]}</strong>验收率</span><span><strong>${w[5]}</strong>本月</span><span><strong>${w[6]}</strong>任务</span></div></article>`).join('')}</div>
    <section class="surface" style="margin-top:14px"><header class="surface-header"><h2>团队策略覆盖</h2><span class="spacer"></span>${statusPill('partial','执行守卫仍有缺口')}</header><div class="table-wrap"><table class="data-table"><thead><tr><th>策略</th><th>默认</th><th>已覆盖入口</th><th>状态</th></tr></thead><tbody><tr><td>数据范围</td><td>仅当前项目</td><td>Provider / Tool / Supervisor</td><td>${chip('部分完成','warning')}</td></tr><tr><td>预算</td><td>按岗位 + 项目</td><td>Provider send / Router</td><td>${chip('部分完成','warning')}</td></tr><tr><td>高风险权限</td><td>每次审批</td><td>文件 / Git / GUI / MCP</td><td>${chip('部分完成','warning')}</td></tr><tr><td>验收规则</td><td>Evidence 必填</td><td>WorkItem terminal gate</td><td>${chip('已验证','success')}</td></tr></tbody></table></div></section>
  </div>`;
}

function renderOffice() {
  return `<div class="office-stage"><img src="../docs/screenshot-office.jpg" alt="CaoGen 当前 3D Office 场景"><header class="office-toolbar"><div><h1>3D Office</h1><span style="font-size:9px;color:var(--ink-3)">真实 Run、审批、成本和工作区状态投影</span></div>${statusPill('partial','当前场景 / 目标角色')}<span class="spacer"></span><div class="office-legend"><span><i style="background:var(--green)"></i>运行 3</span><span><i style="background:var(--amber)"></i>等待 2</span><span><i style="background:var(--danger)"></i>对账 1</span></div>${button('列表回退','list','', 'data-page="team"')}${button('场景设置','sliders-horizontal','', 'data-page="settings"')}</header><section class="office-panel"><header class="surface-header"><span class="avatar avatar-dev">开</span><div><h2>开发员</h2><span>WI-102 · Run 24F7</span></div><span class="spacer"></span>${chip('运行中','success')}</header><div class="surface-body"><div class="metric-row"><span>正在执行</span><strong>冻结测试 Evidence</strong></div><div class="metric-row"><span>当前模型</span><strong>Kimi-K2</strong></div><div class="metric-row"><span>路由</span><strong>DeepSeek → Kimi</strong></div><div class="metric-row"><span>工作区</span><strong class="mono">wt/otp-login · 3 变更</strong></div><div class="metric-row"><span>本轮成本</span><strong>¥0.41</strong></div><div style="display:flex;gap:6px;margin-top:11px">${button('打开运行','activity','primary','data-page="runs"')}${button('打开 Diff','git-compare','', 'data-page="delivery"')}</div></div></section></div>`;
}

function renderRoutines() {
  return `<div class="page-shell">
    ${pageHeader('Routines', '本地定时任务、运行记录和通知；目标态会把每次到期执行纳入 Project、WorkItem 与 Run。', `${button('日历','calendar-days','')}${button('新建 Routine','plus','primary','data-open="new-routine"')}`, 'current','本地能力已验证')}
    <div class="grid three" style="margin-bottom:14px"><section class="surface"><div class="surface-body"><span style="color:var(--ink-3);font-size:9px">下次运行</span><h2 style="margin:6px 0 3px;font-size:19px">今天 18:00</h2><small>每日项目状态摘要</small></div></section><section class="surface"><div class="surface-body"><span style="color:var(--ink-3);font-size:9px">本周成功</span><h2 style="margin:6px 0 3px;font-size:19px">18 / 19</h2><small>1 次预算阻塞</small></div></section><section class="surface"><div class="surface-body"><span style="color:var(--ink-3);font-size:9px">防休眠</span><h2 style="margin:6px 0 3px;font-size:19px">1 个任务</h2><small>运行完成后自动释放</small></div></section></div>
    <section class="surface"><header class="surface-header"><div class="segmented"><button class="active">全部</button><button>已启用</button><button>已暂停</button></div><span class="spacer"></span>${button('运行记录','history','')}</header><div class="table-wrap"><table class="data-table"><thead><tr><th>Routine</th><th>绑定</th><th>计划</th><th>下次运行</th><th>最近结果</th><th>状态</th></tr></thead><tbody>
      <tr data-open="routine"><td><div class="cell-main">${icon('sunset')}<span><strong>每日项目状态摘要</strong><small>通知 + Artifact</small></span></div></td><td>CaoGen Desktop</td><td>每天 18:00</td><td>3 小时后</td><td>${chip('成功','success')}</td><td><button class="toggle on" aria-label="启用每日项目状态摘要"></button></td></tr>
      <tr><td><div class="cell-main">${icon('shield-check')}<span><strong>每周依赖与安全审计</strong><small>创建测试 WorkItem</small></span></div></td><td>CaoGen Desktop</td><td>周一 09:00</td><td>3 天后</td><td>${chip('成功','success')}</td><td><button class="toggle on" aria-label="启用每周依赖与安全审计"></button></td></tr>
      <tr><td><div class="cell-main">${icon('globe-2')}<span><strong>竞品页面变化巡检</strong><small>需要网络权限</small></span></div></td><td>竞品研究</td><td>每周五</td><td>已错过</td><td>${chip('预算阻塞','warning')}</td><td><button class="toggle" aria-label="启用竞品页面变化巡检"></button></td></tr>
    </tbody></table></div></section>
  </div>`;
}

function renderResources() {
  return `<div class="page-shell">
    ${pageHeader('资源与工作台', '在项目边界内查看文件、终端、浏览器、Diff、预览、Git 和 Office 结构。', `${button('打开终端','terminal','')}${button('添加资源','plus','primary','data-open="add-resource"')}`, 'current','当前能力')}
    <div class="file-workbench"><aside class="file-tree"><header><strong>CAOGEN DESKTOP</strong><span style="margin-left:auto">${icon('refresh-cw')}</span></header><div class="tree-row">${icon('chevron-down')}${icon('folder-open')} src</div><div class="tree-row indent">${icon('chevron-down')}${icon('folder-open')} auth</div><div class="tree-row indent active" style="padding-left:39px">${icon('file-code-2')} otp.service.ts</div><div class="tree-row indent" style="padding-left:39px">${icon('file-code-2')} auth.controller.ts</div><div class="tree-row indent">${icon('folder')} test</div><div class="tree-row">${icon('folder')} docs</div><div class="tree-row">${icon('file-text')} caogen.md</div><div class="tree-row">${icon('file-json-2')} package.json</div></aside>
      <section class="preview-area"><header class="preview-header">${icon('file-code-2')}<strong>src/auth/otp.service.ts</strong>${chip('M','warning')}<span class="spacer"></span>${button('在 Diff 中打开','git-compare','', 'data-page="delivery"')}${button('发给 Agent','send','primary','data-toast="文件已加入当前上下文"')}</header><pre class="code-preview"><span style="color:#7f8983">01</span>  import { Injectable } from '@nestjs/common';
<span style="color:#7f8983">02</span>  import { OtpWindowStore } from './otp-window.store';
<span style="color:#7f8983">03</span>
<span style="color:#7f8983">04</span>  @Injectable()
<span style="color:#7f8983">05</span>  export class OtpService {
<span style="color:#7f8983">06</span>    private readonly windowSeconds = 60;
<span style="color:#7f8983">07</span>
<span style="color:#7f8983">08</span>    constructor(
<span style="color:#7f8983">09</span>      private readonly store: OtpWindowStore,
<span style="color:#7f8983">10</span>      private readonly provider: SmsProvider,
<span style="color:#7f8983">11</span>    ) {}
<span style="color:#7f8983">12</span>
<span style="color:#7f8983">13</span>    async send(phone: string): Promise&lt;OtpReceipt&gt; {
<span style="color:#7f8983">14</span>      const window = await this.store.getWindow(phone);
<span style="color:#7f8983">15</span>      if (window?.remaining &gt; 0) throw new TooManyRequestsException();
<span style="color:#7f8983">16</span>      const receipt = await this.provider.send(phone);
<span style="color:#7f8983">17</span>      await this.store.commitWindow(phone, this.windowSeconds);
<span style="color:#7f8983">18</span>      return receipt;
<span style="color:#7f8983">19</span>    }
<span style="color:#7f8983">20</span>  }</pre></section></div>
  </div>`;
}

function renderExtensions() {
  const items = [['GitHub','connector','git-pull-request','项目资源与交付','已连接','success'],['Filesystem','mcp','folder-lock','受控文件读写','内置','success'],['Playwright','mcp','monitor-check','浏览器验证与截图','已启用','success'],['Code Review','skill','scan-search','Diff 审查与证据规则','v2.1','info'],['Release Doctor','plugin','package-search','发布前证据聚合','v1.4','info'],['Notion','connector','notebook-tabs','项目资料同步','未配置','neutral']];
  return `<div class="page-shell">
    ${pageHeader('插件、Skill 与 MCP', '能力作为 Project Resource 或 Tool 接入，显示来源、版本、权限和摘要。', `${button('从本地安装','folder-input','')}${button('添加 MCP','plus','primary','data-open="add-mcp"')}`, 'current','当前能力')}
    <div class="notice warning">${icon('shield-alert')}<div><strong>1 个扩展请求扩大权限</strong><small>升级前先查看 capability diff；未批准版本不会进入执行路径。</small></div>${button('审查变更','scan-search','', 'data-open="capability-diff"')}</div>
    <div class="grid three">${items.map(item => `<section class="surface"><div class="surface-body"><div style="display:flex;align-items:center;gap:9px"><span class="action-icon">${icon(item[2])}</span><div style="min-width:0;flex:1"><strong>${item[0]}</strong><div style="color:var(--ink-3);font-size:9px">${item[1].toUpperCase()}</div></div>${chip(item[4],item[5])}</div><p style="color:var(--ink-3);font-size:10px;min-height:30px">${item[3]}</p><div style="display:flex;gap:6px">${button('详情','settings-2','', 'data-open="extension"')}${button('停用','pause','')}</div></div></section>`).join('')}</div>
    <section class="surface" style="margin-top:14px"><header class="surface-header"><h2>能力清单</h2><span class="spacer"></span>${statusPill('target','Capability Manifest 收口中')}</header><div class="table-wrap"><table class="data-table"><thead><tr><th>能力</th><th>来源</th><th>作用域</th><th>风险</th><th>审批</th></tr></thead><tbody><tr><td class="mono">filesystem.write</td><td>内置 Runtime</td><td>Project paths</td><td>${chip('中','warning')}</td><td>每次 Diff</td></tr><tr><td class="mono">github.pull_request.create</td><td>GitHub</td><td>1 repository</td><td>${chip('高','danger')}</td><td>每次</td></tr><tr><td class="mono">browser.navigate</td><td>Playwright MCP</td><td>Allowlist</td><td>${chip('低','success')}</td><td>按域</td></tr></tbody></table></div></section>
  </div>`;
}

function renderLearning() {
  return `<div class="page-shell">
    ${pageHeader('记忆与学习', '自动学习只生成项目级草稿；必须由用户批准后才能进入提示词或 Skill。', `${button('已批准','badge-check','')}${button('新建记忆','plus','primary','data-open="new-memory"')}`, 'current','审批生效')}
    <section class="stat-strip"><div class="stat"><span>待审批</span><strong>2</strong><small>不会自动生效</small></div><div class="stat"><span>已批准</span><strong>18</strong><small>当前项目</small></div><div class="stat"><span>即将过期</span><strong>1</strong><small>7 天内</small></div><div class="stat"><span>已撤销</span><strong>4</strong><small>保留审计</small></div></section>
    <div class="grid wide-left">
      <section class="surface"><header class="surface-header"><h2>学习草稿</h2>${chip('Memory','purple')}<span class="spacer"></span><span class="mono" style="font-size:9px;color:var(--ink-3)">draft mem-18d2</span></header><div class="surface-body"><h3 style="margin:0 0 5px;font-size:12px">测试前先确认项目包管理器</h3><p style="color:var(--ink-3);font-size:10px">来源：Run 24F7 · 置信度 0.91 · 仅 CaoGen Desktop</p><div class="diff-view" style="height:220px;margin-top:12px"><div class="diff-file">Project Memory / workflow-preferences.md</div><div class="diff-line add"><span class="line-no">+</span><span>+</span><span>运行测试前读取 lockfile，优先使用项目现有包管理器。</span></div><div class="diff-line add"><span class="line-no">+</span><span>+</span><span>存在 package-lock.json 时使用 npm，不切换到 pnpm 或 yarn。</span></div></div></div><footer class="surface-footer"><span>payload sha256 2f9a…71</span><div>${button('拒绝','x','danger','data-toast="学习草稿已拒绝"')}${button('编辑后批准','pencil','')}${button('批准','check','primary','data-toast="记忆已批准并将在下次 Run 生效"')}</div></footer></section>
      <div class="grid"><section class="surface"><header class="surface-header"><h2>生效边界</h2></header><div class="surface-body"><div class="metric-row"><span>项目</span><strong>CaoGen Desktop</strong></div><div class="metric-row"><span>读取者</span><strong>开发 / 测试岗位</strong></div><div class="metric-row"><span>有效期</span><strong>90 天</strong></div><div class="metric-row"><span>自动进入提示词</span><strong>批准后</strong></div></div></section><section class="surface"><header class="surface-header"><h2>版本历史</h2></header><div class="action-list"><button class="action-row"><span class="action-icon">${icon('rotate-ccw')}</span><span><strong>v3 · 当前草稿</strong><small>来自 Run 24F7</small></span>${chip('待审批','warning')}</button><button class="action-row"><span class="action-icon">${icon('check')}</span><span><strong>v2 · 已批准</strong><small>2026-07-20</small></span>${icon('chevron-right')}</button></div></section></div>
    </div>
  </div>`;
}

function renderRouting() {
  return `<div class="page-shell">
    ${pageHeader('Provider 与路由', '以能力、隐私、权限和预算为硬约束，再在健康候选中优化质量、速度和成本。', `${button('策略','sliders-horizontal','', 'data-open="routing-policy"')}${button('添加 Provider','plus','primary','data-open="provider"')}`, 'partial','当前能力 / 恢复目标')}
    <div class="notice">${icon('route')}<div><strong>跨 Provider 自动切换仅限批准的信任域</strong><small>首次跨域或跨区域传输需要确认；项目可设置 local_only、no_failover 和区域限制。</small></div>${button('信任域','shield-check','', 'data-open="trust-domain"')}</div>
    <div class="grid wide-left">
      <section class="surface"><header class="surface-header"><h2>Provider 健康</h2><span class="spacer"></span><span style="font-size:9px;color:var(--ink-3)">30 秒前更新</span></header><div class="table-wrap"><table class="data-table"><thead><tr><th>Provider</th><th>协议</th><th>健康</th><th>P95 延迟</th><th>本月成本</th><th>信任域</th></tr></thead><tbody>
        <tr data-open="provider"><td><div class="cell-main"><span class="project-dot" style="background:var(--green)"></span><span><strong>Local Ollama</strong><small>qwen3-coder</small></span></div></td><td>OpenAI compatible</td><td>${chip('健康','success')}</td><td>1.8s</td><td>¥0</td><td>${chip('本地','success')}</td></tr>
        <tr><td><div class="cell-main"><span class="project-dot" style="background:var(--blue)"></span><span><strong>Moonshot</strong><small>Kimi-K2</small></span></div></td><td>OpenAI compatible</td><td>${chip('健康','success')}</td><td>2.4s</td><td>¥18.40</td><td>${chip('CN-approved','info')}</td></tr>
        <tr><td><div class="cell-main"><span class="project-dot" style="background:var(--amber)"></span><span><strong>DeepSeek</strong><small>V3</small></span></div></td><td>OpenAI compatible</td><td>${chip('余额不足','warning')}</td><td>2.1s</td><td>¥9.20</td><td>${chip('CN-approved','info')}</td></tr>
        <tr><td><div class="cell-main"><span class="project-dot" style="background:var(--purple)"></span><span><strong>Anthropic</strong><small>Claude Sonnet</small></span></div></td><td>Messages</td><td>${chip('健康','success')}</td><td>3.2s</td><td>¥10.60</td><td>${chip('需确认','purple')}</td></tr>
      </tbody></table></div></section>
      <section class="surface"><header class="surface-header"><h2>当前决策</h2>${chip('质量优先','info')}</header><div class="surface-body"><div class="metric-row"><span>任务</span><strong>编码 · 中风险</strong></div><div class="metric-row"><span>硬条件</span><strong>工具 / CN 域 / ≤ ¥2</strong></div><div class="metric-row"><span>候选</span><strong>5 个 · 3 健康</strong></div><div class="metric-row"><span>选中</span><strong>Kimi-K2</strong></div><div class="metric-row"><span>原因</span><strong>质量档匹配</strong></div></div></section>
    </div>
    <section class="surface" style="margin-top:14px"><header class="surface-header"><h2>故障恢复阶梯</h2>${statusPill('target','目标契约')}</header><div class="surface-body"><div class="delivery-flow"><div class="flow-step complete"><strong>瞬时重试</strong><small>1 / 2</small></div><div class="flow-step complete"><strong>同 Key</strong><small>不可用</small></div><div class="flow-step complete"><strong>同 Provider</strong><small>无健康模型</small></div><div class="flow-step active"><strong>同协议 Provider</strong><small>Kimi 接管</small></div><div class="flow-step"><strong>跨协议</strong><small>需 Adapter</small></div><div class="flow-step"><strong>降级</strong><small>只读 / 本地</small></div><div class="flow-step"><strong>人工</strong><small>停止并说明</small></div></div></div></section>
  </div>`;
}

function renderRecovery() {
  return `<div class="page-shell">
    ${pageHeader('审计与恢复', '从 Goal 到 Effect 回答谁、何时、为何、用什么资源、产生什么结果，以及能否安全重试。', `${button('导出审计','download','')}${button('运行诊断','stethoscope','primary','data-toast="只读诊断已开始"')}`, 'partial','部分完成')}
    <div class="notice danger">${icon('shield-question')}<div><strong>Effect eff-7F2 的外部结果未知</strong><small>进程在部署请求发出后、回执持久化前退出。系统已进入 waiting_reconciliation，禁止自动重放。</small></div>${button('开始对账','scan-search','primary','data-open="reconcile"')}</div>
    <section class="stat-strip"><div class="stat"><span>Ledger 状态</span><strong style="color:var(--green)">完整</strong><small>hash chain valid</small></div><div class="stat"><span>非终态 Run</span><strong>4</strong><small>3 可恢复</small></div><div class="stat"><span>待对账 Effect</span><strong>1</strong><small>已停止重放</small></div><div class="stat"><span>读源模式</span><strong>legacy</strong><small>默认尚未切换</small></div></section>
    <div class="grid wide-right">
      <section class="surface"><header class="surface-header"><h2>恢复队列</h2><span class="spacer"></span>${chip('1 需人工','warning')}</header><div class="action-list"><button class="action-row" data-open="reconcile"><span class="action-icon">${icon('database-zap')}</span><span><strong>数据库迁移</strong><small>waiting_reconciliation · 38m</small></span>${chip('人工','danger')}</button><button class="action-row"><span class="action-icon">${icon('rotate-ccw')}</span><span><strong>竞品页面巡检</strong><small>retry_safe · 4m</small></span>${chip('可恢复','success')}</button><button class="action-row"><span class="action-icon">${icon('pause')}</span><span><strong>回归测试</strong><small>paused_by_user · 2m</small></span>${chip('已暂停','neutral')}</button></div></section>
      <section class="surface"><header class="surface-header"><h2>事件链 · Run 23E1</h2><span class="spacer"></span><span class="mono" style="font-size:9px;color:var(--ink-3)">verified 18 / 18</span></header><div class="surface-body event-timeline"><div class="event"><time>13:42:01</time><span class="event-mark"></span><div class="event-body"><strong>Run started</strong><small>lease 7bc · fencing 12</small></div></div><div class="event"><time>13:42:08</time><span class="event-mark"></span><div class="event-body"><strong>Approval granted</strong><small>scope: staging database migration</small></div></div><div class="event"><time>13:42:10</time><span class="event-mark"></span><div class="event-body"><strong>Effect prepared</strong><small class="mono">eff-7F2 · postcondition pending</small></div></div><div class="event warning"><time>13:42:11</time><span class="event-mark"></span><div class="event-body"><strong>Process heartbeat lost</strong><small>external request may have completed</small></div></div><div class="event danger"><time>13:42:42</time><span class="event-mark"></span><div class="event-body"><strong>Replay blocked</strong><small>waiting_reconciliation · read-only check required</small></div></div></div></section>
    </div>
    <section class="surface" style="margin-top:14px"><header class="surface-header"><h2>Canonical 切换准备度</h2>${statusPill('target','门禁驱动')}</header><div class="surface-body"><div class="grid four"><div><div class="metric-row"><span>入口盘点</span><strong>进行中</strong></div><div class="progress amber"><i style="width:72%"></i></div></div><div><div class="metric-row"><span>恢复场景</span><strong>1 / 11</strong></div><div class="progress red"><i style="width:9%"></i></div></div><div><div class="metric-row"><span>影子一致性</span><strong>本地通过</strong></div><div class="progress"><i style="width:86%"></i></div></div><div><div class="metric-row"><span>当前默认</span><strong>legacy</strong></div><div class="progress amber"><i style="width:33%"></i></div></div></div></div></section>
  </div>`;
}

function renderSettings() {
  return `<div class="page-shell">
    ${pageHeader('设置', '项目边界、运行策略、数据、权限、Provider、外观和迁移集中管理。', `${button('导出配置','download','')}${button('保存更改','save','primary','data-toast="设置已保存"')}`, 'current','当前能力')}
    <div class="surface"><div class="surface-body">
      <section class="form-section"><div class="form-copy"><h2>体验模式</h2><p>只改变信息密度，不改变任务、预算、权限或模型。</p></div><div class="form-controls"><div class="field"><label>默认模式</label><select><option>Studio</option><option>Assistant</option></select></div><div class="toggle-row"><span><strong>记住每个项目的布局</strong><small>面板、筛选和侧栏状态</small></span><button class="toggle on" type="button" aria-label="记住布局"></button></div></div></section>
      <section class="form-section"><div class="form-copy"><h2>权限与信任</h2><p>高风险操作默认 fail-closed，未知副作用不得自动重放。</p></div><div class="form-controls"><div class="field"><label>默认权限模式</label><select><option>按操作审批</option><option>只读</option><option>项目允许列表</option></select></div><div class="toggle-row"><span><strong>跨 Provider 首次传输需确认</strong><small>批准后可保存项目级信任域</small></span><button class="toggle on" type="button" aria-label="跨 Provider 首次传输需确认"></button></div><div class="toggle-row"><span><strong>禁止项目数据外发</strong><small>启用后仅使用 local_only 路由</small></span><button class="toggle" type="button" aria-label="禁止项目数据外发"></button></div></div></section>
      <section class="form-section"><div class="form-copy"><h2>预算与路由</h2><p>硬约束先于成本、速度和质量偏好。</p></div><div class="form-controls"><div class="field"><label>月度预算</label><input value="100.00" inputmode="decimal"></div><div class="field"><label>默认策略</label><select><option>质量优先</option><option>均衡</option><option>成本优先</option><option>速度优先</option></select></div></div></section>
      <section class="form-section"><div class="form-copy"><h2>本地数据</h2><p>统一管理保留、导出、备份、删除和 canonical 读源。</p></div><div class="form-controls"><div class="field"><label>备份保留</label><select><option>7 天</option><option>30 天</option><option>90 天</option></select></div><div class="field"><label>恢复读源</label><select><option>legacy（当前默认）</option><option>compare</option><option>canonical（门禁未满足）</option></select></div><div style="display:flex;gap:6px">${button('导出全部数据','archive','')}${button('检查完整性','shield-check','')}</div></div></section>
      <section class="form-section"><div class="form-copy"><h2>外观与性能</h2><p>3D 场景始终提供状态文字与列表回退。</p></div><div class="form-controls"><div class="field"><label>主题</label><select><option>跟随系统</option><option>浅色</option><option>深色</option></select></div><div class="toggle-row"><span><strong>低性能模式</strong><small>减少角色 LOD 和实时动画</small></span><button class="toggle" type="button" aria-label="低性能模式"></button></div><div class="toggle-row"><span><strong>减少动态效果</strong><small>同时尊重系统辅助功能设置</small></span><button class="toggle" type="button" aria-label="减少动态效果"></button></div></div></section>
    </div></div>
  </div>`;
}

const renderers = {
  home: renderHome,
  assistant: renderAssistant,
  projects: renderProjects,
  work: renderWork,
  runs: renderRuns,
  delivery: renderDelivery,
  team: renderTeam,
  office: renderOffice,
  routines: renderRoutines,
  resources: renderResources,
  extensions: renderExtensions,
  learning: renderLearning,
  routing: renderRouting,
  recovery: renderRecovery,
  settings: renderSettings
};

function defaultInspector(meta) {
  const statusCopy = meta.status === 'current'
    ? '已有实现或本地验证证据。'
    : meta.status === 'partial'
      ? '已有可验证切片，仍有产品或恢复边界开放。'
      : '目标产品设计，不代表当前已交付。';
  return inspectorTemplate(meta.label, meta.status, meta.statusText, `
    <section class="inspector-section"><h3>状态边界</h3><p style="margin:0;color:var(--ink-2);font-size:10px;line-height:1.6">${statusCopy}</p></section>
    <section class="inspector-section"><h3>当前项目</h3><div class="detail-list"><div class="detail-row"><span>项目</span><strong>CaoGen Desktop</strong></div><div class="detail-row"><span>项目类型</span><strong>Software</strong></div><div class="detail-row"><span>数据位置</span><strong>本地</strong></div></div></section>
    <section class="inspector-section"><h3>运行边界</h3><div class="detail-list"><div class="detail-row"><span>Provider</span><strong>自动路由</strong></div><div class="detail-row"><span>权限</span><strong>按操作审批</strong></div><div class="detail-row"><span>月度预算</span><strong>¥100</strong></div></div></section>`);
}

function renderPage(pageId, pushHash = true) {
  if (!renderers[pageId]) pageId = 'home';
  currentPage = pageId;
  if (pageId !== 'assistant' && app.dataset.mode === 'studio') previousStudioPage = pageId;
  const meta = pageMeta[pageId];
  workspace.innerHTML = renderers[pageId]();
  inspector.innerHTML = defaultInspector(meta);
  titleSection.textContent = meta.section;
  titlePage.textContent = meta.label;
  document.querySelectorAll('[data-page]').forEach(node => node.classList.toggle('active', node.dataset.page === pageId));
  if (pushHash) history.replaceState(null, '', `#${pageId}`);
  workspace.scrollTop = 0;
  refreshIcons();
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `${icon('check-circle-2')}<span>${message}</span>`;
  toastRegion.appendChild(toast);
  refreshIcons();
  window.setTimeout(() => toast.remove(), 2800);
}

const drawerContent = {
  approval: ['审查 Diff', '批准后只进入 Acceptance，不会自动合并或推送。', '中风险', '3 个文件', '7 / 7 测试', '¥0.41'],
  reconcile: ['副作用对账', '先读取目标系统状态，再决定标记成功、取消或授权新的 Attempt。', '高风险', 'Effect eff-7F2', '结果未知', '禁止自动重放'],
  run: ['Run 24F7', '同一 WorkItem 下的第 2 个 ModelAttempt，租约与 checkpoint 有效。', '执行中', '开发员', 'Kimi-K2', '06:42'],
  worker: ['开发员', '项目内岗位实例；身份、记忆和历史不绑定 Provider。', '在岗', '19 个任务', '94% 验收率', '¥8.12 / 月'],
  provider: ['Provider 配置', '凭据保存在主进程 Broker，Renderer 只读取脱敏状态。', '健康', 'OpenAI compatible', 'CN-approved', '2.4s P95'],
  'goal-contract': ['Goal Contract', '修复 OTP 节流并交付可审查的 Diff 与 patch，不直接写入主分支。', '执行中', '预算 ¥5', '截止 18:00', '3 条 Acceptance']
};

function openDrawer(kind) {
  const data = drawerContent[kind] || [kind.replaceAll('-', ' '), '该面板展示高保真交互结构；状态与能力边界以页面标签为准。', '原型状态', '当前项目', '本地优先', '按操作审批'];
  detailDrawer.innerHTML = `<header class="drawer-head"><span class="action-icon">${icon(kind === 'reconcile' ? 'shield-question' : 'panel-right-open')}</span><h2>${data[0]}</h2><button class="icon-button quiet" type="button" data-close-drawer aria-label="关闭">${icon('x')}</button></header><div class="drawer-body"><p style="margin:0 0 14px;color:var(--ink-2);line-height:1.65">${data[1]}</p><section class="surface"><div class="surface-body"><div class="metric-row"><span>状态</span><strong>${data[2]}</strong></div><div class="metric-row"><span>范围</span><strong>${data[3]}</strong></div><div class="metric-row"><span>证据</span><strong>${data[4]}</strong></div><div class="metric-row"><span>约束</span><strong>${data[5]}</strong></div></div></section><section class="inspector-section" style="margin-top:16px"><h3>审批记录</h3><div class="event-timeline"><div class="event"><time>14:22</time><span class="event-mark"></span><div class="event-body"><strong>请求已创建</strong><small>绑定当前 Project / WorkItem / Run</small></div></div><div class="event warning"><time>现在</time><span class="event-mark"></span><div class="event-body"><strong>等待用户决定</strong><small>未批准前不会产生新的副作用</small></div></div></div></section><div style="display:flex;gap:7px;justify-content:flex-end;margin-top:16px">${button('取消','x','', 'data-close-drawer')}${button(kind === 'reconcile' ? '执行只读对账' : '确认','check','primary', 'data-toast="操作已记录" data-close-drawer')}</div></div>`;
  drawerBackdrop.hidden = false;
  detailDrawer.classList.add('open');
  detailDrawer.setAttribute('aria-hidden', 'false');
  refreshIcons();
}

function closeDrawer() {
  detailDrawer.classList.remove('open');
  detailDrawer.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => { drawerBackdrop.hidden = true; }, 180);
}

function renderCommandResults(query = '') {
  const q = query.trim().toLowerCase();
  const entries = Object.entries(pageMeta).filter(([, meta]) => !q || `${meta.label} ${meta.section} ${meta.statusText}`.toLowerCase().includes(q));
  commandResults.innerHTML = entries.length
    ? entries.map(([id, meta], index) => `<button class="command-result ${index === 0 ? 'active' : ''}" type="button" data-page="${id}" data-close-palette><span class="action-icon">${icon(meta.icon)}</span><span><strong>${meta.label}</strong><small>${meta.section} · ${meta.statusText}</small></span><em>打开</em></button>`).join('')
    : `<div class="empty-state" style="min-height:160px"><div><span class="empty-icon">${icon('search-x')}</span><h2>没有匹配结果</h2><p>换一个功能名、对象或状态。</p></div></div>`;
  refreshIcons();
}

function openPalette() {
  paletteBackdrop.hidden = false;
  renderCommandResults('');
  window.setTimeout(() => commandInput.focus(), 0);
}

function closePalette() {
  paletteBackdrop.hidden = true;
  commandInput.value = '';
}

function setMode(mode) {
  app.dataset.mode = mode;
  document.querySelectorAll('[data-mode-value]').forEach(buttonNode => buttonNode.setAttribute('aria-pressed', String(buttonNode.dataset.modeValue === mode)));
  if (mode === 'assistant') {
    if (currentPage !== 'assistant') previousStudioPage = currentPage;
    renderPage('assistant');
  } else {
    renderPage(previousStudioPage || 'home');
  }
}

document.addEventListener('click', event => {
  const pageTarget = event.target.closest('[data-page]');
  if (pageTarget) {
    renderPage(pageTarget.dataset.page);
    closePalette();
  }
  const toastTarget = event.target.closest('[data-toast]');
  if (toastTarget) showToast(toastTarget.dataset.toast);
  const openTarget = event.target.closest('[data-open]');
  if (openTarget) openDrawer(openTarget.dataset.open);
  const modeTarget = event.target.closest('[data-mode-value]');
  if (modeTarget) setMode(modeTarget.dataset.modeValue);
  const toggleTarget = event.target.closest('.toggle');
  if (toggleTarget) toggleTarget.classList.toggle('on');
  if (event.target.closest('[data-close-drawer]')) closeDrawer();
  if (event.target.closest('[data-close-palette]')) closePalette();
});

document.getElementById('command-trigger').addEventListener('click', openPalette);
document.getElementById('mobile-more').addEventListener('click', openPalette);
drawerBackdrop.addEventListener('click', closeDrawer);
paletteBackdrop.addEventListener('click', event => { if (event.target === paletteBackdrop) closePalette(); });
commandInput.addEventListener('input', event => renderCommandResults(event.target.value));

document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  }
  if (event.key === 'Escape') {
    closePalette();
    closeDrawer();
  }
});

window.addEventListener('hashchange', () => renderPage(location.hash.replace('#', '') || 'home', false));

renderPage(currentPage, false);
refreshIcons();
