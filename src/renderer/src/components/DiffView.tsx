interface Props {
  filePath?: string
  oldText: string
  newText: string
}

/**
 * 轻量差异视图:删除内容红色块、新增内容绿色块。
 * Edit 工具的 old_string/new_string 通常是局部片段,直接对照展示已足够清晰。
 */
export default function DiffView({ filePath, oldText, newText }: Props): React.JSX.Element {
  return (
    <div className="diff">
      {filePath && <div className="diff-file">{filePath}</div>}
      {oldText && (
        <pre className="diff-block diff-old">
          {oldText
            .split('\n')
            .map((l) => `- ${l}`)
            .join('\n')}
        </pre>
      )}
      {newText && (
        <pre className="diff-block diff-new">
          {newText
            .split('\n')
            .map((l) => `+ ${l}`)
            .join('\n')}
        </pre>
      )}
    </div>
  )
}
