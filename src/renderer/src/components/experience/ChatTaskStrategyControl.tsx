import type { TaskStrategy } from '../../../../shared/types'
import { useStore } from '../../store'
import TaskStrategyControl from './TaskStrategyControl'

interface ChatTaskStrategyControlProps {
  value: TaskStrategy
  disabled: boolean
}

export default function ChatTaskStrategyControl({
  value,
  disabled
}: ChatTaskStrategyControlProps): React.JSX.Element {
  const setTaskStrategy = useStore((store) => store.setTaskStrategy)
  return (
    <TaskStrategyControl value={value} disabled={disabled} compact
      onChange={(strategy) => void setTaskStrategy(strategy).catch(() => undefined)} />
  )
}
