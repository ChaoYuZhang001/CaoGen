import { createHmac } from 'node:crypto'

export interface DingTalkNotificationInput {
  title: string
  text: string
  linkUrl?: string
  atMobiles?: string[]
  atUserIds?: string[]
  atAll?: boolean
}

export type DingTalkWebhookPayload =
  | {
      msgtype: 'markdown'
      markdown: { title: string; text: string }
      at?: DingTalkAt
    }
  | {
      msgtype: 'link'
      link: { title: string; text: string; messageUrl: string; picUrl?: string }
      at?: DingTalkAt
    }

export interface DingTalkAt {
  atMobiles?: string[]
  atUserIds?: string[]
  isAtAll?: boolean
}

export interface DingTalkSendOptions {
  webhookUrl?: string
  secret?: string
  dryRun?: boolean
  timeoutMs?: number
}

export interface DingTalkSendResult {
  ok: boolean
  dryRun: boolean
  sent: boolean
  payload: DingTalkWebhookPayload
  signedUrl?: string
  status?: number
  responseText?: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

export function buildDingTalkWebhookPayload(input: DingTalkNotificationInput): DingTalkWebhookPayload {
  const title = requiredText(input.title, 'title')
  const text = requiredText(input.text, 'text')
  const at = buildAt(input)
  const linkUrl = input.linkUrl?.trim()

  if (linkUrl) {
    return compactPayload({
      msgtype: 'link',
      link: { title, text, messageUrl: linkUrl },
      at
    })
  }

  return compactPayload({
    msgtype: 'markdown',
    markdown: { title, text: `### ${title}\n\n${text}` },
    at
  })
}

export async function sendDingTalkNotification(
  input: DingTalkNotificationInput,
  options: DingTalkSendOptions = {}
): Promise<DingTalkSendResult> {
  const payload = buildDingTalkWebhookPayload(input)
  const webhookUrl = options.webhookUrl?.trim()
  const dryRun = options.dryRun !== false || !webhookUrl
  const signedUrl = webhookUrl ? withDingTalkSignature(webhookUrl, options.secret) : undefined

  // 默认 dry-run：必须 dryRun:false 且传入 webhookUrl 才会发送。
  if (dryRun || !signedUrl) return { ok: true, dryRun: true, sent: false, payload, signedUrl }

  return postJson(signedUrl, JSON.stringify(payload), payload, options.timeoutMs)
}

function buildAt(input: DingTalkNotificationInput): DingTalkAt | undefined {
  const atMobiles = uniqueTrimmed(input.atMobiles)
  const atUserIds = uniqueTrimmed(input.atUserIds)
  if (!input.atAll && atMobiles.length === 0 && atUserIds.length === 0) return undefined
  return {
    ...(atMobiles.length > 0 ? { atMobiles } : {}),
    ...(atUserIds.length > 0 ? { atUserIds } : {}),
    ...(input.atAll ? { isAtAll: true } : {})
  }
}

function compactPayload(payload: DingTalkWebhookPayload): DingTalkWebhookPayload {
  if (payload.at) return payload
  const { at: _unused, ...rest } = payload
  return rest
}

function withDingTalkSignature(webhookUrl: string, secret?: string): string {
  if (!secret?.trim()) return webhookUrl
  const timestamp = Date.now().toString()
  const sign = createHmac('sha256', secret.trim()).update(`${timestamp}\n${secret.trim()}`).digest('base64')
  const url = new URL(webhookUrl)
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('sign', sign)
  return url.toString()
}

async function postJson(
  signedUrl: string,
  body: string,
  payload: DingTalkWebhookPayload,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<DingTalkSendResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(signedUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body,
      signal: controller.signal
    })
    const responseText = await response.text()
    return { ok: response.ok, dryRun: false, sent: true, payload, signedUrl, status: response.status, responseText }
  } catch (error) {
    return { ok: false, dryRun: false, sent: false, payload, signedUrl, error: error instanceof Error ? error.message : String(error) }
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
