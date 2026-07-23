import type { LearningActor } from '../../shared/learning-types'

declare const trustedLearningDecisionBrand: unique symbol

export interface TrustedLearningDecision {
  readonly [trustedLearningDecisionBrand]: true
}

const trustedDecisions = new WeakMap<object, LearningActor>()

export function createTrustedUserLearningDecision(source: string, id = 'local-user'): TrustedLearningDecision {
  const authority = Object.freeze({}) as TrustedLearningDecision
  trustedDecisions.set(authority, {
    type: 'user',
    id: normalizeIdentity(id, 'local-user'),
    source: normalizeIdentity(source, 'trusted-main-process')
  })
  return authority
}

export function requireTrustedUserLearningActor(authority: unknown): LearningActor {
  if (!authority || typeof authority !== 'object') {
    throw decisionError()
  }
  const actor = trustedDecisions.get(authority)
  if (!actor || actor.type !== 'user') throw decisionError()
  return { ...actor }
}

function normalizeIdentity(value: string, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().slice(0, 128)
  return normalized || fallback
}

function decisionError(): Error {
  const error = new Error('Learning activation requires a trusted user decision')
  error.name = 'UntrustedLearningDecisionError'
  Object.assign(error, { code: 'UNTRUSTED_LEARNING_DECISION' })
  return error
}
