import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const repoRoot = process.cwd()
const buildDir = mkdtempSync(path.join(tmpdir(), 'caogen-effect-entry-inventory-'))
const required = process.argv.includes('--required')
const startedAt = new Date()

try {
  execFileSync(process.execPath, [
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    'src/main/task/effect-entry-inventory.ts',
    '--outDir', buildDir,
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict'
  ], { cwd: repoRoot, stdio: 'inherit' })

  const inventory = await import(pathToFileURL(findCompiled(buildDir, 'effect-entry-inventory.js')).href)
  const ipcRegistrations = discoverIpcRegistrations()
  const toolNames = discoverToolNames()
  assertExactInventory('IPC channel', ipcRegistrations.map((item) => item.id), inventory.IPC_EFFECT_ENTRY_POLICIES)
  assertExactInventory('Agent tool', toolNames, inventory.AGENT_TOOL_EFFECT_ENTRY_POLICIES)
  validatePolicies('IPC channel', inventory.IPC_EFFECT_ENTRY_POLICIES, false)
  validatePolicies('Agent tool', inventory.AGENT_TOOL_EFFECT_ENTRY_POLICIES, true)
  validateGatewayActions(inventory.GATEWAY_ACTION_EFFECT_ENTRY_POLICIES)
  validateIpcEvidence(ipcRegistrations, inventory.IPC_EFFECT_ENTRY_POLICIES)
  validateRuntimeBoundary(inventory)

  const report = {
    schemaVersion: 1,
    status: 'passed',
    required,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    gitCommit: git(['rev-parse', 'HEAD']),
    worktreeClean: git(['status', '--porcelain=v1']).length === 0,
    inventoryVersion: inventory.EFFECT_ENTRY_INVENTORY_VERSION,
    counts: {
      ipcChannels: ipcRegistrations.length,
      agentTools: toolNames.length,
      gatewayActions: Object.values(inventory.GATEWAY_ACTION_EFFECT_ENTRY_POLICIES)
        .reduce((total, policies) => total + Object.keys(policies).length, 0),
      ipcImpacts: impactCounts(inventory.IPC_EFFECT_ENTRY_POLICIES),
      agentToolImpacts: impactCounts(inventory.AGENT_TOOL_EFFECT_ENTRY_POLICIES),
      ipcPolicies: policyCounts(inventory.IPC_EFFECT_ENTRY_POLICIES),
      agentToolPolicies: policyCounts(inventory.AGENT_TOOL_EFFECT_ENTRY_POLICIES)
    },
    connectorBoundary: {
      mcp_call_tool: inventory.AGENT_TOOL_EFFECT_ENTRY_POLICIES.mcp_call_tool,
      mcp_discover: inventory.AGENT_TOOL_EFFECT_ENTRY_POLICIES.mcp_discover
    }
  }
  const runId = report.startedAt.replaceAll(':', '-').replaceAll('.', '-')
  const reportDir = path.join(repoRoot, 'test-results', 'effect-entry-inventory', runId)
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...report, reportDir }, null, 2))
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}

function discoverIpcRegistrations() {
  const registrations = []
  for (const file of walk(path.join(repoRoot, 'src', 'main')).filter((item) => item.endsWith('.ts'))) {
    const source = parse(file)
    visit(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
      const owner = node.expression.expression
      const channel = node.arguments[0]
      if (!ts.isIdentifier(owner) || owner.text !== 'ipcMain' || node.expression.name.text !== 'handle') return
      if (!channel || !ts.isStringLiteralLike(channel)) throw new Error(`ipcMain.handle channel must be a literal: ${relative(file)}`)
      registrations.push({
        id: channel.text,
        file: relative(file),
        body: source.text.slice(node.pos, node.end)
      })
    })
  }
  registrations.sort((left, right) => left.id.localeCompare(right.id))
  assert.equal(new Set(registrations.map((item) => item.id)).size, registrations.length, 'IPC channels must be unique')
  return registrations
}

function discoverToolNames() {
  const stringConstants = discoverStringConstants()
  const specs = [
    ['src/main/openaiTools.ts', 'OPENAI_CODING_TOOLS'],
    ['src/main/agent/tools/git-tools.ts', 'GIT_TOOLS'],
    ['src/main/agent/tools/browser-tools.ts', 'BROWSER_TOOLS'],
    ['src/main/agent/tools/p2-tools.ts', 'P2_TOOLS'],
    ['src/main/agent/tools/gui-tools.ts', 'GUI_TOOLS']
  ]
  const names = []
  for (const [relativePath, declarationName] of specs) {
    const source = parse(path.join(repoRoot, relativePath))
    const declaration = findVariable(source, declarationName)
    const initializer = unwrapExpression(declaration.initializer)
    assert(ts.isArrayLiteralExpression(initializer), `${declarationName} must remain an array literal`)
    for (const element of initializer.elements) {
      if (ts.isSpreadElement(element)) continue
      const item = unwrapExpression(element)
      if (!ts.isObjectLiteralExpression(item)) continue
      const functionProperty = property(item, 'function')
      const functionValue = functionProperty && unwrapExpression(functionProperty.initializer)
      assert(functionValue && ts.isObjectLiteralExpression(functionValue), `${declarationName} tool must have a function object`)
      const nameProperty = property(functionValue, 'name')
      assert(nameProperty, `${declarationName} tool must have a name`)
      const nameValue = unwrapExpression(nameProperty.initializer)
      if (ts.isStringLiteralLike(nameValue)) names.push(nameValue.text)
      else if (ts.isIdentifier(nameValue) && stringConstants.has(nameValue.text)) names.push(stringConstants.get(nameValue.text))
      else throw new Error(`${declarationName} tool name must resolve to a string literal`)
    }
  }
  names.sort()
  assert.equal(new Set(names).size, names.length, 'Agent tool names must be unique')
  return names
}

