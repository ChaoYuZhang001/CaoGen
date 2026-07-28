import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  installLocalPluginWithEffect,
  uninstallPluginWithEffect
} from '../pluginInstallEffect'

export interface PluginInstallIpcDependencies {
  pluginsRoot(): string
}

export function registerPluginInstallIpc(dependencies: PluginInstallIpcDependencies): void {
  ipcMain.handle('plugins:installLocal', async (event, sourcePath?: string, overwrite?: boolean) => {
    let selectedPath = typeof sourcePath === 'string' && sourcePath.trim() ? sourcePath : ''
    if (!selectedPath) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const picked = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0], {
        title: '选择插件目录(需含 plugin.json / SKILL.md / agent .md)',
        properties: ['openDirectory']
      })
      if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'canceled' }
      selectedPath = picked.filePaths[0]
    }
    return installLocalPluginWithEffect(
      selectedPath,
      dependencies.pluginsRoot(),
      overwrite === true
    )
  })

  ipcMain.handle('plugins:uninstall', (_event, targetPath: string) =>
    uninstallPluginWithEffect(targetPath, dependencies.pluginsRoot())
  )
}
