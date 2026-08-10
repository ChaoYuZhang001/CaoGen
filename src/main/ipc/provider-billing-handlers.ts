import { ipcMain } from 'electron'
import type {
  ProviderBillingStatementInput,
  ProviderBillingStatementSource
} from '../../shared/provider-billing-types'
import type { ProviderBillingSyncInput } from '../../shared/provider-billing-query-types'
import {
  listProviderBillingStatements,
  reconcileProviderBilling,
  removeProviderBillingStatement,
  saveProviderBillingStatement
} from '../provider/providerBillingService'
import {
  inspectProviderBillingQuery,
  syncProviderBillingStatement
} from '../provider/providerBillingQueryService'
import { executeProviderOperationEffect } from '../provider/providerOperationEffect'

export function registerProviderBillingIpc(): void {
  ipcMain.handle('providers:billing:list', (_event, providerId: unknown) =>
    listProviderBillingStatements(requiredString(providerId)))
  ipcMain.handle('providers:billing:reconcile', (_event, providerId: unknown) =>
    reconcileProviderBilling(requiredString(providerId)))
  ipcMain.handle('providers:billing:capability', (_event, providerId: unknown) =>
    inspectProviderBillingQuery(requiredString(providerId)))
  ipcMain.handle('providers:billing:sync', (_event, rawInput: unknown) => {
    const input = normalizeSyncInput(rawInput)
    return executeProviderOperationEffect(
      'provider_billing_statement_sync',
      'Sync Provider billing statement',
      {
        providerId: input.providerId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd
      },
      () => syncProviderBillingStatement(input)
    )
  })
  ipcMain.handle('providers:billing:save', (_event, rawInput: unknown) => {
    const input = normalizeStatementInput(rawInput)
    return executeProviderOperationEffect(
      'provider_billing_statement_save',
      'Save Provider billing statement',
      {
        providerId: input.providerId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        billedCostUsd: input.billedCostUsd,
        source: input.source
      },
      () => saveProviderBillingStatement(input)
    )
  })
  ipcMain.handle('providers:billing:remove', (_event, providerId: unknown, statementId: unknown) => {
    const normalizedProviderId = requiredString(providerId)
    const normalizedStatementId = requiredString(statementId)
    return executeProviderOperationEffect(
      'provider_billing_statement_remove',
      'Remove Provider billing statement',
      { providerId: normalizedProviderId, statementId: normalizedStatementId },
      () => removeProviderBillingStatement(normalizedProviderId, normalizedStatementId)
    )
  })
}

function normalizeSyncInput(value: unknown): ProviderBillingSyncInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider billing sync input is invalid')
  }
  const input = value as Record<string, unknown>
  return {
    providerId: requiredString(input.providerId),
    periodStart: requiredNumber(input.periodStart),
    periodEnd: requiredNumber(input.periodEnd)
  }
}

function normalizeStatementInput(value: unknown): ProviderBillingStatementInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider billing statement is invalid')
  }
  const input = value as Record<string, unknown>
  return {
    providerId: requiredString(input.providerId),
    periodStart: requiredNumber(input.periodStart),
    periodEnd: requiredNumber(input.periodEnd),
    billedCostUsd: requiredNumber(input.billedCostUsd),
    source: requiredSource(input.source)
  }
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function requiredNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN
}

function requiredSource(value: unknown): ProviderBillingStatementSource {
  if (value === 'provider-api' || value === 'provider-console' || value === 'invoice'
    || value === 'balance-export' || value === 'other') return value
  throw new Error('Provider billing statement source is invalid')
}
