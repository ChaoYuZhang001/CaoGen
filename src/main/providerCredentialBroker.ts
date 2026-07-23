export interface CredentialCryptoBackend {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

export interface ProviderCredentialRef {
  providerId: string
  keyId: string
}

export interface ProviderCredentialRecord {
  encryptedToken: string
  sessionOnly?: boolean
}

export type CredentialStorageState =
  | 'encrypted'
  | 'session'
  | 'legacy-b64'
  | 'unavailable'
  | 'missing'

export interface ProviderCredentialResolution {
  token: string
  storage: CredentialStorageState
  available: boolean
}

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token'
])

const SENSITIVE_CREDENTIAL_NAME_PART =
  /(?:^|[-_])(?:api[-_]?key|apikey|auth|authcode|authentication|authorization|client[-_]?key|credential|hmac|key|password|private|secret|sig|sign|signature|subscription|token|access[-_]?key)(?:$|[-_])/i
const SENSITIVE_CREDENTIAL_COMPACT_PART =
  /apikey|apisecret|apisign|authcode|authkey|authtoken|bearertoken|clientkey|clientsecret|credential|hmac|password|privatekey|secret|signature|subscriptionkey|accesstoken|accesskey/
const SAFE_CUSTOM_HEADER_NAMES = new Set([
  'accept',
  'accept-encoding',
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'http-referer',
  'openai-organization',
  'openai-project',
  'referer',
  'user-agent',
  'x-rapidapi-host',
  'x-title'
])
const SAFE_CUSTOM_HEADER_NAME_PATTERN =
  /^(?:(?:x-)?(?:account|channel|correlation|debug|deployment|endpoint|experiment|feature|gateway|meta|metadata|model|org|organization|project|provider|region|request|route|routing|source|tag|tenant|trace|vendor|version|workspace)(?:-|$)|helicone-property-)/i
const ALLOWED_MANAGED_CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'api-key',
  'apikey',
  'api_key',
  'x-api-key',
  'x-api_key',
  'x-api-token',
  'x-auth-key',
  'x-auth-token',
  'x-access-token',
  'x-goog-api-key',
  'x-rapidapi-key',
  'ocp-apim-subscription-key'
])
const CREDENTIAL_VALUE_MARKER =
  /(?:^|[^A-Za-z0-9])(?:(?:basic|bearer)\s+|sk[-_]|gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-|AIza|ya29\.|(?:AKIA|ASIA)[A-Z0-9]{12,}|eyJ)/i
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const FORBIDDEN_HEADER_VALUE_CHARACTERS = /[\0-\x08\x0A-\x1F\x7F]/

export type ProviderCredentialSessionSnapshot = Array<[keyId: string, token: string]>

export class ProviderCredentialBroker {
  private readonly sessionTokens = new Map<string, Map<string, string>>()

  constructor(private readonly backend: CredentialCryptoBackend) {}

  canPersistSecurely(): boolean {
    try {
      if (!this.backend.isEncryptionAvailable()) return false
      const selectedBackend = this.backend.getSelectedStorageBackend?.()
      return selectedBackend?.trim().toLowerCase() !== 'basic_text'
    } catch {
      return false
    }
  }

  store(ref: ProviderCredentialRef, token: string): ProviderCredentialRecord {
    if (!isValidProviderCredentialToken(token)) {
      throw new Error('Credential token must be non-empty and must not contain ASCII control characters')
    }
    if (this.canPersistSecurely()) {
      try {
        const encrypted = this.backend.encryptString(token)
        if (!Buffer.isBuffer(encrypted)) throw new Error('Credential encryption returned a non-buffer')
        this.forget(ref)
        return { encryptedToken: `enc:${encrypted.toString('base64')}` }
      } catch {
        // A backend can report itself available and still fail at write time.
        // Keep the new credential in this process instead of writing reversible data.
      }
    }

    this.setSessionToken(ref, token)
    return { encryptedToken: '', sessionOnly: true }
  }

