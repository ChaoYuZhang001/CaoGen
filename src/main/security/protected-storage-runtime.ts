import { app, safeStorage } from 'electron'
import { isProtectedStorageRuntimeEligible } from './protected-storage-policy'

export interface ProtectedStorageBackend {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend(): string
}

let eligible: boolean | undefined

export const protectedStorage: ProtectedStorageBackend = {
  isEncryptionAvailable(): boolean {
    if (!runtimeEligible()) return false
    return safeStorage.isEncryptionAvailable()
  },
  encryptString(value: string): Buffer {
    assertRuntimeEligible()
    return safeStorage.encryptString(value)
  },
  decryptString(value: Buffer): string {
    assertRuntimeEligible()
    return safeStorage.decryptString(value)
  },
  getSelectedStorageBackend(): string {
    if (!runtimeEligible()) return 'unavailable'
    return safeStorage.getSelectedStorageBackend()
  }
}

function runtimeEligible(): boolean {
  if (eligible !== undefined) return eligible
  eligible = isProtectedStorageRuntimeEligible({
    platform: process.platform,
    electronMain: process.type === 'browser',
    isPackaged: app.isPackaged,
    executablePath: process.execPath
  })
  return eligible
}

function assertRuntimeEligible(): void {
  if (!runtimeEligible()) {
    throw new Error('Protected system credential storage is unavailable in this application build')
  }
}
