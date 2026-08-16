#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.cwd()
const tempRoot = mkdtempSync(path.join(tmpdir(), 'caogen-open-source-agent-migration-'))
const outDir = path.join(tempRoot, 'compiled')
const home = path.join(tempRoot, 'home')
const project = path.join(tempRoot, 'project')
const caogenRoot = path.join(tempRoot, 'caogen-user-data')
const backupRoot = path.join(tempRoot, 'backups')
const secret = ['open', 'source', 'migration', 'secret', 'canary', '24681357'].join('-')
const checks = []

try {
  compile()
  createFixture()
  const migration = await import(pathToFileURL(findCompiled('migration.js')).href)
  const memoryStore = await import(pathToFileURL(findCompiled('memoryStore.js')).href)
  const routineStore = await import(pathToFileURL(findCompiled('routineStore.js')).href)
  const scanMigration = (...args) => migration.scanMigration(args.length > 0 ? args[0] : project, home, caogenRoot)

  const scan = scanMigration()
  const openClawAssets = scan.assets.filter((asset) => asset.agent === 'OpenClaw')
  const hermesAssets = scan.assets.filter((asset) => asset.agent === 'Hermes Agent')
  const clineAssets = scan.assets.filter((asset) => asset.agent === 'Cline')
  const continueAssets = scan.assets.filter((asset) => asset.agent === 'Continue')
  const geminiAssets = scan.assets.filter((asset) => asset.agent === 'Gemini CLI')
  const qwenAssets = scan.assets.filter((asset) => asset.agent === 'Qwen Code')
  const openCodeAssets = scan.assets.filter((asset) => asset.agent === 'OpenCode')
  assert(openClawAssets.some((asset) => asset.kind === 'config' && !asset.importable), 'OpenClaw full config is review-only')
  assert(hermesAssets.some((asset) => asset.kind === 'config' && !asset.importable), 'Hermes full config is review-only')
  equal(continueAssets.filter((asset) => asset.kind === 'config').length, 2, 'Continue project and user configs are detected')
  assert(continueAssets.filter((asset) => asset.kind === 'config').every((asset) => !asset.importable), 'Continue full configs remain blocked')
  assert(geminiAssets.filter((asset) => asset.kind === 'config').length === 2, 'Gemini project and user configs are detected')
  assert(geminiAssets.filter((asset) => asset.kind === 'config').every((asset) => !asset.importable), 'Gemini full configs remain blocked')
  assert(qwenAssets.filter((asset) => asset.kind === 'config').length === 2, 'Qwen project and user configs are detected')
  assert(qwenAssets.filter((asset) => asset.kind === 'config').every((asset) => !asset.importable), 'Qwen full configs remain blocked')
  assert(openCodeAssets.filter((asset) => asset.kind === 'config').length === 2, 'OpenCode project and user configs are detected')
  assert(openCodeAssets.filter((asset) => asset.kind === 'config').every((asset) => !asset.importable), 'OpenCode full configs remain blocked')
  equal(openClawAssets.filter((asset) => asset.kind === 'mcp').length, 2, 'OpenClaw JSON5 comments and trailing commas parse')
  equal(hermesAssets.filter((asset) => asset.kind === 'mcp').length, 2, 'Hermes YAML MCP entries parse')
  equal(clineAssets.filter((asset) => asset.kind === 'mcp').length, 5, 'Cline project, CLI, and shared IDE MCP entries parse')
  equal(continueAssets.filter((asset) => asset.kind === 'mcp').length, 3, 'Continue config and standalone YAML/JSON MCP entries parse')
  equal(geminiAssets.filter((asset) => asset.kind === 'mcp').length, 3, 'Gemini project and user MCP entries parse')
  equal(qwenAssets.filter((asset) => asset.kind === 'mcp').length, 2, 'Qwen project and user MCP entries parse')
  equal(openCodeAssets.filter((asset) => asset.kind === 'mcp').length, 2, 'OpenCode JSON and JSONC MCP entries parse')
  equal(clineAssets.filter((asset) => asset.kind === 'rules').length, 4, 'Cline file, directory, and global rules are detected')
  equal(continueAssets.filter((asset) => asset.kind === 'rules').length, 1, 'Continue project rules are detected')
  equal(geminiAssets.filter((asset) => asset.kind === 'rules').length, 2, 'Gemini project and user GEMINI.md rules are detected')
  equal(qwenAssets.filter((asset) => asset.kind === 'rules').length, 2, 'Qwen project and user QWEN.md rules are detected')
  equal(openCodeAssets.filter((asset) => asset.kind === 'rules').length, 1, 'OpenCode global AGENTS.md rules are detected without duplicating project AGENTS.md')
  equal(clineAssets.filter((asset) => asset.kind === 'skill').length, 2, 'Cline project and user Skills are discovered')
  equal(geminiAssets.filter((asset) => asset.kind === 'skill').length, 2, 'Gemini project and user Skills are discovered')
  equal(qwenAssets.filter((asset) => asset.kind === 'skill').length, 2, 'Qwen project and user Skills are discovered')
  equal(openCodeAssets.filter((asset) => asset.kind === 'skill').length, 2, 'OpenCode project and user Skills are discovered')
  assert(openClawAssets.some((asset) => asset.kind === 'skill' && asset.name === 'research/web'), 'nested OpenClaw user Skill is discovered')
  assert(openClawAssets.some((asset) => asset.kind === 'skill' && asset.name === 'shared'), 'OpenClaw workspace Skill is discovered')
  assert(hermesAssets.some((asset) => asset.kind === 'skill' && asset.name === 'writing/office/report'), 'three-level Hermes Skill is discovered')
  assert(openClawAssets.some((asset) => asset.kind === 'memory' && asset.importable && asset.risk === 'review' && !asset.recommended), 'OpenClaw memory is an unselected review draft')
  assert(openClawAssets.some((asset) => asset.kind === 'memory' && !asset.importable && asset.risk === 'blocked'), 'credential-bearing OpenClaw memory is blocked')
  assert(hermesAssets.some((asset) => asset.kind === 'memory' && asset.importable), 'Hermes memory is discovered as a project draft')
  assert(openClawAssets.filter((asset) => asset.kind === 'routine' && asset.importable).length === 2, 'safe OpenClaw Cron jobs become disabled routine drafts')
  assert(openClawAssets.filter((asset) => asset.kind === 'routine' && !asset.importable).length === 2, 'script and credential-bearing OpenClaw Cron jobs are blocked')
  assert(hermesAssets.some((asset) => asset.kind === 'routine' && asset.importable), 'Hermes Cron jobs are discovered')
  assert(openClawAssets.some((asset) => asset.kind === 'channel' && asset.importable && !asset.recommended), 'OpenClaw Channel becomes an unselected sanitized index')
  assert(hermesAssets.some((asset) => asset.kind === 'channel' && asset.importable && !asset.recommended), 'Hermes Channel becomes an unselected sanitized index')
  assert(scan.diagnostics.some((item) => item.code === 'migration_source_symlink'), 'Skill symlink is rejected with a diagnostic')
  assert(scan.diagnostics.some((item) => item.code === 'migration_source_file_limit'), 'oversized Skill file set is rejected')
  assert(scan.diagnostics.some((item) => item.code === 'migration_source_symlink'), 'memory symlink is rejected')
  assert(scan.diagnostics.some((item) => item.code === 'migration_source_size_invalid'), 'oversized memory directory is rejected')
  assert(!JSON.stringify(scan).includes(secret), 'secret canary never enters scan output')

  const blockedSkill = openClawAssets.find((asset) => asset.kind === 'skill' && asset.name === 'secret-skill')
  assert(blockedSkill?.risk === 'blocked' && !blockedSkill.importable, 'secret-bearing Skill is blocked')
  const openRemote = findAsset(openClawAssets, 'mcp', 'open-remote')
  assert(openRemote.ignoredFields.includes('headers') && openRemote.ignoredFields.includes('url.query_or_fragment'), 'OpenClaw headers and URL credentials are stripped')
  const hermesStdio = findAsset(hermesAssets, 'mcp', 'hermes-stdio')
  assert(hermesStdio.ignoredFields.includes('env') && hermesStdio.ignoredFields.some((field) => field.startsWith('args.')), 'Hermes env and credential CLI args are stripped')
  const clineStdio = findAsset(clineAssets, 'mcp', 'cline-stdio')
  assert(clineStdio.ignoredFields.includes('env') && clineStdio.ignoredFields.some((field) => field.startsWith('args.')), 'Cline env and credential CLI args are stripped')
  const clineHttp = findAsset(clineAssets, 'mcp', 'cline-http')
  assert(clineHttp.ignoredFields.includes('headers') && clineHttp.ignoredFields.includes('url.query_or_fragment'), 'Cline HTTP headers and URL credentials are stripped')
  const unsafeClineMcp = findAsset(clineAssets, 'mcp', 'constructor')
  assert(!unsafeClineMcp.importable && unsafeClineMcp.risk === 'blocked', 'dangerous Cline MCP names fail closed')
  const continueProjectMcp = findAsset(continueAssets, 'mcp', 'continue-project')
  assert(continueProjectMcp.ignoredFields.includes('env') && continueProjectMcp.ignoredFields.some((field) => field.startsWith('args.')), 'Continue env and credential CLI args are stripped')
  const continueUserMcp = findAsset(continueAssets, 'mcp', 'continue-user')
  assert(continueUserMcp.ignoredFields.includes('apiKey') && continueUserMcp.ignoredFields.includes('requestOptions') && continueUserMcp.ignoredFields.includes('url.query_or_fragment'), 'Continue API Key, request options, and URL credentials are stripped')
  const geminiStdio = findAsset(geminiAssets, 'mcp', 'gemini-stdio')
  assert(geminiStdio.ignoredFields.includes('env') && geminiStdio.ignoredFields.some((field) => field.startsWith('args.')), 'Gemini env and credential CLI args are stripped')
  const geminiHttp = findAsset(geminiAssets, 'mcp', 'gemini-http')
  assert(geminiHttp.ignoredFields.includes('headers') && geminiHttp.ignoredFields.includes('url.query_or_fragment'), 'Gemini httpUrl remote credentials are stripped')
  const geminiSse = findAsset(geminiAssets, 'mcp', 'gemini-sse')
  assert(geminiSse.ignoredFields.includes('headers'), 'Gemini SSE headers are stripped')
  const qwenProjectMcp = findAsset(qwenAssets, 'mcp', 'qwen-project')
  assert(qwenProjectMcp.ignoredFields.includes('env') && qwenProjectMcp.ignoredFields.some((field) => field.startsWith('args.')), 'Qwen env and credential CLI args are stripped')
  const openCodeLocal = findAsset(openCodeAssets, 'mcp', 'opencode-local')
  assert(openCodeLocal.ignoredFields.includes('env') && openCodeLocal.ignoredFields.some((field) => field.startsWith('args.')), 'OpenCode environment and credential command args are stripped')
  const openCodeRemote = findAsset(openCodeAssets, 'mcp', 'opencode-remote')
  assert(openCodeRemote.ignoredFields.includes('headers') && openCodeRemote.ignoredFields.includes('oauth'), 'OpenCode remote credentials and OAuth policy are not copied')

  const selected = [...openClawAssets, ...hermesAssets, ...clineAssets, ...continueAssets, ...geminiAssets, ...qwenAssets, ...openCodeAssets].filter((asset) => asset.importable)
  const applied = migration.applyMigration({
    scanId: scan.scanId,
    decisions: scan.assets.map((asset) => ({ assetId: asset.id, action: asset.importable && selected.includes(asset) ? 'import' : 'skip' }))
  }, { backupRoot })
  assert(applied.ok && applied.status === 'applied', 'open-source agent assets apply as one batch')
  equal(applied.applied.length, selected.length, 'every selected safe asset is applied')

  const settings = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
  assert(settings.mcpServers['open-remote'].disabled === true, 'OpenClaw enabled=false remains disabled after migration')
  assert(!settings.mcpServers['open-remote'].url.includes('?') && !Object.hasOwn(settings.mcpServers['open-remote'], 'headers'), 'remote MCP target excludes query credentials and headers')
  equal(settings.mcpServers['hermes-stdio'].args, ['--safe'], 'credential CLI flag and its value are removed')
  assert(!Object.hasOwn(settings.mcpServers['hermes-stdio'], 'env'), 'MCP environment is absent from target')
  assert(settings.mcpServers['cline-http'].transport === 'http', 'Cline streamableHttp maps to HTTP transport')
  assert(!settings.mcpServers['cline-http'].url.includes('?') && !Object.hasOwn(settings.mcpServers['cline-http'], 'headers'), 'Cline remote credentials are absent from target')
  equal(settings.mcpServers['cline-stdio'].args, ['--safe'], 'Cline credential args are removed from the user MCP target')
  assert(settings.mcpServers['continue-user'].transport === 'http', 'Continue streamable-http maps to HTTP transport')
  assert(!settings.mcpServers['continue-user'].url.includes('?') && !Object.hasOwn(settings.mcpServers['continue-user'], 'apiKey'), 'Continue user credentials are absent from target')
  assert(settings.mcpServers['gemini-sse'].transport === 'sse', 'Gemini SSE transport is preserved after migration')
  assert(!settings.mcpServers['gemini-sse'].url.includes('?') && !Object.hasOwn(settings.mcpServers['gemini-sse'], 'headers'), 'Gemini user remote credentials are absent from target')
  assert(settings.mcpServers['qwen-remote'].disabled === true, 'Qwen enabled=false remains disabled after migration')
  assert(!settings.mcpServers['qwen-remote'].url.includes('?') && !Object.hasOwn(settings.mcpServers['qwen-remote'], 'headers'), 'Qwen remote credentials are absent from target')
  assert(settings.mcpServers['opencode-remote'].disabled === true, 'OpenCode enabled=false remains disabled after migration')
  assert(!settings.mcpServers['opencode-remote'].url.includes('?') && !Object.hasOwn(settings.mcpServers['opencode-remote'], 'headers'), 'OpenCode remote credentials are absent from target')
  const projectMcp = JSON.parse(readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers
  assert(projectMcp['cline-project'].transport === 'http', 'Cline project streamableHttp maps to HTTP transport')
  equal(projectMcp['continue-project'].args, ['--safe'], 'Continue credential args are removed from the project MCP target')
  assert(projectMcp['continue-http'].transport === 'http' && !projectMcp['continue-http'].url.includes('?'), 'Continue standalone JSON HTTP transport is preserved without URL credentials')
  equal(projectMcp['gemini-stdio'].args, ['--safe'], 'Gemini credential args are removed from the project MCP target')
  assert(!Object.hasOwn(projectMcp['gemini-stdio'], 'env'), 'Gemini environment is absent from the project MCP target')
  assert(projectMcp['gemini-http'].url === 'https://gemini-http.example.invalid/mcp' && projectMcp['gemini-http'].transport === 'http', 'Gemini httpUrl overrides url and forces HTTP transport')
  equal(projectMcp['qwen-project'].args, ['--safe'], 'Qwen credential args are removed from the project MCP target')
  equal(projectMcp['opencode-local'].command, 'npx', 'OpenCode command array is converted to the CaoGen command field')
  equal(projectMcp['opencode-local'].args, ['-y', 'opencode-mcp', '--safe'], 'OpenCode command tail becomes sanitized CaoGen args')
  assert(!Object.hasOwn(projectMcp['opencode-local'], 'env'), 'OpenCode environment is absent from the project MCP target')
  const projectRules = readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')
  assert(projectRules.includes('Cline') && projectRules.includes('Continue') && projectRules.includes('Gemini CLI') && projectRules.includes('Qwen Code'), 'Cline, Continue, Gemini, and Qwen project rules are merged into the managed project rules file')
  const userRules = readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')
  assert(userRules.includes('Cline') && userRules.includes('Gemini CLI') && userRules.includes('Qwen Code') && userRules.includes('OpenCode'), 'Cline, Gemini, Qwen, and OpenCode global rules are merged into the managed user rules file')
  assert(existsSync(path.join(project, '.claude', 'skills', 'cline--project-debug', 'SKILL.md')), 'Cline project Skill target is namespaced')
  assert(existsSync(path.join(project, '.claude', 'skills', 'gemini--project-planning', 'SKILL.md')), 'Gemini project Skill target is namespaced')
  assert(existsSync(path.join(project, '.claude', 'skills', 'qwen--project-review', 'SKILL.md')), 'Qwen project Skill target is namespaced')
  assert(existsSync(path.join(project, '.claude', 'skills', 'opencode--pr-review', 'SKILL.md')), 'OpenCode project Skill target is namespaced')
  assert(existsSync(path.join(home, '.claude', 'skills', 'cline--global-review', 'SKILL.md')), 'Cline user Skill target is namespaced')
  assert(existsSync(path.join(home, '.claude', 'skills', 'gemini--global-research', 'SKILL.md')), 'Gemini user Skill target is namespaced')
  assert(existsSync(path.join(home, '.claude', 'skills', 'qwen--global-review', 'SKILL.md')), 'Qwen user Skill target is namespaced')
  assert(existsSync(path.join(home, '.claude', 'skills', 'opencode--release-notes', 'SKILL.md')), 'OpenCode user Skill target is namespaced')
  assert(existsSync(path.join(project, '.claude', 'skills', 'openclaw--shared', 'SKILL.md')), 'workspace Skill target is namespaced')
  assert(existsSync(path.join(project, '.claude', 'skills', 'openclaw-agents--shared', 'SKILL.md')), 'agents Skill target cannot overwrite workspace Skill')
  assert(existsSync(path.join(home, '.claude', 'skills', 'hermes--writing--office--report', 'SKILL.md')), 'nested Hermes Skill target is deterministic')
  const projectMemory = await memoryStore.readProjectMemory(project, path.join(caogenRoot, 'memory'))
  assert(projectMemory.entries.length === 0 && projectMemory.drafts.length >= 2, 'runtime reads imported external memory only from the drafts bucket')
  assert(projectMemory.drafts.every((entry) => entry.status === 'draft' && entry.reason.includes('approval')), 'every imported memory remains explicitly untrusted')
  const routines = await routineStore.listRoutines(path.join(caogenRoot, 'routines'))
  assert(routines.length >= 3, 'multiple OpenClaw and Hermes jobs merge into one runtime-compatible routine store')
  assert(routines.every((routine) => !routine.enabled && routine.providerId === '' && routine.model === ''), 'all imported routines are disabled and provider-neutral')
  assert(routines.every((routine) => routine.permissionMode === 'plan' && routine.budgetUsd === 0), 'all imported routines use plan-only permission and zero budget')
  assert(routines.every((routine) => !routine.notification.enabled && !routine.notification.onSuccess && !routine.notification.onFailure), 'all imported routine notifications are disabled')
  assert(existsSync(path.join(caogenRoot, 'migration-imports', 'channels')), 'sanitized channel indexes are written to the migration report store')
  assert(!allFilesText(path.join(caogenRoot, 'migration-imports', 'channels')).includes(secret), 'channel indexes exclude credentials and identifiers')
  assert(!allFilesText(caogenRoot).includes(secret), 'all CaoGen migration targets exclude the credential canary')
  assert(!allFilesText(backupRoot).includes(secret), 'backup and journal files exclude source credentials')

  const rolledBack = migration.rollbackMigration(applied.backupId, backupRoot)
  assert(rolledBack.ok, 'batch rollback succeeds')
  assert(!existsSync(path.join(home, '.claude', 'settings.json')), 'rollback removes newly created MCP target')
  assert(!existsSync(path.join(project, '.mcp.json')), 'rollback removes newly created project MCP target')
  assert(!existsSync(path.join(project, 'CLAUDE.md')), 'rollback removes newly created project rules target')
  assert(!existsSync(path.join(home, '.claude', 'CLAUDE.md')), 'rollback removes newly created user rules target')
  assert(!existsSync(path.join(project, '.claude', 'skills', 'openclaw--shared')), 'rollback removes newly created project Skill')
  assert(!existsSync(path.join(caogenRoot, 'routines', 'routines.json')), 'rollback removes the newly created routine store')
  equal(allFilesText(path.join(caogenRoot, 'migration-imports', 'channels')), '', 'rollback removes sanitized channel index files')
  equal((await memoryStore.readProjectMemory(project, path.join(caogenRoot, 'memory'))).drafts.length, 0, 'rollback removes imported memory drafts')

  const conversationScan = scanMigration(undefined)
  assert(conversationScan.assets.filter((asset) => asset.kind === 'memory').every((asset) => !asset.importable), 'memory import is blocked without a project folder')
  assert(conversationScan.assets.filter((asset) => asset.kind === 'routine').every((asset) => !asset.importable), 'routine import is blocked without a project folder')
  assert(conversationScan.assets.some((asset) => asset.kind === 'channel' && asset.importable), 'sanitized channel indexes remain available without a project folder')

  const memoryDriftScan = scanMigration()
  const memoryDriftAsset = memoryDriftScan.assets.find((asset) => asset.agent === 'OpenClaw' && asset.kind === 'memory' && asset.importable)
  assert(memoryDriftAsset, 'safe memory asset exists for source drift test')
  const workspaceMemoryPath = path.join(project, 'MEMORY.md')
  const workspaceMemory = readFileSync(workspaceMemoryPath, 'utf8')
  writeFileSync(workspaceMemoryPath, '# Changed after memory preview\n')
  const memoryDrift = migration.applyMigration({
    scanId: memoryDriftScan.scanId,
    decisions: [{ assetId: memoryDriftAsset.id, action: 'import' }]
  }, { backupRoot })
  assert(!memoryDrift.ok && memoryDrift.errorCode === 'migration_source_changed', 'memory source drift fails closed')
  writeFileSync(workspaceMemoryPath, workspaceMemory)

  const memoryDuplicateScan = scanMigration()
  const memoryDuplicateAsset = memoryDuplicateScan.assets.find((asset) => asset.agent === 'OpenClaw' && asset.kind === 'memory' && asset.importable)
  assert(memoryDuplicateAsset, 'safe memory asset exists for duplicate test')
  const memoryImported = migration.applyMigration({
    scanId: memoryDuplicateScan.scanId,
    decisions: [{ assetId: memoryDuplicateAsset.id, action: 'import' }]
  }, { backupRoot })
  assert(memoryImported.ok, 'single memory draft imports')
  const memoryDuplicate = scanMigration().assets.find((asset) => asset.id === memoryDuplicateAsset.id)
  assert(memoryDuplicate?.conflict === 'duplicate' && !memoryDuplicate.importable, 'identical memory draft is classified as duplicate')
  assert(migration.rollbackMigration(memoryImported.backupId, backupRoot).ok, 'memory duplicate fixture rolls back')

  const routineDuplicateScan = scanMigration()
  const routineDuplicateAsset = routineDuplicateScan.assets.find((asset) => asset.agent === 'OpenClaw' && asset.kind === 'routine' && asset.importable)
  assert(routineDuplicateAsset, 'safe routine asset exists for duplicate test')
  const routineImported = migration.applyMigration({
    scanId: routineDuplicateScan.scanId,
    decisions: [{ assetId: routineDuplicateAsset.id, action: 'import' }]
  }, { backupRoot })
  assert(routineImported.ok, 'single disabled routine draft imports')
  const routineDuplicate = scanMigration().assets.find((asset) => asset.id === routineDuplicateAsset.id)
  assert(routineDuplicate?.conflict === 'duplicate' && !routineDuplicate.importable, 'identical routine draft is classified as duplicate')
  assert(migration.rollbackMigration(routineImported.backupId, backupRoot).ok, 'routine duplicate fixture rolls back')

  const replacementSeedScan = scanMigration()
  const replacementRoutine = replacementSeedScan.assets.find((asset) => asset.agent === 'OpenClaw' && asset.kind === 'routine' && asset.importable)
  assert(replacementRoutine, 'safe routine asset exists for replacement test')
  mkdirSync(path.dirname(replacementRoutine.targetPath), { recursive: true })
  const oldRoutineId = `migration-routine-${replacementRoutine.id.slice(-24)}`
  const oldRoutineStore = `${JSON.stringify({ version: 1, routines: [{
    id: oldRoutineId,
    name: 'Existing disabled draft',
    prompt: 'Existing content',
    content: 'Existing content',
    projectCwd: project,
    schedule: '@daily',
    frequency: '@daily',
    providerId: '',
    model: '',
    permissionMode: 'plan',
    budgetUsd: 0,
    notification: { enabled: false, onSuccess: false, onFailure: false },
    enabled: false,
    createdAt: 0,
    updatedAt: 0,
    lastRunAt: null
  }] }, null, 2)}\n`
  writeFileSync(replacementRoutine.targetPath, oldRoutineStore)
  const routineReplaceScan = scanMigration()
  const routineReplacement = routineReplaceScan.assets.find((asset) => asset.id === replacementRoutine.id)
  assert(routineReplacement?.conflict === 'replace_required' && routineReplacement.supportedActions.includes('replace'), 'routine ID conflict requires explicit replacement')
  const routineReplaced = migration.applyMigration({
    scanId: routineReplaceScan.scanId,
    decisions: [{ assetId: routineReplacement.id, action: 'replace' }]
  }, { backupRoot })
  assert(routineReplaced.ok, 'confirmed routine replacement succeeds')
  assert((await routineStore.listRoutines(path.join(caogenRoot, 'routines')))[0].migrationReviewRequired === true, 'routine replacement restores safe imported defaults')
  assert(migration.rollbackMigration(routineReplaced.backupId, backupRoot).ok, 'routine replacement rollback succeeds')
  equal(readFileSync(replacementRoutine.targetPath, 'utf8'), oldRoutineStore, 'routine replacement rollback restores prior bytes')
  rmSync(path.join(caogenRoot, 'routines'), { recursive: true, force: true })

  const faultScan = scanMigration()
  const faultAssets = ['memory', 'routine', 'channel'].map((kind) =>
    faultScan.assets.find((asset) => asset.kind === kind && asset.importable)).filter(Boolean)
  assert(new Set(faultAssets.map((asset) => asset.kind)).size >= 3, 'fault injection batch spans memory, routine, and channel targets')
  const faulted = migration.applyMigration({
    scanId: faultScan.scanId,
    decisions: faultAssets.map((asset) => ({ assetId: asset.id, action: 'import' }))
  }, { backupRoot, faultAfterWrites: 2 })
  assert(!faulted.ok && faulted.errorCode === 'migration_test_fault', 'fault injection reports the controlled failure')
  equal((await memoryStore.readProjectMemory(project, path.join(caogenRoot, 'memory'))).drafts.length, 0, 'fault rollback removes partial memory writes')
  equal((await routineStore.listRoutines(path.join(caogenRoot, 'routines'))).length, 0, 'fault rollback removes partial routine writes')
  equal(allFilesText(path.join(caogenRoot, 'migration-imports', 'channels')), '', 'fault rollback removes partial channel writes')

  const duplicateScan = scanMigration()
  const duplicateSource = findAsset(duplicateScan.assets.filter((asset) => asset.agent === 'OpenClaw'), 'skill', 'research/web')
  const duplicateApply = migration.applyMigration({
    scanId: duplicateScan.scanId,
    decisions: [{ assetId: duplicateSource.id, action: 'import' }]
  }, { backupRoot })
  assert(duplicateApply.ok, 'single Skill import succeeds before duplicate scan')
  const duplicateResult = scanMigration().assets.find((asset) => asset.id === duplicateSource.id)
  assert(duplicateResult?.conflict === 'duplicate' && !duplicateResult.importable, 'repeated identical Skill is classified as duplicate')
  assert(migration.rollbackMigration(duplicateApply.backupId, backupRoot).ok, 'duplicate fixture import rolls back')

  const replaceTarget = path.join(home, '.claude', 'skills', 'hermes--writing--office--report')
  writeSkill(replaceTarget, '# Existing target\n')
  const replaceScan = scanMigration()
  const replacement = findAsset(replaceScan.assets.filter((asset) => asset.agent === 'Hermes Agent'), 'skill', 'writing/office/report')
  assert(replacement.conflict === 'replace_required' && replacement.supportedActions.includes('replace'), 'existing Skill requires explicit replacement')
  const replaced = migration.applyMigration({
    scanId: replaceScan.scanId,
    decisions: [{ assetId: replacement.id, action: 'replace' }]
  }, { backupRoot })
  assert(replaced.ok && readFileSync(path.join(replaceTarget, 'SKILL.md'), 'utf8').includes('Hermes report Skill'), 'confirmed replacement writes source Skill')
  assert(migration.rollbackMigration(replaced.backupId, backupRoot).ok, 'replacement rollback succeeds')
  assert(readFileSync(path.join(replaceTarget, 'SKILL.md'), 'utf8').includes('Existing target'), 'replacement rollback restores prior directory')
  rmSync(path.join(home, '.claude'), { recursive: true, force: true })

  const sourceDriftScan = scanMigration()
  const sourceDriftAsset = findAsset(sourceDriftScan.assets.filter((asset) => asset.agent === 'OpenClaw'), 'skill', 'shared')
  writeSkill(path.join(project, 'skills', 'shared'), '# Changed after preview\n')
  const sourceDrift = migration.applyMigration({
    scanId: sourceDriftScan.scanId,
    decisions: [{ assetId: sourceDriftAsset.id, action: 'import' }]
  }, { backupRoot })
  assert(!sourceDrift.ok && sourceDrift.errorCode === 'migration_source_changed', 'Skill source drift fails closed')
  assert(!existsSync(sourceDriftAsset.targetPath), 'source drift does not mutate target')
  writeSkill(path.join(project, 'skills', 'shared'), '# OpenClaw workspace Skill\n')

  const targetDriftScan = scanMigration()
  const targetDriftAsset = findAsset(targetDriftScan.assets.filter((asset) => asset.agent === 'Hermes Agent'), 'mcp', 'hermes-stdio')
  mkdirSync(path.dirname(targetDriftAsset.targetPath), { recursive: true })
  writeFileSync(targetDriftAsset.targetPath, '{}\n')
  const targetDrift = migration.applyMigration({
    scanId: targetDriftScan.scanId,
    decisions: [{ assetId: targetDriftAsset.id, action: 'import' }]
  }, { backupRoot })
  assert(!targetDrift.ok && targetDrift.errorCode === 'migration_target_changed', 'MCP target drift fails closed')
  equal(readFileSync(targetDriftAsset.targetPath, 'utf8'), '{}\n', 'target drift preserves external bytes')
  rmSync(path.join(home, '.claude'), { recursive: true, force: true })

  const openClawConfig = path.join(home, '.openclaw', 'openclaw.json')
  const validOpenClawConfig = readFileSync(openClawConfig, 'utf8')
  writeFileSync(openClawConfig, '{ mcp: { servers: { broken: ] } }')
  const malformedJson5 = scanMigration()
  assert(malformedJson5.diagnostics.some((item) => item.path === openClawConfig), 'malformed OpenClaw JSON5 is reported without crashing scan')
  assert(!malformedJson5.assets.some((asset) => asset.agent === 'OpenClaw' && asset.kind === 'mcp'), 'malformed JSON5 produces no MCP assets')
  writeFileSync(openClawConfig, validOpenClawConfig)

  const openClawCron = path.join(home, '.openclaw', 'cron', 'jobs.json')
  const validOpenClawCron = readFileSync(openClawCron, 'utf8')
  writeFileSync(openClawCron, '{"jobs": [}')
  const malformedCron = scanMigration()
  assert(malformedCron.diagnostics.some((item) => item.path === openClawCron), 'malformed OpenClaw Cron JSON is reported without crashing scan')
  assert(!malformedCron.assets.some((asset) => asset.agent === 'OpenClaw' && asset.kind === 'routine'), 'malformed Cron JSON produces no routine drafts')
  writeFileSync(openClawCron, `${JSON.stringify({ jobs: Array.from({ length: 201 }, (_, index) => ({
    id: `job-${index}`,
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    payload: { kind: 'agentTurn', message: 'bounded job' }
  })) })}\n`)
  const excessiveCron = scanMigration()
  assert(excessiveCron.diagnostics.some((item) => item.path === openClawCron && item.code === 'migration_cron_job_limit'), 'Cron job count limit fails closed')
  assert(!excessiveCron.assets.some((asset) => asset.agent === 'OpenClaw' && asset.kind === 'routine'), 'over-limit Cron store produces no routine drafts')
  writeFileSync(openClawCron, validOpenClawCron)

  const hermesConfig = path.join(home, '.hermes', 'config.yaml')
  const validHermesConfig = readFileSync(hermesConfig, 'utf8')
  writeFileSync(hermesConfig, 'mcp_servers:\n  broken: [unterminated\n')
  const malformedYaml = scanMigration()
  assert(malformedYaml.diagnostics.some((item) => item.path === hermesConfig), 'malformed Hermes YAML is reported without crashing scan')
  assert(!malformedYaml.assets.some((asset) => asset.agent === 'Hermes Agent' && asset.kind === 'mcp'), 'malformed YAML produces no MCP assets')
  assert(!malformedYaml.assets.some((asset) => asset.agent === 'Hermes Agent' && asset.kind === 'channel' && asset.path === hermesConfig), 'malformed YAML produces no channel indexes from that config')
  writeFileSync(hermesConfig, validHermesConfig.replace('hermes-stdio:', 'open-stdio:'))

  const ambiguous = scanMigration().assets.filter((asset) => asset.kind === 'mcp' && asset.name === 'open-stdio')
  equal(ambiguous.length, 2, 'same-name MCP collision is detected across sources')
  assert(ambiguous.every((asset) => !asset.importable && asset.conflict === 'unsupported'), 'ambiguous MCP destinations are all blocked')

  const qwenProjectConfig = path.join(project, '.qwen', 'settings.json')
  const validQwenProjectConfig = readFileSync(qwenProjectConfig, 'utf8')
  writeFileSync(qwenProjectConfig, '{"mcpServers":{"broken":]}}')
  const malformedQwen = scanMigration()
  assert(malformedQwen.diagnostics.some((item) => item.path === qwenProjectConfig), 'malformed Qwen settings are reported without crashing scan')
  assert(!malformedQwen.assets.some((asset) => asset.agent === 'Qwen Code' && asset.kind === 'mcp' && asset.scope === 'project'), 'malformed Qwen settings produce no project MCP assets')
  writeFileSync(qwenProjectConfig, validQwenProjectConfig)

  const clineConfig = path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json')
  const validClineConfig = readFileSync(clineConfig, 'utf8')
  writeFileSync(clineConfig, '{"mcpServers":{"broken":]}}')
  const malformedCline = scanMigration()
  assert(malformedCline.diagnostics.some((item) => item.path === clineConfig), 'malformed Cline settings are reported without crashing scan')
  assert(!malformedCline.assets.some((asset) => asset.agent === 'Cline' && asset.kind === 'mcp' && asset.path === clineConfig), 'malformed Cline settings produce no MCP assets from that source')
  writeFileSync(clineConfig, validClineConfig)

  const continueConfig = path.join(home, '.continue', 'config.yaml')
  const validContinueConfig = readFileSync(continueConfig, 'utf8')
  writeFileSync(continueConfig, 'mcpServers:\n  - name: broken\n    args: [unterminated\n')
  const malformedContinue = scanMigration()
  assert(malformedContinue.diagnostics.some((item) => item.path === continueConfig), 'malformed Continue YAML is reported without crashing scan')
  assert(!malformedContinue.assets.some((asset) => asset.agent === 'Continue' && asset.kind === 'mcp' && asset.path === continueConfig), 'malformed Continue YAML produces no MCP assets from that source')
  writeFileSync(continueConfig, `name: Duplicate MCP Config
version: 1.0.0
schema: v1
mcpServers:
  - name: duplicate
    command: first
  - name: duplicate
    command: second
`)
  const duplicateContinue = scanMigration()
  assert(duplicateContinue.diagnostics.some((item) => item.path === continueConfig && item.code === 'migration_mcp_server_duplicate'), 'duplicate Continue MCP names fail closed')
  assert(!duplicateContinue.assets.some((asset) => asset.agent === 'Continue' && asset.kind === 'mcp' && asset.path === continueConfig), 'duplicate Continue MCP names produce no partial assets')
  writeFileSync(continueConfig, validContinueConfig)

  const geminiProjectConfig = path.join(project, '.gemini', 'settings.json')
  const validGeminiProjectConfig = readFileSync(geminiProjectConfig, 'utf8')
  writeFileSync(geminiProjectConfig, '{"mcpServers":{"broken":]}}')
  const malformedGemini = scanMigration()
  assert(malformedGemini.diagnostics.some((item) => item.path === geminiProjectConfig), 'malformed Gemini settings are reported without crashing scan')
  assert(!malformedGemini.assets.some((asset) => asset.agent === 'Gemini CLI' && asset.kind === 'mcp' && asset.scope === 'project'), 'malformed Gemini settings produce no project MCP assets')
  writeFileSync(geminiProjectConfig, validGeminiProjectConfig)

  const openCodeProjectConfig = path.join(project, 'opencode.jsonc')
  const validOpenCodeProjectConfig = readFileSync(openCodeProjectConfig, 'utf8')
  writeFileSync(openCodeProjectConfig, '{ mcp: { broken: ] } }')
  const malformedOpenCode = scanMigration()
  assert(malformedOpenCode.diagnostics.some((item) => item.path === openCodeProjectConfig), 'malformed OpenCode JSONC is reported without crashing scan')
  assert(!malformedOpenCode.assets.some((asset) => asset.agent === 'OpenCode' && asset.kind === 'mcp' && asset.scope === 'project'), 'malformed OpenCode JSONC produces no project MCP assets')
  writeFileSync(openCodeProjectConfig, validOpenCodeProjectConfig)

  writeFileSync(openClawConfig, `{ providers: { local: { model: 'example' } } }\n`)
  writeFileSync(hermesConfig, 'model: example\n')
  writeFileSync(clineConfig, '{"mcpServers":{}}\n')
  writeFileSync(continueConfig, 'name: Local Config\nversion: 1.0.0\nschema: v1\n')
  writeFileSync(geminiProjectConfig, '{"model":{"name":"example"}}\n')
  writeFileSync(qwenProjectConfig, '{"model":{"name":"example"}}\n')
  writeFileSync(openCodeProjectConfig, '{ "model": "example/model" }\n')
  const noMcp = scanMigration()
  assert(!noMcp.diagnostics.some((item) => [openClawConfig, hermesConfig, clineConfig, continueConfig, geminiProjectConfig, qwenProjectConfig, openCodeProjectConfig].includes(item.path)), 'valid configs without MCP do not produce false diagnostics')

  console.log(`Open-source agent migration smoke passed: ${checks.length}/${checks.length}`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function compile() {
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/migration.ts',
    'src/main/routineStore.ts',
    '--outDir', outDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck'
  ], { cwd: repoRoot, stdio: 'inherit' })
}

function createFixture() {
  createWorkspaceFixture()
  createClineAndContinueFixtures()
  createProjectModelAgentFixtures()
  createUserModelAgentFixtures()
  createOpenClawFixture()
  createHermesFixture()
}

function createWorkspaceFixture() {
  mkdirSync(project, { recursive: true })
  mkdirSync(caogenRoot, { recursive: true })
  writeFileSync(path.join(project, 'MEMORY.md'), '# Workspace memory\n\nPrefer concise delivery reports.\n')
  mkdirSync(path.join(project, 'memory'), { recursive: true })
  const linkedMemory = path.join(tempRoot, 'linked-memory.md')
  writeFileSync(linkedMemory, '# Linked memory\n')
  symlinkSync(linkedMemory, path.join(project, 'memory', 'linked.md'))
}

function createClineAndContinueFixtures() {
  mkdirSync(path.join(project, '.clinerules'), { recursive: true })
  mkdirSync(path.join(project, '.cline', 'rules'), { recursive: true })
  mkdirSync(path.join(project, '.continue', 'rules'), { recursive: true })
  mkdirSync(path.join(project, '.continue', 'mcpServers'), { recursive: true })
  writeFileSync(path.join(project, '.clinerules', '01-project.md'), '# Cline project rules\n\nKeep changes reviewable.\n')
  writeFileSync(path.join(project, '.continuerc.json'), `${JSON.stringify({ models: [{ provider: 'example', apiKey: secret }] }, null, 2)}\n`)
  writeFileSync(path.join(project, '.cline', 'mcp.json'), `${JSON.stringify({
    mcpServers: {
      'cline-project': {
        type: 'streamableHttp',
        url: `https://cline-project.example.invalid/mcp?token=${secret}`,
        headers: { Authorization: `Bearer ${secret}` }
      }
    }
  }, null, 2)}\n`)
  writeFileSync(path.join(project, '.cline', 'rules', 'testing.md'), '# Cline testing rules\n\nRun focused checks.\n')
  writeSkill(path.join(project, '.cline', 'skills', 'project-debug'), '# Cline project debug Skill\n')
  writeFileSync(path.join(project, '.continue', 'rules', 'project.md'), '# Continue project rules\n\nPreserve project context.\n')
  writeFileSync(path.join(project, '.continue', 'mcpServers', 'local.yaml'), `name: Local MCP Servers
