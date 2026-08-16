import {
  buildGenesisOrchestration,
  type GenesisOrchestrationInput,
  type GenesisOrchestrationReport
} from '../genesis/orchestrator'
import type { TaskPlanDraftInput, TaskPlanStateView } from '../../shared/types'

export async function buildGenesisPlanContract(
  parentSessionId: string,
  input: GenesisOrchestrationInput
): Promise<Record<string, unknown>> {
  const report = await buildGenesisOrchestration(input)
  const manager = await loadSessionManager()
  const plan = await manager.createAgentTaskPlanVersion(parentSessionId, planDraft(report))
  return {
    report,
    planContract: {
      version: plan.currentVersion?.version,
      digest: plan.currentVersion?.digest,
      approvalStatus: plan.approvalStatus
    }
  }
}

async function loadSessionManager() {
  const specifier = '../sessionManager.js'
  return (await import(specifier) as { sessionManager: {
    createAgentTaskPlanVersion(parentSessionId: string, input: TaskPlanDraftInput): Promise<TaskPlanStateView>
  } }).sessionManager
}

function planDraft(report: GenesisOrchestrationReport): TaskPlanDraftInput {
  const deliveryArtifact = report.deliveryStrategy.recommendedMode === 'patch'
    ? '可审查的代码补丁与验证结果'
    : '可审查的执行报告与验证结果'
  const dataEgress = ['已配置 Provider：任务请求、必要上下文与工具结果']
  return {
    objective: report.request,
    steps: report.taskPlan.dag.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description || task.prompt,
      dependsOn: task.dependencies,
      expectedArtifacts: [deliveryArtifact],
      dataEgress,
      estimatedCostUsd: null,
      riskLevel: report.risk.level
    })),
    expectedArtifacts: [deliveryArtifact],
    dataEgress,
    estimatedCostUsd: null,
    riskLevel: report.risk.level,
    acceptanceCriteria: report.validationGates
      .filter((gate) => gate.required)
      .map((gate) => gate.command ? `${gate.title}: ${gate.command}` : gate.title),
    source: 'genesis'
  }
}
