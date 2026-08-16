#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const repoRoot = process.cwd()
const policyPath = path.join(repoRoot, 'src', 'main', 'security', 'protected-storage-policy.ts')
const source = readFileSync(policyPath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    strict: true
  },
  fileName: policyPath,
  reportDiagnostics: true
})
const errors = (compiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
)
assert(errors.length === 0, 'protected storage policy must transpile')
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`
const policy = await import(moduleUrl)

let probeCalls = 0
const result = (status, output) => () => {
  probeCalls += 1
  return { status, output }
}
const runtime = (overrides = {}) => ({
  platform: 'darwin',
  electronMain: true,
  isPackaged: true,
  executablePath: '/Applications/CaoGen.app/Contents/MacOS/CaoGen',
  ...overrides
})
const developerIdOutput = [
  'Authority=Developer ID Application: CaoGen Test (26CX9F23YL)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=26CX9F23YL'
].join('\n')

assert(policy.isProtectedStorageRuntimeEligible(
  runtime({ platform: 'win32', isPackaged: false, executablePath: 'C:\\CaoGen.exe' }),
  result(1, '')
), 'non-macOS runtime must preserve native safeStorage behavior')
assert(probeCalls === 0, 'non-macOS runtime must not invoke codesign')
assert(policy.isProtectedStorageRuntimeEligible(
  runtime({ electronMain: false, isPackaged: false, executablePath: process.execPath }),
  result(1, '')
), 'deterministic Node harnesses must keep injected storage backends')
assert(probeCalls === 0, 'Node harness must not invoke codesign')
assert(!policy.isProtectedStorageRuntimeEligible(
  runtime({ isPackaged: false, executablePath: process.execPath }),
  result(0, developerIdOutput)
), 'unpackaged macOS Electron must fail closed before codesign')
assert(probeCalls === 0, 'unpackaged macOS Electron must not invoke codesign')
assert(policy.isProtectedStorageRuntimeEligible(runtime(), result(0, developerIdOutput)),
  'matching Developer ID authority and TeamIdentifier must allow protected storage')
assert(!policy.isProtectedStorageRuntimeEligible(runtime(), result(1, 'code object is not signed at all')),
  'unsigned packaged macOS runtime must fail closed')
assert(!policy.isProtectedStorageRuntimeEligible(runtime(), result(0,
  developerIdOutput.replace('TeamIdentifier=26CX9F23YL', 'TeamIdentifier=ABCDEFGHIJ'))),
  'mismatched signing authority and TeamIdentifier must fail closed')
assert(!policy.isProtectedStorageRuntimeEligible(runtime(), result(0,
  'Signature=adhoc\nTeamIdentifier=not set')),
  'ad-hoc signed packaged macOS runtime must fail closed')
assert(!policy.isProtectedStorageRuntimeEligible(
  runtime({ executablePath: 'relative/CaoGen' }), result(0, developerIdOutput)
), 'relative executable paths must fail closed')

const directImports = []
for (const file of walk(path.join(repoRoot, 'src', 'main'))) {
  if (!file.endsWith('.ts') || file.endsWith('protected-storage-runtime.ts')) continue
  const content = readFileSync(file, 'utf8')
  if (/import\s*\{[^}]*\bsafeStorage\b[^}]*\}\s*from\s*['"]electron['"]/.test(content)) {
    directImports.push(path.relative(repoRoot, file))
  }
}
assert(directImports.length === 0,
  `main-process safeStorage calls must use the guarded runtime: ${directImports.join(', ')}`)

console.log('protected storage policy smoke ok')

function walk(root) {
  const output = []
  for (const entry of readdirSync(root)) {
    const file = path.join(root, entry)
    if (statSync(file).isDirectory()) output.push(...walk(file))
    else output.push(file)
  }
  return output
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