function discoverStringConstants() {
  const values = new Map()
  for (const file of walk(path.join(repoRoot, 'src', 'main')).filter((item) => item.endsWith('.ts'))) {
    const source = parse(file)
    visit(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return
      const initializer = unwrapExpression(node.initializer)
      if (ts.isStringLiteralLike(initializer)) values.set(node.name.text, initializer.text)
    })
  }
  return values
}

function validatePolicies(label, policies, agentTool) {
  for (const [id, policy] of Object.entries(policies)) {
    assert(['read_only', 'local', 'external'].includes(policy.impact), `${label} ${id} impact is invalid`)
    if (policy.impact !== 'external') {
      assert.equal(policy.effect, 'none', `${label} ${id} must not claim an Effect policy`)
      assert.equal(policy.replay, 'not_applicable', `${label} ${id} replay policy must be not_applicable`)
      continue
    }
    assert.notEqual(policy.effect, 'none', `${label} ${id} external mutation needs an explicit policy`)
    if (agentTool) {
      assert(
        ['queryable', 'opaque', 'conditional'].includes(policy.effect),
        `${label} ${id} must cross the native Effect runtime`
      )
    }
    if (policy.effect === 'opaque') assert.equal(policy.replay, 'manual_reconciliation')
    if (policy.effect === 'queryable' || policy.effect === 'conditional') {
      assert.equal(policy.replay, 'reconcile_before_retry')
    }
    if (policy.effect === 'delegated') {
      assert.equal(policy.replay, 'downstream_barrier')
      assert(policy.evidence, `${label} ${id} delegated policy needs boundary evidence`)
    }
    if (policy.effect === 'direct_user') assert.equal(policy.replay, 'never')
  }
}

function validateGatewayActions(gateways) {
  const specs = {
    'projectWorkspace:invoke': ['src/main/ipc/project-workspace-handlers.ts', 'PROJECT_WORKSPACE_HANDLERS'],
    'digitalWorker:invoke': ['src/main/ipc/digital-worker-handlers.ts', 'DIGITAL_WORKER_ACTION_HANDLERS'],
    'supervisor:invoke': ['src/main/ipc/supervisor-handlers.ts', 'HANDLERS']
  }
  assert.deepEqual(Object.keys(gateways).sort(), Object.keys(specs).sort(), 'gateway inventory set drifted')
  for (const [channel, [relativePath, declarationName]] of Object.entries(specs)) {
    const source = parse(path.join(repoRoot, relativePath))
    const initializer = unwrapExpression(findVariable(source, declarationName).initializer)
    assert(ts.isObjectLiteralExpression(initializer), `${declarationName} must remain an object literal`)
    const actions = initializer.properties.flatMap((item) => {
      if (!item.name) return []
      if (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) return [item.name.text]
      return []
    })
    assertExactInventory(`${channel} action`, actions, gateways[channel])
    validatePolicies(`${channel} action`, gateways[channel], false)
  }
}

function validateIpcEvidence(registrations, policies) {
  for (const registration of registrations) {
    const policy = policies[registration.id]
    const evidenceSource = registrationEvidenceSource(registration)
    if (policy.effect === 'queryable') {
      assert(
        evidenceSource.includes('executeInteractiveOperationEffect') ||
          (policy.evidence && evidenceSource.includes(policy.evidence)),
        `${registration.id} must cross executeInteractiveOperationEffect`
      )
    }
    if (policy.effect === 'opaque') {
      assert(
        evidenceSource.includes('executeInteractiveOperationEffect') ||
          (policy.evidence && evidenceSource.includes(policy.evidence)),
        `${registration.id} opaque mutation must cross executeInteractiveOperationEffect`
      )
    }
    if (policy.effect === 'delegated') {
      assert(evidenceSource.includes(policy.evidence), `${registration.id} delegated boundary drifted: ${policy.evidence}`)
    }
  }
}

