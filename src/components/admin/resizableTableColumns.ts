import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import type { CSSProperties } from "react"

const COLUMN_MAX = 720

export type TableColumnWidths = Record<string, number>

export function clampTableColumnWidth(value: number, min: number, max = COLUMN_MAX): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function readTableColumnWidths(
  storageKey: string,
  keys: string[],
  mins: TableColumnWidths,
): TableColumnWidths | null {
  if (!storageKey) return null
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const columns: TableColumnWidths = {}
    for (const key of keys) {
      const value = parsed[key]
      if (typeof value !== "number" || !Number.isFinite(value)) return null
      columns[key] = clampTableColumnWidth(value, mins[key] ?? 64)
    }
    return columns
  } catch {
    return null
  }
}

export function writeTableColumnWidths(storageKey: string, widths: TableColumnWidths) {
  if (!storageKey) return
  try {
    localStorage.setItem(storageKey, JSON.stringify(widths))
  } catch {
    /* ignore quota or private-mode failures */
  }
}

export function clearTableColumnWidths(storageKey: string) {
  if (!storageKey) return
  try {
    localStorage.removeItem(storageKey)
  } catch {
    /* ignore private-mode failures */
  }
}

export function tableColumnStyle(width: number | undefined): CSSProperties | undefined {
  if (!width) return undefined
  return { width, minWidth: width, maxWidth: width }
}

export function sameTableColumnWidths(keys: string[], left: TableColumnWidths | null, right: TableColumnWidths) {
  if (!left) return false
  return keys.every((key) => left[key] === right[key])
}

export function fitTableColumnWidths(
  keys: string[],
  widths: TableColumnWidths,
  containerWidth: number,
  mins: TableColumnWidths,
): TableColumnWidths {
  const available = Math.round(containerWidth)
  if (available <= 0) return widths
  const minSum = keys.reduce((sum, key) => sum + (mins[key] ?? 64), 0)
  const target = Math.max(available, minSum)
  const current = keys.reduce((sum, key) => sum + (widths[key] ?? 0), 0)
  if (current <= 0) return widths
  const alreadyAtFloor = keys.every((key) => (widths[key] ?? 0) >= (mins[key] ?? 64))
  if (current === target && alreadyAtFloor) return widths
  const scale = target / current
  const next: TableColumnWidths = { ...widths }
  let used = 0
  keys.forEach((key, index) => {
    const min = mins[key] ?? 64
    if (index === keys.length - 1) {
      next[key] = Math.max(min, Math.min(COLUMN_MAX, target - used))
      return
    }
    next[key] = Math.max(min, Math.min(COLUMN_MAX, Math.round((widths[key] ?? min) * scale)))
    used += next[key]
  })
  const unchanged = keys.every((key) => next[key] === widths[key])
  return unchanged ? widths : next
}

export function defaultTableColumnWidths(
  keys: string[],
  preferred: TableColumnWidths,
  mins: TableColumnWidths,
  containerWidth: number,
): TableColumnWidths {
  const available = Math.max(0, Math.round(containerWidth))
  const minSum = keys.reduce((sum, key) => sum + (mins[key] ?? 64), 0)
  const rest = Math.max(available, minSum)
  const preferredSum = keys.reduce((sum, key) => sum + (preferred[key] ?? 64), 0)
  const scale = preferredSum > 0 ? rest / preferredSum : 1
  const next: TableColumnWidths = {}
  let used = 0
  keys.forEach((key, index) => {
    const min = mins[key] ?? 64
    if (index === keys.length - 1) {
      next[key] = Math.max(min, rest - used)
      return
    }
    next[key] = Math.max(min, Math.min(COLUMN_MAX, Math.round((preferred[key] ?? 64) * scale)))
    used += next[key]
  })
  return next
}

function tableWrapWidth(root: HTMLElement | null) {
  return root?.clientWidth ?? 0
}

