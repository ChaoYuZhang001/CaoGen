#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  REQUIRED_RECOVERY_FAULTS,
  durableRecoveryRequirementStatus,
  durableWriterInventoryClosed,
  workflowDeliverySurfacesClosed
} from './lib/durable-recovery-closure.mjs'

assert.equal(durableRecoveryRequirementStatus({ gap: 1, implemented_unverified: 0 }), 'open')
assert.equal(durableRecoveryRequirementStatus({ gap: 0, implemented_unverified: 1 }), 'inventory_closed_unverified')
assert.equal(durableRecoveryRequirementStatus({ verified: 2, exempt: 1 }), 'verified')

const writers = [
  { contract: { recovery: 'verified', evidence: ['writer.json'] } },
  { contract: { recovery: 'exempt' } }
]
const inventory = {
  inventoryStatus: 'complete',
  requirementStatus: 'verified',
  summary: { modules: 2, recovery: { verified: 1, exempt: 1 } },
  writers
}
assert.equal(durableWriterInventoryClosed(inventory), true)
assert.equal(durableWriterInventoryClosed({ ...inventory, requirementStatus: 'inventory_closed_unverified' }), false)
assert.equal(durableWriterInventoryClosed({
  ...inventory,
  summary: { modules: 2, recovery: { verified: 1, exempt: 0, implemented_unverified: 1 } }
}), false)
assert.equal(durableWriterInventoryClosed({
  ...inventory,
  writers: [{ contract: { recovery: 'verified', evidence: [] } }, writers[1]]
}), false)

for (const faultClass of REQUIRED_RECOVERY_FAULTS) {
  const report = {
    writer: 'src/main/task/workflow-artifact-delivery.ts',
    faults: {
      [faultClass]: {
        status: 'verified',
        requiredSurfaces: ['manifest', 'package'],
        surfaces: { manifest: { status: 'verified' }, package: { status: 'verified' } }
      }
    }
  }
  assert.equal(workflowDeliverySurfacesClosed(report, faultClass), true)
  assert.equal(workflowDeliverySurfacesClosed({
    ...report,
    faults: {
      [faultClass]: {
        ...report.faults[faultClass],
        surfaces: { manifest: { status: 'verified' } }
      }
    }
  }, faultClass), false)
}

console.log(JSON.stringify({ status: 'passed', checks: 11 }))