  resolve(
    ref: ProviderCredentialRef,
    record: ProviderCredentialRecord
  ): ProviderCredentialResolution {
    if (record.sessionOnly) {
      const sessionToken = this.getSessionToken(ref)
      if (sessionToken.found) {
        return {
          token: sessionToken.token,
          storage: 'session',
          available: true
        }
      }
      return unavailableResolution()
    }

    const encryptedToken = record.encryptedToken
    if (!encryptedToken) return missingResolution()

    if (encryptedToken.startsWith('enc:')) {
      if (!this.canPersistSecurely()) return unavailableResolution()
      const encrypted = decodeBase64Strict(encryptedToken.slice(4))
      if (!encrypted) return unavailableResolution()
      try {
        const token = this.backend.decryptString(encrypted)
        if (!isValidProviderCredentialToken(token)) return unavailableResolution()
        return {
          token,
          storage: 'encrypted',
          available: true
        }
      } catch {
        return unavailableResolution()
      }
    }

    if (encryptedToken.startsWith('b64:')) {
      const token = decodeUtf8Base64Strict(encryptedToken.slice(4))
      if (token === null || !isValidProviderCredentialToken(token)) return unavailableResolution()
      return {
        token,
        storage: 'legacy-b64',
        available: true
      }
    }

    return unavailableResolution()
  }

  migrateLegacy(
    ref: ProviderCredentialRef,
    encryptedToken: string
  ): ProviderCredentialRecord | null {
    if (!encryptedToken.startsWith('b64:') || !this.canPersistSecurely()) return null
    const token = decodeUtf8Base64Strict(encryptedToken.slice(4))
    if (!token || !isValidProviderCredentialToken(token)) return null

    try {
      const encrypted = this.backend.encryptString(token)
      if (!Buffer.isBuffer(encrypted)) return null
      this.forget(ref)
      return { encryptedToken: `enc:${encrypted.toString('base64')}` }
    } catch {
      return null
    }
  }

  forget(ref: ProviderCredentialRef): void {
    const providerTokens = this.sessionTokens.get(ref.providerId)
    if (!providerTokens) return
    providerTokens.delete(ref.keyId)
    if (providerTokens.size === 0) this.sessionTokens.delete(ref.providerId)
  }

  forgetProvider(providerId: string): void {
    this.sessionTokens.delete(providerId)
  }

  snapshotProvider(providerId: string): ProviderCredentialSessionSnapshot {
    return [...(this.sessionTokens.get(providerId)?.entries() ?? [])]
  }

  restoreProvider(providerId: string, snapshot: ProviderCredentialSessionSnapshot): void {
    if (snapshot.length === 0) {
      this.sessionTokens.delete(providerId)
      return
    }
    this.sessionTokens.set(providerId, new Map(snapshot))
  }

  private setSessionToken(ref: ProviderCredentialRef, token: string): void {
    let providerTokens = this.sessionTokens.get(ref.providerId)
    if (!providerTokens) {
      providerTokens = new Map()
      this.sessionTokens.set(ref.providerId, providerTokens)
    }
    providerTokens.set(ref.keyId, token)
  }

  private getSessionToken(
    ref: ProviderCredentialRef
  ): { found: true; token: string } | { found: false; token: '' } {
    const providerTokens = this.sessionTokens.get(ref.providerId)
    if (!providerTokens?.has(ref.keyId)) return { found: false, token: '' }
    return { found: true, token: providerTokens.get(ref.keyId) ?? '' }
  }
}

export function isSensitiveProviderHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  const compact = normalized.replace(/[-_\s]/g, '')
  return SENSITIVE_HEADER_NAMES.has(normalized)
    || SENSITIVE_CREDENTIAL_NAME_PART.test(normalized)
    || SENSITIVE_CREDENTIAL_COMPACT_PART.test(compact)
}

