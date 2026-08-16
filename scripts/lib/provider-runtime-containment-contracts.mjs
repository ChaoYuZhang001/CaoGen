export function buildProviderIpcContractAudit({ programSource, exportedSymbol, exportedType }) {
  const sources = {
    providers: programSource('src/main/providers.ts'),
    authorization: programSource('src/main/provider/providerAuthorizationService.ts'),
    authorizationAccount: programSource('src/main/provider/providerAuthorizationAccountService.ts'),
    authorizationHandlers: programSource('src/main/ipc/provider-authorization-handlers.ts'),
    balance: programSource('src/main/provider/providerBalanceService.ts'),
    billing: programSource('src/main/provider/providerBillingService.ts'),
    billingQuery: programSource('src/main/provider/providerBillingQueryService.ts'),
    gateway: programSource('src/main/provider/providerGatewayService.ts'),
    gatewayStore: programSource('src/main/provider/providerGatewayStore.ts'),
    usage: programSource('src/main/provider/providerUsage.ts'),
    shared: programSource('src/shared/types.ts'),
    billingTypes: programSource('src/shared/provider-billing-types.ts'),
    billingQueryTypes: programSource('src/shared/provider-billing-query-types.ts'),
    gatewayTypes: programSource('src/shared/provider-gateway-types.ts'),
    pricing: programSource('src/main/provider/providerPricingCatalog.ts'),
    authorizationTypes: programSource('src/shared/provider-authorization-types.ts'),
    balanceTypes: programSource('src/shared/provider-balance-types.ts'),
    usageTypes: programSource('src/shared/provider-usage-types.ts')
  }
  const types = {
    providerView: exportedType(sources.shared, 'ProviderView'),
    authorizationAccountView: exportedType(sources.authorizationTypes, 'ProviderAuthorizationAccountView'),
    deviceAuthorizationView: exportedType(sources.authorizationTypes, 'ProviderDeviceAuthorizationView'),
    quickDeviceAuthorizationView: exportedType(sources.authorizationTypes, 'ProviderQuickDeviceAuthorizationView'),
    authorizationPollResult: exportedType(sources.authorizationTypes, 'ProviderAuthorizationPollResult'),
    quickAuthorizationPollResult: exportedType(sources.authorizationTypes, 'ProviderQuickAuthorizationPollResult'),
    authorizationQuotaView: exportedType(sources.authorizationTypes, 'ProviderAuthorizationQuotaView'),
    authorizationQuotaTierView: exportedType(sources.authorizationTypes, 'ProviderAuthorizationQuotaTierView'),
    balanceCapabilityView: exportedType(sources.balanceTypes, 'ProviderBalanceCapabilityView'),
    balanceView: exportedType(sources.balanceTypes, 'ProviderBalanceView'),
    providerUsageSummary: exportedType(sources.usageTypes, 'ProviderUsageSummary'),
    pricingFetchResult: exportedType(sources.shared, 'ProviderPricingCatalogFetchResult'),
    generationProbeResult: exportedType(sources.shared, 'ProviderGenerationProbeResult'),
    billingStatementView: exportedType(sources.billingTypes, 'ProviderBillingStatementView'),
    billingReconciliationView: exportedType(sources.billingTypes, 'ProviderBillingReconciliationView'),
    billingQueryCapabilityView: exportedType(sources.billingQueryTypes, 'ProviderBillingQueryCapabilityView'),
    billingSyncResult: exportedType(sources.billingQueryTypes, 'ProviderBillingSyncResult'),
    gatewayStatusView: exportedType(sources.gatewayTypes, 'ProviderGatewayStatusView'),
    gatewayModelView: exportedType(sources.gatewayTypes, 'ProviderGatewayModelView')
  }
  const contract = (target, expectedType, extra = {}) => ({
    target: exportedSymbol(target[0], target[1]),
    returns: true,
    ...(expectedType ? { expectedType } : {}),
    ...extra
  })
  const contracts = new Map([
    ['providers:activateLocalCompute', { target: exportedSymbol(programSource('src/main/provider/localCompute.ts'), 'activateLocalCompute'), returns: true }],
    ['providers:authorization:accounts', contract([sources.authorizationAccount, 'listProviderAuthorizationAccounts'], types.authorizationAccountView, { array: true })],
    ['providers:authorization:bind', contract([sources.authorizationHandlers, 'bindOrMutate'], types.providerView)],
    ['providers:authorization:poll', contract([sources.authorization, 'pollProviderAuthorization'], types.authorizationPollResult)],
    ['providers:authorization:quota', contract([sources.authorization, 'queryProviderAuthorizationQuota'], types.authorizationQuotaView)],
    ['providers:authorization:quick-poll', contract([sources.authorization, 'pollQuickProviderAuthorization'], types.quickAuthorizationPollResult)],
    ['providers:authorization:quick-start', contract([sources.authorization, 'startQuickProviderAuthorization'], types.quickDeviceAuthorizationView)],
    ['providers:authorization:refresh', contract([sources.authorization, 'refreshProviderAuthorization'], types.providerView)],
    ['providers:authorization:revoke', contract([sources.authorization, 'revokeProviderAuthorization'], types.providerView)],
    ['providers:authorization:start', contract([sources.authorization, 'startProviderAuthorization'], types.deviceAuthorizationView)],
    ['providers:balance:capability', contract([sources.balance, 'inspectProviderBalance'], types.balanceCapabilityView)],
    ['providers:balance:query', contract([sources.balance, 'queryProviderBalance'], types.balanceView)],
    ['providers:billing:capability', contract([sources.billingQuery, 'inspectProviderBillingQuery'], types.billingQueryCapabilityView)],
    ['providers:billing:list', contract([sources.billing, 'listProviderBillingStatements'], types.billingStatementView, { array: true })],
    ['providers:billing:reconcile', contract([sources.billing, 'reconcileProviderBilling'], types.billingReconciliationView, { array: true })],
    ['providers:billing:remove', contract([sources.billing, 'removeProviderBillingStatement'])],
    ['providers:billing:save', contract([sources.billing, 'saveProviderBillingStatement'], types.billingStatementView)],
    ['providers:billing:sync', contract([sources.billingQuery, 'syncProviderBillingStatement'], types.billingSyncResult)],
    ['providers:create', contract([sources.providers, 'createProvider'])],
    ['providers:delete', {
      target: exportedSymbol(sources.authorization, 'removeProviderAuthorizations'), returns: false,
      sequence: [exportedSymbol(sources.providers, 'deleteProvider'), exportedSymbol(sources.authorization, 'removeProviderAuthorizations')]
    }],
    ['providers:fetchModels', contract([sources.providers, 'fetchModels'])],
    ['providers:fetchPricingCatalog', contract([sources.pricing, 'fetchProviderPricingCatalog'], types.pricingFetchResult)],
    ['providers:gateway:copy-token', {
      verifyTarget: exportedSymbol(sources.gatewayStore, 'resolveProviderGatewayToken')
    }],
    ['providers:gateway:models', contract([sources.gateway, 'listProviderGatewayModels'], types.gatewayModelView, { array: true })],
    ['providers:gateway:status', contract([sources.gateway, 'providerGatewayStatus'], types.gatewayStatusView)],
    ['providers:gateway:update', contract([sources.gateway, 'updateProviderGateway'], types.gatewayStatusView)],
    ['providers:health', contract([programSource('src/main/scheduler.ts'), 'listHealth'])],
    ['providers:list', contract([sources.providers, 'listProviders'])],
    ['providers:probeGeneration', contract([sources.providers, 'probeProviderGeneration'], types.generationProbeResult)],
    ['providers:update', contract([sources.providers, 'updateProvider'])],
    ['providers:usage', contract([sources.usage, 'queryProviderUsage'], types.providerUsageSummary)]
  ])
  return { contracts, expectedProviderChannels: [...contracts.keys()].sort(), types }
}
