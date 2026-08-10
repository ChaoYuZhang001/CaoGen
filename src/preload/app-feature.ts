import { ipcRenderer } from 'electron'

export function invokeAppFeature<T>(feature: string, action: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke('appFeatures:invoke', feature, action, ...args) as Promise<T>
}
