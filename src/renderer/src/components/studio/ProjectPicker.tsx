import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { ProjectWorkspace } from '../../../../shared/types'
import { PROJECT_STATUS_LABELS, TEXT } from './projectWorkspaceStudioModel'

interface ProjectPickerProps {
  labelId: string
  projects: ProjectWorkspace[]
  selectedProjectId: string
  disabled: boolean
  onSelect: (id: string) => void
}

/**
 * Keep project selection inside the Electron window. Native macOS select menus
 * can size themselves from an unbounded option label and paint over other
 * windows, so the visible control uses a bounded listbox while the hidden
 * select preserves the existing automation/state probe contract.
 */
export default function ProjectPicker({
  ...props
}: ProjectPickerProps): React.JSX.Element {
  const {
    activeIndex,
    close,
    choose,
    listboxId,
    nativeSelectId,
    onOptionKeyDown,
    onTriggerKeyDown,
    open,
    openPicker,
    optionRefs,
    rootRef,
    selectedLabel,
    triggerRef
  } = useProjectPickerController(props)
  const { disabled, labelId, onSelect, projects, selectedProjectId } = props

  return (
    <div ref={rootRef} className="pws-project-picker">
      <label id={labelId} className="pws-visually-hidden" htmlFor={nativeSelectId}>{TEXT.selectProject}</label>
      <button
        ref={triggerRef}
        type="button"
        className="select pws-project-select pws-project-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={labelId}
        title={selectedLabel}
        disabled={disabled || projects.length === 0}
        onClick={() => open ? close(false) : openPicker()}
        onKeyDown={onTriggerKeyDown}
        data-project-workspace-select-trigger
      >
        <span className="pws-project-select-label">{selectedLabel}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <ProjectPickerMenu
          activeIndex={activeIndex}
          listboxId={listboxId}
          onChoose={choose}
          onOptionKeyDown={onOptionKeyDown}
          optionRefs={optionRefs}
          projects={projects}
          selectedProjectId={selectedProjectId}
        />
      )}
      <ProjectPickerNativeSelect
        disabled={disabled || projects.length === 0}
        id={nativeSelectId}
        onSelect={onSelect}
        projects={projects}
        selectedProjectId={selectedProjectId}
      />
    </div>
  )
}

function useProjectPickerController({
  disabled,
  onSelect,
  projects,
  selectedProjectId
}: Omit<ProjectPickerProps, 'labelId'>): {
  activeIndex: number
  close: (restoreFocus: boolean) => void
  choose: (index: number) => void
  listboxId: string
  nativeSelectId: string
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  onTriggerKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void
  open: boolean
  openPicker: (index?: number) => void
  optionRefs: MutableRefObject<Array<HTMLDivElement | null>>
  rootRef: React.MutableRefObject<HTMLDivElement | null>
  selectedLabel: string
  triggerRef: React.MutableRefObject<HTMLButtonElement | null>
} {
  const pickerId = useId()
  const listboxId = `${pickerId}-listbox`
  const nativeSelectId = `${pickerId}-native`
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLDivElement | null>>([])
  const [open, setOpen] = useState(false)
  const selectedIndex = Math.max(0, projects.findIndex((project) => project.id === selectedProjectId))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[selectedIndex]
  const selectedLabel = selectedProject ? projectLabel(selectedProject) : TEXT.noProjects

  useEffect(() => {
    setActiveIndex(selectedIndex)
  }, [selectedIndex])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onWindowBlur = (): void => setOpen(false)
    const onWindowResize = (): void => setOpen(false)
    document.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('resize', onWindowResize)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('resize', onWindowResize)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
  }, [disabled])

  const close = (restoreFocus: boolean): void => {
    if (restoreFocus) triggerRef.current?.focus()
    setOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const choose = (index: number): void => {
    const project = projects[index]
    if (!project) return
    setActiveIndex(index)
    onSelect(project.id)
    close(true)
  }

  const openPicker = (index = selectedIndex): void => {
    if (disabled || projects.length === 0) return
    setActiveIndex(Math.max(0, Math.min(index, projects.length - 1)))
    setOpen(true)
  }

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    handleTriggerKeyDown(event, disabled, projects.length, open, selectedIndex, close, openPicker)
  }
  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
    handleOptionKeyDown(event, index, projects.length, setActiveIndex, optionRefs, choose, close, setOpen)
  }
  return {
    activeIndex,
    close,
    choose,
    listboxId,
    nativeSelectId,
    onOptionKeyDown,
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
  projectCount: number,
  open: boolean,
  selectedIndex: number,
  close: (restoreFocus: boolean) => void,
  openPicker: (index?: number) => void
): void {
  if (disabled || projectCount === 0) return
  if (event.key === 'Escape' && open) {
    event.preventDefault()
    close(true)
  } else if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    openPicker(selectedIndex)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    openPicker(selectedIndex - 1)
  }
}

function handleOptionKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  index: number,
  projectCount: number,
  setActiveIndex: (index: number) => void,
  optionRefs: MutableRefObject<Array<HTMLDivElement | null>>,
  choose: (index: number) => void,
  close: (restoreFocus: boolean) => void,
  setOpen: (open: boolean) => void
): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? projectCount - 1
        : event.key === 'ArrowDown' ? Math.min(projectCount - 1, index + 1)
          : Math.max(0, index - 1)
    setActiveIndex(next)
    optionRefs.current[next]?.focus()
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

function projectLabel(project: ProjectWorkspace): string {
  return `${project.name}${project.status === 'active' ? '' : ` · ${PROJECT_STATUS_LABELS[project.status]}`}`
}

interface ProjectPickerMenuProps {
  activeIndex: number
  listboxId: string
  onChoose: (index: number) => void
  onOptionKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  optionRefs: MutableRefObject<Array<HTMLDivElement | null>>
  projects: ProjectWorkspace[]
  selectedProjectId: string
}

function ProjectPickerMenu({
  activeIndex,
  listboxId,
  onChoose,
  onOptionKeyDown,
  optionRefs,
  projects,
  selectedProjectId
}: ProjectPickerMenuProps): React.JSX.Element {
  return (
    <div
      id={listboxId}
      className="pws-project-select-menu"
      role="listbox"
      aria-label={TEXT.selectProject}
      data-project-workspace-select-menu
    >
      {projects.map((project, index) => (
        <div
          key={project.id}
          ref={(element) => { optionRefs.current[index] = element }}
          className="pws-project-select-option"
          role="option"
          aria-selected={project.id === selectedProjectId}
          tabIndex={index === activeIndex ? 0 : -1}
          onClick={() => onChoose(index)}
          onKeyDown={(event) => onOptionKeyDown(event, index)}
          data-project-workspace-option={project.id}
        >
          <Check size={14} aria-hidden="true" />
          <span>{projectLabel(project)}</span>
        </div>
      ))}
    </div>
  )
}

function ProjectPickerNativeSelect({
  disabled,
  id,
  onSelect,
  projects,
  selectedProjectId
}: {
  disabled: boolean
  id: string
  onSelect: (id: string) => void
  projects: ProjectWorkspace[]
  selectedProjectId: string
}): React.JSX.Element {
  return (
    <select
      id={id}
      className="pws-project-select-native pws-visually-hidden"
      value={selectedProjectId}
      onChange={(event) => onSelect(event.target.value)}
      disabled={disabled}
      tabIndex={-1}
      aria-hidden="true"
      data-project-workspace-select
    >
      {projects.length === 0 && <option value="">{TEXT.noProjects}</option>}
      {projects.map((project) => <option key={project.id} value={project.id}>{projectLabel(project)}</option>)}
    </select>
  )
}
