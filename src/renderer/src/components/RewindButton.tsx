import { useStore } from '../store'

/**
 * 用户消息旁的"回退"入口:打开全局回溯面板,先 dryRun 预览,确认后恢复代码。
 */
export default function RewindButton({
  messageId,
  sourceText
}: {
  messageId: string
  sourceText?: string
}): React.JSX.Element {
  const openRewindPanel = useStore((s) => s.openRewindPanel)

  return (
    <span className="rewind">
      <button
        className="rewind-trigger"
        title="回退代码到此轮之前"
        onClick={() => openRewindPanel(messageId, sourceText, 'button')}
      >
        ⟲ 回退
      </button>
    </span>
  )
}
