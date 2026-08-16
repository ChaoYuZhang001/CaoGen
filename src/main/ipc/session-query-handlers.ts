import type { IpcMainInvokeEvent } from 'electron'
import { app } from 'electron'
import { join } from 'node:path'
import { listHistory } from '../history'
import { querySessionDirectory } from '../session-query'
import { sessionManager } from '../sessionManager'
import { assertTrustedWorkflowLedgerSender } from './workflow-ledger-handlers'

export type SessionQueryAction = 'query'

export async function handleSessionQueryIpc(
  event: IpcMainInvokeEvent,
  rawAction: unknown,
  input: unknown
) {
  assertTrustedWorkflowLedgerSender(event)
  if (rawAction !== 'query') throw new Error('Session query action is invalid')
  return querySessionDirectory({
    activeSessions: sessionManager.list(),
    history: listHistory(),
    snapshots: await sessionManager.listTaskSnapshots(),
    transcriptsDir: join(app.getPath('userData'), 'transcripts')
  }, input)
}
