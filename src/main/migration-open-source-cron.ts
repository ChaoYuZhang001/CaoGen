import type { JsonObject } from './migration-scan-store'
import { sha256 } from './migration-safety'

export type OpenSourceCronDialect = 'openclaw' | 'hermes'

export interface OpenSourceCronSchedule {
  value: string
  kind: string
  supported: boolean
}

export function cronJobs(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!isObject(value)) throw new Error('migration_cron_store_invalid')
  if (!Array.isArray(value.jobs)) throw new Error('migration_cron_jobs_invalid')
  return value.jobs
}

export function cronPrompt(job: JsonObject, dialect: OpenSourceCronDialect): string | undefined {
  if (dialect === 'openclaw') {
    const payload = isObject(job.payload) ? job.payload : {}
    return firstString(payload.message, payload.text, job.message, job.prompt)
  }
  return firstString(job.prompt, job.message, job.task, isObject(job.payload) ? job.payload.message : undefined)
}

export function cronSchedule(job: JsonObject, dialect: OpenSourceCronDialect): OpenSourceCronSchedule {
  const schedule = isObject(job.schedule) ? job.schedule : {}
  const rawKind = firstString(schedule.kind, job.schedule_type, job.type)?.toLowerCase()
  const cron = firstString(schedule.expr, schedule.cron, job.cron)
  if (rawKind === 'cron' || (!rawKind && cron)) return cronExpressionSchedule(cron)
  if (rawKind === 'every' || rawKind === 'interval') {
    return cronIntervalSchedule(schedule.everyMs ?? schedule.interval ?? job.interval)
  }
  if (rawKind === 'at' || rawKind === 'once') {
    return cronOnceSchedule(firstString(schedule.at, schedule.when, job.run_at, job.at))
  }
  return { value: '@daily', kind: dialect === 'openclaw' ? 'unknown' : rawKind || 'unknown', supported: false }
}

export function isScriptJob(job: JsonObject): boolean {
  const values = [job.type, job.kind, job.job_type, job.mode].filter((value): value is string => typeof value === 'string')
  return values.some((value) => /^(?:script|no_agent|no-agent|command|shell)$/i.test(value.trim())) ||
    typeof job.command === 'string' || typeof job.script === 'string'
}

export function stableJobSeed(job: JsonObject, index: number): string {
  const externalId = firstString(job.id, job.job_id, job.uuid)
  return externalId ? sha256(externalId) : String(index)
}

function cronExpressionSchedule(value: string | undefined): OpenSourceCronSchedule {
  return validSchedule(value)
    ? { value, kind: 'cron', supported: true }
    : { value: '@daily', kind: 'cron', supported: false }
}

function cronIntervalSchedule(raw: unknown): OpenSourceCronSchedule {
  const value = intervalSchedule(raw)
  return value
    ? { value, kind: 'interval', supported: true }
    : { value: '@daily', kind: 'interval', supported: false }
}

function cronOnceSchedule(value: string | undefined): OpenSourceCronSchedule {
  return validSchedule(value)
    ? { value: `once ${value}`, kind: 'once', supported: false }
    : { value: '@daily', kind: 'once', supported: false }
}

function intervalSchedule(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const milliseconds = Math.floor(value)
    if (milliseconds % 86_400_000 === 0) return `every ${milliseconds / 86_400_000}d`
    if (milliseconds % 3_600_000 === 0) return `every ${milliseconds / 3_600_000}h`
    if (milliseconds % 60_000 === 0) return `every ${milliseconds / 60_000}m`
    if (milliseconds % 1_000 === 0) return `every ${milliseconds / 1_000}s`
    return undefined
  }
  const text = typeof value === 'string' ? value.trim() : ''
  if (/^(?:every\s+)?\d+(?:s|m|h|d)$/i.test(text) && text.length <= 40) {
    return text.toLowerCase().startsWith('every ') ? text : `every ${text}`
  }
  return undefined
}

function validSchedule(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !/[\0-\x1f\x7f]/.test(value)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
