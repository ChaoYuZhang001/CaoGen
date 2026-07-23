import { randomUUID } from 'node:crypto'
import { settingsForCaoGenDrive } from './model/drive'
import { getSettings } from './settings'
import { EDIT_TOOLS, executeCodingTool, type ToolExecResult } from './openaiTools'
import {
  GUI_TEMPORARY_GRANT_MESSAGE,
  decideGuiPermission,
  grantTemporaryGuiAutomation,
  type GuiPermissionDecision
} from './permission/permission-manager'
import { writeAuditLog } from './permission/audit-log'
import { evaluateToolPermission, type ToolPermissionDecision } from './permission/tool-permission'
import { taskRuntimeRegistry, type ToolIdempotencyDecision } from './task/task-runtime-registry'
import { isDisabledModeInspectionToolCall, isReadOnlyToolCall } from './task/tool-idempotency'
import { digitalWorkerToolPolicyError } from './digital-worker/tool-action-policy'
import {
  cancelEffectExecution,
  completeEffectExecution,
  markEffectExecutionStarted,
  prepareEffectExecution,
  type PrepareEffectExecutionInput
} from './task/effect-runtime'
import type { AgentEvent, EffectStatus, PermissionRequestInfo, SessionMeta, ToolRiskLevel } from '../shared/types'

export type NativeToolExecutionResult = ToolExecResult & { effectStatus?: EffectStatus }
export type NativeToolPermissionDecision = { allow: boolean; message?: string }

type EffectExecutionHandle = Awaited<ReturnType<typeof prepareEffectExecution>>

type PreparedEffect =
  | { kind: 'ready'; handle: EffectExecutionHandle }
  | { kind: 'failed'; result: NativeToolExecutionResult }

type NativeToolPreflightDecision =
  | { allow: false; message: string }
  | {
      allow: true
      policy: ToolPermissionDecision
      readOnlyCall: boolean
      guiDecision: GuiPermissionDecision
      idempotency: ToolIdempotencyDecision
    }

interface PendingPermission {
  resolve: (result: NativeToolPermissionDecision) => void
  info: PermissionRequestInfo
}

const LOCAL_EXECUTION_DISABLED_MESSAGE =
  'Agent 本地执行能力已禁用:旧严格 Docker 设置不会自动降级为宿主机执行。当前仅保留最小项目检查能力，请先在设置 > 权限中确认启用。'

/** Shared permission, durable Effect, execution, and audit runtime for CaoGen native tools. */
export class NativeToolRuntime {
  private readonly pendingPerms = new Map<string, PendingPermission>()

  constructor(
    private readonly meta: SessionMeta,
    private readonly emit: (event: AgentEvent) => void
  ) {}

  respondPermission(requestId: string, allow: boolean, message?: string): void {
    const pending = this.pendingPerms.get(requestId)
    if (!pending) return
    this.pendingPerms.delete(requestId)
    if (allow && message === GUI_TEMPORARY_GRANT_MESSAGE && pending.info.toolName.startsWith('gui_')) {
      grantTemporaryGuiAutomation()
    }
    writeAuditLog(this.meta.cwd, {
      action: allow ? 'allow' : 'deny',
      source: 'user',
      toolName: pending.info.toolName,
      input: pending.info.input,
      message
    })
    this.emit({ kind: 'permission-resolved', requestId, behavior: allow ? 'allow' : 'deny' })
    pending.resolve({ allow, message })
  }

  pendingPermissions(): PermissionRequestInfo[] {
    return [...this.pendingPerms.values()].map((pending) => pending.info)
  }

  rejectAllPending(message: string): void {
    for (const [requestId, pending] of this.pendingPerms) {
      this.emit({ kind: 'permission-resolved', requestId, behavior: 'deny' })
      pending.resolve({ allow: false, message })
    }
    this.pendingPerms.clear()
  }