function registrationEvidenceSource(registration) {
  const absolutePath = path.join(repoRoot, registration.file)
  const source = parse(absolutePath)
  let evidence = registration.body
  const includedFunctions = new Set()
  let expanded = true
  while (expanded) {
    expanded = false
    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name ||
          includedFunctions.has(statement.name.text) || !evidence.includes(statement.name.text)) continue
      includedFunctions.add(statement.name.text)
      evidence += `\n${source.text.slice(statement.pos, statement.end)}`
      expanded = true
    }
  }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith('.')) continue
    const localNames = importLocalNames(statement.importClause)
    if (!localNames.some((name) => evidence.includes(name))) continue
    evidence += `\n${readFileSync(resolveLocalModule(absolutePath, statement.moduleSpecifier.text), 'utf8')}`
  }
  return evidence
}

function importLocalNames(clause) {
  if (!clause) return []
  const names = clause.name ? [clause.name.text] : []
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    names.push(clause.namedBindings.name.text)
  } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    names.push(...clause.namedBindings.elements.map((element) => element.name.text))
  }
  return names
}

function resolveLocalModule(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const extensionless = base.replace(/\.(?:js|mjs|cjs)$/, '')
  const candidates = [base, `${extensionless}.ts`, `${extensionless}.tsx`, path.join(extensionless, 'index.ts')]
  const match = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!match) throw new Error(`Cannot resolve local IPC boundary module ${specifier} from ${relative(fromFile)}`)
  return match
}

function validateRuntimeBoundary(inventory) {
  const idempotency = read('src/main/task/tool-idempotency.ts')
  const nativeRuntime = read('src/main/native-tool-runtime.ts')
  const targetBuilder = read('src/main/task/effect-target-builder.ts')
  const reconciler = read('src/main/task/effect-reconciler.ts')
  const localReconciler = read('src/main/task/effect-reconciler-local-targets.ts')
  const pluginEffect = read('src/main/pluginInstallEffect.ts')
  assert(idempotency.includes('EFFECT_FREE_AGENT_TOOL_NAMES'), 'runtime effect-free set must consume the inventory')
  assert(nativeRuntime.indexOf('prepareToolEffect(effectInput)') < nativeRuntime.indexOf('executeCodingTool(name'),
    'native tool runtime must prepare the Effect before execution')
  assert(targetBuilder.includes("return { kind: 'unsupported', toolName }"), 'unknown mutating tools must become opaque')
  assert(reconciler.includes('该副作用没有注册只读查询器，禁止自动重放'), 'opaque effects must forbid automatic replay')
  for (const connector of ['mcp_call_tool', 'mcp_discover', 'mcp_builtin_servers', 'mcp_import_claude_desktop']) {
    assert.equal(inventory.AGENT_TOOL_EFFECT_ENTRY_POLICIES[connector]?.effect, 'opaque', `${connector} must stay opaque`)
  }
  for (const toolName of ['write_file', 'search_replace', 'git_commit', 'git_merge', 'git_push', 'git_create_pr', 'code_forge_delivery']) {
    assert(targetBuilder.includes(`toolName === '${toolName}'`), `${toolName} queryable target builder missing`)
  }
  assert(
    targetBuilder.includes("toolName !== 'edit_file'") && targetBuilder.includes('buildEditFileTarget('),
    'edit_file queryable target builder missing'
  )
  assert(targetBuilder.includes('isGitIndexEffectToolName(toolName)'), 'Git index queryable target builder missing')
  assert(targetBuilder.includes('isManagedPluginEffectToolName(toolName)'), 'plugin queryable target builder missing')
  assert(localReconciler.includes('reconcileManagedPluginEffectTarget(target)'), 'plugin queryable reconciler missing')
  assert(pluginEffect.includes('executeInteractiveOperationEffect'), 'plugin IPC wrapper must cross the Effect gateway')
}

function assertExactInventory(label, discovered, policies) {
  const actual = [...new Set(discovered)].sort()
  const declared = Object.keys(policies).sort()
  assert.deepEqual(declared, actual, `${label} inventory drifted`)
}

function policyCounts(policies) {
  return Object.values(policies).reduce((counts, policy) => {
    counts[policy.effect] = (counts[policy.effect] ?? 0) + 1
    return counts
  }, {})
}

function impactCounts(policies) {
  return Object.values(policies).reduce((counts, policy) => {
    counts[policy.impact] = (counts[policy.impact] ?? 0) + 1
    return counts
  }, {})
}

function findVariable(source, name) {
  let found
  visit(source, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node
  })
  assert(found, `variable declaration missing: ${name}`)
  return found
}

function property(object, name) {
  return object.properties.find((item) =>
    ts.isPropertyAssignment(item) && item.name &&
    (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)) && item.name.text === name)
}

function unwrapExpression(expression) {
  let current = expression
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, (child) => visit(child, callback))
}

function walk(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...walk(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

function findCompiled(root, fileName) {
  const match = walk(root).find((item) => path.basename(item) === fileName)
  if (!match) throw new Error(`compiled file not found: ${fileName}`)
  return match
}

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function relative(file) {
  return path.relative(repoRoot, file)
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}
