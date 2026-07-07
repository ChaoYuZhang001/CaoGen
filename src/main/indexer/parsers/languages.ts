import Parser from 'tree-sitter'
import tsGrammar from 'tree-sitter-typescript'
import jsGrammar from 'tree-sitter-javascript'
import pyGrammar from 'tree-sitter-python'
import goGrammar from 'tree-sitter-go'
import rustGrammar from 'tree-sitter-rust'
import javaGrammar from 'tree-sitter-java'
import { extname } from 'node:path'

export type CodeLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'rust' | 'java'
export type CodeSymbolKind = 'function' | 'class' | 'interface' | 'method' | 'constant' | 'type' | 'export'

export interface ParsedSymbol {
  name: string
  kind: CodeSymbolKind
  line: number
  column: number
  endLine: number
  signature: string
  exported: boolean
}

export interface ParsedImport {
  specifier: string
  line: number
}

export interface ParsedCodeFile {
  language: CodeLanguage
  symbols: ParsedSymbol[]
  imports: ParsedImport[]
}

interface LanguageConfig {
  language: CodeLanguage
  grammar: unknown
}

const parser = new Parser()

export function languageForFile(filePath: string): LanguageConfig | null {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.ts') return { language: 'typescript', grammar: tsGrammar.typescript }
  if (ext === '.tsx') return { language: 'tsx', grammar: tsGrammar.tsx }
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    return { language: 'javascript', grammar: jsGrammar }
  }
  if (ext === '.py') return { language: 'python', grammar: pyGrammar }
  if (ext === '.go') return { language: 'go', grammar: goGrammar }
  if (ext === '.rs') return { language: 'rust', grammar: rustGrammar }
  if (ext === '.java') return { language: 'java', grammar: javaGrammar }
  return null
}

export function parseCodeFile(filePath: string, content: string): ParsedCodeFile | null {
  const config = languageForFile(filePath)
  if (!config) return null
  parser.setLanguage(config.grammar)
  const tree = parser.parse(content)
  const symbols: ParsedSymbol[] = []
  collectSymbols(tree.rootNode, content, symbols)
  return {
    language: config.language,
    symbols: dedupeSymbols(symbols),
    imports: extractImports(config.language, content)
  }
}

function collectSymbols(node: Parser.SyntaxNode, content: string, symbols: ParsedSymbol[]): void {
  const symbol = symbolForNode(node, content)
  if (symbol) symbols.push(symbol)
  for (const child of node.namedChildren) collectSymbols(child, content, symbols)
}

function symbolForNode(node: Parser.SyntaxNode, content: string): ParsedSymbol | null {
  const kind = kindForNode(node)
  if (!kind) return null
  const nameNode = nameNodeFor(node)
  const name = nameNode?.text.trim()
  if (!name) return null
  return {
    name,
    kind,
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    signature: signatureForNode(node, content),
    exported: isExported(node)
  }
}

function kindForNode(node: Parser.SyntaxNode): CodeSymbolKind | null {
  switch (node.type) {
    case 'function_declaration':
    case 'function_definition':
    case 'function_item':
      return 'function'
    case 'class_declaration':
    case 'class_definition':
      return 'class'
    case 'interface_declaration':
    case 'interface_type':
    case 'interface_item':
    case 'trait_item':
      return 'interface'
    case 'type_alias_declaration':
    case 'type_declaration':
    case 'struct_item':
    case 'enum_item':
      return 'type'
    case 'method_definition':
    case 'method_declaration':
    case 'method_signature':
      return 'method'
    case 'lexical_declaration':
    case 'const_declaration':
    case 'const_item':
      return 'constant'
    case 'export_statement':
      return 'export'
    default:
      return null
  }
}

function nameNodeFor(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const named = node.childForFieldName('name')
  if (named) return named
  if (node.type === 'lexical_declaration' || node.type === 'const_declaration') {
    return firstDescendantOfType(node, ['identifier', 'property_identifier', 'type_identifier'])
  }
  if (node.type === 'export_statement') {
    return firstDescendantOfType(node, ['identifier', 'property_identifier', 'type_identifier'])
  }
  return firstDescendantOfType(node, ['identifier', 'property_identifier', 'type_identifier'])
}

function firstDescendantOfType(node: Parser.SyntaxNode, types: string[]): Parser.SyntaxNode | null {
  if (types.includes(node.type)) return node
  for (const child of node.namedChildren) {
    const found = firstDescendantOfType(child, types)
    if (found) return found
  }
  return null
}

function isExported(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node
  while (current) {
    if (current.type === 'export_statement') return true
    current = current.parent
  }
  const previous = node.previousSibling?.text.trim()
  return previous === 'export' || previous === 'pub'
}

function signatureForNode(node: Parser.SyntaxNode, content: string): string {
  const start = node.startIndex
  const maxEnd = Math.min(content.length, start + 500)
  const raw = content.slice(start, maxEnd)
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? node.text.slice(0, 160)
  return firstLine.length > 240 ? `${firstLine.slice(0, 240)}...` : firstLine
}

function extractImports(language: CodeLanguage, content: string): ParsedImport[] {
  const patterns = importPatterns(language)
  const imports: ParsedImport[] = []
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1]?.trim()
      if (specifier) imports.push({ specifier, line: lineNumberAt(content, match.index) })
    }
  }
  return dedupeImports(imports)
}

function importPatterns(language: CodeLanguage): RegExp[] {
  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    return [
      /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
      /\bexport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
    ]
  }
  if (language === 'python') return [/^\s*(?:from|import)\s+([A-Za-z0-9_\.]+)/gm]
  if (language === 'go') return [/\bimport\s+(?:\(\s*)?["`]([^"`]+)["`]/g]
  if (language === 'rust') return [/\bmod\s+([A-Za-z0-9_]+)\s*;/g, /\buse\s+([A-Za-z0-9_:]+)/g]
  if (language === 'java') return [/\bimport\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/g]
  return []
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1
  const capped = Math.min(Math.max(offset, 0), content.length)
  for (let i = 0; i < capped; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

function dedupeSymbols(symbols: ParsedSymbol[]): ParsedSymbol[] {
  const seen = new Set<string>()
  return symbols.filter((symbol) => {
    const key = `${symbol.kind}:${symbol.name}:${symbol.line}:${symbol.column}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeImports(imports: ParsedImport[]): ParsedImport[] {
  const seen = new Set<string>()
  return imports.filter((item) => {
    const key = `${item.specifier}:${item.line}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
