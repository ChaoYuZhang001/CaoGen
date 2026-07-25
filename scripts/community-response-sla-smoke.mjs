#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  COMMUNITY_RESPONSE_SLA_HOURS,
  classifyCommunityFeedback,
  isMaintainerAssociation,
  summarizeCommunityFeedback
} from './lib/community-response-sla.mjs'

const now = '2026-07-26T12:00:00.000Z'
const item = (overrides = {}) => ({
  kind: 'issue',
  number: 17,
  title: 'External feedback',
  url: 'https://github.com/example/repo/issues/17',
  createdAt: '2026-07-24T13:00:00.000Z',
  authorAssociation: 'NONE',
  responses: [],
  ...overrides
})

assert.equal(COMMUNITY_RESPONSE_SLA_HOURS, 48)
assert.equal(isMaintainerAssociation('OWNER'), true)
assert.equal(isMaintainerAssociation('member'), true)
assert.equal(isMaintainerAssociation('CONTRIBUTOR'), false)
assert.equal(classifyCommunityFeedback(item(), { now }).status, 'pending')
assert.equal(
  classifyCommunityFeedback(item({ createdAt: '2026-07-24T11:00:00.000Z' }), { now }).status,
  'overdue'
)
assert.equal(
  classifyCommunityFeedback(item({
    responses: [{ createdAt: '2026-07-26T12:59:59.000Z', authorAssociation: 'COLLABORATOR' }]
  }), { now: '2026-07-27T12:00:00.000Z' }).status,
  'responded_on_time'
)
assert.equal(
  classifyCommunityFeedback(item({
    responses: [{ createdAt: '2026-07-26T13:00:01.000Z', authorAssociation: 'OWNER' }]
  }), { now: '2026-07-27T12:00:00.000Z' }).status,
  'responded_late'
)
assert.equal(
  classifyCommunityFeedback(item({
    responses: [{ createdAt: '2026-07-24T14:00:00.000Z', authorAssociation: 'NONE' }]
  }), { now: '2026-07-27T12:00:00.000Z' }).status,
  'overdue'
)
assert.equal(
  classifyCommunityFeedback(item({ authorAssociation: 'OWNER' }), { now }).status,
  'maintainer_authored'
)

const summary = summarizeCommunityFeedback([
  item(),
  item({ number: 18, createdAt: '2026-07-24T11:00:00.000Z' }),
  item({ number: 19, authorAssociation: 'MEMBER' })
], { now })
assert.deepEqual(summary.counts, {
  total: 3,
  maintainer_authored: 1,
  pending: 1,
  overdue: 1,
  responded_on_time: 0,
  responded_late: 0
})

assert.throws(() => classifyCommunityFeedback(item({ createdAt: 'invalid' }), { now }), /valid timestamp/)
assert.throws(() => classifyCommunityFeedback(item(), { now, slaHours: 0 }), /greater than zero/)

console.log('community response SLA smoke ok')