version: 1.0.0
schema: v1
mcpServers:
  - name: continue-project
    type: stdio
    command: continue-project-mcp
    args: [--api-key, "${secret}", --safe]
    env:
      API_KEY: "${secret}"
`)
  writeFileSync(path.join(project, '.continue', 'mcpServers', 'remote.json'), `${JSON.stringify({
    mcpServers: {
      'continue-http': {
        type: 'http',
        url: `https://continue-project.example.invalid/mcp?token=${secret}`,
        headers: { Authorization: `Bearer ${secret}` }
      }
    }
  }, null, 2)}\n`)

  const clineRoot = path.join(home, '.cline')
  mkdirSync(path.join(clineRoot, 'data', 'settings'), { recursive: true })
  mkdirSync(path.join(clineRoot, 'rules'), { recursive: true })
  writeFileSync(path.join(clineRoot, 'data', 'settings', 'cline_mcp_settings.json'), `${JSON.stringify({
    mcpServers: {
      'cline-stdio': {
        command: 'cline-mcp',
        args: ['--token', secret, '--safe'],
        env: { API_KEY: secret },
        disabled: false
      },
      'cline-http': {
        type: 'streamableHttp',
        url: `https://cline.example.invalid/mcp?token=${secret}`,
        headers: { Authorization: `Bearer ${secret}` },
        autoApprove: ['read']
      },
      constructor: { command: 'must-not-import' }
    }
  }, null, 2)}\n`)
  writeFileSync(path.join(clineRoot, 'mcp.json'), `${JSON.stringify({
    mcpServers: {
      'cline-cli': { command: 'cline-cli-mcp', args: ['--safe'] }
    }
  }, null, 2)}\n`)
  writeFileSync(path.join(clineRoot, 'rules', 'global.md'), '# Cline global rules\n\nKeep credentials local.\n')
  writeSkill(path.join(clineRoot, 'skills', 'global-review'), '# Cline global review Skill\n')
  mkdirSync(path.join(home, 'Documents', 'Cline', 'Rules'), { recursive: true })
  writeFileSync(path.join(home, 'Documents', 'Cline', 'Rules', 'personal.txt'), 'Cline personal rule: keep delivery evidence.\n')

  const continueRoot = path.join(home, '.continue')
  mkdirSync(continueRoot, { recursive: true })
  writeFileSync(path.join(continueRoot, 'config.yaml'), `name: Local Config
