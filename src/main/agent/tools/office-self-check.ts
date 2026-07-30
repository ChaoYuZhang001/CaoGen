import { access, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

export type OfficeArtifactKind = 'document' | 'spreadsheet'

export interface OfficeSelfCheckInput {
  workspacePath: string
  /** 期望的字节 sha256，前缀 'sha256:'；由 producer 以 source_ref 摘要注入。undefined 时跳过 digest 比对。 */
  expectedSha256?: string
  artifactKind: OfficeArtifactKind
  mediaType: string
  /** 来源材料引用（输入文档/数据表的 workspace 路径），用于可追溯 */
  sourceRefs: string[]
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
// media type 字符串本身位于压缩 XML 内，故改用部件名判定。
const DOCUMENT_MEDIA_TYPE_FRAGMENT = 'wordprocessingml'
const SPREADSHEET_MEDIA_TYPE_FRAGMENT = 'spreadsheetml'
const DOCUMENT_PART_MARKER = 'word/document.xml'
const SPREADSHEET_PART_MARKER = 'xl/workbook.xml'
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // 'PK\x03\x04'
const OOXML_PART_SCAN_LIMIT = 1 * 1024 * 1024

/**
 * Office 成品结构/打开性/来源可追溯自校验（producer 在 T03 调用于驱动 Acceptance）。
 * 仅做"硬失败信号"：OOXML(ZIP) 容器可被对应应用打开、kind/mediaType 一致、来源可追溯；
 * 字节完整性由 Effect 声明的 expectedSha256（producer 以 source_ref 摘要注入）二次保证。
 * 不依赖 ExcelJS/Docx 完整 DOM 解析，保持自校验轻量且环境无关。
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
  if (!isOpenableOfficeArtifact(bytes, input.artifactKind)) {
    return {
      ...base,
      digestMatch,
      ok: false,
      reason: `${input.artifactKind} 成品结构无效，无法打开`
    }
  }

  const sourceTraceable = input.sourceRefs.length > 0
    ? await checkSourceTraceability(input.sourceRefs)
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
  return mediaType.includes(SPREADSHEET_MEDIA_TYPE_FRAGMENT)
}

function isOpenableOfficeArtifact(bytes: Buffer, kind: OfficeArtifactKind): boolean {
  const partMarker = kind === 'document' ? DOCUMENT_PART_MARKER : SPREADSHEET_PART_MARKER
  return isOpenableOoxml(bytes, partMarker)
}

function isOpenableOoxml(bytes: Buffer, partMarker: string): boolean {
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(ZIP_LOCAL_HEADER)) return false
  const scan = bytes.subarray(0, Math.min(bytes.length, OOXML_PART_SCAN_LIMIT))
  return scan.includes(Buffer.from(partMarker, 'utf8'))
}

async function checkSourceTraceability(sourceRefs: string[]): Promise<boolean> {
  if (sourceRefs.length === 0) return false
  for (const ref of sourceRefs) {
    try {
      await access(ref)
    } catch {
      return false
    }
  }
  return true
}