export function useResizableTableColumns({
  storageKey,
  keys,
  mins,
  preferred,
  enabled = true,
}: {
  storageKey: string
  keys: string[]
  mins: TableColumnWidths
  preferred: TableColumnWidths
  enabled?: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const resizeLock = useRef(false)
  const keysKey = keys.join("\0")
  const minsKey = keys.map((key) => `${key}:${mins[key] ?? 64}`).join("|")
  const preferredKey = keys.map((key) => `${key}:${preferred[key] ?? 64}`).join("|")
  const stableKeys = useMemo(() => keysKey.split("\0").filter(Boolean), [keysKey])
  const stableMins = useMemo(() => {
    const next: TableColumnWidths = {}
    for (const part of minsKey.split("|")) {
      const sep = part.lastIndexOf(":")
      if (sep < 0) continue
      next[part.slice(0, sep)] = Number(part.slice(sep + 1))
    }
    return next
  }, [minsKey])
  const stablePreferred = useMemo(() => {
    const next: TableColumnWidths = {}
    for (const part of preferredKey.split("|")) {
      const sep = part.lastIndexOf(":")
      if (sep < 0) continue
      next[part.slice(0, sep)] = Number(part.slice(sep + 1))
    }
    return next
  }, [preferredKey])
  const [custom, setCustom] = useState<TableColumnWidths | null>(() =>
    readTableColumnWidths(storageKey, stableKeys, stableMins),
  )
  const [defaults, setDefaults] = useState<TableColumnWidths | null>(null)
  const layoutMode = custom ? "custom" : "default"
  const activeWidths = custom ?? defaults

  useEffect(() => {
    setCustom(readTableColumnWidths(storageKey, stableKeys, stableMins))
    setDefaults(null)
  }, [storageKey, keysKey, minsKey])

  useEffect(() => {
    if (!enabled || !storageKey) return
    const root = wrapRef.current
    if (!root) return
    const fit = () => {
      if (resizeLock.current) return
      const width = tableWrapWidth(root)
      if (width < 1) return
      if (layoutMode === "custom") {
        setCustom((current) => {
          if (!current) return current
          return fitTableColumnWidths(stableKeys, current, width, stableMins)
        })
        return
      }
      const next = defaultTableColumnWidths(stableKeys, stablePreferred, stableMins, width)
      setDefaults((current) => (sameTableColumnWidths(stableKeys, current, next) ? current : next))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(root)
    return () => observer.disconnect()
  }, [enabled, layoutMode, storageKey, keysKey, minsKey, preferredKey, stableKeys, stableMins, stablePreferred])

  const startResize = useCallback(
    (column: string, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      const index = stableKeys.indexOf(column)
      const partner = stableKeys[index + 1]
      if (!partner) return
      event.preventDefault()
      event.stopPropagation()
      const row = event.currentTarget.closest("tr")
      const cells = row ? [...row.querySelectorAll("th")] : []
      if (cells.length !== stableKeys.length) return
      const measured: TableColumnWidths = {}
      stableKeys.forEach((key, cellIndex) => {
        measured[key] = Math.round(cells[cellIndex].getBoundingClientRect().width)
      })
      const container = tableWrapWidth(wrapRef.current)
      const baseline = container > 0 ? fitTableColumnWidths(stableKeys, measured, container, stableMins) : measured
      const origin = baseline[column]
      const startX = event.clientX
      const handle = event.currentTarget
      const rightKeys = stableKeys.slice(index + 1)
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        /* The pointer is only capturable during a real drag. */
      }
      resizeLock.current = true
      handle.classList.add("is-active")
      document.body.classList.add("admin-node-col-resizing")
      const widthsAt = (clientX: number) => {
        const limits = stableMins
        const desired = Math.max(limits[column] ?? 64, clampTableColumnWidth(origin + clientX - startX, limits[column] ?? 64))
        const delta = desired - origin
        const next = { ...baseline }
        if (delta > 0) {
          let remain = delta
          for (const key of rightKeys) {
            const spare = Math.max(0, baseline[key] - (limits[key] ?? 64))
            const take = Math.min(spare, remain)
            next[key] = baseline[key] - take
            remain -= take
          }
          next[column] = origin + (delta - remain)
        } else {
          const shrink = Math.min(-delta, Math.max(0, origin - (limits[column] ?? 64)))
          next[column] = origin - shrink
          next[partner] = baseline[partner] + shrink
        }
        return next
      }
      const move = (ev: PointerEvent) => setCustom(widthsAt(ev.clientX))
      const end = (ev: PointerEvent) => {
        resizeLock.current = false
        const root = wrapRef.current
        const fitted = root
          ? fitTableColumnWidths(stableKeys, widthsAt(ev.clientX), tableWrapWidth(root), stableMins)
          : widthsAt(ev.clientX)
        setCustom(fitted)
        writeTableColumnWidths(storageKey, fitted)
        handle.classList.remove("is-active")
        document.body.classList.remove("admin-node-col-resizing")
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", end)
        handle.removeEventListener("pointercancel", end)
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", end)
      handle.addEventListener("pointercancel", end)
    },
    [stableKeys, stableMins, storageKey],
  )

  const reset = useCallback(() => {
    clearTableColumnWidths(storageKey)
    setCustom(null)
  }, [storageKey])

  return { wrapRef, activeWidths, startResize, reset }
}
