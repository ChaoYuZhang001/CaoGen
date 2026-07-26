#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expandDiscussionFeedback, summarizeCommunityFeedback } from './lib/community-response-sla.mjs'

const repoRoot = process.cwd()
const required = process.argv.includes('--required')
const liveRequested = process.argv.includes('--live')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const reportRoot = path.join(repoRoot, 'test-results', 'community-feedback-audit')
const reportDir = path.join(reportRoot, runId)
const failures = []
const warnings = []
const checks = []

validateStaticContract()
let live = null
if (liveRequested) {
  try {
    live = await auditLiveCommunity()
  } catch (error) {
    failures.push(`live community audit failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  required,
  liveRequested,
  runId,
  reportDir,
  policy: {
    channel: 'GitHub Issues, Pull Requests, and Discussions',
    firstResponseHours: 48,
    maintainerAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    automatedRepliesCount: false,
    currentOverdueBlocks: true,
    historicalLateResponseWarns: true
  },
  checks,
  live,
  warnings,
  failures
}

mkdirSync(reportDir, { recursive: true })
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
writeFileSync(path.join(reportRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
if (report.status !== 'passed') process.exitCode = 1

function validateStaticContract() {
  requireSnippets('SUPPORT.md', [
    '48 小时内收到维护者首次回应',
    'initial maintainer response within 48 hours',
    '/discussions/categories/general',
    '/discussions/categories/ideas',
    '/discussions/categories/q-a',
    'SECURITY.md'
  ])
  requireSnippets('README.md', ['SUPPORT.md', 'GitHub Discussions'])
  requireSnippets('README.en.md', ['SUPPORT.md', 'GitHub Discussions'])
  requireSnippets('CONTRIBUTING.md', ['Issue、Pull Request 和 Discussion', 'issue, pull request, and discussion'])
  requireSnippets('.github/ISSUE_TEMPLATE/config.yml', [
    '/discussions/categories/q-a',
    '/discussions/categories/general',
    'Security report / 安全报告'
  ])
  for (const slug of ['general', 'ideas', 'q-a']) {
    requireSnippets(`.github/DISCUSSION_TEMPLATE/${slug}.yml`, ['body:', 'validations:', 'required: true'])
  }
  requireSnippets('.github/workflows/community-response-sla.yml', [
    'schedule:',
    "cron: '23 */6 * * *'",
    'discussion_comment:',
    'discussions: read',
    'issues: read',
    'pull-requests: read',
    'node scripts/community-feedback-audit.mjs --required --live'
  ])
  requireSnippets('package.json', [
    'test:community-feedback:required',
    'test:community-feedback:live:required',
    'test:community-feedback:smoke'
  ])
  requireSnippets('scripts/deep-test.mjs', [
    'community feedback contract audit',
    'community response SLA smoke'
  ])
  requireSnippets('scripts/community-feedback-audit.mjs', [
    'issues(states: [OPEN, CLOSED]',
    'pullRequests(states: [OPEN, CLOSED, MERGED]'
  ])
}

async function auditLiveCommunity() {
  const token = resolveToken()
  const repository = argValue('--repository') || process.env.CAOGEN_COMMUNITY_REPOSITORY || process.env.GITHUB_REPOSITORY || 'ChaoYuZhang001/CaoGen'
  const [owner, name, extra] = repository.split('/')
  if (!owner || !name || extra) throw new Error('repository must use OWNER/NAME')

  const metadata = await graphql(token, repositoryMetadataQuery(), { owner, name })
  const repo = metadata.repository
  if (!repo) throw new Error(`repository not found: ${repository}`)
  const categorySlugs = validateLiveCategories(repo)

  const issues = await loadIssues(token, owner, name)
  const pullRequests = await loadPullRequests(token, owner, name)
  const discussionFeedback = await loadDiscussions(token, owner, name)
  const summary = summarizeCommunityFeedback([...issues, ...pullRequests, ...discussionFeedback.items])
  recordResponseResults(summary)

  return {
    repository,
    repositoryUrl: repo.url,
    discussionsEnabled: repo.hasDiscussionsEnabled,
    categorySlugs,
    scanned: {
      issues: issues.length,
      pullRequests: pullRequests.length,
      discussions: discussionFeedback.discussionCount,
      discussionCommentThreads: discussionFeedback.commentThreadCount
    },
    ...summary
  }
}

function validateLiveCategories(repo) {
  const categorySlugs = repo.discussionCategories.nodes.map((category) => category.slug).sort()
  if (!repo.hasDiscussionsEnabled) failures.push('GitHub Discussions is not enabled')
  for (const slug of ['general', 'ideas', 'q-a']) {
    if (!categorySlugs.includes(slug)) failures.push(`live Discussion category is missing: ${slug}`)
  }
  return categorySlugs
}

function recordResponseResults(summary) {
  for (const item of summary.items.filter((candidate) => candidate.status === 'overdue')) {
    failures.push(`overdue ${item.kind} #${item.number}: ${item.url}`)
  }
  for (const item of summary.items.filter((candidate) => candidate.status === 'responded_late')) {
    warnings.push(`late maintainer response for ${item.kind} #${item.number}: ${item.url}`)
  }
}

async function loadIssues(token, owner, name) {
  return loadConnection(token, issueQuery(), 'issues', { owner, name }, (node) => ({
    kind: 'issue',
    ...commonItem(node),
    responses: node.comments.nodes
  }))
}

async function loadPullRequests(token, owner, name) {
  return loadConnection(token, pullRequestQuery(), 'pullRequests', { owner, name }, (node) => ({
    kind: 'pull_request',
    ...commonItem(node),
    responses: [
      ...node.comments.nodes,
      ...node.reviews.nodes.filter((review) => review.submittedAt).map((review) => ({
        createdAt: review.submittedAt,
        authorAssociation: review.authorAssociation
      }))
    ]
  }))
}

async function loadDiscussions(token, owner, name) {
  const discussions = await loadConnection(token, discussionQuery(), 'discussions', { owner, name }, (node) => node)
  const items = discussions.flatMap(expandDiscussionFeedback)
  return {
    items,
    discussionCount: discussions.length,
    commentThreadCount: items.filter((item) => item.kind === 'discussion_comment').length
  }
}

async function loadConnection(token, query, connectionName, variables, mapNode) {
  const items = []
  let after = null
  do {
    const data = await graphql(token, query, { ...variables, after })
    const connection = data.repository?.[connectionName]
    if (!connection) throw new Error(`missing GraphQL connection: ${connectionName}`)
    for (const node of connection.nodes) items.push(mapNode(node))
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
  } while (after)
  return items
}

function commonItem(node) {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    authorAssociation: node.authorAssociation
  }
}

