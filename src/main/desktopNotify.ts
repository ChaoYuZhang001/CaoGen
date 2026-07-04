import { app, BrowserWindow, Notification } from 'electron'

function truncate(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function focusAnyWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  if (process.platform === 'darwin') {
    app.focus({ steal: true })
  } else {
    app.focus()
  }
}

export function showDesktopNotification(input: {
  title: string
  body: string
  sessionId: string
}): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: input.title,
    body: truncate(input.body),
    silent: false
  })
  notification.once('click', () => {
    focusAnyWindow()
  })
  notification.show()
}
