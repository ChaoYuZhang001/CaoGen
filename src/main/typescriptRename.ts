import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import type { TypeScriptLanguageInput } from '../shared/types'

const MAX_PROJECT_FILES = 5_000

export function getTypeScriptRenameWorkspaceEdit(
  projectRoot: string,
  input: TypeScriptLanguageInput,
  newName: string
): unknown {
  const root = realpathSync(projectRoot)
  const fileName = realpathSync(path.resolve(root, input.path))
  if (!isInside(root, fileName)) throw new Error('Project file path escapes the workspace')
  const config = projectConfiguration(root)
  const normalizedSource = canonical(fileName)
  if (!config.fileNames.some((candidate) => canonical(candidate) === normalizedSource)) {
    config.fileNames.push(fileName)
  }
  if (config.fileNames.length > MAX_PROJECT_FILES) throw new Error(`TypeScript project exceeds ${MAX_PROJECT_FILES} source files`)
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => config.options,
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getScriptFileNames: () => config.fileNames,
    getScriptVersion: (name) => {
      try { return String(statSync(name).mtimeMs) } catch { return '0' }
    },
    getScriptSnapshot: (name) => {
      const content = canonical(name) === normalizedSource ? input.content : ts.sys.readFile(name)
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine
  }
  const service = ts.createLanguageService(host, ts.createDocumentRegistry())
  try {
    const position = offsetForLocation(input.content, input.line, input.column)
    const info = service.getRenameInfo(fileName, position, { allowRenameOfImportPath: false })
    if (!info.canRename) throw new Error(info.localizedErrorMessage || 'TypeScript cannot rename this symbol')
    const locations = service.findRenameLocations(fileName, position, false, false, true) ?? []
    const changes: Record<string, Array<{ range: { start: Location; end: Location }; newText: string }>> = {}
    for (const location of locations) {
      const content = canonical(location.fileName) === normalizedSource ? input.content : ts.sys.readFile(location.fileName)
      if (content === undefined) throw new Error('TypeScript rename target could not be read')
      const start = locationForOffset(content, location.textSpan.start)
      const end = locationForOffset(content, location.textSpan.start + location.textSpan.length)
      const uri = pathToFileURL(location.fileName).href
      changes[uri] ??= []
      changes[uri].push({
        range: { start, end },
        newText: `${location.prefixText ?? ''}${newName}${location.suffixText ?? ''}`
      })
    }
    return { changes }
  } finally {
    service.dispose()
  }
}

interface Location {
  line: number
  character: number
}

function projectConfiguration(root: string): { fileNames: string[]; options: ts.CompilerOptions } {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') ??
    ts.findConfigFile(root, ts.sys.fileExists, 'jsconfig.json')
  if (!configPath) {
    const fileNames = ts.sys.readDirectory(root, ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], ['node_modules', '.git', 'dist', 'build', 'out'], ['**/*'])
    return { fileNames, options: { allowJs: true, checkJs: false, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.NodeNext } }
  }
  const source = ts.readConfigFile(configPath, ts.sys.readFile)
  if (source.error) throw new Error(flattenDiagnostic(source.error))
  const parsed = ts.parseJsonConfigFileContent(source.config, ts.sys, path.dirname(configPath), undefined, configPath)
  const error = parsed.errors.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (error) throw new Error(flattenDiagnostic(error))
  return { fileNames: parsed.fileNames, options: parsed.options }
}

function offsetForLocation(content: string, lineValue: number, columnValue: number): number {
  const lines = content.split('\n')
  const line = Math.max(1, Math.min(Math.floor(lineValue), lines.length))
  let offset = 0
  for (let index = 0; index < line - 1; index += 1) offset += lines[index].length + 1
  return offset + Math.max(0, Math.min(Math.floor(columnValue) - 1, lines[line - 1].length))
}

function locationForOffset(content: string, offsetValue: number): Location {
  const offset = Math.max(0, Math.min(offsetValue, content.length))
  let line = 0
  let lineStart = 0
  for (let index = 0; index < offset; index += 1) {
    if (content[index] !== '\n') continue
    line += 1
    lineStart = index + 1
  }
  return { line, character: offset - lineStart }
}

function canonical(value: string): string {
  const resolved = path.resolve(value)
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLocaleLowerCase()
}

function isInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function flattenDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}
