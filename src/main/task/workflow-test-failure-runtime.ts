import { createHash } from 'node:crypto'
import type {
  AgentEvent,
  AgentEventIdentity,
  SessionMeta,
  TaskRunRecord,
  TaskSnapshotRecord,
  TranscriptEntry
} from '../../shared/types'
import { stableValueDigest } from './tool-idempotency'
import {
  ingestWorkflowAcceptanceFailure,
  WorkflowAcceptanceFailureIngressError,
  type WorkflowAcceptanceFailureIngressErrorCode,
  type WorkflowAcceptanceFailureInput,
  type WorkflowAcceptanceFailureResult
} from './workflow-acceptance-failure-ingress'

type TestFailureInput = Extract<WorkflowAcceptanceFailureInput, { sourceKind: 'test' }>
type ToolResultEvent = Extract<AgentEvent, { kind: 'tool-result' }>
type ToolRequestBlock = Extract<
  NonNullable<Extract<AgentEvent, { kind: 'assistant-message' }>['blocks'][number]>,
  { type: 'tool_use' }
>
type ToolExecution = NonNullable<TaskRunRecord['toolExecutions']>[number]
type WorkflowTestFailureRejection = Exclude<WorkflowTestFailurePlan, { disposition: 'ingest' }>
type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; result: WorkflowTestFailureRejection }

const NON_RETRYABLE_INGRESS_CODES = new Set<WorkflowAcceptanceFailureIngressErrorCode>([
  'WORKFLOW_FAILURE_INPUT_INVALID',
  'WORKFLOW_FAILURE_TARGET_NOT_FOUND',
  'WORKFLOW_FAILURE_TARGET_AMBIGUOUS',
  'WORKFLOW_FAILURE_PROJECT_BOUNDARY',
  'WORKFLOW_FAILURE_GOAL_BOUNDARY',
  'WORKFLOW_FAILURE_WORK_ITEM_BOUNDARY',
  'WORKFLOW_FAILURE_RUN_BOUNDARY',
  'WORKFLOW_FAILURE_TRANSITION_INVALID'
])

interface WorkflowTestFailureOwnership {
  sourceEventId: string
  projectId: string
  workItemId: string
  goalId?: string
}

interface SnapshotBarrierCursor {
  eventId: string
  seq: number
}

export type WorkflowTestFailurePlan =
  | { disposition: 'ingest'; input: TestFailureInput }
  | { disposition: 'ignore'; reason: 'not_tool_result' | 'successful_result' | 'command_not_exited' | 'not_test_command' }
  | { disposition: 'unowned'; reason: 'workspace_or_work_item_missing' }
  | {
      disposition: 'malformed'
      reason:
        | 'exit_code_missing'
        | 'event_identity_invalid'
        | 'run_binding_invalid'
        | 'tool_execution_missing'
        | 'tool_execution_invalid'
        | 'tool_request_missing'
        | 'tool_request_invalid'
    }

export interface WorkflowTestFailureContext {
  meta: SessionMeta
  run: TaskRunRecord | undefined
  transcript: readonly TranscriptEntry[]
  event: AgentEvent
  identity: AgentEventIdentity
}

export interface WorkflowTestFailureRuntimeDependencies {
  context(sessionId: string): Omit<WorkflowTestFailureContext, 'event' | 'identity'> | undefined
  captureEventBarrier(sessionId: string, identity: AgentEventIdentity): () => Promise<void>
  rootDir?: string
}

export interface WorkflowTestFailureRuntimeResult {
  plan: Extract<WorkflowTestFailurePlan, { disposition: 'ingest' }>
  ingress: WorkflowAcceptanceFailureResult
}

export interface WorkflowTestFailureRecoveryResult {
  recovered: string[]
  existing: string[]
  rejected: Array<{ sourceEventId: string; code: WorkflowAcceptanceFailureIngressErrorCode; error: string }>
  ignored: number
  failures: Array<{ sourceEventId: string; error: string }>
}