  async gateTool(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string
  ): Promise<NativeToolPermissionDecision> {
    const preflight = this.preflightToolGate(name, input, toolUseId)
    if (!preflight.allow) return preflight
    const { policy, readOnlyCall, guiDecision, idempotency } = preflight

    if (idempotency.kind === 'ask') {
      this.auditGateDecision(
        'ask',
        'idempotency',
        name,
        input,
        idempotency.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return this.requestToolPermission(
        name,
        input,
        toolUseId,
        idempotency.reason,
        idempotency.duplicateExecutionId
      )
    }
    if (guiDecision.kind === 'allow') {
      this.auditGateDecision('allow', 'policy', name, input, guiDecision.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true }
    }
    if (guiDecision.kind === 'ask') {
      this.auditGateDecision('ask', 'policy', name, input, guiDecision.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return this.requestToolPermission(name, input, toolUseId, guiDecision.reason)
    }
    if (policy.kind === 'allow') {
      writeAuditLog(this.meta.cwd, {
        action: 'allow',
        source: 'policy',
        toolName: name,
        input,
        message: policy.reason,
        riskLevel: policy.risk.level,
        riskReasons: policy.risk.reasons
      })
      return { allow: true, message: policy.reason }
    }

    const mode = this.meta.permissionMode
    if (mode === 'bypassPermissions') {
      this.auditGateDecision(
        'allow',
        'permission-mode',
        name,
        input,
        policy.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true }
    }
    if (readOnlyCall) {
      this.auditGateDecision(
        'allow',
        'permission-mode',
        name,
        input,
        policy.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true }
    }
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(name)) {
      this.auditGateDecision(
        'allow',
        'permission-mode',
        name,
        input,
        policy.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: true }
    }
    this.auditGateDecision(
      'ask',
      'permission-mode',
      name,
      input,
      policy.reason,
      policy.risk.level,
      policy.risk.reasons
    )
    return this.requestToolPermission(name, input, toolUseId, policy.reason)
  }

  preflightToolGate(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string
  ): NativeToolPreflightDecision {
    const workerPolicyError = digitalWorkerToolPolicyError(this.meta, name, input)
    if (workerPolicyError) return { allow: false, message: workerPolicyError }
    const settings = settingsForCaoGenDrive(getSettings(), this.meta.driveMode)
    const policy = evaluateToolPermission(settings, { toolName: name, input, cwd: this.meta.cwd })
    if (policy.kind === 'deny') {
      writeAuditLog(this.meta.cwd, {
        action: 'deny',
        source: 'policy',
        toolName: name,
        input,
        message: policy.reason,
        riskLevel: policy.risk.level,
        riskReasons: policy.risk.reasons
      })
      return { allow: false, message: policy.reason }
    }

    const readOnlyCall = isReadOnlyToolCall(name, input)
    const disabledModeInspectionCall = isDisabledModeInspectionToolCall(name)
    if (settings.sandboxMode === 'disabled' && !disabledModeInspectionCall) {
      this.auditGateDecision(
        'deny',
        'policy',
        name,
        input,
        LOCAL_EXECUTION_DISABLED_MESSAGE,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message: LOCAL_EXECUTION_DISABLED_MESSAGE }
    }
    const guiDecision = decideGuiPermission(name, settings)
    if (guiDecision.kind === 'deny') {
      this.auditGateDecision('deny', 'policy', name, input, guiDecision.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message: guiDecision.reason }
    }
    const mode = this.meta.permissionMode
    if (mode === 'plan' && !readOnlyCall) {
      const message = '规划模式:只允许只读工具和 search_replace dry_run 预览，不执行写入或命令'
      this.auditGateDecision(
        'deny',
        'permission-mode',
        name,
        input,
        message,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message }
    }
    const idempotency = taskRuntimeRegistry.evaluateTool({
      sessionId: this.meta.id,
      cwd: this.meta.cwd,
      toolName: name,
      toolInput: input,
      toolUseId
    })
    if (idempotency.kind === 'deny') {
      this.auditGateDecision(
        'deny',
        'idempotency',
        name,
        input,
        idempotency.reason,
        policy.risk.level,
        policy.risk.reasons
      )
      return { allow: false, message: idempotency.reason }
    }
    return { allow: true, policy, readOnlyCall, guiDecision, idempotency }
  }

  async executeToolWithPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    signal?: AbortSignal
  ): Promise<NativeToolExecutionResult> {
    if (signal?.aborted) return { ok: false, output: '操作已中断，未进入权限判断' }
    const preflight = this.preflightToolGate(name, input, toolUseId)
    if (preflight.allow === false) {
      return { ok: false, output: `操作已被权限策略拒绝${preflight.message ? `:${preflight.message}` : ''}` }
    }
    const effectInput: PrepareEffectExecutionInput = {
      sessionId: this.meta.id,
      cwd: this.meta.cwd,
      toolUseId,
      toolName: name,
      toolInput: input
    }
    const prepared = await this.prepareToolEffect(effectInput)
    if (prepared.kind === 'failed') return prepared.result
    const effectHandle = prepared.handle
    const interruptedBeforeGate = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在权限判断前已中断'
    )
    if (interruptedBeforeGate) return interruptedBeforeGate

