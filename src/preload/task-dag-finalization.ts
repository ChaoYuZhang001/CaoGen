import { ipcRenderer } from 'electron'
import type { AgentDeskApi } from '../shared/types'

export const resolveTaskDagFinalization: AgentDeskApi['resolveTaskDagFinalization'] = (
  executionId,
  expectedRevision,
  resolution
) => ipcRenderer.invoke('taskSnapshots:resolveDagFinalization', executionId, expectedRevision, resolution)
