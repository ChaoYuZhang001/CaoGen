import { createHmac } from 'node:crypto'

export interface FeishuNotificationInput {
  title: string
  text: string
  linkUrl?: string
  atUserIds?: string[]
  atAll?: boolean
}

export type FeishuWebhookPayload =
  | {
      msg_type: 'interactive'
      card: {
        config: { wide_screen_mode: true }
        elements: Array<
          | { tag: 'div'; text: { tag: 'lark_md'; content: string } }
          | { tag: 'action'; actions: Array<{ tag: 'button'; text: { tag: 'plain_text'; content: string }; url: string; type: 'primary' }> }
        >
        header: { title: { tag: 'plain_text'; content: string } }
      }
    }
  | {
      msg_type: 'text'
      content: { text: string }
    }

export interface FeishuSendOptions {
  webhookUrl?: string
  secret?: string
  dryRun?: boolean
  timeoutMs?: number
}

export interface FeishuSendResult {
  ok: boolean
  dryRun: boolean
  sent: boolean
  payload: FeishuWebhookPayload
  status?: number
  responseText?: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

export function buildFeishuWebhookPayload(input: FeishuNotificationInput): FeishuWebhookPayload {
  const title = requiredText(input.title, 'title')
  const text = requiredText(input.text, 'text')
  const mentions = formatFeishuMentions(input)
  const content = [text, mentions].filter(Boolean).join('\n')

  if (input.linkUrl?.trim()) {
    return {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content } },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '查看详情' },
                url: input.linkUrl.trim(),
                type: 'primary'
              }
            ]
          }
        ],
        header: { title: { tag: 'plain_text', content: title } }
      }
    }
  }

  return {
    msg_type: 'text',
    content: { text: `${title}\n${content}` }
  }
}

export async function sendFeishuNotification(
  input: FeishuNotificationInput,
  options: FeishuSendOptions = {}
): Promise<FeishuSendResult> {
  const payload = buildFeishuWebhookPayload(input)
  const webhookUrl = options.webhookUrl?.trim()
  const dryRun = options.dryRun !== false || !webhookUrl

  // 默认 dry-run：没有显式 webhookUrl 时绝不触网，避免影响老用户。
  if (dryRun) return { ok: true, dryRun: true, sent: false, payload }

  const body = JSON.stringify(withFeishuSignature(payload, options.secret))
  return postJson(webhookUrl, body, payload, options.timeoutMs)
}

function withFeishuSignature(payload: FeishuWebhookPayload, secret?: string): FeishuWebhookPayload | (FeishuWebhookPayload & { timestamp: string; sign: string }) {
  if (!secret?.trim()) return payload
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const sign = createHmac('sha256', `${timestamp}\n${secret.trim()}`).update('').digest('base64')
  return { ...payload, timestamp, sign }
}

function formatFeishuMentions(input: FeishuNotificationInput): string {
  if (input.atAll) return '<at user_id="all">所有人</at>'
  const ids = input.atUserIds?.map((item) => item.trim()).filter(Boolean) ?? []
  return ids.map((id) => `<at user_id="${escapeAttribute(id)}">${escapeAttribute(id)}</at>`).join(' ')
}

async function postJson(
  webhookUrl: string,
  body: string,
  payload: FeishuWebhookPayload,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<FeishuSendResult> {
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

function requiredText(value: string, name: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${name} 不能为空`)
  return text
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
