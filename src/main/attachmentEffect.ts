import type { ImageAttachmentResult } from '../shared/types'
import type { PreparedImageAttachment } from './attachmentOps'
import { persistPreparedImageAttachment } from './attachmentOps'
import {
  executeInteractiveOperationEffect,
  type InteractiveOperationEffectOutcome
} from './task/operation-effect-gateway'

type OperationGateway = typeof executeInteractiveOperationEffect
type AttachmentEffectSource = 'user_file' | 'renderer_bytes'

export interface ImageAttachmentEffectContext {
  sourceSessionId: string
  projectId?: string
  cwd: string
  attachmentsRoot: string
}

export async function executePreparedImageAttachmentEffect(
  context: ImageAttachmentEffectContext,
  prepared: PreparedImageAttachment,
  source: AttachmentEffectSource,
  runOperation: OperationGateway = executeInteractiveOperationEffect
): Promise<ImageAttachmentResult> {
  const toolName = source === 'user_file' ? 'attachment_copy_image' : 'attachment_save_image_bytes'
  const outcome = await runOperation({
    kind: 'attachment_write',
    title: source === 'user_file' ? '复制图片到会话附件区' : '保存图片到会话附件区',
    sourceSessionId: context.sourceSessionId,
    projectId: context.projectId,
    cwd: context.cwd,
    toolName,
    toolInput: {
      source,
      contentSha256: prepared.hash,
      bytes: prepared.bytes,
      mime: prepared.mime
    },
    execute: (effect) => {
      if (effect.target.kind !== 'unsupported' || effect.target.toolName !== toolName) {
        throw new Error('附件写入 EffectTarget 必须保持 opaque 并与工具名绑定')
      }
      return persistPreparedImageAttachment(prepared, context.attachmentsRoot)
    },
    isSuccess: (result) => result.ok,
    resultSummary: summarizeAttachmentResult
  })
  return attachmentEffectOutcome(outcome)
}

function attachmentEffectOutcome(
  outcome: InteractiveOperationEffectOutcome<Awaited<ReturnType<typeof persistPreparedImageAttachment>>>
): ImageAttachmentResult {
  if (outcome.status === 'completed' && outcome.value?.ok) return outcome.value
  if (outcome.status === 'completed') {
    return { ok: false, error: '附件写入效果已确认，但执行结果缺失' }
  }
  return {
    ok: false,
    error: outcome.error,
    effectStatus: outcome.effectStatus,
    operationId: outcome.operationId,
    ...(outcome.status === 'waiting_reconciliation' ? { snapshotId: outcome.snapshotId } : {})
  }
}

function summarizeAttachmentResult(
  result: Awaited<ReturnType<typeof persistPreparedImageAttachment>>
): string {
  return result.ok
    ? JSON.stringify({ ok: true, hash: result.hash, mime: result.mime, bytes: result.bytes })
    : JSON.stringify(result)
}
