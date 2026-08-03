export function verifySessionChoiceContract(sessionManager, lifecycle, assert) {
  assert(
    sessionManager.includes('prepareSessionCreationDraft(opts, parentMeta)') &&
      lifecycle.includes('const provider = explicitSessionProvider(selectedProviderId, selectedModel)') &&
      lifecycle.includes('engine: resolveProviderEngine(provider)') &&
      !lifecycle.includes('engine: opts.engine') &&
      lifecycle.includes("if (!model) throw new Error('请选择模型或显式选择自动调度')") &&
      lifecycle.includes("if (!providerId) throw new Error('请选择可用 Provider')") &&
      lifecycle.includes('if (!providerIsReady(provider))'),
    'Session creation must resolve a ready provider/model and derive the engine from that Provider'
  )
}
