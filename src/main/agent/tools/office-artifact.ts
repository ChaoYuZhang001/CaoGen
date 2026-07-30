import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { Document, HeadingLevel, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import type { EffectTarget, FileSystemIdentity } from '../../../shared/types'
import { resolveExistingProjectPath, resolveWritableProjectPath } from '../../utils/safe-project-path'
import {
  confirmed,
  notApplied,
  unresolved,
  type EffectReconciliationResult
} from '../../task/effect-reconciliation-result'
import { stableValueDigest } from '../../task/tool-idempotency'
import { runOfficeSelfCheck } from './office-self-check'

export const CREATE_DOCUMENT_TOOL = 'create_document'
export const CREATE_SPREADSHEET_TOOL = 'create_spreadsheet'
// 备注：presentation / pdf 两种 artifactKind 属 P1（T06）范围，本 stick 不实现其生成器，
// 故以下常量仅作为惰性导出保留以兼容现有工具注册代码，实际生成/校验仅限 document | spreadsheet。
export const CREATE_PRESENTATION_TOOL = 'create_presentation'
export const CREATE_PDF_TOOL = 'create_pdf'
export const OFFICE_ARTIFACT_TOOLS = new Set([
  CREATE_DOCUMENT_TOOL,
  CREATE_SPREADSHEET_TOOL
])

export type OfficeArtifactToolName =
  | typeof CREATE_DOCUMENT_TOOL
  | typeof CREATE_SPREADSHEET_TOOL
export type OfficeArtifactKind = 'document' | 'spreadsheet'
export type OfficeScalar = string | number | boolean
export type OfficeCellValue = OfficeScalar | { formula: string; result?: OfficeScalar }

export const DOCUMENT_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const SPREADSHEET_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface OfficeDocumentSpec {
  artifactKind: 'document'
  headings: string[]
  paragraphs: string[]
}

export interface OfficeSpreadsheetSpec {
  artifactKind: 'spreadsheet'
  sheets: Array<{ name: string; rows: OfficeCellValue[][] }>
}

export type OfficeArtifactSpec = OfficeDocumentSpec | OfficeSpreadsheetSpec

export interface OfficeArtifactPlan {
  title: string
  workspacePath: string
  rootPath: string
  rootIdentity: FileSystemIdentity
  relativePath: string
  sourceRefs: string[]
  spec: OfficeArtifactSpec
  specDigest: string
  mediaType: string
}

export interface GeneratedOfficeArtifact {
  path: string
  sha256: string
  bytes: number
  mediaType: string
  artifactKind: OfficeArtifactKind
  title: string
  sourceRefs: string[]
}

export function isOfficeArtifactTool(name: string): boolean {
  return OFFICE_ARTIFACT_TOOLS.has(name)
}

/** Build the immutable Effect target before permission is requested. */
export async function buildOfficeArtifactEffectTarget(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): Promise<Extract<EffectTarget, { kind: 'office_artifact' }>> {
  const plan = await planOfficeArtifact(toolName, input, cwd)
  const state = await lstat(plan.workspacePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (state) throw new Error(`Office 输出文件已存在，禁止覆盖历史 Artifact: ${plan.relativePath}`)
  return {
    kind: 'office_artifact',
    artifactKind: plan.spec.artifactKind,
    rootPath: plan.rootPath,
    rootIdentity: plan.rootIdentity,
    relativePath: plan.relativePath,
    workspacePath: plan.workspacePath,
    specDigest: plan.specDigest,
    mediaType: plan.mediaType,
    sourceRefs: plan.sourceRefs,
    title: plan.title
  }
}

/** Execute only after NativeToolRuntime has crossed the durable Effect barrier. */
export async function executeOfficeArtifactTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  target: EffectTarget | undefined,
  signal?: AbortSignal
): Promise<GeneratedOfficeArtifact> {
  if (!target || target.kind !== 'office_artifact') {
    throw new Error('Office 生成缺少已冻结的 Effect target')
  }
  const plan = await planOfficeArtifact(toolName, input, cwd)
  assertOfficePlanMatchesTarget(plan, target)
  assertRootIdentity(plan.rootPath, target.rootIdentity)
  if (signal?.aborted) throw new Error('Office 生成已中断，文件尚未写入')

  const bytes = await generateOfficeArtifactBytes(plan.title, plan.spec)
  if (signal?.aborted) throw new Error('Office 生成已中断，文件尚未写入')

  await mkdir(dirname(plan.workspacePath), { recursive: true, mode: 0o700 })
  const refreshed = await resolveWritableProjectPath(cwd, plan.workspacePath)
  if (refreshed.root !== target.rootPath || refreshed.relativePath !== target.relativePath) {
    throw new Error('Office 输出目录在审批后发生变化')
  }
  assertRootIdentity(refreshed.root, target.rootIdentity)

  const handle = await open(refreshed.fullPath, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(refreshed.fullPath, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  return {
    path: refreshed.fullPath,
    sha256,
    bytes: bytes.byteLength,
    mediaType: plan.mediaType,
    artifactKind: plan.spec.artifactKind,
    title: plan.title,
    sourceRefs: plan.sourceRefs
  }
}

export async function reconcileOfficeArtifactEffectTarget(
  target: Extract<EffectTarget, { kind: 'office_artifact' }>
): Promise<EffectReconciliationResult> {
  try {
    assertRootIdentity(target.rootPath, target.rootIdentity)
    const resolved = await resolveWritableProjectPath(target.rootPath, target.workspacePath)
    if (resolved.root !== target.rootPath || resolved.relativePath !== target.relativePath ||
        resolved.fullPath !== target.workspacePath) {
      return unresolved({ kind: target.kind, reason: 'Office 输出路径已脱离审批时冻结的 Project 位置' })
    }
  } catch (error) {
    return unresolved({
      kind: target.kind,
      reason: error instanceof Error ? error.message : String(error)
    })
  }
  const state = await lstat(target.workspacePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!state) {
    return notApplied(
      { kind: target.kind, workspacePath: target.workspacePath, state: 'absent' },
      'Office 输出文件不存在'
    )
  }
  if (state.isSymbolicLink() || !state.isFile()) {
    return unresolved({ kind: target.kind, reason: 'Office 输出路径不是普通文件' })
  }
  const selfCheck = await runOfficeSelfCheck({
    workspacePath: target.workspacePath,
    artifactKind: target.artifactKind,
    mediaType: target.mediaType,
    sourceRefs: target.sourceRefs,
    runtimeTraceable: true
  })
  if (!selfCheck.ok) {
    return unresolved({ kind: target.kind, selfCheck, reason: selfCheck.reason ?? 'Office 输出无法验证' })
  }
  const bytes = await readFile(target.workspacePath)
  return confirmed({
    kind: target.kind,
    workspacePath: target.workspacePath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    selfCheck
  }, 'Office 输出文件存在且结构、类型与来源校验通过')
}

async function planOfficeArtifact(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): Promise<OfficeArtifactPlan> {
  if (!isOfficeArtifactTool(toolName)) throw new Error(`未知 Office 工具: ${toolName}`)
  const title = requiredText(input.title, 'title', 240)
  const output = await resolveWritableProjectPath(cwd, requiredText(input.path, 'path', 1_024))
  const artifactKind = officeArtifactKind(toolName)
  assertExtension(output.fullPath, artifactKind)
  const sourceRefs = await canonicalSourceRefs(cwd, input.source_refs)
  const spec = artifactKind === 'document'
    ? normalizeDocumentSpec(input)
    : normalizeSpreadsheetSpec(input)
  return {
    title,
    workspacePath: output.fullPath,
    rootPath: output.root,
    rootIdentity: fileSystemIdentity(output.root),
    relativePath: output.relativePath,
    sourceRefs,
    spec,
    specDigest: stableValueDigest({ title, spec }),
    mediaType: officeMediaType(artifactKind)
  }
}

function normalizeDocumentSpec(input: Record<string, unknown>): OfficeDocumentSpec {
  return {
    artifactKind: 'document',
    headings: optionalStringArray(input.headings, 'headings', 200),
    paragraphs: optionalStringArray(input.paragraphs, 'paragraphs', 5_000)
  }
}

function normalizeSpreadsheetSpec(input: Record<string, unknown>): OfficeSpreadsheetSpec {
  if (!Array.isArray(input.sheets) || input.sheets.length === 0 || input.sheets.length > 100) {
    throw new Error('sheets 必须是 1 到 100 个工作表的数组')
  }
  let cellCount = 0
  const sheets = input.sheets.map((candidate, sheetIndex) => {
    const sheet = requiredRecord(candidate, `sheets[${sheetIndex}]`)
    const name = requiredText(sheet.name ?? `Sheet${sheetIndex + 1}`, `sheets[${sheetIndex}].name`, 31)
    if (!Array.isArray(sheet.rows) || sheet.rows.length > 50_000) {
      throw new Error(`sheets[${sheetIndex}].rows 必须是最多 50000 行的数组`)
    }
    const rows = sheet.rows.map((candidateRow, rowIndex) => {
      if (!Array.isArray(candidateRow) || candidateRow.length > 16_384) {
        throw new Error(`sheets[${sheetIndex}].rows[${rowIndex}] 不是有效行`)
      }
      cellCount += candidateRow.length
      if (cellCount > 500_000) throw new Error('工作簿最多允许 500000 个单元格')
      return candidateRow.map((value, columnIndex) =>
        normalizeCellValue(value, `sheets[${sheetIndex}].rows[${rowIndex}][${columnIndex}]`))
    })
    return { name, rows }
  })
  return { artifactKind: 'spreadsheet', sheets }
}

function normalizeCellValue(value: unknown, label: string): OfficeCellValue {
  if (typeof value === 'string') return requiredText(value, label, 100_000, true)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  const record = requiredRecord(value, label)
  const formula = requiredText(record.formula, `${label}.formula`, 8_192)
  const result = record.result
  if (result === undefined) return { formula }
  if (typeof result === 'string') return { formula, result: requiredText(result, `${label}.result`, 100_000, true) }
  if ((typeof result === 'number' && Number.isFinite(result)) || typeof result === 'boolean') {
    return { formula, result: result as number | boolean }
  }
  throw new Error(`${label}.result 必须是字符串、数字或布尔值`)
}

async function canonicalSourceRefs(cwd: string, value: unknown): Promise<string[]> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200) throw new Error('source_refs 必须是最多 200 项的路径数组')
  const refs: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const source = await resolveExistingProjectPath(cwd, requiredText(value[index], `source_refs[${index}]`, 1_024))
    refs.push(source.fullPath)
  }
  return [...new Set(refs)]
}

