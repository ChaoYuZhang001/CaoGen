const sessionOperationQueues = new Map<string, Promise<void>>()

/** Serializes every action that can start or rewind one Session's execution state. */
export function withSessionOperationQueue<T>(
  sessionId: string,
  task: () => T | Promise<T>
): Promise<T> {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId || normalizedSessionId.includes('\0')) {
    return Promise.reject(new Error('sessionId 不能为空或包含非法字符'))
  }
  const previous = sessionOperationQueues.get(normalizedSessionId) ?? Promise.resolve()
  const execution = previous.then(task, task)
  const released = execution.then(() => undefined, () => undefined)
  sessionOperationQueues.set(normalizedSessionId, released)
  void released.finally(() => {
    if (sessionOperationQueues.get(normalizedSessionId) === released) {
      sessionOperationQueues.delete(normalizedSessionId)
    }
  })
  return execution
}
