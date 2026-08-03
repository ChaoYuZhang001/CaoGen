import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadVerifiedDeliveryProductionApi(outDir) {
  const load = (relativePath) => import(pathToFileURL(path.join(outDir, relativePath)).href)
  const [
    workspaceStore,
    workspaceCommands,
    snapshot,
    taskRun,
    lifecycle,
    workflow,
    handoff,
    handlers,
    repair,
    aggregate,
    studioResult
  ] = await Promise.all([
    load('main/project-workspace/store.js'),
    load('main/project-workspace/command-service.js'),
    load('main/task/task-snapshot.js'),
    load('main/task/task-run.js'),
    load('main/task/artifact-lifecycle-api.js'),
    load('main/task/workflow-ledger-api.js'),
    load('main/task/workflow-stage-handoff.js'),
    load('main/ipc/workflow-ledger-handlers.js'),
    load('main/task/workflow-acceptance-repair-coordinator.js'),
    load('main/project-aggregate/project-aggregate-factory.js'),
    load('main/studio-result/studio-result-service.js')
  ])
  return {
    workspaceStore,
    workspaceCommands,
    snapshot,
    taskRun,
    lifecycle,
    workflow,
    handoff,
    handlers,
    repair,
    aggregate,
    studioResult
  }
}

export function buildOwnershipDigest(workItems, runs) {
  return digestJson({
    workItems: [...workItems].sort(byId).map((item) => ({
      id: item.id,
      projectId: item.projectId,
      goalId: item.goalId,
      parentId: item.parentId,
      ownerId: item.owner?.id,
      status: item.status,
      dependencyIds: [...item.dependencyIds].sort(),
      runRefs: [...item.runRefs].sort(),
      artifactRefs: [...item.artifactRefs].sort()
    })),
    runs: [...runs].sort(byId).map((run) => ({
      id: run.id,
      projectId: run.projectId,
      goalId: run.goalId,
      workItemId: run.workItemId,
      sessionId: run.sessionId,
      status: run.status
    }))
  })
}

export function buildEvidenceChainDigest(evidence, ledger) {
  return digestJson({
    evidence: [...evidence]
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
      .map((item) => ({
        evidenceId: item.evidenceId,
        projectId: item.projectId,
        goalId: item.goalId,
        workItemId: item.workItemId,
        runId: item.runId,
        artifactId: item.artifactId,
        contentDigest: item.contentDigest,
        digest: item.digest
      })),
    links: [...ledger.evidenceLinks.items].sort(byId).map((item) => ({
      id: item.id,
      evidenceId: item.evidenceId,
      artifactId: item.artifactId,
      acceptanceId: item.acceptanceId,
      relation: item.relation
    })),
    acceptances: [...ledger.acceptances.items].sort(byId).map((item) => ({
      id: item.id,
      workItemId: item.workItemId,
      status: item.status,
      evidenceRefs: [...item.evidenceRefs].sort(),
      revision: item.revision
    }))
  })
}

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function byId(left, right) {
  return left.id.localeCompare(right.id)
}
