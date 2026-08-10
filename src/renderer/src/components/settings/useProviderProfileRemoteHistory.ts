import { useMemo, useState } from 'react'
import type {
  ProviderProfileApplyResult,
  ProviderProfileImportAction,
  ProviderProfileImportDecision,
  ProviderProfileSyncHistoryEntry,
  ProviderProfileSyncHistoryPreview
} from '../../../../shared/types'

interface HistoryApi {
  list(): Promise<ProviderProfileSyncHistoryEntry[]>
  preview(revisionId: string): Promise<ProviderProfileSyncHistoryPreview>
  apply(previewId: string, decisions: ProviderProfileImportDecision[]): Promise<ProviderProfileApplyResult>
}

interface Options {
  api: HistoryApi
  refreshProviders(): Promise<void>
  onMessage(message: string): void
  onError(error: string): void
  appliedMessage(result: ProviderProfileApplyResult): string
}

export function useProviderProfileRemoteHistory(options: Options) {
  const [entries, setEntries] = useState<ProviderProfileSyncHistoryEntry[] | null>(null)
  const [preview, setPreview] = useState<ProviderProfileSyncHistoryPreview | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ProviderProfileImportAction>>({})
  const [busy, setBusy] = useState(false)
  const selectedChanges = useMemo(() => preview?.importPreview.items.reduce(
    (count, item) => count + Number((decisions[item.id] ?? item.defaultAction) !== 'skip'), 0
  ) ?? 0, [decisions, preview])

  async function toggle(): Promise<void> {
    if (entries !== null) { close(); return }
    await run(async () => { setEntries(await options.api.list()); setPreview(null); setDecisions({}) })
  }

  async function inspect(revisionId: string): Promise<void> {
    await run(async () => {
      const next = await options.api.preview(revisionId)
      setPreview(next)
      setDecisions(Object.fromEntries(next.importPreview.items.map((item) => [item.id, item.defaultAction])))
    })
  }

  async function apply(): Promise<void> {
    if (!preview || selectedChanges === 0) return
    await run(async () => {
      const selected = preview.importPreview.items.map((item) => ({
        itemId: item.id,
        action: decisions[item.id] ?? item.defaultAction
      }))
      const result = await options.api.apply(preview.previewId, selected)
      await options.refreshProviders()
      close()
      options.onMessage(options.appliedMessage(result))
    })
  }

  function close(): void { setEntries(null); setPreview(null); setDecisions({}) }

  async function run(operation: () => Promise<void>): Promise<void> {
    setBusy(true); options.onMessage(''); options.onError('')
    try { await operation() } catch (caught) { options.onError(errorMessage(caught)) } finally { setBusy(false) }
  }

  return { entries, preview, decisions, setDecisions, busy, selectedChanges, toggle, inspect, apply, close }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
