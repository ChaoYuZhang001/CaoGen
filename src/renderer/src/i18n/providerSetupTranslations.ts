export const PROVIDER_SETUP_TRANSLATIONS = {
  providerEditTitle: { zh: '编辑 Provider', en: 'Edit Provider' },
  providerAddTitle: { zh: '添加 Provider', en: 'Add Provider' },
  providerQuickTitle: { zh: '快速开始', en: 'Quick start' },
  providerQuickRecommended: { zh: '推荐', en: 'Recommended' },
  providerQuickName: { zh: 'CaoGen 快速服务', en: 'CaoGen Quick Service' },
  providerQuickKeyLabel: { zh: '主账号', en: 'Primary' },
  providerQuickKeyPlaceholder: { zh: '粘贴 API Key', en: 'Paste API key' },
  providerQuickGetKey: { zh: '获取 API Key', en: 'Get an API key' },
  providerQuickAdvanced: { zh: '自定义服务', en: 'Custom service' },
  providerQuickConnect: { zh: '连接并使用', en: 'Connect and use' },
  providerQuickConnecting: { zh: '正在验证…', en: 'Checking…' },
  providerQuickKeyRequired: { zh: '请先粘贴 API Key', en: 'Paste an API key first' },
  providerQuickUnavailable: {
    zh: '当前服务不可用，请稍后重试或使用自定义服务',
    en: 'The service is unavailable. Try again later or use a custom service.'
  },
  providerQuickUseLocal: { zh: '使用本机模型', en: 'Use a local model' },
  providerQuickOrKey: { zh: '或使用 API Key', en: 'or use an API key' },
  providerQuickLocalUnavailable: {
    zh: '未发现已启动且安装了模型的 Ollama、LM Studio 或 vLLM。',
    en: 'No running Ollama, LM Studio, or vLLM service with an installed model was found.'
  },
  providerEngineLabel: { zh: '执行引擎', en: 'Execution engine' },
  providerEngineOpenAI: { zh: 'OpenAI-compatible', en: 'OpenAI-compatible' },
  providerEngineAnthropic: { zh: 'Anthropic Messages API', en: 'Anthropic Messages API' },
  providerEngineClaude: { zh: 'Claude Agent SDK', en: 'Claude Agent SDK' },
  quickTemplate: { zh: '快速模板', en: 'Quick templates' },
  pickTemplate: { zh: '选择一个模板…', en: 'Pick a template…' },
  gatewayNote1: {
    zh: 'OpenAI-compatible 使用 Responses / Chat Completions;Anthropic Messages 使用原生 /v1/messages。Claude Agent SDK 接入 ',
    en: 'OpenAI-compatible uses Responses / Chat Completions; Anthropic Messages uses native /v1/messages. With Claude Agent SDK, '
  },
  gatewayNoteBold: { zh: 'OpenAI / Gemini / 国产模型', en: 'OpenAI / Gemini / other vendors' },
  gatewayNote2: {
    zh: ' 仍需经 Anthropic 兼容网关(one-api、new-api、LiteLLM 等)转译。',
    en: ' still needs an Anthropic-compatible gateway (one-api, new-api, LiteLLM, …).'
  }
}