class WorkflowTestFailureQueueBlockedError extends Error {
  constructor(readonly cause: unknown) {
    super('A different workflow test failure must be replayed successfully before this event can run')
    this.name = 'WorkflowTestFailureQueueBlockedError'
  }
}

/**
 * Converts only a structured failed native bash test result into Acceptance
 * failure input. Model turn errors and unstructured shell output never enter
 * this boundary.
 */
export function planWorkflowTestFailureIngress(
  context: WorkflowTestFailureContext
): WorkflowTestFailurePlan {
  const { event, identity, meta, run, transcript } = context
  if (event.kind !== 'tool-result') return { disposition: 'ignore', reason: 'not_tool_result' }
  const exitCode = resolveFailedExitCode(event)
  if (exitCode.ok === false) return exitCode.result
  const ownership = resolveTestFailureOwnership(identity, meta)
  if (ownership.ok === false) return ownership.result
  const boundRun = resolveBoundRun(run, meta.id)
  if (boundRun.ok === false) return boundRun.result
  const execution = resolveBoundToolExecution(boundRun.value, event, ownership.value.sourceEventId)
  if (execution.ok === false) return execution.result
  const command = resolveBoundTestCommand(transcript, execution.value, event, identity.seq)
  if (command.ok === false) return command.result
  if (!isExplicitTestCommand(command.value)) {
    return { disposition: 'ignore', reason: 'not_test_command' }
  }

  return {
    disposition: 'ingest',
    input: {
      sourceKind: 'test',
      sourceEventId: ownership.value.sourceEventId,
      projectId: ownership.value.projectId,
      ...(ownership.value.goalId ? { goalId: ownership.value.goalId } : {}),
      workItemId: ownership.value.workItemId,
      runId: boundRun.value.id,
      title: 'Automated test command failed',
      summary: `A native bash test command failed with exit code ${exitCode.value}.`,
      verifier: 'native-tool:bash',
      observedAt: identity.occurredAt,
      contentDigest: createHash('sha256').update(event.content).digest('hex'),
      outcome: 'failed',
      exitCode: exitCode.value
    }
  }
}

function resolveFailedExitCode(event: ToolResultEvent): ValidationResult<number> {
  if (event.commandTermination !== 'exited') return { ok: false, result: { disposition: 'ignore', reason: 'command_not_exited' } }
  if (!event.isError || event.exitCode === 0) {
    return { ok: false, result: { disposition: 'ignore', reason: 'successful_result' } }
  }
  if (typeof event.exitCode !== 'number' || !Number.isSafeInteger(event.exitCode)) {
    return { ok: false, result: { disposition: 'malformed', reason: 'exit_code_missing' } }
  }
  return { ok: true, value: event.exitCode }
}

function resolveTestFailureOwnership(
  identity: AgentEventIdentity,
  meta: SessionMeta
): ValidationResult<WorkflowTestFailureOwnership> {
  const sourceEventId = cleanIdentity(identity.eventId)
  if (!sourceEventId || !validTimestamp(identity.occurredAt)) {
    return { ok: false, result: { disposition: 'malformed', reason: 'event_identity_invalid' } }
  }
  const projectId = cleanOwnershipId(meta.workspaceId)
  const workItemId = cleanOwnershipId(meta.workItemId)
  if (!projectId || !workItemId) {
    return { ok: false, result: { disposition: 'unowned', reason: 'workspace_or_work_item_missing' } }
  }
  const goalId = cleanOwnershipId(meta.goalId)
  return { ok: true, value: { sourceEventId, projectId, workItemId, ...(goalId ? { goalId } : {}) } }
}

function resolveBoundRun(
  run: TaskRunRecord | undefined,
  sessionId: string
): ValidationResult<TaskRunRecord> {
  if (!run || run.sessionId !== sessionId || !cleanIdentity(run.id)) {
    return { ok: false, result: { disposition: 'malformed', reason: 'run_binding_invalid' } }
  }
  return { ok: true, value: run }
}

