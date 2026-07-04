import { app, BrowserWindow, WebContentsView, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  listAnnotations,
  saveAnnotation,
  type BrowserAnnotationInput
} from './browserAnnotations'
import type {
  BrowserAnnotation,
  BrowserBounds,
  BrowserEvent,
  BrowserViewState
} from '../shared/types'

interface BrowserRecord {
  sessionId: string
  view: WebContentsView
  owner: BrowserWindow
  consoleErrors: string[]
  state: BrowserViewState
}

interface SelectionPayload {
  url?: string
  title?: string
  text?: string
  selector?: string
  boundingBox?: { x: number; y: number; width: number; height: number }
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
}

type Listener = (event: BrowserEvent) => void

const DEFAULT_URL = 'about:blank'
const MAX_CONSOLE_ERRORS = 200

class BrowserViewManager {
  private readonly records = new Map<string, BrowserRecord>()
  private readonly listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async open(owner: BrowserWindow, sessionId: string, url = DEFAULT_URL): Promise<BrowserViewState> {
    const existing = this.records.get(sessionId)
    if (existing && !existing.owner.isDestroyed()) {
      if (url && url !== DEFAULT_URL) await this.navigate(sessionId, url)
      return { ...existing.state }
    }

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `persist:caogen-browser-${safePartitionId(sessionId)}`
      }
    })
    // Keep the native view invisible until the React BrowserPanel reports its viewport bounds.
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    owner.contentView.addChildView(view)

    const record: BrowserRecord = {
      sessionId,
      view,
      owner,
      consoleErrors: [],
      state: {
        sessionId,
        url: DEFAULT_URL,
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }
    }
    this.records.set(sessionId, record)
    this.wireRecord(record)
    owner.once('closed', () => this.close(sessionId))

    if (url && url !== DEFAULT_URL) {
      await this.navigate(sessionId, url)
    } else {
      await view.webContents.loadURL(DEFAULT_URL).catch(() => undefined)
      this.refreshState(record)
    }
    return { ...record.state }
  }

  async navigate(sessionId: string, rawUrl: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    const url = normalizeNavigationUrl(rawUrl)
    await record.view.webContents.loadURL(url)
    this.refreshState(record)
    return { ...record.state }
  }

  async goBack(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    if (record.view.webContents.navigationHistory.canGoBack()) {
      record.view.webContents.navigationHistory.goBack()
    }
    this.refreshState(record)
    return { ...record.state }
  }

  async goForward(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    if (record.view.webContents.navigationHistory.canGoForward()) {
      record.view.webContents.navigationHistory.goForward()
    }
    this.refreshState(record)
    return { ...record.state }
  }

  async reload(sessionId: string): Promise<BrowserViewState> {
    const record = this.requireRecord(sessionId)
    record.view.webContents.reload()
    this.refreshState(record)
    return { ...record.state }
  }

  setBounds(sessionId: string, bounds: BrowserBounds): void {
    const record = this.requireRecord(sessionId)
    record.view.setBounds(normalizeBounds(bounds))
  }

  close(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (!record) return
    this.records.delete(sessionId)
    if (!record.owner.isDestroyed()) {
      try {
        record.owner.contentView.removeChildView(record.view)
      } catch {
        // View may already be detached during window teardown.
      }
    }
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
    this.emit({ kind: 'closed', sessionId })
  }

  async captureAnnotation(sessionId: string, note: string): Promise<BrowserAnnotation> {
    const record = this.requireRecord(sessionId)
    const selection = await record.view.webContents.executeJavaScript(selectionScript(), true)
    const payload = normalizeSelectionPayload(selection)
    const annotationId = randomUUID()
    const screenshotPath = await captureAnnotationScreenshot(record, annotationId).catch(() => undefined)
    const annotationInput: BrowserAnnotationInput = {
      id: annotationId,
      sessionId,
      url: payload.url || record.state.url,
      title: payload.title || record.state.title,
      selector: payload.selector,
      boundingBox: payload.boundingBox,
      screenshotPath,
      note: note.trim() || payload.text || '网页批注',
      consoleErrors: record.consoleErrors,
      viewport: payload.viewport
    }
    const annotation = await saveAnnotation(annotationsRoot(), annotationInput)
    await this.injectHighlight(record, annotation).catch(() => undefined)
    this.emit({ kind: 'annotation', sessionId, annotation })
    return annotation
  }

  async listAnnotations(sessionId: string): Promise<BrowserAnnotation[]> {
    return listAnnotations(annotationsRoot(), sessionId)
  }

  private wireRecord(record: BrowserRecord): void {
    const wc = record.view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void wc.loadURL(url)
      } else {
        void shell.openExternal(url).catch(() => undefined)
      }
      return { action: 'deny' }
    })
    wc.on('did-start-loading', () => {
      record.state = { ...record.state, loading: true }
      this.publishState(record)
    })
    wc.on('did-stop-loading', () => {
      this.refreshState(record)
      this.publishState(record)
    })
    wc.on('page-title-updated', (_event, title) => {
      record.state = { ...record.state, title }
      this.publishState(record)
    })
    wc.on('did-navigate', () => {
      this.refreshState(record)
      this.publishState(record)
      void this.replayHighlights(record)
    })
    wc.on('did-navigate-in-page', () => {
      this.refreshState(record)
      this.publishState(record)
    })
    wc.on('console-message', (_event, level, message) => {
      if (level < 2) return
      record.consoleErrors.push(message)
      if (record.consoleErrors.length > MAX_CONSOLE_ERRORS) {
        record.consoleErrors = record.consoleErrors.slice(-MAX_CONSOLE_ERRORS)
      }
    })
    wc.on('render-process-gone', (_event, details) => {
      this.emit({ kind: 'error', sessionId: record.sessionId, message: `浏览器渲染进程退出:${details.reason}` })
    })
  }

  private refreshState(record: BrowserRecord): void {
    const wc = record.view.webContents
    record.state = {
      sessionId: record.sessionId,
      url: wc.getURL() || DEFAULT_URL,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  private publishState(record: BrowserRecord): void {
    this.emit({ kind: 'state', sessionId: record.sessionId, state: { ...record.state } })
  }

  private async replayHighlights(record: BrowserRecord): Promise<void> {
    const annotations = await this.listAnnotations(record.sessionId).catch(() => [])
    for (const annotation of annotations.filter((item) => item.url === record.state.url)) {
      await this.injectHighlight(record, annotation).catch(() => undefined)
    }
  }

  private async injectHighlight(record: BrowserRecord, annotation: BrowserAnnotation): Promise<void> {
    await record.view.webContents.executeJavaScript(highlightScript(annotation), true)
  }

  private requireRecord(sessionId: string): BrowserRecord {
    const record = this.records.get(sessionId)
    if (!record || record.owner.isDestroyed() || record.view.webContents.isDestroyed()) {
      throw new Error('浏览器面板尚未打开')
    }
    return record
  }

  private emit(event: BrowserEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function annotationsRoot(): string {
  return join(app.getPath('userData'), 'browser-annotations')
}

async function captureAnnotationScreenshot(
  record: BrowserRecord,
  annotationId: string
): Promise<string | undefined> {
  const bounds = record.view.getBounds()
  if (bounds.width <= 0 || bounds.height <= 0) return undefined
  const image = await record.view.webContents.capturePage()
  if (image.isEmpty()) return undefined
  const sessionDir = join(annotationsRoot(), record.sessionId)
  await mkdir(sessionDir, { recursive: true })
  const screenshotPath = join(sessionDir, `${annotationId}.png`)
  await writeFile(screenshotPath, image.toPNG())
  return screenshotPath
}

function safePartitionId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'default'
}

function normalizeNavigationUrl(rawUrl: string): string {
  const text = rawUrl.trim()
  if (!text) throw new Error('URL 不能为空')
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(text) ? text : `https://${text}`
  const url = new URL(withProtocol)
  if (!['http:', 'https:', 'file:', 'about:'].includes(url.protocol)) {
    throw new Error('浏览器只允许 http、https、file 或 about URL')
  }
  return url.href
}

function normalizeBounds(bounds: BrowserBounds): BrowserBounds {
  const x = Math.max(0, Math.round(bounds.x))
  const y = Math.max(0, Math.round(bounds.y))
  const width = Math.max(0, Math.round(bounds.width))
  const height = Math.max(0, Math.round(bounds.height))
  return { x, y, width, height }
}

function normalizeSelectionPayload(value: unknown): SelectionPayload {
  return value && typeof value === 'object' ? (value as SelectionPayload) : {}
}

function selectionScript(): string {
  return `(() => {
    const selection = window.getSelection();
    const text = selection ? String(selection.toString()).trim() : '';
    let rect;
    let selector;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const box = range.getBoundingClientRect();
      rect = { x: box.x, y: box.y, width: box.width, height: box.height };
      const node = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
      if (node && node instanceof Element) {
        selector = node.tagName.toLowerCase();
        if (node.id) selector += '#' + CSS.escape(node.id);
        else if (node.classList.length) selector += '.' + Array.from(node.classList).slice(0, 3).map((c) => CSS.escape(c)).join('.');
      }
    }
    return {
      url: location.href,
      title: document.title,
      text,
      selector,
      boundingBox: rect,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio || 1
      }
    };
  })()`
}

function highlightScript(annotation: BrowserAnnotation): string {
  const data = JSON.stringify(annotation)
  return `(() => {
    const annotation = ${data};
    const box = annotation.boundingBox;
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return false;
    const id = 'caogen-annotation-' + annotation.id;
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.position = 'fixed';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '2147483647';
      el.style.border = '2px solid #f2c94c';
      el.style.background = 'rgba(242, 201, 76, 0.18)';
      el.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.02)';
      document.documentElement.appendChild(el);
    }
    el.style.left = box.x + 'px';
    el.style.top = box.y + 'px';
    el.style.width = Math.max(1, box.width) + 'px';
    el.style.height = Math.max(1, box.height) + 'px';
    el.title = annotation.note || '';
    return true;
  })()`
}

export const browserViewManager = new BrowserViewManager()
