export const PROVIDER_PROFILE_TRANSLATIONS = {
  providerProfileImport: { zh: '导入', en: 'Import' },
  providerProfileExport: { zh: '导出', en: 'Export' },
  providerProfileSafetyHint: {
    zh: 'Profile 只迁移 Provider、协议、模型和路由元数据，不导出或导入 API Key；应用前会自动创建本机私密备份。',
    en: 'Profiles move providers, protocols, models, and routing metadata only. API keys are never exported or imported, and a private local backup is created before applying changes.'
  },
  providerProfileExported: { zh: '已导出 {n} 个 Provider，不含 API Key。', en: 'Exported {n} providers without API keys.' },
  providerProfileApplied: {
    zh: 'Profile 已应用：新建 {created}、更新 {updated}、跳过 {skipped}。',
    en: 'Profile applied: {created} created, {updated} updated, {skipped} skipped.'
  },
  providerProfileRolledBack: { zh: '已回滚并恢复 {n} 个 Provider。', en: 'Rolled back and restored {n} providers.' },
  providerProfilePreviewTitle: { zh: '导入预览', en: 'Import preview' },
  providerProfilePreviewCounts: {
    zh: '新建 {create} · 更新 {update} · 跳过 {skip}',
    en: '{create} create · {update} update · {skip} skip'
  },
  providerProfileProtocol: { zh: '协议：{protocol}', en: 'Protocol: {protocol}' },
  providerProfileChangedFields: { zh: '将变更：{fields}', en: 'Changes: {fields}' },
  providerProfileCredentialSkipped: { zh: 'Key：跳过，不改变现有配置', en: 'Key: skipped; existing configuration is unchanged' },
  providerProfileCredentialNone: { zh: 'Key：本机服务无需密钥', en: 'Key: not required for this local service' },
  providerProfileCredentialMissing: {
    zh: 'Key：Profile 不含密钥，应用后需单独录入',
    en: 'Key: profiles contain no secret; enter a key after applying'
  },
  providerProfileCredentialUnnamed: { zh: '未命名 Key', en: 'Unnamed key' },
  providerProfileCredentialPreserved: {
    zh: '当前 Key：{label}（共 {n} 个）；目标绑定不变，将继续使用',
    en: 'Current key: {label} ({n} total); target binding is unchanged and the key remains usable'
  },
  providerProfileCredentialReentry: {
    zh: '当前 Key：{label}（共 {n} 个）；目标绑定变化或已隔离，应用后需重新录入',
    en: 'Current key: {label} ({n} total); the binding changes or is quarantined, so re-entry is required'
  },
  providerProfileCredentialRemoved: {
    zh: '当前 Key：{label}（共 {n} 个）；切换为无需密钥后将永久删除',
    en: 'Current key: {label} ({n} total); switching to no-auth permanently removes it'
  },
  providerProfileActionFor: { zh: '{name} 的导入动作', en: 'Import action for {name}' },
  providerProfileAction_create: { zh: '新建', en: 'Create' },
  providerProfileAction_update: { zh: '更新现有', en: 'Update existing' },
  providerProfileAction_skip: { zh: '跳过', en: 'Skip' },
  providerProfileConflictNone: { zh: '未发现冲突', en: 'No conflict' },
  providerProfileConflict_same_provider: {
    zh: '匹配现有 Provider：{target}',
    en: 'Matches existing provider: {target}'
  },
  providerProfileConflict_name: { zh: '名称冲突：{target}', en: 'Name conflict: {target}' },
  providerProfileConflict_target: { zh: '目标冲突：{target}', en: 'Endpoint conflict: {target}' },
  providerProfileConflictAmbiguous: {
    zh: '匹配到多个现有 Provider，默认跳过',
    en: 'Matches multiple existing providers and will be skipped by default'
  },
  providerProfileBackupBeforeApply: {
    zh: '应用前自动备份现有配置；API Key 不写入 Profile 备份，回滚后可能需要重新录入。',
    en: 'Existing configuration is backed up before applying. API keys are excluded and may require re-entry after rollback.'
  },
  providerProfileApply: { zh: '应用 Profile', en: 'Apply profile' },
  providerProfileApplying: { zh: '正在应用…', en: 'Applying…' },
  providerProfileBackupsTitle: { zh: '最近备份', en: 'Recent backups' },
  providerProfileBackupSummary: { zh: '{n} 个 Provider', en: '{n} providers' },
  providerProfileSessionKeyWarning: {
    zh: '{n} 个仅本次会话 Key 不在磁盘备份中',
    en: '{n} session-only keys are not included in the disk backup'
  },
  providerProfileCredentialReentryWarning: {
    zh: '{n} 个已存 Key 已从备份排除；回滚后需重新录入',
    en: '{n} stored keys were excluded; re-enter them after rollback'
  },
  providerProfileRollback: { zh: '回滚', en: 'Rollback' },
  providerProfileRollbackConfirm: {
    zh: '回滚到 {time} 的 Provider 配置？当前配置会先自动备份。',
    en: 'Roll back to the provider configuration from {time}? The current configuration will be backed up first.'
  }
}
