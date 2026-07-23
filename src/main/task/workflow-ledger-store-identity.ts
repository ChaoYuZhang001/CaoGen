import { randomUUID } from 'node:crypto'
import type { WorkflowLedgerDatabase } from './workflow-ledger-db'
import { WorkflowLedgerCorruptionError } from './workflow-ledger-errors'

export const WORKFLOW_LEDGER_STORE_IDENTITY_TABLE = 'workflow_store_identity' as const

export interface WorkflowLedgerStoreIdentity {
  storeId: string
  createdAt: number
}

export function setupWorkflowLedgerStoreIdentity(db: WorkflowLedgerDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ${WORKFLOW_LEDGER_STORE_IDENTITY_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      store_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
  `)
  const existing = readWorkflowLedgerStoreIdentityRows(db)
  if (existing.length === 0) {
    db.run(
      `INSERT INTO ${WORKFLOW_LEDGER_STORE_IDENTITY_TABLE}(singleton, store_id, created_at) VALUES (1, ?, ?)`,
      [randomUUID(), Date.now()]
    )
    return
  }
  assertWorkflowLedgerStoreIdentityRows(existing)
}

export function readWorkflowLedgerStoreIdentity(db: WorkflowLedgerDatabase): WorkflowLedgerStoreIdentity {
  const rows = readWorkflowLedgerStoreIdentityRows(db)
  assertWorkflowLedgerStoreIdentityRows(rows)
  return { storeId: rows[0].storeId, createdAt: rows[0].createdAt }
}

function readWorkflowLedgerStoreIdentityRows(
  db: WorkflowLedgerDatabase
): Array<{ singleton: unknown; storeId: unknown; createdAt: unknown }> {
  const rows: Array<{ singleton: unknown; storeId: unknown; createdAt: unknown }> = []
  const stmt = db.prepare(
    `SELECT singleton, store_id, created_at FROM ${WORKFLOW_LEDGER_STORE_IDENTITY_TABLE} ORDER BY singleton`
  )
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject()
      rows.push({ singleton: row.singleton, storeId: row.store_id, createdAt: row.created_at })
    }
  } finally {
    stmt.free()
  }
  return rows
}

function assertWorkflowLedgerStoreIdentityRows(
  rows: ReadonlyArray<{ singleton: unknown; storeId: unknown; createdAt: unknown }>
): asserts rows is ReadonlyArray<{ singleton: 1; storeId: string; createdAt: number }> {
  const row = rows[0]
  if (
    rows.length !== 1 ||
    row?.singleton !== 1 ||
    typeof row.storeId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.storeId) ||
    typeof row.createdAt !== 'number' ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0
  ) {
    throw new WorkflowLedgerCorruptionError('workflow store identity is invalid')
  }
}
