import { ipcRenderer } from 'electron'
import type { LearningApi } from '../shared/learning-types'

export const learningApi: LearningApi = {
  listLearning: (sessionId: string) => ipcRenderer.invoke('learning:list', sessionId),
  approveLearning: (sessionId: string, recordId: string) =>
    ipcRenderer.invoke('learning:approve', sessionId, recordId),
  rejectLearning: (sessionId: string, recordId: string) =>
    ipcRenderer.invoke('learning:reject', sessionId, recordId),
  rollbackLearning: (sessionId: string, recordId: string) =>
    ipcRenderer.invoke('learning:rollback', sessionId, recordId),
  revokeLearning: (sessionId: string, recordId: string) =>
    ipcRenderer.invoke('learning:revoke', sessionId, recordId),
  deleteLearning: (sessionId: string, recordId: string) =>
    ipcRenderer.invoke('learning:delete', sessionId, recordId)
}