    const gate = await this.awaitToolPermission(name, input, toolUseId, effectHandle)
    if (!gate.allow) {
      return this.settlePermissionDenial(effectHandle, gate)
    }
    const interruptedAfterGate = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在审批后、外部执行前已中断'
    )
    if (interruptedAfterGate) return interruptedAfterGate
    return this.executeAllowedTool(name, input, effectHandle, effectInput, signal)
  }

  private async prepareToolEffect(effectInput: PrepareEffectExecutionInput): Promise<PreparedEffect> {
    try {
      return { kind: 'ready', handle: await prepareEffectExecution(effectInput) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        kind: 'failed',
        result: {
          ok: false,
          output: `外部副作用账本准备失败，已阻止审批和执行:${message}`
        }
      }
    }
  }

  private async awaitToolPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    effectHandle: EffectExecutionHandle
  ): Promise<NativeToolPermissionDecision> {
    try {
      return await this.gateTool(name, input, toolUseId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await cancelEffectExecution(effectHandle, `权限判断异常，未执行:${message}`).catch(() => undefined)
      throw error
    }
  }

  private async settlePermissionDenial(
    effectHandle: EffectExecutionHandle,
    gate: NativeToolPermissionDecision
  ): Promise<NativeToolExecutionResult> {
    const reason = `用户拒绝了此操作${gate.message ? `:${gate.message}` : ''}`
    try {
      await cancelEffectExecution(effectHandle, reason)
      return {
        ok: false,
        output: reason,
        effectStatus: effectHandle ? 'abandoned' : undefined
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        output: `${reason}\n\n拒绝结果未能写入效果账本，已保持 fail-closed:${message}`,
        effectStatus: effectHandle ? 'waiting_reconciliation' : undefined
      }
    }
  }

  private async cancelIfAborted(
    signal: AbortSignal | undefined,
    effectHandle: EffectExecutionHandle,
    reason: string
  ): Promise<NativeToolExecutionResult | undefined> {
    if (!signal?.aborted) return undefined
    await cancelEffectExecution(effectHandle, reason)
    return {
      ok: false,
      output: '操作已中断，外部执行未开始',
      effectStatus: effectHandle ? 'abandoned' : undefined
    }
  }

  private auditGateDecision(
    action: 'allow' | 'deny' | 'ask',
    source: 'policy' | 'permission-mode' | 'idempotency',
    toolName: string,
    input: Record<string, unknown>,
    message: string,
    riskLevel: ToolRiskLevel,
    riskReasons: string[]
  ): void {
    writeAuditLog(this.meta.cwd, { action, source, toolName, input, message, riskLevel, riskReasons })
  }

  private requestToolPermission(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string,
    decisionReason?: string,
    duplicateExecutionId?: string
  ): Promise<NativeToolPermissionDecision> {
    const requestId = randomUUID()
    const info: PermissionRequestInfo = {
      requestId,
      toolName: name,
      input,
      toolUseId,
      decisionReason,
      duplicateExecutionId
    }
    this.emit({ kind: 'permission-request', request: info })
    return new Promise((resolve) => {
      this.pendingPerms.set(requestId, { resolve, info })
    })
  }

  private async executeAllowedTool(
    name: string,
    input: Record<string, unknown>,
    effectHandle: EffectExecutionHandle,
    effectInput: PrepareEffectExecutionInput,
    signal?: AbortSignal
  ): Promise<NativeToolExecutionResult> {
    const settings = settingsForCaoGenDrive(getSettings(), this.meta.driveMode)
    const interruptedBeforeStart = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在外部执行前已中断'
    )
    if (interruptedBeforeStart) return interruptedBeforeStart
    const startFailure = await this.markEffectStarted(effectHandle, effectInput)
    if (startFailure) return startFailure
    const interruptedAfterStart = await this.cancelIfAborted(
      signal,
      effectHandle,
      '操作在外部执行前已中断'
    )
    if (interruptedAfterStart) return interruptedAfterStart
    let exec: ToolExecResult
    try {
      exec = await executeCodingTool(name, input, this.meta.cwd, {
        signal,
        sandboxMode: settings.sandboxMode,
        chinaMirrorEnabled: settings.chinaEcosystemMirrorEnabled,
        npmRegistry: settings.chinaNpmRegistry,
        pipIndexUrl: settings.chinaPipIndexUrl,
        sessionId: this.meta.id,
        worktreeContext: {
          sessionId: this.meta.id,
          repoRoot: this.meta.repoRoot,
          sourceCwd: this.meta.sourceCwd,
          worktreePath: this.meta.worktreePath,
          branch: this.meta.branch,
          baseBranch: this.meta.baseBranch,
          baseSha: this.meta.baseSha
        },
        effectTarget: effectHandle?.target
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        output: `外部工具执行异常，结果未知:${message}`,
        effectStatus: effectHandle ? 'waiting_reconciliation' : undefined
      }
    }
    const executionPolicy = evaluateToolPermission(settings, {
      toolName: name,
      input,
      cwd: this.meta.cwd
    })
    writeAuditLog(this.meta.cwd, {
      action: 'execute',
      source: 'local-execution',
      toolName: name,
      input,
      ok: exec.ok,
      riskLevel: executionPolicy.risk.level,
      riskReasons: executionPolicy.risk.reasons,
      sandboxMode: exec.sandboxMode,
      modeUsed: exec.modeUsed,
      sandboxed: exec.sandboxed,
      fallbackReason: exec.fallbackReason
    })
    try {
      const effect = await completeEffectExecution(effectHandle, exec)
      return effect ? { ...exec, effectStatus: effect.status } : exec
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...exec,
        ok: false,
        output: `${exec.output}\n\n外部操作结果未能写入效果账本，已进入未知结果保护:${message}`,
        effectStatus: 'waiting_reconciliation'
      }
    }
  }

  private async markEffectStarted(
    effectHandle: EffectExecutionHandle,
    effectInput: PrepareEffectExecutionInput
  ): Promise<NativeToolExecutionResult | undefined> {
    try {
      await markEffectExecutionStarted(effectHandle, effectInput)
      return undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = `外部副作用账本启动标记失败，已阻止执行:${message}`
      try {
        await cancelEffectExecution(effectHandle, reason)
        return {
          ok: false,
          output: reason,
          effectStatus: effectHandle ? 'abandoned' : undefined
        }
      } catch (cancelError) {
        const cancelMessage = cancelError instanceof Error ? cancelError.message : String(cancelError)
        return {
          ok: false,
          output: `${reason}\n\n取消结果未能写入效果账本，已进入未知结果保护:${cancelMessage}`,
          effectStatus: 'waiting_reconciliation'
        }
      }
    }
  }
}
