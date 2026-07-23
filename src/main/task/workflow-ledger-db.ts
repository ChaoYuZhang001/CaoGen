import type initSqlJs from 'sql.js'

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>

/** Shared database type keeps Ledger helpers independent from the facade module. */
export type WorkflowLedgerDatabase = InstanceType<SqlJsStatic['Database']>
