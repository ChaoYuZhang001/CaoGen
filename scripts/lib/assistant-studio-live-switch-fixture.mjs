import { writeFileSync } from 'node:fs'
import path from 'node:path'

export function seedUnknownEffectRecoverySnapshot({ projectDir, recoverySessionId, userDataDir }) {
  const createdAt = Date.now() - 60_000
  const updatedAt = createdAt + 30_000
  const runId = 'exp003-unknown-effect-run'
  const effect = unknownEffect({ createdAt, recoverySessionId, runId, updatedAt })
  const meta = recoveryMeta({ createdAt, effect, projectDir, recoverySessionId })
  const snapshot = {
    id: recoverySessionId,
    taskId: recoverySessionId,
    sessionId: recoverySessionId,
    title: meta.title,
    projectPath: projectDir,
    engine: 'openai',
    model: meta.model,
    providerId: meta.providerId,
    createdAt,
    updatedAt,
    eventCount: 0,
    reason: 'shutdown',
    meta,
    execution: { status: 'error', lastSeq: 0, cursor: { seq: 0 }, lastEventAt: updatedAt },
    run: {
      schemaVersion: 1,
      id: runId,
      sessionId: recoverySessionId,
      taskId: recoverySessionId,
      status: 'waiting_reconciliation',
      revision: 3,
      attempt: 1,
      recoveryCount: 1,
      createdAt,
      updatedAt,
      startedAt: createdAt,
      error: effect.error,
      steps: [],
      toolExecutions: [],
      effects: [effect]
    },
    transcript: [],
    subtasks: [],
    dagExecutions: [],
    dagRuntimes: []
  }
  writeFileSync(
    path.join(userDataDir, 'task-snapshots.json'),
    `${JSON.stringify({ version: 1, snapshots: [snapshot] }, null, 2)}\n`,
    'utf8'
  )
}

function unknownEffect({ createdAt, recoverySessionId, runId, updatedAt }) {
  return {
    schemaVersion: 1,
    id: 'exp003-unknown-effect',
    effectKey: 'effect-v1:exp003-unknown',
    resourceKey: 'resource-v1:exp003-unknown',
    sessionId: recoverySessionId,
    runId,
    toolUseId: 'exp003-unknown-tool-use',
    toolName: 'unknown_future_tool',
    generation: 1,
    revision: 3,
    status: 'waiting_reconciliation',
    reconcilability: 'opaque',
    target: { kind: 'unsupported', toolName: 'unknown_future_tool' },
    targetDigest: 'exp003-unknown-target-digest',
    intentDigest: 'exp003-unknown-intent-digest',
    inputDigest: 'exp003-unknown-input-digest',
    evidence: [{
      id: 'exp003-unknown-effect-evidence',
      kind: 'execution_result',
      digest: 'exp003-unknown-result-digest',
      observedAt: updatedAt,
      verifier: 'native-tool-runtime',
      generation: 1
    }],
    createdAt,
    updatedAt,
    error: '外部结果未知，必须人工确认后才能继续。'
  }
}

function recoveryMeta({ createdAt, effect, projectDir, recoverySessionId }) {
  return {
    id: recoverySessionId,
    title: 'EXP-003 未知 Effect 恢复',
    cwd: projectDir,
    model: 'live-model-primary',
    providerId: 'live-switch-provider',
    status: 'error',
    taskStrategy: 'execute',
    permissionMode: 'default',
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costUsd: 0,
    contextTokens: 0,
    createdAt,
    engine: 'openai',
    lastError: effect.error
  }
}
