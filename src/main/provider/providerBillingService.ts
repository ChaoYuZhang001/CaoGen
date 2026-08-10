import type {
  ProviderBillingReconciliationView,
  ProviderBillingStatementInput,
  ProviderBillingStatementView
} from '../../shared/provider-billing-types'
import { getProvider } from '../providers'
import { queryProviderUsage } from './providerUsage'
import {
  listStoredProviderBillingStatements,
  removeStoredProviderBillingStatement,
  saveStoredProviderBillingStatement
} from './providerBillingStore'
import { reconcileProviderBillingStatement } from './providerBillingReconciliation'

export function listProviderBillingStatements(providerId: string): ProviderBillingStatementView[] {
  requireProvider(providerId)
  return listStoredProviderBillingStatements(providerId)
}

export function saveProviderBillingStatement(
  input: ProviderBillingStatementInput,
  now = Date.now()
): ProviderBillingStatementView {
  requireProvider(input.providerId)
  return saveStoredProviderBillingStatement(input, now)
}

export function removeProviderBillingStatement(providerId: string, statementId: string): boolean {
  requireProvider(providerId)
  return removeStoredProviderBillingStatement(providerId, statementId)
}

export async function reconcileProviderBilling(
  providerId: string,
  now = Date.now()
): Promise<ProviderBillingReconciliationView[]> {
  requireProvider(providerId)
  const results: ProviderBillingReconciliationView[] = []
  for (const statement of listStoredProviderBillingStatements(providerId)) {
    const usage = await queryProviderUsage({
      providerId,
      from: statement.periodStart,
      to: statement.periodEnd,
      limit: 1,
      offset: 0,
      bucketCount: 1
    })
    results.push(reconcileProviderBillingStatement(statement, usage, now))
  }
  return results
}

function requireProvider(providerId: string): void {
  if (!getProvider(providerId.trim())) throw new Error('Provider was not found')
}
