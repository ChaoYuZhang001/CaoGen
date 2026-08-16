import type { RoleTemplateInput } from '../../../../shared/types'

export interface TeamTemplatePack {
  id: string
  name: string
  summary: string
  policy: string
  roles: RoleTemplateInput[]
}

const BASE_POLICY = {
  memoryPolicy: { scope: 'project', learning: 'user_approval_required' },
  routingRequirements: { vendorNeutral: true, acceptanceFeedback: true },
  verificationPolicy: { evidenceRequired: true, selfApprovalAllowed: false },
  escalationPolicy: { target: 'project-owner', afterFailures: 2 }
} as const

export const TEAM_TEMPLATE_MARKET: readonly TeamTemplatePack[] = [
  {
    id: 'software-delivery',
    name: '软件交付团队',
    summary: '规划、开发、测试和独立审查四岗，适合代码与发布任务。',
    policy: '最小权限、独立审查、失败两次升级给 Project Owner',
    roles: [
      role('planner', '产品策划', '把目标拆成范围、依赖、风险和验收计划。', ['planning', 'requirements'], false),
      role('developer', '开发工程师', '在批准范围内实现、重构并生成可审查变更。', ['coding', 'refactor'], true),
      role('tester', '测试工程师', '执行独立验证，记录失败证据并推动复验。', ['testing', 'diagnostics'], true),
      role('reviewer', '交付审查员', '检查风险、证据、验收、回滚和交付完整性。', ['review', 'delivery'], false)
    ]
  },
  {
    id: 'research-office',
    name: '研究与办公团队',
    summary: '研究、写作、数据和演示四岗，适合报告与 Office 成品。',
    policy: '来源可追溯、数据写入需审批、成品必须有独立验收',
    roles: [
      role('researcher', '研究员', '收集可引用来源并区分事实、判断与未知项。', ['research', 'citation'], false),
      role('writer', '报告编辑', '把研究证据整理为清晰、可交付的文档。', ['writing', 'documentation'], false),
      role('analyst', '数据分析师', '整理数据、公式、图表和可复核计算。', ['spreadsheet', 'analysis'], true),
      role('designer', '演示设计师', '生成结构清晰、可打开并可修改的演示成品。', ['presentation', 'design'], true)
    ]
  },
  {
    id: 'content-studio',
    name: '内容制作团队',
    summary: '策划、视觉、音频和成片审查四岗，适合视频 Studio。',
    policy: '素材版本锁定、外部生成受预算约束、采用决定可追溯',
    roles: [
      role('story', '内容策划', '维护结构版本、分镜、角色连续性和制作约束。', ['planning', 'storyboard'], false),
      role('visual', '视觉制作', '生产和管理角色、场景、关键帧及镜头素材。', ['image', 'video'], true),
      role('audio', '声音制作', '维护对白、声线、字幕、音轨和授权边界。', ['audio', 'subtitle'], true),
      role('producer', '成片审查', '核对血缘、成本、完整性、可播放性和最终验收。', ['review', 'delivery'], false)
    ]
  }
] as const

function role(
  suffix: string,
  name: string,
  purpose: string,
  capabilityRefs: string[],
  allowWrite: boolean
): RoleTemplateInput {
  return {
    id: `market.${suffix}.v1`,
    name,
    purpose,
    instructions: purpose,
    capabilityRefs,
    skillRefs: [],
    toolPolicy: {
      workspaceRead: true,
      workspaceWrite: allowWrite,
      terminal: allowWrite,
      browser: false,
      network: false
    },
    ...BASE_POLICY,
    source: 'imported'
  }
}
