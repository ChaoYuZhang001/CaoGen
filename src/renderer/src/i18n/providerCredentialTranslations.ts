type TranslationEntry = { zh: string; en: string }

export const PROVIDER_CREDENTIAL_TRANSLATIONS: Record<string, TranslationEntry> = {
  providerCredentialSessionTag: { zh: '仅本次运行', en: 'Current run only' },
  providerCredentialLegacyTag: { zh: '旧密钥待迁移', en: 'Legacy key pending migration' },
  providerCredentialUnavailableTag: {
    zh: '安全存储当前不可用',
    en: 'Secure storage unavailable'
  },
  providerCredentialMixedTag: { zh: '混合存储状态', en: 'Mixed storage state' },
  providerCredentialSessionNotice: {
    zh: '此 Provider 的密钥仅保存在当前进程内，应用重启后失效。请在系统安全存储可用后重新输入并保存。',
    en: 'This Provider key is held only in the current process and will be lost when the app restarts. Re-enter and save it after secure storage becomes available.'
  },
  providerCredentialLegacyNotice: {
    zh: '检测到旧版可逆编码密钥。系统安全存储可用后会自动迁移；建议现在通过 API 密钥字段重新输入。',
    en: 'A legacy reversibly encoded key was found. It will migrate automatically when secure storage is available; re-entering it in the API key field now is recommended.'
  },
  providerCredentialUnavailableNotice: {
    zh: '已保存的加密密钥当前无法解密，此 Provider 在本次运行不可用。请恢复系统安全存储或重新输入密钥。',
    en: 'The saved encrypted key cannot be decrypted right now, so this Provider is unavailable for this run. Restore secure storage or re-enter the key.'
  },
  providerCredentialMixedNotice: {
    zh: '此 Provider 的密钥处于混合存储状态。请逐项检查仅本次运行、旧版待迁移或当前不可用的密钥。',
    en: 'This Provider has keys in mixed storage states. Review keys that are current-run only, pending legacy migration, or currently unavailable.'
  },
  providerCredentialMigrationNotice: {
    zh: '旧配置中不安全或不受支持的请求头/Base URL 信息已移除，请检查路由，并通过 API 密钥或受管鉴权头重新配置。',
    en: 'Unsafe or unsupported custom-header/Base-URL data was removed from the legacy configuration. Review routing and reconfigure credentials with the API key or managed credential headers.'
  },
  apiKeyStorageEncrypted: { zh: '安全加密保存', en: 'Securely encrypted' },
  apiKeyStorageSession: { zh: '仅本次运行（重启后失效）', en: 'Current run only (lost on restart)' },
  apiKeyStorageLegacy: {
    zh: '旧密钥待迁移（安全存储可用后迁移；建议重新输入）',
    en: 'Legacy key pending migration (migrates when secure storage is available; re-entry recommended)'
  },
  apiKeyStorageUnavailable: { zh: '安全存储当前不可用', en: 'Secure storage unavailable' },
  apiKeyStorageNone: { zh: '未保存密钥', en: 'No saved key' },
  apiKeyStorageMixed: { zh: '混合存储状态', en: 'Mixed storage state' },
  apiKeyCurrentlyUnavailable: { zh: '当前进程不可用', en: 'Unavailable in this process' },
  customHeadersLabel: { zh: '自定义请求头', en: 'Custom headers' },
  customHeadersHint: {
    zh: '仅允许标准头和路由元数据头（如 X-Gateway-Route、X-Trace-Id）；未知头、畸形行及疑似凭据值会被拒绝',
    en: 'Only standard headers and routing metadata (such as X-Gateway-Route and X-Trace-Id) are allowed. Unknown headers, malformed lines, and credential-like values are rejected.'
  },
  credentialHeaderNamesLabel: { zh: '受管鉴权头名称', en: 'Managed credential header names' },
  credentialHeaderNamesHint: {
    zh: '每行一个已知鉴权头，如 Authorization、api-key、X-RapidAPI-Key；值由主进程 Broker 注入',
    en: 'One known credential header per line, such as Authorization, api-key, or X-RapidAPI-Key. The main-process Broker injects its value.'
  }
}
