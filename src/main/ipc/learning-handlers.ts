import { ipcMain } from 'electron'
import {
  approveLearningDraft,
  deleteLearningRecord,
  listLearningProject,
  rejectLearningDraft,
  revokeLearningRecord,
  rollbackLearningRecord
} from '../learning/learning-lifecycle'
import { createTrustedUserLearningDecision } from '../learning/learning-security'
import { resolveDefaultLearningRoot } from '../learning/learning-store'

export interface LearningIpcOptions {
  projectRootFor(sessionId: string): string | null
}

export function registerLearningIpc(options: LearningIpcOptions): void {
  const contextFor = async (sessionId: string): Promise<{ projectRoot: string; learningRoot: string }> => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('必须指定会话')
    const projectRoot = options.projectRootFor(sessionId.trim())
    if (!projectRoot) throw new Error('会话不存在')
    return { projectRoot, learningRoot: await resolveDefaultLearningRoot(projectRoot) }
  }

  ipcMain.handle('learning:list', async (_event, sessionId: string) => {
    const { projectRoot, learningRoot } = await contextFor(sessionId)
    return listLearningProject(projectRoot, learningRoot)
  })
  ipcMain.handle('learning:approve', async (_event, sessionId: string, recordId: string) => {
    const { projectRoot, learningRoot } = await contextFor(sessionId)
    return approveLearningDraft(projectRoot, learningRoot, requiredRecordId(recordId), decision('approve'))
  })
  ipcMain.handle('learning:reject', async (_event, sessionId: string, recordId: string) => {
    const { projectRoot, learningRoot } = await contextFor(sessionId)
    return rejectLearningDraft(projectRoot, learningRoot, requiredRecordId(recordId), decision('reject'))
  })
  ipcMain.handle('learning:rollback', async (_event, sessionId: string, recordId: string) => {
    const { projectRoot, learningRoot } = await contextFor(sessionId)
    return rollbackLearningRecord(projectRoot, learningRoot, requiredRecordId(recordId), decision('rollback'))
  })
  ipcMain.handle('learning:revoke', async (_event, sessionId: string, recordId: string) => {
    const { projectRoot, learningRoot } = await contextFor(sessionId)
    return revokeLearningRecord(projectRoot, learningRoot, requiredRecordId(recordId), decision('revoke'))
  })
  ipcMain.handle('learning:delete', async (_event, sessionId: string, recordId: string) => {
    const { projectRoot, learningRoot } = await contextFor(sessionId)
    return deleteLearningRecord(projectRoot, learningRoot, requiredRecordId(recordId), decision('delete'))
  })
}

function requiredRecordId(recordId: string): string {
  if (typeof recordId !== 'string' || !recordId.trim()) throw new Error('必须指定 Learning 记录')
  return recordId.trim()
}

function decision(action: string) {
  return createTrustedUserLearningDecision(`ipc:learning:${action}`)
}
