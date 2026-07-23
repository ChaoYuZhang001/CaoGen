export class WorkflowLedgerCorruptionError extends Error {
  readonly code = 'WORKFLOW_LEDGER_CORRUPTION'
  readonly seq?: number

  constructor(reason: string, seq?: number) {
    super(`Workflow ledger corruption${seq === undefined ? '' : ` at seq=${seq}`}: ${reason}`)
    this.name = 'WorkflowLedgerCorruptionError'
    this.seq = seq
  }
}
