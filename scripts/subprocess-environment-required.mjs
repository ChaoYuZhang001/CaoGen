#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const sourceRoot = path.join(repoRoot, 'src', 'main')
const failures = []
let filesChecked = 0
let subprocessCalls = 0

for (const filePath of walk(sourceRoot)) {
  if (!/\.(?:c|m)?ts$/.test(filePath) || filePath.endsWith('.d.ts')) continue
  const sourceText = readFileSync(filePath, 'utf8')
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true)
  const childFunctions = new Set()
  const promisifiedChildFunctions = new Set()

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:child_process') continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      if (['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(imported)) {
        childFunctions.add(element.name.text)
      }
    }
  }

  visit(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return
    if (
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'promisify' &&
      node.initializer.arguments.length === 1 &&
      ts.isIdentifier(node.initializer.arguments[0]) &&
      childFunctions.has(node.initializer.arguments[0].text)
    ) {
      promisifiedChildFunctions.add(node.name.text)
    }
  })

  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
    if (!childFunctions.has(node.expression.text) && !promisifiedChildFunctions.has(node.expression.text)) return
    subprocessCalls += 1
    const options = findOptionsObject(node.arguments)
    if (!options || !objectHasProperty(options, 'env')) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source))
      failures.push(`${relative(filePath)}:${position.line + 1} subprocess call must supply an explicit minimal env`)
    }
  })

  if (/\.\.\.process\.env|env\s*:\s*process\.env/.test(sourceText)) {
    failures.push(`${relative(filePath)} passes the full parent process environment`)
  }
  filesChecked += 1
}

const terminalPath = path.join(sourceRoot, 'terminal.ts')
const terminalSource = readFileSync(terminalPath, 'utf8')
if (!/nodePty\.spawn\([\s\S]*?env:\s*args\.env/.test(terminalSource)) {
  failures.push('src/main/terminal.ts node-pty spawn is missing the minimal environment')
}

if (failures.length > 0) {
  console.error(`subprocess-environment: FAIL (${failures.length})`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(`subprocess-environment: PASS (${filesChecked} files, ${subprocessCalls + 1} subprocess calls)`)

function findOptionsObject(args) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (ts.isObjectLiteralExpression(args[index])) return args[index]
  }
  return null
}

function objectHasProperty(object, name) {
  return object.properties.some((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false
    return property.name && property.name.getText().replace(/^['"]|['"]$/g, '') === name
  })
}

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

function walk(root) {
  const files = []
  for (const entry of readdirSync(root)) {
    const target = path.join(root, entry)
    const state = statSync(target)
    if (state.isDirectory()) files.push(...walk(target))
    else if (state.isFile()) files.push(target)
  }
  return files
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/')
}