export function isAllowedProviderCustomHeaderName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed !== name || !trimmed || trimmed.length > 80 || !HTTP_HEADER_NAME.test(trimmed)) return false
  const normalized = trimmed.toLowerCase()
  return SAFE_CUSTOM_HEADER_NAMES.has(normalized) || SAFE_CUSTOM_HEADER_NAME_PATTERN.test(normalized)
}

export function isAllowedProviderManagedCredentialHeaderName(name: string): boolean {
  const trimmed = name.trim()
  return Boolean(trimmed)
    && trimmed.length <= 80
    && HTTP_HEADER_NAME.test(trimmed)
    && ALLOWED_MANAGED_CREDENTIAL_HEADER_NAMES.has(trimmed.toLowerCase())
}

export function looksLikeProviderCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_MARKER.test(value.trim())
}

export function inspectProviderBaseUrl(value: string): {
  safeValue: string
  rejectedNames: string[]
} {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value.trim()
      ? { safeValue: '', rejectedNames: ['invalid Base URL'] }
      : { safeValue: value, rejectedNames: [] }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safeValue: '', rejectedNames: [`URL protocol ${url.protocol}`] }
  }

  const rejectedNames: string[] = []
  const discardUrl = inspectProviderUrlAuthority(url, rejectedNames)
  inspectProviderUrlPath(url, rejectedNames)
  inspectProviderUrlQuery(value, url, rejectedNames)
  inspectProviderUrlFragment(value, url, rejectedNames)

  return {
    safeValue: rejectedNames.length > 0 ? (discardUrl ? '' : url.toString()) : value,
    rejectedNames
  }
}

export function inspectProviderCustomHeaders(value: string): {
  safeValue: string
  rejectedNames: string[]
} {
  const lines = splitHeaderLines(value)
  const rejectedNames: string[] = []
  const seenRejectedNames = new Set<string>()
  const safeLines: HeaderLine[] = []

  for (const line of lines) {
    const inspection = inspectProviderHeaderLine(line)
    if (inspection.safeLine) safeLines.push(inspection.safeLine)
    if (inspection.rejectedName) {
      addUniqueRejectedName(inspection.rejectedName, rejectedNames, seenRejectedNames)
    }
  }

  return {
    safeValue: joinSafeHeaderLines(safeLines, endsWithLineBreak(value)),
    rejectedNames
  }
}

interface HeaderLine {
  value: string
  ending: string
}

function inspectProviderUrlAuthority(url: URL, rejectedNames: string[]): boolean {
  if (url.username || url.password) {
    rejectedNames.push('URL userinfo')
    url.username = ''
    url.password = ''
  }
  if (!looksLikeProviderCredentialValue(url.hostname)) return false
  rejectedNames.push('credential-like URL host')
  return true
}

function inspectProviderUrlPath(url: URL, rejectedNames: string[]): void {
  let decodedPathname = url.pathname
  try {
    decodedPathname = decodeURIComponent(url.pathname)
  } catch {
    rejectedNames.push('invalid URL path encoding')
    url.pathname = '/'
  }
  if (looksLikeProviderCredentialValue(decodedPathname)) {
    rejectedNames.push('credential-like URL path')
    url.pathname = '/'
  }
}

function inspectProviderUrlQuery(value: string, url: URL, rejectedNames: string[]): void {
  const queryNames = [...new Set(url.searchParams.keys())]
  for (const name of queryNames) {
    pushUniqueRejectedName(rejectedProviderQueryName(name), rejectedNames)
  }
  if (queryNames.length > 0 || value.includes('?')) {
    if (queryNames.length === 0) rejectedNames.push('URL query')
    url.search = ''
  }
}

function rejectedProviderQueryName(name: string): string {
  if (looksLikeProviderCredentialValue(name)) return '(credential-like query parameter)'
  if (name && name.length <= 80 && !/[\0-\x1F\x7F]/.test(name)) return name
  return '(invalid query parameter)'
}

