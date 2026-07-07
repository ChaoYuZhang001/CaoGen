type MouseButton = 'left' | 'right' | 'middle'

interface NutMouse {
  setPosition?: (target: unknown) => Promise<void> | void
  leftClick?: () => Promise<void> | void
  rightClick?: () => Promise<void> | void
  click?: (button: unknown) => Promise<void> | void
  scrollDown?: (amount: number) => Promise<void> | void
  scrollUp?: (amount: number) => Promise<void> | void
  scrollLeft?: (amount: number) => Promise<void> | void
  scrollRight?: (amount: number) => Promise<void> | void
}

interface NutKeyboard {
  type?: (text: string) => Promise<void> | void
  pressKey?: (...keys: unknown[]) => Promise<void> | void
  releaseKey?: (...keys: unknown[]) => Promise<void> | void
}

interface NutModule {
  mouse?: NutMouse
  keyboard?: NutKeyboard
  Point?: new (x: number, y: number) => unknown
  straightTo?: (target: unknown) => unknown
  Button?: Record<string, unknown>
  Key?: Record<string, unknown>
}

type NutLoadResult = { ok: true; nut: NutModule } | { ok: false; error: string }

let cachedNut: Promise<NutLoadResult> | null = null

export async function nutClick(x: number, y: number, button: MouseButton): Promise<boolean> {
  const loaded = await loadNut()
  if (!loaded.ok) return false
  const { nut } = loaded
  if (!nut.mouse || !nut.Point) return false
  const point = new nut.Point(x, y)
  const target = nut.straightTo ? nut.straightTo(point) : point
  await nut.mouse.setPosition?.(target)
  if (button === 'right' && nut.mouse.rightClick) {
    await nut.mouse.rightClick()
    return true
  }
  if (button === 'middle' && nut.mouse.click && nut.Button?.MIDDLE) {
    await nut.mouse.click(nut.Button.MIDDLE)
    return true
  }
  if (nut.mouse.leftClick) {
    await nut.mouse.leftClick()
    return true
  }
  return false
}

export async function nutType(text: string): Promise<boolean> {
  const loaded = await loadNut()
  if (!loaded.ok || !loaded.nut.keyboard?.type) return false
  await loaded.nut.keyboard.type(text)
  return true
}

export async function nutHotkey(keys: string[]): Promise<boolean> {
  const loaded = await loadNut()
  if (!loaded.ok) return false
  const keyboard = loaded.nut.keyboard
  const keyMap = loaded.nut.Key
  if (!keyboard?.pressKey || !keyboard.releaseKey || !keyMap) return false
  const resolved = keys.map((key) => resolveNutKey(keyMap, key)).filter((key): key is unknown => key !== undefined)
  if (resolved.length !== keys.length) return false
  await keyboard.pressKey(...resolved)
  await keyboard.releaseKey(...resolved.reverse())
  return true
}

export async function nutScroll(
  deltaX: number | undefined,
  deltaY: number | undefined,
  x?: number,
  y?: number
): Promise<boolean> {
  const loaded = await loadNut()
  if (!loaded.ok || !loaded.nut.mouse) return false
  const { mouse, Point, straightTo } = loaded.nut
  if (typeof x === 'number' && typeof y === 'number' && Point) {
    const point = new Point(x, y)
    const target = straightTo ? straightTo(point) : point
    await mouse.setPosition?.(target)
  }

  let scrolled = false
  const vertical = scrollAmount(deltaY)
  if (vertical > 0) {
    if ((deltaY ?? 0) > 0 && mouse.scrollDown) {
      await mouse.scrollDown(vertical)
      scrolled = true
    } else if ((deltaY ?? 0) < 0 && mouse.scrollUp) {
      await mouse.scrollUp(vertical)
      scrolled = true
    }
  }

  const horizontal = scrollAmount(deltaX)
  if (horizontal > 0) {
    if ((deltaX ?? 0) > 0 && mouse.scrollRight) {
      await mouse.scrollRight(horizontal)
      scrolled = true
    } else if ((deltaX ?? 0) < 0 && mouse.scrollLeft) {
      await mouse.scrollLeft(horizontal)
      scrolled = true
    }
  }

  return scrolled
}

function loadNut(): Promise<NutLoadResult> {
  cachedNut ??= loadNutOnce()
  return cachedNut
}

async function loadNutOnce(): Promise<NutLoadResult> {
  for (const specifier of ['@nut-tree-fork/nut-js', '@nut-tree/nut-js']) {
    try {
      const imported = await dynamicImport(specifier)
      if (isNutModule(imported)) return { ok: true, nut: imported }
    } catch {
      // nut.js 是可选依赖;不可用时交给系统级兜底实现。
    }
  }
  return { ok: false, error: 'nut.js is not installed' }
}

function dynamicImport(specifier: string): Promise<unknown> {
  const importer = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<unknown>
  return importer(specifier)
}

function isNutModule(value: unknown): value is NutModule {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.mouse === 'object' || typeof record.keyboard === 'object'
}

function resolveNutKey(keyMap: Record<string, unknown>, raw: string): unknown {
  const normalized = raw.trim().toLowerCase()
  const aliases: Record<string, string> = {
    cmd: 'LeftCmd',
    command: 'LeftCmd',
    meta: 'LeftWin',
    win: 'LeftWin',
    ctrl: 'LeftControl',
    control: 'LeftControl',
    alt: 'LeftAlt',
    option: 'LeftAlt',
    shift: 'LeftShift',
    enter: 'Enter',
    return: 'Enter',
    esc: 'Escape',
    escape: 'Escape',
    tab: 'Tab',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete'
  }
  const candidate = aliases[normalized] ?? normalized.toUpperCase()
  return keyMap[candidate] ?? keyMap[capitalize(normalized)]
}

function scrollAmount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 0
  return Math.max(1, Math.min(100, Math.round(Math.abs(value) / 120) || 1))
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value
}