async function generateDocumentBytes(title: string, spec: OfficeDocumentSpec): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })]
  for (const heading of spec.headings) {
    children.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }))
  }
  for (const paragraph of spec.paragraphs) children.push(new Paragraph({ text: paragraph }))
  return Packer.toBuffer(new Document({ sections: [{ children }] }))
}

async function generateSpreadsheetBytes(spec: OfficeSpreadsheetSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'CaoGen'
  for (const sheet of spec.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name)
    for (const row of sheet.rows) worksheet.addRow(row)
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function generateOfficeArtifactBytes(title: string, spec: OfficeArtifactSpec): Promise<Buffer> {
  if (spec.artifactKind === 'document') return generateDocumentBytes(title, spec)
  return generateSpreadsheetBytes(spec)
}

function assertOfficePlanMatchesTarget(
  plan: OfficeArtifactPlan,
  target: Extract<EffectTarget, { kind: 'office_artifact' }>
): void {
  if (plan.spec.artifactKind !== target.artifactKind || plan.workspacePath !== target.workspacePath ||
      plan.rootPath !== target.rootPath || plan.relativePath !== target.relativePath ||
      plan.specDigest !== target.specDigest || plan.mediaType !== target.mediaType ||
      plan.title !== target.title || stableValueDigest(plan.sourceRefs) !== stableValueDigest(target.sourceRefs)) {
    throw new Error('Office 工具输入与已批准 Effect target 不一致')
  }
}

function assertRootIdentity(rootPath: string, expected: FileSystemIdentity): void {
  const actual = fileSystemIdentity(rootPath)
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error('Office 项目根目录身份在审批后发生变化')
  }
}

