import { AUTO_MODEL, type SessionMeta } from '../../shared/types'

export function effectiveSessionModel(meta: SessionMeta, resolvedModel?: string): string {
  return meta.model && meta.model !== AUTO_MODEL ? meta.model : resolvedModel || ''
}

export function redactKnownCredentials(value: string, tokens: Iterable<string>): string {
  let redacted = value
  for (const token of tokens) {
    if (token) redacted = redacted.split(token).join('[REDACTED]')
  }
  return redacted
}