function resolveBoundToolExecution(
  run: TaskRunRecord,
  event: ToolResultEvent,
  sourceEventId: string
): ValidationResult<ToolExecution> {
  const execution = run.toolExecutions?.find((candidate) => candidate.toolUseId === event.toolUseId)
  if (!execution) {
    return { ok: false, result: { disposition: 'malformed', reason: 'tool_execution_missing' } }
  }
  if (
    execution.runId !== run.id ||
    execution.sessionId !== run.sessionId ||
    execution.toolName.trim().toLowerCase() !== 'bash' ||
    execution.status !== 'failed' ||
    execution.resultEventId !== sourceEventId ||
    execution.outputDigest !== stableValueDigest(event.content)
  ) {
    return { ok: false, result: { disposition: 'malformed', reason: 'tool_execution_invalid' } }
  }
  return { ok: true, value: execution }
}

function resolveBoundTestCommand(
  transcript: readonly TranscriptEntry[],
  execution: ToolExecution,
  event: ToolResultEvent,
  resultSeq: number
): ValidationResult<string> {
  const request = findBoundToolRequest(transcript, execution.requestedEventId, event.toolUseId, resultSeq)
  if (!request) {
    return { ok: false, result: { disposition: 'malformed', reason: 'tool_request_missing' } }
  }
  if (
    request.name.trim().toLowerCase() !== 'bash' ||
    !isRecord(request.input) ||
    typeof request.input.command !== 'string' ||
    execution.inputDigest !== stableValueDigest(request.input)
  ) {
    return { ok: false, result: { disposition: 'malformed', reason: 'tool_request_invalid' } }
  }
  return { ok: true, value: request.input.command.trim() }
}

export class WorkflowTestFailureRuntime {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly failureLatches = new Map<string, Map<string, unknown>>()

  constructor(private readonly dependencies: WorkflowTestFailureRuntimeDependencies) {}

  handleEvent(
    sessionId: string,
    event: AgentEvent,
    identity: AgentEventIdentity
  ): Promise<WorkflowTestFailureRuntimeResult | undefined> {
    const context = this.dependencies.context(sessionId)
    if (!context) return Promise.resolve(undefined)
    const plan = planWorkflowTestFailureIngress({ ...context, event, identity })
    if (plan.disposition !== 'ingest') return Promise.resolve(undefined)
    const persistEventBarrier = captureEventBarrier(this.dependencies, sessionId, identity)
    return this.enqueue(sessionId, plan.input.sourceEventId, async () => {
      await persistEventBarrier()
      const ingress = await ingestWorkflowAcceptanceFailure(plan.input, this.dependencies.rootDir)
      return { plan, ingress }
    })
  }

  async flush(sessionId: string): Promise<void> {
    while (this.queues.has(sessionId)) {
      await this.queues.get(sessionId)
    }
    const failures = this.failureLatches.get(sessionId)
    if (failures && failures.size > 0) throw failures.values().next().value
  }

  private enqueue<T>(sessionId: string, sourceEventId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const run = () => {
      const blockingFailure = this.blockingFailure(sessionId, sourceEventId)
      return blockingFailure
        ? Promise.reject(new WorkflowTestFailureQueueBlockedError(blockingFailure.error))
        : task()
    }
    const next = previous.then(run, run)
    const settled = next.then(
      () => {
        this.clearFailure(sessionId, sourceEventId)
        if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId)
      },
      (error: unknown) => {
        if (error instanceof WorkflowTestFailureQueueBlockedError) {
          // The original source remains the recovery candidate; this event never crossed its barrier.
        } else if (nonRetryableIngressCode(error)) {
          this.clearFailure(sessionId, sourceEventId)
        } else {
          this.recordFailure(sessionId, sourceEventId, error)
        }
        if (this.queues.get(sessionId) === settled) this.queues.delete(sessionId)
      }
    )
    this.queues.set(sessionId, settled)
    return next
  }

  private recordFailure(sessionId: string, sourceEventId: string, error: unknown): void {
    const failures = this.failureLatches.get(sessionId) ?? new Map<string, unknown>()
    failures.set(sourceEventId, error)
    this.failureLatches.set(sessionId, failures)
  }

  private blockingFailure(sessionId: string, sourceEventId: string): { error: unknown } | undefined {
    const failures = this.failureLatches.get(sessionId)
    if (!failures || failures.has(sourceEventId)) return undefined
    return { error: failures.values().next().value }
  }

  private clearFailure(sessionId: string, sourceEventId: string): void {
    const failures = this.failureLatches.get(sessionId)
    if (!failures) return
    failures.delete(sourceEventId)
    if (failures.size === 0) this.failureLatches.delete(sessionId)
  }
}

