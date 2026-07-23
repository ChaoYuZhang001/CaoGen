export function verifySessionChoiceContract(sessionManager, lifecycle, assert) {
  assert(
    sessionManager.includes('prepareSessionCreationDraft(opts, parentMeta)') &&
      lifecycle.includes('const provider = explicitSessionProvider(selectedProviderId, selectedModel)') &&
      lifecycle.includes('engine: resolveProviderEngine(provider)') &&
      !lifecycle.includes('engine: opts.engine') &&
      lifecycle.includes("if (!model) throw new Error('请选择模型或显式选择自动调度')") &&
      lifecycle.includes("if (!providerId) throw new Error('请选择已配置 API key 的 Provider')"),
    'Session creation must require an explicit provider/model choice and derive the engine from the selected Provider'
  )
}
