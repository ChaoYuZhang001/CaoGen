import type { EffectTarget, FileSystemIdentity } from '../../shared/types'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from './effect-reconciliation-result'

export type FileContentObservation =
  | { state: 'absent' }
  | {
      state: 'file'
      identity: FileSystemIdentity
      bytes: number
      sha256?: string
    }

type FileContentTarget = Extract<EffectTarget, { kind: 'file_content' }>

export function reconcileFileContentObservation(
  target: FileContentTarget,
  observation: FileContentObservation,
  maxHashBytes: number
): EffectReconciliationResult {
  const expectedState = target.expectedState ?? 'file'
  if (observation.state === 'absent') return reconcileAbsentFileContent(target, expectedState)
  const payload = observedFilePayload(target, observation)
  const couldBeExpected = expectedState === 'file' && observation.bytes === target.expectedBytes
  const couldBePreState = couldBePreFileContent(target, observation.bytes)
  if (!couldBeExpected && !couldBePreState) {
    return unresolved({ ...payload, reason: '文件大小既不匹配执行前状态，也不匹配预期状态' })
  }
  if (typeof observation.sha256 !== 'string') {
    return unresolved({
      ...payload,
      maxHashBytes,
      reason: '目标文件超过自动对账哈希上限，已转人工确认'
    })
  }
  const hashedPayload = { ...payload, observedSha256: observation.sha256 }
  if (couldBeExpected && observation.sha256 === target.expectedSha256) {
    return confirmed(hashedPayload, '文件内容与预期摘要完全一致')
  }
  if (matchesPreFileContent(target, observation.sha256, observation.identity)) {
    return notApplied(hashedPayload, '文件仍是执行前内容，已授权后续生成新 lease 重试')
  }
  return unresolved({ ...hashedPayload, reason: '文件既不是执行前状态，也不是预期状态' })
}

function reconcileAbsentFileContent(
  target: FileContentTarget,
  expectedState: 'absent' | 'file'
): EffectReconciliationResult {
  const payload = { kind: target.kind, observedState: 'absent', relativePath: target.relativePath }
  if (expectedState === 'absent') return confirmed(payload, '目标文件已按预期不存在')
  return target.preState === 'absent'
    ? notApplied(payload, '目标仍不存在，已证明写入没有发生')
    : unresolved({ ...payload, reason: '目标文件在对账时缺失' })
}

function observedFilePayload(
  target: FileContentTarget,
  observation: Extract<FileContentObservation, { state: 'file' }>
) {
  return {
    kind: target.kind,
    relativePath: target.relativePath,
    observedState: observation.state,
    observedBytes: observation.bytes,
    observedIdentity: observation.identity
  }
}

function couldBePreFileContent(target: FileContentTarget, observedBytes: number): boolean {
  return target.preState === 'file' && target.preBytes === observedBytes && typeof target.preSha256 === 'string'
}

function matchesPreFileContent(
  target: FileContentTarget,
  observedSha256: string,
  observedIdentity: FileSystemIdentity
): boolean {
  if (target.preState !== 'file' || target.preSha256 !== observedSha256) return false
  return !target.preFileIdentity || sameFileSystemIdentity(target.preFileIdentity, observedIdentity)
}

function sameFileSystemIdentity(left: FileSystemIdentity, right: FileSystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}