version: 1.0.0
schema: v1
models:
  - name: private
    provider: example
    apiKey: "${secret}"
mcpServers:
  - name: continue-user
    type: streamable-http
    url: "https://continue.example.invalid/mcp?token=${secret}"
    apiKey: "${secret}"
    requestOptions:
      headers:
        Authorization: "Bearer ${secret}"
`)
}

function createProjectModelAgentFixtures() {
  writeFileSync(path.join(project, 'GEMINI.md'), '# Gemini project rules\n\nKeep tool execution reviewable.\n')
  mkdirSync(path.join(project, '.gemini'), { recursive: true })
  writeFileSync(path.join(project, '.gemini', 'settings.json'), `${JSON.stringify({
    model: { name: 'gemini-example', apiKey: secret },
    mcpServers: {
      'gemini-stdio': {
        command: 'gemini-project-mcp',
        args: ['--api-key', secret, '--safe'],
        env: { API_KEY: secret },
        type: 'stdio'
      },
      'gemini-http': {
        url: 'https://ignored.example.invalid/mcp',
        httpUrl: `https://gemini-http.example.invalid/mcp?token=${secret}#private`,
        type: 'sse',
        headers: { Authorization: `Bearer ${secret}` }
      }
    }
  }, null, 2)}\n`)
  writeSkill(path.join(project, '.gemini', 'skills', 'project-planning'), '# Gemini project planning Skill\n')

  writeFileSync(path.join(project, 'QWEN.md'), '# Qwen project rules\n\nRun the focused checks before delivery.\n')
  mkdirSync(path.join(project, '.qwen'), { recursive: true })
  writeFileSync(path.join(project, '.qwen', 'settings.json'), `${JSON.stringify({
    model: { name: 'qwen-example', apiKey: secret },
    mcpServers: {
      'qwen-project': {
        command: 'qwen-project-mcp',
        args: ['--token', secret, '--safe'],
        env: { API_KEY: secret },
        trust: true
      }
    }
  }, null, 2)}\n`)
  writeSkill(path.join(project, '.qwen', 'skills', 'project-review'), '# Qwen project review Skill\n')

  writeFileSync(path.join(project, 'opencode.jsonc'), `{
    // OpenCode local MCP commands are arrays.
    "model": "example/private-model",
    "mcp": {
      "opencode-local": {
        "type": "local",
        "command": ["npx", "-y", "opencode-mcp", "--token", "${secret}", "--safe"],
        "environment": { "API_KEY": "${secret}" },
        "enabled": true,
      },
    },
  }\n`)
  writeSkill(path.join(project, '.opencode', 'skills', 'pr-review'), '# OpenCode PR review Skill\n')
}

function createUserModelAgentFixtures() {
  const geminiRoot = path.join(home, '.gemini')
  mkdirSync(geminiRoot, { recursive: true })
  writeFileSync(path.join(geminiRoot, 'GEMINI.md'), '# Gemini user rules\n\nKeep provider authorization explicit.\n')
  writeFileSync(path.join(geminiRoot, 'settings.json'), `${JSON.stringify({
    security: { auth: { selectedType: 'gemini-api-key', apiKey: secret } },
    mcpServers: {
      'gemini-sse': {
        url: `https://gemini-sse.example.invalid/mcp?token=${secret}`,
        type: 'sse',
        headers: { Authorization: `Bearer ${secret}` }
      }
    }
  }, null, 2)}\n`)
  writeSkill(path.join(geminiRoot, 'skills', 'global-research'), '# Gemini global research Skill\n')

  const qwenRoot = path.join(home, '.qwen')
  mkdirSync(qwenRoot, { recursive: true })
  writeFileSync(path.join(qwenRoot, 'QWEN.md'), '# Qwen user rules\n\nKeep model selection explicit.\n')
  writeFileSync(path.join(qwenRoot, 'settings.json'), `${JSON.stringify({
    auth: { apiKey: secret },
    mcpServers: {
      'qwen-remote': {
        url: `https://qwen.example.invalid/mcp?token=${secret}`,
        headers: { Authorization: `Bearer ${secret}` },
        enabled: false
      }
    }
  }, null, 2)}\n`)
  writeSkill(path.join(qwenRoot, 'skills', 'global-review'), '# Qwen global review Skill\n')

  const openCodeRoot = path.join(home, '.config', 'opencode')
  mkdirSync(openCodeRoot, { recursive: true })
  writeFileSync(path.join(openCodeRoot, 'AGENTS.md'), '# OpenCode user rules\n\nUse deterministic delivery evidence.\n')
  writeFileSync(path.join(openCodeRoot, 'opencode.json'), `${JSON.stringify({
    provider: { private: { options: { apiKey: secret } } },
    mcp: {
      'opencode-remote': {
        type: 'remote',
        url: `https://opencode.example.invalid/mcp?token=${secret}`,
        headers: { Authorization: `Bearer ${secret}` },
        oauth: { clientSecret: secret },
        enabled: false
      }
    }
  }, null, 2)}\n`)
  writeSkill(path.join(openCodeRoot, 'skills', 'release-notes'), '# OpenCode release notes Skill\n')
}

function createOpenClawFixture() {
  const openClawRoot = path.join(home, '.openclaw')
  mkdirSync(openClawRoot, { recursive: true })
  writeFileSync(path.join(openClawRoot, 'openclaw.json'), `{
    // JSON5 comments and trailing commas are intentional.
    mcp: { servers: {
      'open-stdio': { command: 'open-mcp', args: ['--safe'], env: { API_KEY: '${secret}' }, },
      'open-remote': { url: 'https://mcp.example.invalid/path?token=${secret}', headers: { Authorization: 'Bearer ${secret}' }, enabled: false, },
    }, },
    channels: {
      telegram: {
        enabled: true,
        accounts: { primary: { token: '${secret}', accountId: 'account-${secret}' } },
        channels: { privateRoom: { id: 'channel-${secret}', name: '${secret}' } },
        webhook: 'https://example.invalid/${secret}',
      },
    },
    providers: { private: { apiKey: '${secret}' } },
  }\n`)
  mkdirSync(path.join(openClawRoot, 'workspace', 'memory'), { recursive: true })
  writeFileSync(path.join(openClawRoot, 'workspace', 'MEMORY.md'), `# Sensitive memory\n\nAPI_KEY=${secret}\n`)
  writeFileSync(path.join(openClawRoot, 'workspace', 'memory', 'too-large.md'), 'x'.repeat(2 * 1024 * 1024 + 1))
  mkdirSync(path.join(openClawRoot, 'cron'), { recursive: true })
  writeFileSync(path.join(openClawRoot, 'cron', 'jobs.json'), `${JSON.stringify({ jobs: [
    { id: 'daily-review', schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn', message: 'Review project status and prepare a summary.' } },
    { id: 'interval-review', schedule: { kind: 'every', everyMs: 3600000 }, payload: { kind: 'systemEvent', text: 'Check pending project tasks.' } },
    { id: 'script-task', type: 'script', command: '/tmp/external-script', schedule: { kind: 'cron', expr: '0 2 * * *' } },
    { id: 'secret-task', schedule: { kind: 'cron', expr: '0 3 * * *' }, payload: { kind: 'agentTurn', message: `API_KEY=${secret}` } }
  ] }, null, 2)}\n`)
  writeSkill(path.join(openClawRoot, 'skills', 'research', 'web'), '# OpenClaw research Skill\n')
  writeSkill(path.join(openClawRoot, 'skills', 'secret-skill'), `# Secret Skill\n\nAPI_KEY=${secret}\n`)
  writeSkill(path.join(project, 'skills', 'shared'), '# OpenClaw workspace Skill\n')
  writeSkill(path.join(project, '.agents', 'skills', 'shared'), '# OpenClaw agents Skill\n')
}

