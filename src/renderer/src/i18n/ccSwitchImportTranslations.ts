export const CC_SWITCH_IMPORT_TRANSLATIONS = {
  ccSwitchImportTitle: { zh: 'CC Switch \u8fc1\u79fb', en: 'CC Switch migration' },
  ccSwitchImportScan: { zh: '\u626b\u63cf CC Switch', en: 'Scan CC Switch' },
  ccSwitchImportScanning: { zh: '\u6b63\u5728\u626b\u63cf...', en: 'Scanning...' },
  ccSwitchImportApply: { zh: '\u5e94\u7528\u6240\u9009\u914d\u7f6e', en: 'Apply selected configuration' },
  ccSwitchImportApplying: { zh: '\u6b63\u5728\u5e94\u7528...', en: 'Applying...' },
  ccSwitchImportSummary: {
    zh: 'Provider {providers} \u00b7 \u53ef\u5bfc\u5165 {importable} \u00b7 \u51ed\u636e {credentials} \u00b7 \u5b9a\u4ef7 {pricing}',
    en: '{providers} providers \u00b7 {importable} importable \u00b7 {credentials} credentials \u00b7 {pricing} prices'
  },
  ccSwitchImportApplied: {
    zh: '\u5df2\u8fc1\u79fb\uff1a\u65b0\u5efa {created}\uff0c\u66f4\u65b0 {updated}\uff0c\u8df3\u8fc7 {skipped}\u3002',
    en: 'Migration applied: {created} created, {updated} updated, {skipped} skipped.'
  },
  ccSwitchImportProtocol: { zh: '\u534f\u8bae', en: 'Protocol' },
  ccSwitchImportModels: { zh: '\u6a21\u578b', en: 'Models' },
  ccSwitchImportPricing: { zh: '\u5b9a\u4ef7', en: 'Pricing' },
  ccSwitchImportBudget: { zh: '\u6708\u9884\u7b97', en: 'Monthly budget' },
  ccSwitchImportCredential: { zh: '\u51ed\u636e', en: 'Credential' },
  ccSwitchImportCredentialReady: { zh: '\u53ef\u5b89\u5168\u5bfc\u5165', en: 'Ready to import' },
  ccSwitchImportCredentialPreserved: { zh: '\u4fdd\u7559 CaoGen \u73b0\u6709\u51ed\u636e', en: 'Keep existing CaoGen credential' },
  ccSwitchImportCredentialMissing: { zh: '\u672a\u914d\u7f6e', en: 'Not configured' },
  ccSwitchImportSource: { zh: '\u6765\u6e90\uff1a{app}', en: 'Source: {app}' },
  ccSwitchImportChanged: { zh: '\u53d8\u66f4\uff1a{fields}', en: 'Changes: {fields}' },
  ccSwitchImportBackups: { zh: 'CC Switch \u8fc1\u79fb\u8bb0\u5f55', en: 'CC Switch migration history' },
  ccSwitchImportBackupSummary: {
    zh: '{providers} \u4e2a Provider \u00b7 \u51ed\u636e {credentials}',
    en: '{providers} providers \u00b7 {credentials} credentials'
  },
  ccSwitchImportRollbackConfirm: {
    zh: '\u56de\u6eda\u8fd9\u6b21 CC Switch \u8fc1\u79fb\uff1f\u5982\u679c Provider \u5df2\u53d8\u66f4\uff0c\u56de\u6eda\u4f1a\u88ab\u62d2\u7edd\u3002',
    en: 'Roll back this CC Switch migration? Rollback is refused if an imported Provider changed.'
  },
  ccSwitchImportRolledBack: { zh: 'CC Switch \u8fc1\u79fb\u5df2\u56de\u6eda\u3002', en: 'CC Switch migration rolled back.' },
  ccSwitchWarning_credential_missing: { zh: '\u6ca1\u6709\u53ef\u5bfc\u5165\u7684\u51ed\u636e', en: 'No importable credential' },
  ccSwitchWarning_existing_credential_preserved: { zh: '\u4e0d\u8986\u76d6 CaoGen \u73b0\u6709\u51ed\u636e', en: 'Existing CaoGen credential will not be replaced' },
  ccSwitchWarning_daily_limit_not_enforced: { zh: '\u65e5\u9650\u989d\u5c1a\u4e0d\u6267\u884c\uff1b\u53ea\u4fdd\u7559\u6765\u6e90\u503c', en: 'Daily limit is retained as source metadata but is not enforced yet' },
  ccSwitchWarning_proxy_transform_not_supported: { zh: '\u4f9d\u8d56 CC Switch \u79c1\u6709\u4ee3\u7406\u8f6c\u6362\uff0c\u5f53\u524d\u4e0d\u5bfc\u5165', en: 'Requires a CC Switch proxy transform and is not imported' },
  ccSwitchWarning_proxy_listener_not_imported: { zh: 'CC Switch \u672c\u5730\u4ee3\u7406\u76d1\u542c\u5730\u5740\u548c\u7aef\u53e3\u4e0d\u5bfc\u5165', en: 'CC Switch local proxy listener address and port are not imported' },
  ccSwitchWarning_proxy_takeover_not_imported: { zh: 'CC Switch \u7cfb\u7edf\u4ee3\u7406\u63a5\u7ba1\u72b6\u6001\u4e0d\u5bfc\u5165', en: 'CC Switch system proxy takeover state is not imported' },
  ccSwitchWarning_proxy_logging_not_imported: { zh: 'CC Switch \u4ee3\u7406\u65e5\u5fd7\u5f00\u5173\u4e0d\u5bfc\u5165', en: 'CC Switch proxy logging switch is not imported' },
  ccSwitchWarning_empty_provider_config: { zh: '\u7a7a Provider \u6a21\u677f\uff0c\u5df2\u8df3\u8fc7', en: 'Empty Provider template; skipped' }
} as const
