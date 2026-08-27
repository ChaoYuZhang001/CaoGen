export const PROVIDER_HEALTH_TRANSLATIONS = {
  healthOkTip: { zh: '健康 · 成功 {s} 失败 {f} · 最近延迟 {latencyMs}ms', en: 'Healthy · {s} succeeded, {f} failed · latest latency {latencyMs}ms' },
  healthBadTip: { zh: '异常 · 连续失败 {n} · {error}', en: 'Unhealthy · {n} consecutive failures · {error}' },
  healthCircuitOpenTip: { zh: '已熔断 · 暂停自动路由 · {error}', en: 'Circuit open · excluded from automatic routing · {error}' },
  healthCircuitHalfOpenTip: { zh: '半开恢复 · 仅允许受限探测请求', en: 'Half-open recovery · only a limited probe is allowed' },
  providerHealthNotChecked: { zh: '未检测', en: 'Not checked' },
  providerHealthHealthy: { zh: '健康 · {s} 成功 / {f} 失败 · {latencyMs}ms', en: 'Healthy · {s} succeeded / {f} failed · {latencyMs}ms' },
  providerHealthDegraded: { zh: '可用 · 最近失败', en: 'Available · recent failure' },
  providerHealthProbeFailed: { zh: '探测异常', en: 'Probe failed' },
  providerHealthUnhealthy: { zh: '异常 · 连续失败 {n} 次', en: 'Unhealthy · {n} consecutive failures' },
  providerHealthCircuitOpen: { zh: '已熔断 · 暂停自动路由', en: 'Circuit open · excluded from routing' },
  providerHealthCircuitHalfOpen: { zh: '恢复探测中', en: 'Recovery probe in progress' }
} as const