function createHermesFixture() {
  const hermesRoot = path.join(home, '.hermes')
  mkdirSync(hermesRoot, { recursive: true })
  writeFileSync(path.join(hermesRoot, 'config.yaml'), `model: example
mcp_servers:
  hermes-stdio:
    command: hermes-mcp
    args: [--token, "${secret}", --safe]
    env:
      API_KEY: "${secret}"
  hermes-http:
    url: "https://hermes.example.invalid/mcp?token=${secret}"
    headers:
      Authorization: "Bearer ${secret}"
platforms:
  slack:
    enabled: true
    accounts:
      primary:
        token: "${secret}"
    channels:
      delivery:
        id: "channel-${secret}"
gateway:
  platforms:
    discord:
      enabled: false
      guilds:
        private:
          id: "guild-${secret}"
`)
  mkdirSync(path.join(hermesRoot, 'memories'), { recursive: true })
  writeFileSync(path.join(hermesRoot, 'memories', 'MEMORY.md'), '# Hermes memory\n\nUse deterministic acceptance gates.\n')
  writeFileSync(path.join(hermesRoot, 'memories', 'USER.md'), '# User preference\n\nKeep provider selection explicit.\n')
  mkdirSync(path.join(hermesRoot, 'cron'), { recursive: true })
  writeFileSync(path.join(hermesRoot, 'cron', 'jobs.json'), `${JSON.stringify({ jobs: [
    { id: 'hermes-cron', schedule: { kind: 'cron', cron: '0 10 * * 1-5' }, prompt: 'Prepare the weekday project report.' },
    { id: 'hermes-once', schedule: { kind: 'once', at: '2030-01-01T00:00:00.000Z' }, prompt: 'Review the milestone once.' }
  ] }, null, 2)}\n`)
  writeFileSync(path.join(hermesRoot, 'channel_directory.json'), `${JSON.stringify({ entries: [
    { platform: 'telegram', channel_id: `channel-${secret}`, channel_name: secret },
    { platform: 'slack', account_id: `account-${secret}`, target: secret }
  ] }, null, 2)}\n`)
  writeSkill(path.join(hermesRoot, 'skills', 'writing', 'office', 'report'), '# Hermes report Skill\n')
  const oversized = path.join(hermesRoot, 'skills', 'oversized')
  writeSkill(oversized, '# Oversized file count\n')
  for (let index = 0; index < 201; index += 1) writeFileSync(path.join(oversized, `${index}.txt`), 'x')
  const externalSkill = path.join(tempRoot, 'external-skill')
  writeSkill(externalSkill, '# External symlink Skill\n')
  symlinkSync(externalSkill, path.join(hermesRoot, 'skills', 'linked'))
}

function writeSkill(directory, body) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'SKILL.md'), body)
}

function findAsset(assets, kind, name) {
  const asset = assets.find((item) => item.kind === kind && item.name === name)
  if (!asset) throw new Error(`missing ${kind} asset: ${name}`)
  return asset
}

function allFilesText(root) {
  const chunks = []
  const visit = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else chunks.push(readFileSync(target, 'utf8'))
    }
  }
  visit(root)
  return chunks.join('\n')
}

function findCompiled(fileName) {
  const queue = [outDir]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(candidate)
      else if (entry.name === fileName) return candidate
    }
  }
  throw new Error(`compiled module missing: ${fileName}`)
}

function assert(condition, name) {
  checks.push(name)
  if (!condition) throw new Error(name)
}

function equal(actual, expected, name) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
