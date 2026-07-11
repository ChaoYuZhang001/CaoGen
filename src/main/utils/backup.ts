import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises'
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
  await mkdir(backupDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupDir, `${stamp}_${randomUUID().slice(0, 8)}_${basename(filePath)}`)
  if (frozenContent === undefined) await copyFile(filePath, backupPath)
  else await writeFile(backupPath, frozenContent)

  return { backupPath }
}
