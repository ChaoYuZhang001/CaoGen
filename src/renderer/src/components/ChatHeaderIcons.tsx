import * as React from 'react'

export type HeaderIconName =
  | 'summary'
  | 'panel'
  | 'tools'
  | 'review'
  | 'worktree'
  | 'subagents'
  | 'files'
  | 'plugins'
  | 'routines'
  | 'memory'
  | 'browser'
  | 'terminal'

const PATHS: Record<HeaderIconName, React.JSX.Element> = {
  // 摘要 / 上下文
  summary: (
    <>
      <rect x="3" y="2.8" width="10" height="10.4" rx="1.4" />
      <path d="M5.4 5.4h5.2M5.4 8h5.2M5.4 10.6h3" />
    </>
  ),
  // 工具面板
  panel: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.3" />
      <path d="M9.8 3v10" />
    </>
  ),
  // 工具抽屉
  tools: (
    <>
      <rect x="3" y="3" width="3.2" height="3.2" rx=".7" />
      <rect x="9.8" y="3" width="3.2" height="3.2" rx=".7" />
      <rect x="3" y="9.8" width="3.2" height="3.2" rx=".7" />
      <rect x="9.8" y="9.8" width="3.2" height="3.2" rx=".7" />
    </>
  ),
  // 审查
  review: (
    <>
      <rect x="3" y="2.8" width="7.2" height="10.4" rx="1.1" />
      <path d="M5.1 5.4h3M5.1 7.7h2.7M5.1 10h1.8" />
      <circle cx="11" cy="10.5" r="2.2" />
      <path d="m12.6 12.1 1.3 1.3" />
    </>
  ),
  // 分支 / worktree
  worktree: (
    <>
      <circle cx="5" cy="4" r="1.8" />
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="11" cy="8" r="1.8" />
      <path d="M5 5.8v4.4M5 10.2c0-2.4 1.4-3.6 4-3.6" />
    </>
  ),
  // 节点 / 子 Agent
  subagents: (
    <>
      <circle cx="8" cy="3.5" r="1.6" />
      <circle cx="3.5" cy="12" r="1.6" />
      <circle cx="12.5" cy="12" r="1.6" />
      <path d="M8 5.1v2.4M8 7.5 4.4 10.6M8 7.5l3.6 3.1" />
    </>
  ),
  // 文档
  files: (
    <>
      <path d="M4 2.5h5l3 3V13a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 13V3a.5.5 0 0 1 .5-.5Z" />
      <path d="M9 2.5V6h3" />
    </>
  ),
  // 拼图 / 插件
  plugins: (
    <path d="M6 3.2h1.2a.9.9 0 0 0 1.6 0H10a.6.6 0 0 1 .6.6v1.4a.9.9 0 0 0 0 1.6v1.4a.6.6 0 0 1-.6.6H8.8a.9.9 0 0 0-1.6 0H6a.6.6 0 0 1-.6-.6V7.4a.9.9 0 0 0 0-1.6V3.8A.6.6 0 0 1 6 3.2Z" />
  ),
  // 时钟 / Routines
  routines: (
    <>
      <circle cx="8" cy="8" r="5.2" />
      <path d="M8 5v3l2 1.4" />
    </>
  ),
  // 书签 / 记忆
  memory: <path d="M5 2.6h6a.5.5 0 0 1 .5.5v10L8 11l-3.5 2.1v-10a.5.5 0 0 1 .5-.5Z" />,
  // 地球 / 浏览器
  browser: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M2.6 8h10.8M8 2.6c1.7 1.6 2.6 3.5 2.6 5.4S9.7 11.8 8 13.4C6.3 11.8 5.4 9.9 5.4 8S6.3 4.2 8 2.6Z" />
    </>
  ),
  // 终端
  terminal: (
    <>
      <rect x="2.4" y="3" width="11.2" height="10" rx="1.2" />
      <path d="M5 6.4l2 1.8-2 1.8M8.4 10.6h2.6" />
    </>
  )
}

interface HeaderIconProps {
  name: HeaderIconName
}

export function HeaderIcon({ name }: HeaderIconProps): React.JSX.Element {
  return (
    <svg
      className="header-icon-glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
