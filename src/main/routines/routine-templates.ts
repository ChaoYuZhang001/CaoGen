import type { RoutinePermissionMode } from '../routineStore'

export interface RoutineTemplate {
  id: string
  name: string
  description: string
  content: string
  frequency: string
  permissionMode: RoutinePermissionMode
  tags: string[]
}

const TEMPLATES: RoutineTemplate[] = [
  {
    id: 'daily-dependency-audit',
    name: '每日依赖审计',
    description: '检查依赖、锁文件和安全告警，输出可复跑证据。',
    content: '检查当前项目依赖状态、安全告警和锁文件漂移；只报告风险和建议，不自动升级依赖。',
    frequency: '0 9 * * *',
    permissionMode: 'plan',
    tags: ['依赖', '安全', '日报']
  },
  {
    id: 'nightly-deep-test',
    name: '夜间深度测试',
    description: '在空闲时间运行项目深测并汇总真实失败点。',
    content: '运行项目深度测试链路，汇总通过项、失败项、日志路径和首个真实失败点。',
    frequency: '0 2 * * *',
    permissionMode: 'default',
    tags: ['测试', '质量']
  },
  {
    id: 'weekly-release-readiness',
    name: '每周发布就绪检查',
    description: '面向发布前的构建、测试、配置和打包风险复核。',
    content: '复核构建、类型检查、关键 smoke、打包配置和发布阻塞项；输出 GO/NO-GO 结论。',
    frequency: '0 10 * * 1',
    permissionMode: 'plan',
    tags: ['发布', '质量']
  },
  {
    id: 'daily-project-memory-review',
    name: '项目记忆巡检',
    description: '检查项目约定、踩坑和过期记忆，提示需要归档或修正的条目。',
    content: '检索当前项目记忆，找出过期、冲突或低置信度条目，并提出需要用户确认的修正建议。',
    frequency: '0 18 * * *',
    permissionMode: 'plan',
    tags: ['记忆', '维护']
  },
  {
    id: 'weekday-pr-triage',
    name: '工作日变更巡检',
    description: '扫描当天代码改动，给出回归风险和建议验证命令。',
    content: '检查当前工作区近期改动，按风险排序列出需要验证的模块、命令和潜在冲突。',
    frequency: '0 17 * * 1-5',
    permissionMode: 'plan',
    tags: ['代码审计', '回归']
  }
]

export function listRoutineTemplates(): RoutineTemplate[] {
  return TEMPLATES.map((template) => ({ ...template, tags: [...template.tags] }))
}
