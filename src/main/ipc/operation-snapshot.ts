import type { TaskSnapshotRecord } from '../../shared/types'
import { reconcilePersistedTaskSnapshot } from '../task/effect-runtime'
import {
  isInteractiveOperationActive,
  isInteractiveOperationSnapshot,
  settleStoppedInteractiveOperationSnapshot
} from '../task/operation-effect-gateway'

export function assertAgentRecoverySnapshot(snapshot: TaskSnapshotRecord): void {
  if (isInteractiveOperationSnapshot(snapshot)) {
    throw new Error('交互操作快照只能进行效果对账，不能启动 Agent 自动续跑')
  }
}

export async function reconcileInteractiveOperationSnapshot(
  snapshot: TaskSnapshotRecord
): Promise<TaskSnapshotRecord | null> {
  if (isInteractiveOperationActive(snapshot)) return null
  return settleStoppedInteractiveOperationSnapshot(await reconcilePersistedTaskSnapshot(snapshot))
}
