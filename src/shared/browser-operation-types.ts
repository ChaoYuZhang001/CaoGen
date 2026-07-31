import type { EffectStatus } from './effect-types'

export interface BrowserEffectResultMetadata {
  effectStatus?: EffectStatus
  operationId?: string
}

export interface BrowserViewState {
  sessionId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export type BrowserStateActionResult<T> =
  | ({ ok: true; state: T } & BrowserEffectResultMetadata)
  | ({ ok: false; error: string; snapshotId?: string } & BrowserEffectResultMetadata)

export interface BrowserNavigationEffectApi {
  openBrowser(sessionId: string, url?: string): Promise<BrowserStateActionResult<BrowserViewState>>
  navigateBrowser(sessionId: string, url: string): Promise<BrowserStateActionResult<BrowserViewState>>
  browserGoBack(sessionId: string): Promise<BrowserStateActionResult<BrowserViewState>>
  browserGoForward(sessionId: string): Promise<BrowserStateActionResult<BrowserViewState>>
  reloadBrowser(sessionId: string): Promise<BrowserStateActionResult<BrowserViewState>>
}
