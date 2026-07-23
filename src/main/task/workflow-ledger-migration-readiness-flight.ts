import { resolve } from 'node:path'
import { assertWorkflowLedgerReadinessForMode } from './workflow-ledger-migration-read-mode'
import {
  WORKFLOW_LEDGER_MIGRATION_KIND,
  WORKFLOW_LEDGER_MIGRATION_VERSION,
  type EnsureWorkflowLedgerTaskStoreReadyOptions,
  type WorkflowLedgerTaskStoreReadiness
} from './workflow-ledger-migration-types'

type ReadinessRunner = (
  options: EnsureWorkflowLedgerTaskStoreReadyOptions
) => Promise<WorkflowLedgerTaskStoreReadiness>

interface ReadinessFlight {
  promise: Promise<WorkflowLedgerTaskStoreReadiness>
  settled: boolean
}

const readinessFlights = new Map<string, ReadinessFlight>()

export function ensureWorkflowLedgerTaskStoreReadySingleFlight(
  options: EnsureWorkflowLedgerTaskStoreReadyOptions,
  runReadiness: ReadinessRunner
): Promise<WorkflowLedgerTaskStoreReadiness> {
  const key = readinessFlightKey(options.databasePath)
  const pending = readinessFlights.get(key)
  if (options.forceRefresh && pending && !pending.settled) {
    return pending.promise.then(
      () => ensureWorkflowLedgerTaskStoreReadySingleFlight({ ...options, forceRefresh: true }, runReadiness),
      () => ensureWorkflowLedgerTaskStoreReadySingleFlight({ ...options, forceRefresh: true }, runReadiness)
    )
  }
  if (options.forceRefresh && pending) readinessFlights.delete(key)
  const cached = readinessFlights.get(key)
  const base = cached?.promise ?? startReadinessFlight(key, options, runReadiness)
  return base.then((result) => {
    assertWorkflowLedgerReadinessForMode(result.report, options.readMode)
    return result
  })
}

function startReadinessFlight(
  key: string,
  options: EnsureWorkflowLedgerTaskStoreReadyOptions,
  runReadiness: ReadinessRunner
): Promise<WorkflowLedgerTaskStoreReadiness> {
  let flight!: ReadinessFlight
  const promise = runReadiness({ ...options, readMode: undefined, forceRefresh: undefined }).then(
    (result) => {
      flight.settled = true
      return result
    },
    (error) => {
      if (readinessFlights.get(key) === flight) readinessFlights.delete(key)
      throw error
    }
  )
  flight = { promise, settled: false }
  readinessFlights.set(key, flight)
  return promise
}

function readinessFlightKey(databasePath: string): string {
  return `${resolve(databasePath)}:${WORKFLOW_LEDGER_MIGRATION_KIND}:${WORKFLOW_LEDGER_MIGRATION_VERSION}`
}

/** Test-only reset; production keeps the successful first-open gate cached. */
export function clearWorkflowLedgerMigrationSingleFlightForTests(): void {
  readinessFlights.clear()
}

export function clearWorkflowLedgerMigrationSingleFlightForDatabase(databasePath: string): void {
  readinessFlights.delete(readinessFlightKey(databasePath))
}