/** Recover a crash after the failed tool result crossed the snapshot barrier but before ingress committed. */
export async function recoverWorkflowTestFailureIngresses(
  snapshots: readonly TaskSnapshotRecord[],
  rootDir?: string
): Promise<WorkflowTestFailureRecoveryResult> {
  const result: WorkflowTestFailureRecoveryResult = {
    recovered: [],
    existing: [],
    rejected: [],
    ignored: 0,
    failures: []
  }
  for (const snapshot of snapshots) {
    const candidate = latestBarrierTestFailure(snapshot)
    if (!candidate) continue
    const plan = planWorkflowTestFailureIngress({
      meta: snapshot.meta,
      run: snapshot.run,
      transcript: snapshot.transcript,
      event: candidate.event,
      identity: candidate.identity
    })
    if (plan.disposition !== 'ingest') {
      result.ignored += 1
      continue
    }
    const sourceEventId = plan.input.sourceEventId
    try {
      const ingress = await ingestWorkflowAcceptanceFailure(plan.input, rootDir)
      const recovered = ingress.replayed ? result.existing : result.recovered
      recovered.push(sourceEventId)
    } catch (error) {
      const rejectedCode = nonRetryableIngressCode(error)
      if (rejectedCode) {
        result.rejected.push({
          sourceEventId,
          code: rejectedCode,
          error: error instanceof Error ? error.message : String(error)
        })
        continue
      }
      result.failures.push({
        sourceEventId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

export function isExplicitTestCommand(command: string): boolean {
  const segments = splitShellSegments(command)
  // A compound shell status cannot prove which segment produced the failure.
  return segments.length === 1 && isTestInvocation(tokenizeShellSegment(segments[0]))
}

function latestBarrierTestFailure(
  snapshot: TaskSnapshotRecord
): { event: ToolResultEvent; identity: AgentEventIdentity } | undefined {
  const { execution, run, transcript } = snapshot
  if (!run) return undefined
  const cursor = resolveSnapshotBarrierCursor(execution)
  if (!cursor || !runMatchesSnapshotBarrier(run, cursor)) return undefined
  return findLatestBarrierFailure(transcript, cursor)
}

function resolveSnapshotBarrierCursor(
  execution: TaskSnapshotRecord['execution']
): SnapshotBarrierCursor | undefined {
  if (execution.lastEventKind !== 'tool-result') return undefined
  const lastEventId = cleanIdentity(execution.lastEventId)
  if (!lastEventId || execution.lastEventId !== lastEventId) return undefined
  const lastSeq = execution.lastSeq
  if (!Number.isSafeInteger(lastSeq) || lastSeq <= 0) return undefined
  if (execution.cursor && (
    execution.cursor.seq !== lastSeq ||
    execution.cursor.eventId !== lastEventId
  )) return undefined
  return { eventId: lastEventId, seq: lastSeq }
}

function runMatchesSnapshotBarrier(run: TaskRunRecord, cursor: SnapshotBarrierCursor): boolean {
  return run.lastAppliedEventId === cursor.eventId && run.lastAppliedEventSeq === cursor.seq
}

function captureEventBarrier(
  dependencies: WorkflowTestFailureRuntimeDependencies,
  sessionId: string,
  identity: AgentEventIdentity
): () => Promise<void> {
  try {
    return dependencies.captureEventBarrier(sessionId, identity)
  } catch (error) {
    return async () => { throw error }
  }
}

function nonRetryableIngressCode(
  error: unknown
): WorkflowAcceptanceFailureIngressErrorCode | undefined {
  if (!(error instanceof WorkflowAcceptanceFailureIngressError)) return undefined
  return NON_RETRYABLE_INGRESS_CODES.has(error.code) ? error.code : undefined
}

function findLatestBarrierFailure(
  transcript: readonly TranscriptEntry[],
  cursor: SnapshotBarrierCursor
): { event: ToolResultEvent; identity: AgentEventIdentity } | undefined {
  const entry = transcript.find((candidate) =>
    candidate.eventId === cursor.eventId && candidate.seq === cursor.seq
  )
  if (!entry || entry.event.kind !== 'tool-result' || !entry.event.isError) return undefined
  if (transcript.some((candidate) => candidate !== entry && candidate.seq >= cursor.seq)) return undefined
  const identity = transcriptIdentity(entry)
  return identity ? { event: entry.event, identity } : undefined
}

function findBoundToolRequest(
  transcript: readonly TranscriptEntry[],
  requestedEventId: string | undefined,
  toolUseId: string,
  resultSeq: number
): ToolRequestBlock | undefined {
  if (!requestedEventId) return undefined
  const entry = transcript.find((candidate) =>
    candidate.eventId === requestedEventId &&
    candidate.seq <= resultSeq &&
    candidate.event.kind === 'assistant-message'
  )
  if (!entry || entry.event.kind !== 'assistant-message') return undefined
  return entry.event.blocks.find((block) => block.type === 'tool_use' && block.id === toolUseId) as
    | Extract<(typeof entry.event.blocks)[number], { type: 'tool_use' }>
    | undefined
}

function transcriptIdentity(entry: TranscriptEntry): AgentEventIdentity | undefined {
  const eventId = cleanIdentity(entry.eventId)
  const streamId = cleanIdentity(entry.streamId)
  if (!eventId || !streamId || !validTimestamp(entry.occurredAt) || !Number.isSafeInteger(entry.seq) || entry.seq <= 0) {
    return undefined
  }
  return {
    schemaVersion: 1,
    streamId,
    eventId,
    seq: entry.seq,
    occurredAt: entry.occurredAt,
    ...(entry.causationId ? { causationId: entry.causationId } : {}),
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {})
  }
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  const state: ShellSegmentState = { current: '', escaped: false }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (consumeShellContentCharacter(state, char)) continue
    const separatorWidth = shellSeparatorWidth(command, index)
    if (separatorWidth > 0) {
      appendShellSegment(segments, state.current)
      state.current = ''
      index += separatorWidth - 1
      continue
    }
    state.current += char
  }
  appendShellSegment(segments, state.current)
  return segments
}

interface ShellSegmentState {
  current: string
  quote?: "'" | '"'
  escaped: boolean
}

function consumeShellContentCharacter(state: ShellSegmentState, char: string): boolean {
  if (state.escaped) {
    state.current += char
    state.escaped = false
    return true
  }
  if (char === '\\' && state.quote !== "'") {
    state.current += char
    state.escaped = true
    return true
  }
  if (state.quote) {
    state.current += char
    if (char === state.quote) state.quote = undefined
    return true
  }
  if (char === "'" || char === '"') {
    state.current += char
    state.quote = char
    return true
  }
  return false
}

function shellSeparatorWidth(command: string, index: number): number {
  const pair = command.slice(index, index + 2)
  if (pair === '&&' || pair === '||') return 2
  const char = command[index]
  return char === ';' || char === '|' || char === '\n' ? 1 : 0
}

function appendShellSegment(segments: string[], value: string): void {
  const segment = value.trim()
  if (segment) segments.push(segment)
}

function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const char of segment) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function isTestInvocation(rawTokens: readonly string[]): boolean {
  const tokens = stripCommandPrefixes(rawTokens)
  if (tokens.length === 0) return false
  const executable = basename(tokens[0]).toLowerCase()
  const args = tokens.slice(1)
  const first = args[0]?.toLowerCase()
  const second = args[1]?.toLowerCase()

  return isPackageManagerTestInvocation(executable, first, second) ||
    isJavaScriptTestInvocation(executable, args, first) ||
    isLanguageTestInvocation(executable, first, second) ||
    isBuildToolTestInvocation(executable, args, first, second)
}

function isPackageManagerTestInvocation(
  executable: string,
  first: string | undefined,
  second: string | undefined
): boolean {
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable)) {
    if (isTestScript(first)) return true
    if (first === 'run' && isTestScript(second)) return true
    if ((first === 'exec' || first === 'dlx') && isTestRunner(second)) return true
    if (isTestRunner(first)) return true
  }
  return false
}

