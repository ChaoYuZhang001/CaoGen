export const ASSISTANT_PROJECTION_TRANSLATIONS = {
  assistantComputeReady: { zh: '已自动准备执行资源', en: 'Ready to start automatically' },
  assistantComputeUnavailableShort: { zh: '当前无法开始任务', en: 'Unable to start right now' },
  assistantComputeUnavailable: {
    zh: '当前没有可用的执行资源。完成设置后可以从这里继续。',
    en: 'No execution service is available. Finish setup, then continue here.'
  },
  assistantStartFailed: {
    zh: '任务暂时无法开始。请检查可用服务后重试，当前内容不会被发送。',
    en: 'The task could not start. Check available services and retry; nothing was sent.'
  },
  assistantWorkspaceUnavailable: {
    zh: '当前工作位置不可用。请重新选择后再试。',
    en: 'This workspace is unavailable. Choose it again and retry.'
  },
  assistantComputeCheckFailed: {
    zh: '暂时无法检查可用服务。请稍后重试。',
    en: 'Available services could not be checked. Try again shortly.'
  },
  assistantConfigureCompute: { zh: '设置可用服务', en: 'Set up a service' },
  assistantRetryCompute: { zh: '重新检查', en: 'Check again' },
  assistantCheckingCompute: { zh: '检查中…', en: 'Checking…' },
  assistantAutoCompute: { zh: '执行资源由系统自动选择', en: 'Execution is selected automatically' },
  assistantRoutingStatus: { zh: '已自动选择合适的执行资源', en: 'A suitable service was selected automatically' },
  assistantFailoverStatus: {
    zh: '服务短暂不可用，已自动继续',
    en: 'A service was unavailable; work continued automatically'
  }
} as const