async function graphql(token, query, variables) {
  const transientStatuses = new Set([502, 503, 504])
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'caogen-community-response-audit'
      },
      body: JSON.stringify({ query, variables })
    })
    const responseText = await response.text()
    const payload = parseJson(responseText)
    if (response.ok) {
      if (payload?.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '))
      if (!payload?.data) throw new Error('GitHub GraphQL response did not include data')
      return payload.data
    }
    if (!transientStatuses.has(response.status) || attempt === 3) {
      throw new Error(`GitHub GraphQL HTTP ${response.status}`)
    }
    warnings.push(`GitHub GraphQL HTTP ${response.status}; retry ${attempt}/3`)
    await delay(attempt * 500)
  }
  throw new Error('GitHub GraphQL retry loop exhausted')
}

function parseJson(value) {
  try { return JSON.parse(value) } catch { return null }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function resolveToken() {
  const fromEnv = process.env.CAOGEN_COMMUNITY_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv?.trim()) return fromEnv.trim()
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (token) return token
  } catch {}
  throw new Error('live audit requires CAOGEN_COMMUNITY_TOKEN, GITHUB_TOKEN, GH_TOKEN, or an authenticated gh CLI')
}

function requireSnippets(relativePath, snippets) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!existsSync(absolutePath)) {
    failures.push(`required community file is missing: ${relativePath}`)
    return
  }
  const source = readFileSync(absolutePath, 'utf8')
  const missing = snippets.filter((snippet) => !source.includes(snippet))
  if (missing.length > 0) failures.push(`${relativePath} is missing: ${missing.join(', ')}`)
  else checks.push(relativePath)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function repositoryMetadataQuery() {
  return `
    query CommunityRepository($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        url
        hasDiscussionsEnabled
        discussionCategories(first: 50) { nodes { slug } }
      }
    }
  `
}

function issueQuery() {
  return `
    query CommunityIssues($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        issues(states: [OPEN, CLOSED], first: 50, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number title url createdAt authorAssociation
            comments(first: 100) { nodes { createdAt authorAssociation } }
          }
        }
      }
    }
  `
}

function pullRequestQuery() {
  return `
    query CommunityPullRequests($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: [OPEN, CLOSED, MERGED], first: 50, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number title url createdAt authorAssociation
            comments(first: 100) { nodes { createdAt authorAssociation } }
            reviews(first: 100) { nodes { submittedAt authorAssociation } }
          }
        }
      }
    }
  `
}

function discussionQuery() {
  return `
    query CommunityDiscussions($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        discussions(first: 20, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number title url createdAt authorAssociation
            comments(first: 50) {
              nodes {
                url createdAt authorAssociation
                replies(first: 20) { nodes { createdAt authorAssociation } }
              }
            }
          }
        }
      }
    }
  `
}