function inspectProviderUrlFragment(value: string, url: URL, rejectedNames: string[]): void {
  if (url.hash || value.includes('#')) {
    rejectedNames.push('URL fragment')
    url.hash = ''
  }
}

function pushUniqueRejectedName(name: string, rejectedNames: string[]): void {
  if (!rejectedNames.some((item) => item.toLowerCase() === name.toLowerCase())) rejectedNames.push(name)
}

function inspectProviderHeaderLine(line: HeaderLine): {
  safeLine?: HeaderLine
  rejectedName?: string
} {
  const colonIndex = line.value.indexOf(':')
  if (colonIndex <= 0) {
    return line.value.trim() ? { rejectedName: '(invalid header line)' } : { safeLine: line }
  }
  const name = line.value.slice(0, colonIndex)
  const headerValue = line.value.slice(colonIndex + 1).replace(/^[ \t]+|[ \t]+$/g, '')
  if (isSafeProviderHeader(name, headerValue)) {
    return {
      safeLine: { value: `${name}:${headerValue ? ` ${headerValue}` : ''}`, ending: line.ending }
    }
  }
  return { rejectedName: rejectedProviderHeaderName(name) }
}

function isSafeProviderHeader(name: string, value: string): boolean {
  return !isSensitiveProviderHeaderName(name)
    && isAllowedProviderCustomHeaderName(name)
    && !looksLikeProviderCredentialValue(name)
    && value.length <= 8192
    && !FORBIDDEN_HEADER_VALUE_CHARACTERS.test(value)
    && !looksLikeProviderCredentialValue(value)
}

function rejectedProviderHeaderName(name: string): string {
  if (looksLikeProviderCredentialValue(name)) return '(credential-like header name)'
  if (name && name.length <= 80 && HTTP_HEADER_NAME.test(name)) return name
  return '(invalid header name)'
}

function addUniqueRejectedName(
  name: string,
  rejectedNames: string[],
  seenRejectedNames: Set<string>
): void {
  const normalizedName = name.toLowerCase()
  if (seenRejectedNames.has(normalizedName)) return
  rejectedNames.push(name)
  seenRejectedNames.add(normalizedName)
}

function decodeBase64Strict(value: string): Buffer | null {
  if (
    !value ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null
  }

  try {
    const decoded = Buffer.from(value, 'base64')
    return decoded.toString('base64') === value ? decoded : null
  } catch {
    return null
  }
}

function decodeUtf8Base64Strict(value: string): string | null {
  const decoded = decodeBase64Strict(value)
  if (!decoded) return null
  const token = decoded.toString('utf8')
  return Buffer.from(token, 'utf8').equals(decoded) ? token : null
}

function isValidProviderCredentialToken(token: string): boolean {
  return Boolean(token) && !/[\0-\x1F\x7F]/.test(token)
}

function unavailableResolution(): ProviderCredentialResolution {
  return { token: '', storage: 'unavailable', available: false }
}

function missingResolution(): ProviderCredentialResolution {
  return { token: '', storage: 'missing', available: false }
}

function splitHeaderLines(value: string): HeaderLine[] {
  const lines: HeaderLine[] = []
  const matcher = /([^\r\n]*)(\r\n|\r|\n|$)/g
  let match: RegExpExecArray | null

  while ((match = matcher.exec(value)) !== null) {
    if (match[0] === '') break
    lines.push({ value: match[1], ending: match[2] })
  }

  return lines
}

function joinSafeHeaderLines(lines: HeaderLine[], preserveTrailingLineBreak: boolean): string {
  return lines
    .map((line, index) => {
      const isLast = index === lines.length - 1
      if (!isLast || preserveTrailingLineBreak) return `${line.value}${line.ending || '\n'}`
      return line.value
    })
    .join('')
}

function endsWithLineBreak(value: string): boolean {
  return /(?:\r\n|\r|\n)$/.test(value)
}
