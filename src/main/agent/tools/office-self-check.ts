import { access, lstat, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import type { OfficeSourceSnapshot } from '../../../shared/types'

export type OfficeArtifactKind = 'document' | 'spreadsheet' | 'presentation' | 'pdf'

export interface OfficeSelfCheckInput {
  workspacePath: string
  /** 期望的字节 sha256，前缀 'sha256:'；由 producer 以 source_ref 摘要注入。undefined 时跳过 digest 比对。 */
  expectedSha256?: string
  artifactKind: OfficeArtifactKind
  mediaType: string
  /** 来源材料引用（输入文档/数据表的 workspace 路径），用于可追溯 */
  sourceRefs: string[]
  /** Effect 审批时冻结的来源文件身份与内容。缺省仅兼容旧持久化 Effect。 */
  sourceSnapshots?: OfficeSourceSnapshot[]
  /** 无外部来源文件时，由调用方确认当前 Run/Effect 已提供耐久来源链。 */
  runtimeTraceable?: boolean
}

export interface OfficeSelfCheckResult {
  ok: boolean
  kind: OfficeArtifactKind
  mediaType: string
  digestMatch: boolean
  sourceTraceable: boolean
  reason?: string
}

// OOXML 部件名以明文存于 ZIP 本地文件头（不被压缩），可作为"可被对应应用打开"的廉价硬信号；
const DOCUMENT_MEDIA_TYPE_FRAGMENT = 'wordprocessingml'
const SPREADSHEET_MEDIA_TYPE_FRAGMENT = 'spreadsheetml'
const PRESENTATION_MEDIA_TYPE_FRAGMENT = 'presentationml'
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // 'PK\x03\x04'

const OOXML_PRIMARY_PARTS: Record<Exclude<OfficeArtifactKind, 'pdf'>, {
  path: string
  rootElement: RegExp
}> = {
  document: { path: 'word/document.xml', rootElement: /<(?:[A-Za-z_][\w.-]*:)?document\b/ },
  spreadsheet: { path: 'xl/workbook.xml', rootElement: /<(?:[A-Za-z_][\w.-]*:)?workbook\b/ },
  presentation: { path: 'ppt/presentation.xml', rootElement: /<(?:[A-Za-z_][\w.-]*:)?presentation\b/ }
}

/**
 * Office 成品结构/打开性/来源可追溯自校验（producer 在 T03 调用于驱动 Acceptance）。
 * 仅做"硬失败信号"：OOXML ZIP 可完整解析且 CRC/必要部件有效、kind/mediaType 一致、来源可追溯；
 * 字节完整性由 Effect 声明的 expectedSha256（producer 以 source_ref 摘要注入）二次保证。
 */
export async function runOfficeSelfCheck(input: OfficeSelfCheckInput): Promise<OfficeSelfCheckResult> {
  const base: Omit<OfficeSelfCheckResult, 'ok' | 'reason'> = {
    kind: input.artifactKind,
    mediaType: input.mediaType,
    digestMatch: false,
    sourceTraceable: false
  }

  let bytes: Buffer
  try {
    bytes = await readFile(input.workspacePath)
  } catch (error) {
    return { ...base, ok: false, reason: `无法读取 office 成品文件：${(error as Error).message}` }
  }

  const actualSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const digestMatch = input.expectedSha256 === undefined || actualSha256 === input.expectedSha256
  if (!digestMatch) {
    return { ...base, digestMatch: false, ok: false, reason: '字节 sha256 与 Effect 声明不一致（来源不可验证）' }
  }

  const mediaOk = mediaTypeMatches(input.artifactKind, input.mediaType)
  if (!mediaOk) {
    return { ...base, digestMatch, ok: false, reason: `mediaType 与 artifactKind=${input.artifactKind} 不匹配` }
  }

  // 打开性 / 结构校验：OOXML 必须包含对应部件。
  if (!await isOpenableOfficeArtifact(bytes, input.artifactKind)) {
    return {
      ...base,
      digestMatch,
      ok: false,
      reason: `${input.artifactKind} 成品结构无效，无法打开`
    }
  }

  const sourceTraceable = input.sourceRefs.length > 0
    ? await checkSourceTraceability(input.sourceRefs, input.sourceSnapshots)
    : input.runtimeTraceable === true
  if (!sourceTraceable) {
    return {
      ...base,
      digestMatch,
      sourceTraceable,
      ok: false,
      reason:
        input.sourceRefs.length === 0
          ? '无来源材料引用且缺少 Run/Effect 来源链，来源不可追溯'
          : '部分来源材料引用不存在，来源不可追溯'
    }
  }

  return { ...base, digestMatch, sourceTraceable, ok: true }
}

function mediaTypeMatches(kind: OfficeArtifactKind, mediaType: string): boolean {
  if (kind === 'document') return mediaType.includes(DOCUMENT_MEDIA_TYPE_FRAGMENT)
  if (kind === 'spreadsheet') return mediaType.includes(SPREADSHEET_MEDIA_TYPE_FRAGMENT)
  if (kind === 'presentation') return mediaType.includes(PRESENTATION_MEDIA_TYPE_FRAGMENT)
  return mediaType === 'application/pdf'
}

async function isOpenableOfficeArtifact(bytes: Buffer, kind: OfficeArtifactKind): Promise<boolean> {
  if (kind === 'pdf') return isOpenablePdf(bytes)
  return isOpenableOoxml(bytes, kind)
}

function isOpenablePdf(bytes: Buffer): boolean {
  if (bytes.length < 8 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return false
  return bytes.subarray(Math.max(0, bytes.length - 1_024)).includes(Buffer.from('%%EOF', 'ascii'))
}

async function isOpenableOoxml(
  bytes: Buffer,
  kind: Exclude<OfficeArtifactKind, 'pdf'>
): Promise<boolean> {
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(ZIP_LOCAL_HEADER)) return false
  try {
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true })
    const commonParts = [
      { path: '[Content_Types].xml', rootElement: /<(?:[A-Za-z_][\w.-]*:)?Types\b/ },
      { path: '_rels/.rels', rootElement: /<(?:[A-Za-z_][\w.-]*:)?Relationships\b/ }
    ]
    for (const requirement of [...commonParts, OOXML_PRIMARY_PARTS[kind]]) {
      const part = archive.file(requirement.path)
      if (!part || !requirement.rootElement.test(await part.async('string'))) return false
    }
    return true
  } catch {
    return false
  }
}

async function checkSourceTraceability(
  sourceRefs: string[],
  snapshots: OfficeSourceSnapshot[] | undefined
): Promise<boolean> {
  if (sourceRefs.length === 0) return false
  if (snapshots && (snapshots.length !== sourceRefs.length || snapshots.some(
    (snapshot, index) => snapshot.path !== sourceRefs[index]
  ))) return false
  for (let index = 0; index < sourceRefs.length; index += 1) {
    const ref = sourceRefs[index]
    try {
      if (!snapshots) {
        await access(ref)
        continue
      }
      const snapshot = snapshots[index]
      const state = await lstat(ref, { bigint: true })
      if (!state.isFile() || state.dev.toString() !== snapshot.identity.device ||
          state.ino.toString() !== snapshot.identity.inode) return false
      const bytes = await readFile(ref)
      if (bytes.byteLength !== snapshot.bytes ||
          `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== snapshot.sha256) return false
    } catch {
      return false
    }
  }
  return true
}
