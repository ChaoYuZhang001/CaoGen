export interface WeComNotificationInput {
  title: string
  text: string
  linkUrl?: string
  mentionedList?: string[]
  mentionedMobileList?: string[]
  atAll?: boolean
}

export type WeComWebhookPayload =
  | {
      msgtype: 'markdown'
      markdown: { content: string }
    }
  | {
      msgtype: 'news'
      news: { articles: Array<{ title: string; description: string; url: string }> }
    }

export interface WeComSendOptions {
  webhookUrl?: string
  dryRun?: boolean
  timeoutMs?: number
}

export interface WeComSendResult {
  ok: boolean
  dryRun: boolean
  sent: boolean
  payload: WeComWebhookPayload
  status?: number
  responseText?: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

export function buildWeComWebhookPayload(input: WeComNotificationInput): WeComWebhookPayload {
  const title = requiredText(input.title, 'title')
  const text = requiredText(input.text, 'text')
  const linkUrl = input.linkUrl?.trim()

  if (linkUrl) {
    return {
      msgtype: 'news',
      news: { articles: [{ title, description: withMentions(text, input), url: linkUrl }] }
    }
  }

  return {
    msgtype: 'markdown',
    markdown: { content: `### ${title}\n${withMentions(text, input)}` }
  }
}

export async function sendWeComNotification(
  input: WeComNotificationInput,
  options: WeComSendOptions = {}
): Promise<WeComSendResult> {
  const payload = buildWeComWebhookPayload(input)
  const webhookUrl = options.webhookUrl?.trim()
  const dryRun = options.dryRun !== false || !webhookUrl

  // 默认 dry-run：企业微信机器人只有显式 URL 才能触发外部请求。
  if (dryRun) return { ok: true, dryRun: true, sent: false, payload }

  return postJson(webhookUrl, JSON.stringify(payload), payload, options.timeoutMs)
}

function withMentions(text: string, input: WeComNotificationInput): string {
  const users = input.atAll ? ['@all'] : uniqueTrimmed(input.mentionedList).map((item) => `<@${item}>`)
  const mobiles = uniqueTrimmed(input.mentionedMobileList).map((item) => `<@${item}>`)
  return [text, [...users, ...mobiles].join(' ')].filter(Boolean).join('\n')
}

async function postJson(
  webhookUrl: string,
  body: string,
  payload: WeComWebhookPayload,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<WeComSendResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
      signal: controller.signal
    })
    const responseText = await response.text()
    return { ok: response.ok, dryRun: false, sent: true, payload, status: response.status, responseText }
  } catch (error) {
    return { ok: false, dryRun: false, sent: false, payload, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

function uniqueTrimmed(values?: string[]): string[] {
  return [...new Set(values?.map((item) => item.trim()).filter(Boolean) ?? [])]
}

function requiredText(value: string, name: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${name} 不能为空`)
  return text
}
