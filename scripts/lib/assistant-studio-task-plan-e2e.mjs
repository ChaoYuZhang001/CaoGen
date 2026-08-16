export function waitForApprovedPlanCompletion(page, sessionId, waitForValue) {
  return waitForValue(
    () => page.evaluate(async (parentSessionId) => {
      const [sessions, transcript] = await Promise.all([
        window.agentDesk.listSessions(),
        window.agentDesk.getTranscript(parentSessionId)
      ])
      const execution = [...transcript].reverse()
        .find((entry) => entry.event?.kind === 'task-dag-update' &&
          entry.event.execution?.id?.startsWith('plan-dag-'))?.event.execution
      const summaryMessageId = execution?.finalization?.summaryMessageId
      const summaryIndex = summaryMessageId
        ? transcript.findIndex((entry) =>
            entry.event?.kind === 'user-message' && entry.event.messageId === summaryMessageId)
        : -1
      const summaryCompleted = summaryIndex >= 0 && transcript
        .slice(summaryIndex + 1)
        .some((entry) => entry.event?.kind === 'turn-result')
      const children = sessions.filter((item) => item.parentSessionId === parentSessionId)
      return {
        executionStatus: execution?.status,
        finalizationPhase: execution?.finalization?.phase,
        summaryMessageId,
        summaryCompleted,
        parentStatus: sessions.find((item) => item.id === parentSessionId)?.status,
        sessionCount: sessions.length,
        children: children.map((item) => ({ id: item.id, isolated: item.isolated, status: item.status }))
      }
    }, sessionId),
    (value) => Boolean(
      (value.executionStatus === 'success' || value.executionStatus === 'failed') &&
      value.finalizationPhase === 'completed' && value.summaryCompleted && value.parentStatus === 'idle'
    ),
    30_000,
    'waiting for approved plan DAG and parent summary completion'
  )
}

export async function verifyRevokedPlanGates(page, sessionId, assert) {
  const result = await page.evaluate(async (id) => {
    const plan = await window.agentDesk.getTaskPlan(id)
    const current = plan.currentVersion
    if (!current) throw new Error('current plan missing')
    await window.agentDesk.revokeTaskPlanApproval(id, { version: current.version, digest: current.digest })
    const beforeSessions = await window.agentDesk.listSessions()
    const beforeTranscript = await window.agentDesk.getTranscript(id)
    const captureRejection = async (operation) => operation().then(
      () => '',
      (error) => error instanceof Error ? error.message : String(error)
    )
    const subagentRejection = await captureRejection(() =>
      window.agentDesk.dispatchSubagents(id, { tasks: [{ id: 'blocked', prompt: 'must not run' }] }))
    const dagRejection = await captureRejection(() => window.agentDesk.dispatchTaskDag(id, {
      dag: {
        id: 'blocked-dag', title: 'Blocked DAG', source: 'ui-e2e', complexity: 'single', createdAt: Date.now(),
        tasks: [{
          id: 'blocked', title: 'Blocked', description: 'must not run', dependencies: [], role: 'qa', prompt: 'must not run'
        }]
      }
    }))
    await window.agentDesk.sendMessage(id, { text: 'must not enter the transcript' })
    const afterSessions = await window.agentDesk.listSessions()
    const afterTranscript = await window.agentDesk.getTranscript(id)
    await window.agentDesk.approveTaskPlan(id, { version: current.version, digest: current.digest })
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    const restoredTranscript = await window.agentDesk.getTranscript(id)
    return {
      subagentRejection,
      dagRejection,
      sessionCountBefore: beforeSessions.length,
      sessionCountAfter: afterSessions.length,
      transcriptCountBefore: beforeTranscript.length,
      transcriptCountAfter: afterTranscript.length,
      transcriptCountAfterRestore: restoredTranscript.length,
      rejectedMessagePresent: restoredTranscript.some((entry) => entry.event?.text === 'must not enter the transcript'),
      lastError: afterSessions.find((item) => item.id === id)?.lastError
    }
  }, sessionId)
  assert(/尚未批准|取代/.test(result.subagentRejection), `subagent gate missing: ${JSON.stringify(result)}`)
  assert(/尚未批准|取代/.test(result.dagRejection), `DAG gate missing: ${JSON.stringify(result)}`)
  assert(result.sessionCountAfter === result.sessionCountBefore, `rejected dispatch created a session: ${JSON.stringify(result)}`)
  assert(result.transcriptCountAfter === result.transcriptCountBefore, `rejected send entered transcript: ${JSON.stringify(result)}`)
  assert(result.transcriptCountAfterRestore === result.transcriptCountBefore && !result.rejectedMessagePresent,
    `rejected send resumed after approval restoration: ${JSON.stringify(result)}`)
  assert(/尚未批准|取代/.test(result.lastError ?? ''), `send gate missing: ${JSON.stringify(result)}`)
}
