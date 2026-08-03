import assert from 'node:assert/strict'
import { repairReview } from './verified-delivery-flow-repair-actions.mjs'
import { finalReadback, runProbe } from './verified-delivery-flow-probes.mjs'
import {
  attachAndFinalizeStage,
  completeStage,
  createStageAcceptance,
  createStageArtifact,
  createStageEvidence,
  createStageLink,
  failReview,
  passStagedAcceptance,
  prepareReview,
  seedWorkflow
} from './verified-delivery-flow-stage-actions.mjs'
import { stageByName } from './verified-delivery-flow-contract.mjs'
import { loadVerifiedDeliveryProductionApi } from './verified-delivery-flow-runtime.mjs'

export async function runVerifiedDeliveryAction(payload) {
  validatePayload(payload)
  process.env.CAOGEN_USER_DATA = payload.rootDir
  const api = await loadVerifiedDeliveryProductionApi(payload.outDir)
  const stage = () => stageByName(payload.stage)
  const dispatch = {
    seed: () => seedWorkflow(api, payload),
    'create-artifact': () => createStageArtifact(api, payload, stage()),
    'create-evidence': () => createStageEvidence(api, payload, stage()),
    'create-acceptance': () => createStageAcceptance(api, payload, stage()),
    'create-link': () => createStageLink(api, payload, stage()),
    'pass-acceptance': () => passStagedAcceptance(api, payload, stage()),
    'attach-artifact': () => attachAndFinalizeStage(api, payload, stage()),
    'complete-stage': () => completeStage(api, payload, stage()),
    'prepare-review': () => prepareReview(api, payload),
    'fail-review': () => failReview(api, payload),
    'repair-review': () => repairReview(api, payload),
    probe: () => runProbe(api, payload),
    'final-readback': () => finalReadback(api, payload)
  }
  const action = dispatch[payload.action]
  if (!action) throw actionError(payload.action)
  return action()
}

function validatePayload(payload) {
  assert(payload && typeof payload === 'object')
  for (const key of ['action', 'outDir', 'rootDir', 'workspaceRoot']) {
    assert.equal(typeof payload[key], 'string', `${key} is required`)
  }
}

function actionError(action) {
  const error = new Error('unsupported verified-delivery action')
  Object.assign(error, { code: `VERIFIED_DELIVERY_ACTION_${String(action).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}` })
  return error
}
