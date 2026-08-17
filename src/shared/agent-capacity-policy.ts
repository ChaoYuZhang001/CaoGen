/** Desktop orchestration capacity: three entry leads and two active children per lead. */
export const PRIMARY_AGENT_ENTRANCE_COUNT = 3
export const MAX_ACTIVE_PRIMARY_AGENTS = PRIMARY_AGENT_ENTRANCE_COUNT
export const MAX_ACTIVE_CHILD_AGENTS_PER_PRIMARY = 2
export const MAX_ACTIVE_CHILD_AGENTS =
  PRIMARY_AGENT_ENTRANCE_COUNT * MAX_ACTIVE_CHILD_AGENTS_PER_PRIMARY
export const MAX_ACTIVE_AGENT_COUNT = MAX_ACTIVE_PRIMARY_AGENTS + MAX_ACTIVE_CHILD_AGENTS

/** A DAG may remain broad; tasks beyond the active child slots wait in the scheduler. */
export const MAX_TASKS_PER_DAG = 33
export const MAX_DIRECT_SUBAGENT_TASKS = MAX_ACTIVE_CHILD_AGENTS_PER_PRIMARY
export const DIRECT_SUBAGENT_LIMIT_MESSAGE =
  `每个主 Agent 同时最多直接派发 ${MAX_DIRECT_SUBAGENT_TASKS} 个子 Agent；更多任务请使用 DAG 排队`
