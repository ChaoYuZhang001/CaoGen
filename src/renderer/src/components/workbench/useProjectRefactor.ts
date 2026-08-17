import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  ProjectRefactorApplyResult,
  ProjectRefactorPreview,
  ProjectRefactorRollbackResult
} from '../../../../shared/types'
import { useStore } from '../../store'

export interface ProjectRefactorController {
  activeId: string | null
  defaultPath: string
  preview: ProjectRefactorPreview | null
  applied: ProjectRefactorApplyResult | null
  rolledBack: ProjectRefactorRollbackResult | null
  pending: boolean
  error: string
  previewRename(path: string, line: number, column: number, newName: string): Promise<void>
  apply(): Promise<void>
  rollback(): Promise<void>
  clear(): void
}

export function useProjectRefactor(): ProjectRefactorController {
  const activeId = useStore((state) => state.activeId)
  const currentFilePath = useStore((state) => state.workbench.currentFilePath)
  const fileTabs = useStore((state) => state.workbench.fileTabs)
  const closeFileTab = useStore((state) => state.closeFileTab)
  const openFile = useStore((state) => state.openFile)
  const refreshFilesPanel = useStore((state) => state.refreshFilesPanel)
  const refreshProjectDiagnostics = useStore((state) => state.refreshProjectDiagnostics)
  const [preview, setPreview] = useState<ProjectRefactorPreview | null>(null)
  const [applied, setApplied] = useState<ProjectRefactorApplyResult | null>(null)
  const [rolledBack, setRolledBack] = useState<ProjectRefactorRollbackResult | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [recoveryNoticeId, setRecoveryNoticeId] = useState<string | null>(null)

  useEffect(() => {
    setPreview(null); setApplied(null); setRolledBack(null); setPending(false); setError(''); setRecoveryNoticeId(null)
  }, [activeId])
  useProjectRefactorRecovery(activeId, setApplied, setRolledBack, setError, setRecoveryNoticeId)

  const previewRename = async (path: string, line: number, column: number, newName: string): Promise<void> => {
    if (!activeId || pending) return
    const sessionId = activeId
    const sourceTab = fileTabs.find((tab) => tab.sessionId === sessionId && tab.path === path)
    if (sourceTab && sourceTab.content !== sourceTab.savedContent) {
      setError('Save the active file before previewing a refactor')
      return
    }
    setPending(true); setError(''); setPreview(null); setApplied(null); setRolledBack(null)
    try {
      const source = await window.agentDesk.readTextFile(sessionId, path)
      if (!source.ok) throw new Error(source.error ?? 'Source file could not be read')
      const next = await window.agentDesk.previewTypeScriptRename(sessionId, {
        path,
        content: source.content ?? '',
        line,
        column,
        newName
      })
      const dirtyAffected = fileTabs.find((tab) => tab.sessionId === sessionId &&
        next.files.some((file) => file.path === tab.path) && tab.content !== tab.savedContent)
      if (dirtyAffected) throw new Error(`Save ${dirtyAffected.path} before applying this refactor`)
      setPreview(next)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPending(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!activeId || !preview || pending) return
    const sessionId = activeId
    const paths = preview.files.map((file) => file.path)
    const reopenPath = currentFilePath && paths.includes(currentFilePath) ? currentFilePath : ''
    setPending(true); setError('')
    try {
      const result = await window.agentDesk.applyProjectRefactor(sessionId, preview.previewId)
      setApplied(result); setPreview(null); setRolledBack(null); setRecoveryNoticeId(null)
      await reloadAffectedFiles(sessionId, result.files, reopenPath)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPending(false)
    }
  }

  const rollback = async (): Promise<void> => {
    if (!activeId || !applied || pending) return
    const sessionId = activeId
    const reopenPath = currentFilePath && applied.files.includes(currentFilePath) ? currentFilePath : ''
    setPending(true); setError('')
    try {
      const result = await window.agentDesk.rollbackProjectRefactor(sessionId, applied.operationId)
      setRolledBack(result); setApplied(null); setRecoveryNoticeId(null)
      await reloadAffectedFiles(sessionId, result.files, reopenPath)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPending(false)
    }
  }

  const reloadAffectedFiles = async (sessionId: string, paths: string[], reopenPath: string): Promise<void> => {
    if (activeId !== sessionId) return
    for (const path of paths) {
      if (fileTabs.some((tab) => tab.sessionId === sessionId && tab.path === path)) closeFileTab(path)
    }
    await refreshFilesPanel()
    await refreshProjectDiagnostics()
    if (reopenPath) await openFile(reopenPath)
  }

  return {
    activeId,
    defaultPath: currentFilePath ?? '',
    preview,
    applied,
    rolledBack,
    pending,
    error,
    previewRename,
    apply,
    rollback,
    clear: () => {
      if (activeId && recoveryNoticeId) {
        void window.agentDesk.dismissProjectRefactorRecovery(activeId, recoveryNoticeId).catch((caught) => setError(errorMessage(caught)))
      }
      setPreview(null); setApplied(null); setRolledBack(null); setRecoveryNoticeId(null); setError('')
    }
  }
}

function useProjectRefactorRecovery(
  activeId: string | null,
  setApplied: Dispatch<SetStateAction<ProjectRefactorApplyResult | null>>,
  setRolledBack: Dispatch<SetStateAction<ProjectRefactorRollbackResult | null>>,
  setError: Dispatch<SetStateAction<string>>,
  setRecoveryNoticeId: Dispatch<SetStateAction<string | null>>
): void {
  useEffect(() => {
    if (!activeId) return undefined
    let cancelled = false
    void window.agentDesk.getProjectRefactorRecovery(activeId).then((recovery) => {
      if (cancelled) return
      if (recovery.status === 'blocked') {
        setError(recovery.message ?? 'Interrupted refactor recovery is blocked')
        return
      }
      if (!recovery.operationId) return
      if (recovery.status === 'rollback_available') {
        setApplied({
          ok: true,
          operationId: recovery.operationId,
          kind: 'typescript-rename',
          files: recovery.files,
          appliedAt: recovery.occurredAt ?? new Date().toISOString()
        })
        return
      }
      if (recovery.status === 'auto_rolled_back') {
        setRecoveryNoticeId(recovery.operationId)
        setRolledBack({
          ok: true,
          operationId: recovery.operationId,
          files: recovery.files,
          rolledBackAt: recovery.occurredAt ?? new Date().toISOString()
        })
      }
    }).catch((caught) => {
      if (!cancelled) setError(errorMessage(caught))
    })
    return () => { cancelled = true }
  }, [activeId, setApplied, setError, setRecoveryNoticeId, setRolledBack])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
