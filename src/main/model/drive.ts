import {
  AUTO_MODEL,
  caogenDrivePolicyView,
  normalizeCaoGenDriveMode,
  type AppSettings,
  type CaoGenDriveMode,
  type CaoGenDrivePolicyView,
  type SandboxMode,
  type SchedulerStrategy,
  type ToolRiskLevel
} from '../../shared/types'
import type { CrossValidationRequest } from './model-router'
import type { ModelTaskKind } from './model-profile'

export interface CaoGenDriveRuntimePolicy extends CaoGenDrivePolicyView {
  riskFloor: 'low' | 'medium' | 'high'
  expectedOutputTokens: number
  requestedTasks: ModelTaskKind[]
  crossValidation: CrossValidationRequest
  permissionAllowlistRules: string[]
  permissionDenylistRules: string[]
  sandboxMode?: SandboxMode
  guiAutomationEnabled?: boolean
}

export interface CaoGenDriveRouteTuning {
  mode: CaoGenDriveMode
  strategy: SchedulerStrategy
  requestedTasks: ModelTaskKind[]
  expectedOutputTokens: number
  riskFloor: 'low' | 'medium' | 'high'
  crossValidation: CrossValidationRequest
}

const RUNTIME_POLICIES: Record<CaoGenDriveMode, Omit<CaoGenDriveRuntimePolicy, keyof CaoGenDrivePolicyView>> = {
  spark: {
    riskFloor: 'low',
    expectedOutputTokens: 1_000,
    requestedTasks: [],
    crossValidation: { enabled: false, minRiskLevel: 'high', maxValidators: 0 },
    permissionAllowlistRules: ['risk<=low'],
    permissionDenylistRules: [
      'risk>=high',
      'tool=gui_*',
      'tool=genesis_orchestrate',
      'tool=task_dispatch_dag',
      'tool=task_decompose_and_dispatch_dag',
      'tool=code_forge_delivery',
      'tool=git_commit',
      'tool=git_create_pr'
    ]
  },
  core: {
    riskFloor: 'low',
    expectedOutputTokens: 2_000,
    requestedTasks: [],
    crossValidation: { enabled: true, minRiskLevel: 'high', maxValidators: 1 },
    permissionAllowlistRules: ['risk<=low'],
    permissionDenylistRules: ['risk=critical', 'tool=genesis_orchestrate']
  },
  forge: {
    riskFloor: 'medium',
    expectedOutputTokens: 4_000,
    requestedTasks: ['coding', 'reasoning', 'review', 'toolUse'],
    crossValidation: { enabled: true, minRiskLevel: 'medium', maxValidators: 1 },
    permissionAllowlistRules: ['risk<=low'],
    permissionDenylistRules: ['risk=critical', 'tool=genesis_orchestrate'],
    sandboxMode: 'standardSystem'
  },
  command: {
    riskFloor: 'high',
    expectedOutputTokens: 6_000,
    requestedTasks: ['coding', 'reasoning', 'review', 'toolUse'],
    crossValidation: { enabled: true, minRiskLevel: 'medium', maxValidators: 2 },
    permissionAllowlistRules: ['risk<=low'],
    permissionDenylistRules: ['risk=critical'],
    sandboxMode: 'standardSystem',
    guiAutomationEnabled: true
  },
  genesis: {
    riskFloor: 'high',
    expectedOutputTokens: 8_000,
    requestedTasks: ['coding', 'reasoning', 'review', 'toolUse', 'longContext'],
    crossValidation: { enabled: true, minRiskLevel: 'low', maxValidators: 2 },
    permissionAllowlistRules: ['risk<=low'],
    permissionDenylistRules: ['risk=critical'],
    sandboxMode: 'standardSystem',
    guiAutomationEnabled: true
  }
}

export function getCaoGenDrivePolicy(mode: unknown): CaoGenDriveRuntimePolicy {
  const normalized = normalizeCaoGenDriveMode(mode)
  return {
    ...caogenDrivePolicyView(normalized),
    ...RUNTIME_POLICIES[normalized]
  }
}

export function settingsForCaoGenDrive(settings: AppSettings, mode: unknown = settings.driveMode): AppSettings {
  const policy = getCaoGenDrivePolicy(mode)
  return {
    ...settings,
    driveMode: policy.mode,
    defaultModel: policy.defaultModel,
    defaultPermissionMode: policy.defaultPermissionMode,
    schedulerStrategy: policy.schedulerStrategy,
    smartModelRoutingEnabled: settings.smartModelRoutingEnabled || policy.smartModelRoutingEnabled,
    modelCrossValidationAutoRunEnabled:
      settings.modelCrossValidationAutoRunEnabled || policy.modelCrossValidationAutoRunEnabled,
    budgetUsdPerSession: settings.budgetUsdPerSession,
    sandboxMode: policy.sandboxMode ?? settings.sandboxMode,
    guiAutomationEnabled: policy.guiAutomationEnabled ?? settings.guiAutomationEnabled,
    permissionAllowlist: mergeRules(settings.permissionAllowlist, policy.permissionAllowlistRules),
    permissionDenylist: mergeRules(settings.permissionDenylist, policy.permissionDenylistRules)
  }
}

export function driveRouteTuning(mode: unknown): CaoGenDriveRouteTuning {
  const policy = getCaoGenDrivePolicy(mode)
  return {
    mode: policy.mode,
    strategy: policy.schedulerStrategy,
    requestedTasks: policy.requestedTasks,
    expectedOutputTokens: policy.expectedOutputTokens,
    riskFloor: policy.riskFloor,
    crossValidation: policy.crossValidation
  }
}

export function driveDefaultModel(mode: unknown): string {
  return getCaoGenDrivePolicy(mode).defaultModel || AUTO_MODEL
}

export function driveSessionBudgetUsd(mode: unknown, explicitBudgetUsd?: number): number {
  if (typeof explicitBudgetUsd === 'number' && Number.isFinite(explicitBudgetUsd) && explicitBudgetUsd > 0) {
    return explicitBudgetUsd
  }
  return getCaoGenDrivePolicy(mode).sessionBudgetUsd
}

export function driveRiskAtLeast(
  inferred: 'low' | 'medium' | 'high',
  floor: 'low' | 'medium' | 'high'
): 'low' | 'medium' | 'high' {
  return riskRank(inferred) >= riskRank(floor) ? inferred : floor
}

export function driveModeLabel(mode: unknown): string {
  const policy = getCaoGenDrivePolicy(mode)
  return `${policy.label}/${policy.zhLabel}`
}

function mergeRules(existing: string, rules: string[]): string {
  const merged = [existing.trim(), ...rules].filter(Boolean)
  return [...new Set(merged.join('\n').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].join('\n')
}

function riskRank(level: ToolRiskLevel | 'low' | 'medium' | 'high'): number {
  if (level === 'critical') return 4
  if (level === 'high') return 3
  if (level === 'medium') return 2
  return 1
}
