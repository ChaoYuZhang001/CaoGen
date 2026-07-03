import { useStore } from '../store'

const FEATURES: Array<[string, string]> = [
  ['多会话并行', '同时在多个项目上运行 Agent,互不阻塞'],
  ['工具调用可视化', 'Bash / 编辑 / 搜索每一步都看得见'],
  ['Diff 审查', '文件修改以差异视图呈现,一目了然'],
  ['权限掌控', '敏感操作逐条审批,或一键切换模式'],
  ['成本仪表盘', '每轮对话的 token 与费用实时统计'],
  ['会话恢复', '历史会话随时恢复上下文继续工作']
]

export default function WelcomeView(): React.JSX.Element {
  const setShowNewSession = useStore((s) => s.setShowNewSession)

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">◆</div>
        <h1 className="welcome-title">AgentDesk</h1>
        <p className="welcome-sub">多会话并行的桌面 AI 编码 Agent</p>
        <button className="btn btn-primary btn-lg" onClick={() => setShowNewSession(true)}>
          选择项目目录,开始工作
        </button>
        <div className="welcome-grid">
          {FEATURES.map(([title, desc]) => (
            <div key={title} className="welcome-card">
              <div className="welcome-card-title">{title}</div>
              <div className="welcome-card-desc">{desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
