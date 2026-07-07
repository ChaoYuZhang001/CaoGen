declare module 'tree-sitter-typescript' {
  interface TreeSitterGrammar {
    language: unknown
  }
  const grammars: {
    typescript: TreeSitterGrammar
    tsx: TreeSitterGrammar
  }
  export = grammars
}

declare module 'tree-sitter-javascript' {
  const grammar: { language: unknown }
  export = grammar
}

declare module 'tree-sitter-python' {
  const grammar: { language: unknown }
  export = grammar
}

declare module 'tree-sitter-go' {
  const grammar: { language: unknown }
  export = grammar
}

declare module 'tree-sitter-rust' {
  const grammar: { language: unknown }
  export = grammar
}

declare module 'tree-sitter-java' {
  const grammar: { language: unknown }
  export = grammar
}
