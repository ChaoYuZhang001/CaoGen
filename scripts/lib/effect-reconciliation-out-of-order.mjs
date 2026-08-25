export function verifyOutOfOrderReconciliation({ ledger, run, assert, assertEqual }) {
  const before = run.effects[0]
  const delayedObservation = {
    kind: 'confirmed',
    evidenceDigest: 'delayed-confirmation-digest',
    verifier: 'effect-reconciliation-fixture',
    reason: 'delayed adapter response',
    observedAt: before.updatedAt - 1
  }
  const after = ledger.applyEffectReconciliation(
    run,
    before.id,
    delayedObservation,
    before.updatedAt + 10
  )
  assertEqual(after.effects[0].status, before.status,
    'out-of-order reconciliation must preserve Effect status')
  assertEqual(after.effects[0].updatedAt, before.updatedAt,
    'out-of-order reconciliation must preserve Effect timestamp')
  assert(after.effects[0].revision > before.revision,
    'out-of-order reconciliation must append an audit revision')
  assertEqual(after.effects[0].evidence.at(-1)?.kind, 'reconciliation')
  const replayed = ledger.applyEffectReconciliation(
    after,
    before.id,
    delayedObservation,
    before.updatedAt + 20
  )
  assertEqual(replayed.effects[0].revision, after.effects[0].revision,
    'replayed out-of-order observation must be idempotent')
}
