import type { TaskStrategy } from '../../../../shared/types'
import { useT } from '../../i18n'

interface TaskStrategyControlProps {
  value: TaskStrategy
  disabled?: boolean
  onChange: (strategy: TaskStrategy) => void
  compact?: boolean
}

const STRATEGIES: TaskStrategy[] = ['view', 'plan', 'execute']

export default function TaskStrategyControl({
  value,
  disabled = false,
  onChange,
  compact = false
}: TaskStrategyControlProps): React.JSX.Element {
  const t = useT()
  return (
    <div
      className={`task-strategy-control${compact ? ' task-strategy-compact' : ''}`}
      role="group"
      aria-label={t('taskStrategy')}
      data-task-strategy={value}
    >
      {STRATEGIES.map((strategy) => (
        <button
          key={strategy}
          type="button"
          aria-pressed={value === strategy}
          data-task-strategy-option={strategy}
          className={value === strategy ? 'active' : ''}
          disabled={disabled}
          title={t(taskStrategyDescriptionKey(strategy))}
          onClick={() => onChange(strategy)}
        >
          {t(taskStrategyLabelKey(strategy))}
        </button>
      ))}
    </div>
  )
}

function taskStrategyLabelKey(strategy: TaskStrategy): string {
  if (strategy === 'view') return 'taskStrategyView'
  if (strategy === 'plan') return 'taskStrategyPlan'
  return 'taskStrategyExecute'
}

function taskStrategyDescriptionKey(strategy: TaskStrategy): string {
  if (strategy === 'view') return 'taskStrategyViewDescription'
  if (strategy === 'plan') return 'taskStrategyPlanDescription'
  return 'taskStrategyExecuteDescription'
}