function isJavaScriptTestInvocation(
  executable: string,
  args: readonly string[],
  first: string | undefined
): boolean {
  if ((executable === 'npx' || executable === 'bunx') && isTestRunner(first)) return true
  if (isTestRunner(executable)) return true
  if (executable === 'node') {
    if (args.includes('--test')) return true
    return args.some((arg) => /(?:^|[._/-])(?:test|tests|spec|smoke|e2e)(?:[._/-]|$)/i.test(arg))
  }
  return false
}

function isLanguageTestInvocation(
  executable: string,
  first: string | undefined,
  second: string | undefined
): boolean {
  if (executable === 'python' || executable === 'python3') {
    return (first === '-m' && second === 'pytest') || isTestRunner(first)
  }
  if (executable === 'go') return first === 'test'
  if (executable === 'cargo' || executable === 'swift' || executable === 'dotnet' || executable === 'mix') {
    return first === 'test'
  }
  if (executable === 'bundle') return first === 'exec' && second === 'rspec'
  return false
}

function isBuildToolTestInvocation(
  executable: string,
  args: readonly string[],
  first: string | undefined,
  second: string | undefined
): boolean {
  if (executable === 'make' || executable === 'gmake') return args.some((arg) => /^test(?:[-_:].*)?$/i.test(arg))
  if (executable === 'gradle' || executable === 'gradlew') {
    return args.some((arg) => /(?:^|:)test(?:[a-z0-9_-]*)$/i.test(arg))
  }
  if (executable === 'mvn' || executable === 'mvnw') {
    return args.some((arg) => arg === 'test' || arg === 'verify')
  }
  if (executable === 'xcodebuild') return args.some((arg) => arg.toLowerCase() === 'test')
  return false
}

