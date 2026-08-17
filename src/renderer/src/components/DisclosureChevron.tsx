import { ChevronRight } from 'lucide-react'

interface DisclosureChevronProps {
  expanded: boolean
  className?: string
  size?: number
}

export function DisclosureChevron({
  expanded,
  className = '',
  size = 14
}: DisclosureChevronProps): React.JSX.Element {
  return (
    <ChevronRight
      className={`disclosure-chevron ${expanded ? 'is-expanded' : ''} ${className}`.trim()}
      size={size}
      strokeWidth={1.9}
      aria-hidden="true"
    />
  )
}
