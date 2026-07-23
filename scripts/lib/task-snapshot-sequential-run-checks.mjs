export async function verifySequentialRunReplacement(snapshotStore, rootDir, meta, assertEqual) {
  const sessionId = 'session-sequential-runs'
  const firstRun = {
    schemaVersion: 1,
    id: 'run-sequential-first',
    sessionId,
    taskId: sessionId,
    status: 'completed',
    revision: 1,
    attempt: 1,
    recoveryCount: 0,
    createdAt: 4000,
    updatedAt: 4400,
    finishedAt: 4400,
    lastAppliedEventId: 'sequential-event-4',
    lastAppliedEventSeq: 4,
    recentEventIds: ['sequential-event-4'],
    steps: [],
    toolExecutions: [],
    effects: []
  }
  const firstSnapshot = snapshotStore.buildTaskSnapshot({
    meta: meta(sessionId, 'idle'),
    transcript: [],
    lastSeq: 4,
    lastEventId: 'sequential-event-4',
    lastEventKind: 'turn-result',
    eventCount: 4,
    reason: 'important-event',
    run: firstRun,
    now: 4400
  })
  await snapshotStore.saveTaskSnapshot(firstSnapshot, rootDir)

  const secondRun = {
    ...firstRun,
    id: 'run-sequential-second',
    status: 'executing',
    createdAt: 5000,
    updatedAt: 5100,
    finishedAt: undefined,
    lastAppliedEventId: 'sequential-event-5',
    lastAppliedEventSeq: 5,
    recentEventIds: ['sequential-event-5']
  }
  const secondSnapshot = snapshotStore.buildTaskSnapshot({
    meta: meta(sessionId, 'running'),
    transcript: [],
    lastSeq: 5,
    lastEventId: 'sequential-event-5',
    lastEventKind: 'user-message',
    eventCount: 5,
    reason: 'important-event',
    run: secondRun,
    now: 5100
  })
  await snapshotStore.saveTaskSnapshot(secondSnapshot, rootDir)
  assertEqual((await snapshotStore.getTaskSnapshot(sessionId, rootDir)).run.id, secondRun.id)

  await snapshotStore.saveTaskSnapshot(firstSnapshot, rootDir)
  assertEqual((await snapshotStore.getTaskSnapshot(sessionId, rootDir)).run.id, secondRun.id)
  const cancelledSecondRun = {
    ...secondRun,
    status: 'cancelled',
    revision: 2,
    updatedAt: 5200,
    finishedAt: 5200
  }
  assertEqual(await snapshotStore.deleteTaskSnapshot(sessionId, rootDir, cancelledSecondRun), true)
  assertEqual((await snapshotStore.listTaskSnapshots(rootDir)).length, 0)
  const runs = await snapshotStore.listTaskRuns(sessionId, rootDir)
  assertEqual(runs.length, 2)
  assertEqual(runs.find((run) => run.id === secondRun.id).status, 'cancelled')
}
