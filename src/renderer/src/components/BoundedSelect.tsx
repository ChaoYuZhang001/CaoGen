import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject
} from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { createPortal } from 'react-dom'

export interface BoundedSelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface BoundedSelectProps {
  ariaLabel: string
  disabled?: boolean
  nativeClassName: string
  nativeDataAttributes?: Record<string, string>
  onChange: (value: string) => void
  options: BoundedSelectOption[]
  rootClassName?: string
  title?: string
  value: string
}

interface MenuPosition {
  bottom?: number
  left: number
  maxHeight: number
  top?: number
  width: number
}

/**
 * Native macOS select popovers can grow beyond an Electron window when an
 * option contains a long user-controlled label. Keep the visible picker in
 * the viewport while retaining a hidden native select for automation and the
 * browser's controlled-form contract.
 */
export default function BoundedSelect({
  ariaLabel,
  disabled = false,
  nativeClassName,
  nativeDataAttributes,
  onChange,
  options,
  rootClassName = '',
  title,
  value
}: BoundedSelectProps): React.JSX.Element {
  const controller = useBoundedSelectController({ disabled, onChange, options, value })
  const {
    activeIndex,
    choose,
    close,
    listboxId,
    listboxRef,
    menuPosition,
    nativeSelectId,
    onListboxKeyDown,
    onTriggerKeyDown,
    open,
    openPicker,
    optionRefs,
    rootRef,
    selectedLabel,
    triggerRef
  } = controller

  return (
    <div
      ref={rootRef}
      className={`welcome-bounded-select ${rootClassName}`.trim()}
      data-bounded-select
    >
      <button
        ref={triggerRef}
        type="button"
        className="welcome-bounded-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        title={title ?? selectedLabel}
        disabled={disabled}
        onClick={() => open ? close(false) : openPicker()}
        onKeyDown={onTriggerKeyDown}
        data-bounded-select-trigger
      >
        <span className="welcome-bounded-select-label">{selectedLabel}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && menuPosition && createPortal(
        <BoundedSelectMenu
          activeIndex={activeIndex}
          ariaLabel={ariaLabel}
          listboxId={listboxId}
          listboxRef={listboxRef}
          menuPosition={menuPosition}
          onChoose={choose}
          onKeyDown={onListboxKeyDown}
          optionRefs={optionRefs}
          options={options}
          value={value}
        />,
        document.body
      )}
      <select
        {...nativeDataAttributes}
        id={nativeSelectId}
        className={`${nativeClassName} welcome-bounded-select-native`}
        aria-label={ariaLabel}
        aria-hidden="true"
        tabIndex={-1}
        title={title ?? selectedLabel}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </div>
  )
}

function useBoundedSelectController({
  disabled,
  onChange,
  options,
  value
}: Pick<BoundedSelectProps, 'disabled' | 'onChange' | 'options' | 'value'>) {
  const id = useId()
  const listboxId = `${id}-listbox`
  const nativeSelectId = `${id}-native`
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLDivElement | null>>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(() => preferredIndex(options, value))
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const selectedOption = options.find((option) => option.value === value) ?? options[0]
  const selectedLabel = selectedOption?.label ?? ''

  useEffect(() => {
    const nextIndex = preferredIndex(options, value)
    setActiveIndex(nextIndex)
    optionRefs.current.length = options.length
  }, [options, value])

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) return
    const closeFromPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !listboxRef.current?.contains(target)) setOpen(false)
    }
    const closeFromWindow = (): void => setOpen(false)
    document.addEventListener('pointerdown', closeFromPointer, true)
    window.addEventListener('blur', closeFromWindow)
    window.addEventListener('resize', closeFromWindow)
    return () => {
      document.removeEventListener('pointerdown', closeFromPointer, true)
      window.removeEventListener('blur', closeFromWindow)
      window.removeEventListener('resize', closeFromWindow)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.focus()
    else listboxRef.current?.focus()
  }, [activeIndex, open])

  const close = (restoreFocus: boolean): void => {
    setOpen(false)
    if (!restoreFocus) return
    triggerRef.current?.focus()
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const openPicker = (edge?: 'first' | 'last'): void => {
    if (disabled) return
    const nextIndex = edge === 'first'
      ? firstEnabledIndex(options)
      : edge === 'last'
        ? lastEnabledIndex(options)
        : preferredIndex(options, value)
    setActiveIndex(nextIndex)
    setMenuPosition(measureMenu(triggerRef.current, options.length))
    setOpen(true)
  }

  const choose = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    setActiveIndex(index)
    onChange(option.value)
    close(true)
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    handleTriggerKeyDown(event, Boolean(disabled), open, close, openPicker)
  }

  const onListboxKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
    handleListboxKeyDown(event, index, options, setActiveIndex, optionRefs, choose, close, setOpen)
  }

  return {
    activeIndex,
    choose,
    close,
    listboxId,
    listboxRef,
    menuPosition,
    nativeSelectId,
    onListboxKeyDown,
    onTriggerKeyDown,
    open,
    openPicker,
    optionRefs,
    rootRef,
    selectedLabel,
    triggerRef
  }
}

