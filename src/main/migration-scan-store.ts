import type { MigrationAsset, MigrationScan } from '../shared/types'

export type JsonObject = Record<string, unknown>

export interface InternalMigrationAsset {
  asset: MigrationAsset
  sourceRoot: string
  sourcePath: string
  targetRoot?: string
  targetPath?: string
  targetFingerprint?: string
  mcpServerName?: string
  mcpConfig?: JsonObject
}

export interface StoredMigrationScan {
  result: MigrationScan
  assets: Map<string, InternalMigrationAsset>
  createdAt: number
}

const SCAN_TTL_MS = 30 * 60 * 1000
const MAX_STORED_SCANS = 20
const scanStore = new Map<string, StoredMigrationScan>()

export function storeMigrationScan(result: MigrationScan, assets: InternalMigrationAsset[]): void {
  pruneScanStore()
  scanStore.set(result.scanId, {
    result,
    assets: new Map(assets.map((asset) => [asset.asset.id, asset])),
    createdAt: Date.now()
  })
}

export function readStoredMigrationScan(scanId: unknown): StoredMigrationScan | undefined {
  pruneScanStore()
  if (typeof scanId !== 'string') return undefined
  return scanStore.get(scanId)
}

export function deleteStoredMigrationScan(scanId: string): void {
  scanStore.delete(scanId)
}

function pruneScanStore(): void {
  const now = Date.now()
  for (const [scanId, stored] of scanStore) {
    if (now - stored.createdAt > SCAN_TTL_MS) scanStore.delete(scanId)
  }
  while (scanStore.size >= MAX_STORED_SCANS) {
    const oldest = scanStore.keys().next().value as string | undefined
    if (!oldest) break
    scanStore.delete(oldest)
  }
}