function stripCommandPrefixes(rawTokens: readonly string[]): string[] {
  const tokens = [...rawTokens]
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0])) tokens.shift()
  if (tokens[0]?.toLowerCase() === 'env') {
    tokens.shift()
    while (tokens.length > 0 && (tokens[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0]))) {
      tokens.shift()
    }
  }
  if (tokens[0]?.toLowerCase() === 'command') {
    tokens.shift()
    while (tokens[0]?.startsWith('-')) tokens.shift()
  }
  return tokens
}

function isTestScript(value: string | undefined): boolean {
  return Boolean(value && /^test(?::[a-z0-9_.-]+)?$/i.test(value))
}

function isTestRunner(value: string | undefined): boolean {
  if (!value) return false
  return [
    'ava', 'cypress', 'ctest', 'jest', 'mocha', 'node-tap', 'phpunit', 'playwright',
    'pytest', 'rspec', 'tap', 'vitest'
  ].includes(basename(value).toLowerCase())
}

function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').at(-1) ?? value
}

function cleanOwnershipId(value: string | undefined): string | undefined {
  const clean = value?.trim()
  return clean && clean.length <= 256 && !/[\0-\x1f\x7f]/.test(clean) ? clean : undefined
}

function cleanIdentity(value: string | undefined): string | undefined {
  const clean = value?.trim()
  return clean && clean.length <= 256 && !/[\0-\x1f\x7f]/.test(clean) ? clean : undefined
}

function validTimestamp(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
