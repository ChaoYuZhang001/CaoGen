import type { AgentDeskApi, SessionQueryInput } from '../shared/types'
import { invokeAppFeature } from './app-feature'

export const sessionQueryApi: Pick<AgentDeskApi, 'querySessions'> = {
  querySessions: (input?: SessionQueryInput) =>
    invokeAppFeature('session-query', 'query', input)
}
