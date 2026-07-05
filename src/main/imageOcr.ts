import { execFile } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 图片 OCR(P4.2 补全):按可用引擎逐级降级,绝不伪造结果。
 * 1) macOS:系统 Vision 框架(经 osascript ObjC 桥,无需安装任何东西)
 * 2) 任意平台:tesseract(若在 PATH 上)
 * 3) 都没有:如实返回 unavailable,由调用方提示"交给视觉模型直接看图"
 */

export interface OcrResult {
  ok: boolean
  text?: string
  engine?: 'vision' | 'tesseract'
  error?: string
}

const OCR_TIMEOUT_MS = 30_000
const MAX_TEXT = 8_000

export async function ocrImage(imagePath: string): Promise<OcrResult> {
  if (process.platform === 'darwin') {
    const vision = await tryVision(imagePath)
    if (vision.ok || vision.error !== 'unavailable') return vision
  }
  const tess = await tryTesseract(imagePath)
  if (tess.ok || tess.error !== 'unavailable') return tess
  return {
    ok: false,
    error: '本机无可用 OCR 引擎(macOS Vision 不可用且未安装 tesseract);建议直接把图片发给支持视觉的模型。'
  }
}

/** macOS Vision OCR:osascript AppleScript-ObjC 桥,识别中英混排 */
async function tryVision(imagePath: string): Promise<OcrResult> {
  const script = `
use framework "Vision"
use framework "Foundation"
on run argv
  set imagePath to item 1 of argv
  set url to current application's NSURL's fileURLWithPath:imagePath
  set request to current application's VNRecognizeTextRequest's alloc()'s init()
  request's setRecognitionLevel:(current application's VNRequestTextRecognitionLevelAccurate)
  request's setRecognitionLanguages:{"zh-Hans", "zh-Hant", "en-US"}
  set reqHandler to current application's VNImageRequestHandler's alloc()'s initWithURL:url options:(current application's NSDictionary's dictionary())
  set ok to reqHandler's performRequests:{request} |error|:(missing value)
  if ok as boolean is false then return ""
  set resultsList to request's results()
  set out to {}
  repeat with observation in resultsList
    set candidate to (observation's topCandidates:1)'s firstObject()
    if candidate is not missing value then set end of out to (candidate's |string|() as text)
  end repeat
  set text item delimiters to linefeed
  return out as text
end run`
  const scriptPath = join(tmpdir(), `caogen-ocr-${randomUUID()}.applescript`)
  try {
    await writeFile(scriptPath, script, 'utf8')
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        'osascript',
        [scriptPath, imagePath],
        { timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? '')))
      )
    })
    const clean = text.trim().slice(0, MAX_TEXT)
    if (!clean) return { ok: false, engine: 'vision', error: '未识别到文字' }
    return { ok: true, engine: 'vision', text: clean }
  } catch (err) {
    // osascript 本身失败(权限/沙箱/老系统)→ 视作引擎不可用,继续降级
    const message = err instanceof Error ? err.message : String(err)
    if (/not allowed|不允许|permission/i.test(message)) return { ok: false, error: message }
    return { ok: false, error: 'unavailable' }
  } finally {
    void unlink(scriptPath).catch(() => undefined)
  }
}

async function tryTesseract(imagePath: string): Promise<OcrResult> {
  const exists = await new Promise<boolean>((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', ['tesseract'], { timeout: 3000 }, (err) =>
      resolve(!err)
    )
  })
  if (!exists) return { ok: false, error: 'unavailable' }
  try {
    const text = await new Promise<string>((resolve, reject) => {
      execFile(
        'tesseract',
        [imagePath, 'stdout', '-l', 'chi_sim+eng'],
        { timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            // 中文语言包缺失时退回英文
            execFile(
              'tesseract',
              [imagePath, 'stdout'],
              { timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
              (err2, stdout2) => (err2 ? reject(err2) : resolve(String(stdout2 ?? '')))
            )
          } else {
            resolve(String(stdout ?? ''))
          }
        }
      )
    })
    const clean = text.trim().slice(0, MAX_TEXT)
    if (!clean) return { ok: false, engine: 'tesseract', error: '未识别到文字' }
    return { ok: true, engine: 'tesseract', text: clean }
  } catch (err) {
    return { ok: false, engine: 'tesseract', error: err instanceof Error ? err.message : String(err) }
  }
}