function fileSystemIdentity(path: string): FileSystemIdentity {
  const info = statSync(path, { bigint: true })
  return {
    device: info.dev.toString(),
    inode: info.ino.toString()
  }
}

function assertExtension(path: string, kind: OfficeArtifactKind): void {
  const expected = kind === 'document' ? '.docx' : '.xlsx'
  if (extname(path).toLowerCase() !== expected) throw new Error(`Office 输出路径必须以 ${expected} 结尾`)
}

function officeArtifactKind(toolName: string): OfficeArtifactKind {
  if (toolName === CREATE_DOCUMENT_TOOL) return 'document'
  if (toolName === CREATE_SPREADSHEET_TOOL) return 'spreadsheet'
  throw new Error(`未知 Office 工具: ${toolName}`)
}

function officeMediaType(kind: OfficeArtifactKind): string {
  return kind === 'document' ? DOCUMENT_MEDIA_TYPE : SPREADSHEET_MEDIA_TYPE
}

function optionalStringArray(value: unknown, label: string, maxItems: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} 必须是最多 ${maxItems} 项的字符串数组`)
  return value.map((candidate, index) => requiredText(candidate, `${label}[${index}]`, 100_000, true))
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false
): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  if (value.length > maxLength || /[\0\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} 无效`)
  }
  const clean = value.trim()
  if (!allowEmpty && !clean) throw new Error(`${label} 不能为空`)
  return allowEmpty ? value : clean
}

function optionalText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined) return ''
  return requiredText(value, label, maxLength, true).trim()
}

// 注：presentation / pdf 两种 artifactKind 属于 P1（T06）范围，本 stick 仅交付
// document + spreadsheet（见架构 §3.1 与 effect-types office_artifact 分支）。
// 相关工具、规格归一化与生成器（pptxgenjs / pdfkit / @fontsource）留待后续 stick。