function handleTriggerKeyDown(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  disabled: boolean,
  open: boolean,
  close: (restoreFocus: boolean) => void,
  openPicker: () => void
): void {
  if (disabled) return
  if (event.key === 'Escape' && open) {
    event.preventDefault()
    close(true)
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    openPicker()
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open ? close(false) : openPicker()
  }
}

function handleListboxKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  index: number,
  options: BoundedSelectOption[],
  setActiveIndex: (index: number) => void,
  optionRefs: MutableRefObject<Array<HTMLDivElement | null>>,
  choose: (index: number) => void,
  close: (restoreFocus: boolean) => void,
  setOpen: (open: boolean) => void
): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const nextIndex = event.key === 'Home'
      ? firstEnabledIndex(options)
      : event.key === 'End'
        ? lastEnabledIndex(options)
        : nextEnabledIndex(options, index, event.key === 'ArrowDown' ? 1 : -1)
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex)
      optionRefs.current[nextIndex]?.focus()
    }
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    choose(index)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    close(true)
  } else if (event.key === 'Tab') {
    setOpen(false)
  }
}

function BoundedSelectMenu({
  activeIndex,
  ariaLabel,
  listboxId,
  listboxRef,
  menuPosition,
  onChoose,
  onKeyDown,
  optionRefs,
  options,
  value
}: {
  activeIndex: number
  ariaLabel: string
  listboxId: string
  listboxRef: React.RefObject<HTMLDivElement>
  menuPosition: MenuPosition
  onChoose: (index: number) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  optionRefs: MutableRefObject<Array<HTMLDivElement | null>>
  options: BoundedSelectOption[]
  value: string
}): React.JSX.Element {
  const style: CSSProperties = menuPosition
  return (
    <div
      ref={listboxRef}
      id={listboxId}
      className="welcome-bounded-select-menu"
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={activeIndex < 0 ? 0 : -1}
      style={style}
      onKeyDown={(event) => onKeyDown(event, activeIndex)}
      data-bounded-select-menu
    >
      {options.map((option, index) => (
        <div
          key={option.value}
          ref={(element) => { optionRefs.current[index] = element }}
          className="welcome-bounded-select-option"
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          tabIndex={index === activeIndex && !option.disabled ? 0 : -1}
          title={option.label}
          onClick={() => onChoose(index)}
          data-bounded-select-option={option.value}
        >
          <Check size={13} aria-hidden="true" />
          <span>{option.label}</span>
        </div>
      ))}
    </div>
  )
}

function firstEnabledIndex(options: BoundedSelectOption[]): number {
  return options.findIndex((option) => !option.disabled)
}

function lastEnabledIndex(options: BoundedSelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index
  }
  return -1
}

function preferredIndex(options: BoundedSelectOption[], value: string): number {
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled)
  return selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(options)
}

function nextEnabledIndex(options: BoundedSelectOption[], index: number, direction: 1 | -1): number {
  let candidate = index + direction
  while (candidate >= 0 && candidate < options.length) {
    if (!options[candidate]?.disabled) return candidate
    candidate += direction
  }
  return index >= 0 && !options[index]?.disabled ? index : preferredIndex(options, '')
}

function measureMenu(trigger: HTMLButtonElement | null, optionCount: number): MenuPosition {
  const viewportPadding = 12
  const menuGap = 6
  const viewportWidth = Math.max(1, window.innerWidth)
  const viewportHeight = Math.max(1, window.innerHeight)
  const rect = trigger?.getBoundingClientRect() ?? new DOMRect(viewportPadding, viewportPadding, 180, 30)
  const width = Math.min(Math.max(rect.width, 190), Math.max(1, viewportWidth - viewportPadding * 2))
  const left = Math.min(
    Math.max(viewportPadding, rect.left),
    Math.max(viewportPadding, viewportWidth - viewportPadding - width)
  )
  const spaceAbove = Math.max(0, rect.top - viewportPadding - menuGap)
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - viewportPadding - menuGap)
  const estimatedHeight = Math.min(320, Math.max(42, optionCount * 38 + 10))
  const placeAbove = spaceAbove >= estimatedHeight || spaceAbove > spaceBelow
  const maxHeight = Math.min(320, placeAbove ? spaceAbove : spaceBelow)

  return placeAbove
    ? { bottom: viewportHeight - rect.top + menuGap, left, maxHeight, width }
    : { top: rect.bottom + menuGap, left, maxHeight, width }
}
