import DiffPanel from './workbench/DiffPanel'

export interface DiffReviewPanelProps {
  className?: string
}

/**
 * P1 Diff 审查入口。
 * 现有工作台 DiffPanel 已提供逐 hunk 接受/拒绝、Git 暂存和提交能力；
 * 该组件保留路线图中的稳定命名，方便后续从任务完成事件直接打开。
 */
export default function DiffReviewPanel(_props: DiffReviewPanelProps): React.JSX.Element {
  return <DiffPanel />
}
