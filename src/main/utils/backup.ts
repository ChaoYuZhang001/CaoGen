import { randomUUID } from 'node:crypto'
import { access, chmod, copyFile, mkdir, open, rename, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, join } from 'node:path'

export interface FileBackupResult {
  backupPath: string
}

/** 为即将修改的文件创建一次性备份,备份目录固定在项目 .caogen 下。 */
export async function createFileBackup(
  projectRoot: string,
  filePath: string,
  frozenContent?: string | Buffer
): Promise<FileBackupResult> {
  if (frozenContent === undefined) await access(filePath, constants.R_OK)
  const backupDir = join(projectRoot, '.caogen', 'tmp', 'backup')
  await mkdir(backupDir, { recursive: true, mode: 0o700 })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const identity = randomUUID()
  const backupPath = join(backupDir, `${stamp}_${identity}_${basename(filePath)}`)
  const temporary = join(backupDir, `.backup.${process.pid}.${identity}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (frozenContent === undefined) {
      await copyFile(filePath, temporary, constants.COPYFILE_EXCL)
      await chmod(temporary, 0o600)
      handle = await open(temporary, 'r')
    } else {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(frozenContent)
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, backupPath)
    await syncBackupDirectory(backupDir)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }

  return { backupPath }
}

async function syncBackupDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
