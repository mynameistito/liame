import { Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

export interface PaletteItem {
  id: string
  title: string
  group: string
  /** Formatted shortcut, if the item has one. */
  hint?: string
  disabled?: boolean
  run: () => void
}

interface Props {
  items: PaletteItem[]
  /** Prefilled text, e.g. "Move to " when opened from the move shortcut. */
  initialQuery?: string
  onClose: () => void
}

/** Subsequence match; earlier and word-start matches score higher. -1 when the query does not match. */
function score(text: string, query: string): number {
  const t = text.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  if (t.startsWith(q)) return 1000 - t.length
  const word = t.indexOf(` ${q}`)
  if (word !== -1) return 800 - word
  let at = -1
  let total = 0
  for (const ch of q) {
    const next = t.indexOf(ch, at + 1)
    if (next === -1) return -1
    total += next - at
    at = next
  }
  return 500 - total
}

export function Palette({ items, initialQuery = '', onClose }: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const results = useMemo(() => {
    const enabled = items.filter((i) => !i.disabled)
    if (!query.trim()) return enabled
    return enabled
      .map((item) => ({ item, s: Math.max(score(item.title, query), score(`${item.group} ${item.title}`, query) - 100) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.item)
  }, [items, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    list.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function run(item: PaletteItem | undefined) {
    if (!item) return
    onClose()
    // Let the palette unmount first so focus and key handling return to the window.
    requestAnimationFrame(item.run)
  }

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" onKeyDown={(e) => e.stopPropagation()}>
        <label className="palette-input">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            placeholder="Type a command or mailbox"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
                e.preventDefault()
                setActive((i) => Math.min(results.length - 1, i + 1))
              } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
                e.preventDefault()
                setActive((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(results[active])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
        </label>
        <div className="palette-list fade-end" ref={list}>
          {results.length === 0 && <div className="palette-empty">No matching commands</div>}
          {results.map((item, i) => (
            <div key={item.id}>
              {!query.trim() && item.group !== results[i - 1]?.group && <div className="palette-group">{item.group}</div>}
              <button className={`palette-item ${i === active ? 'active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => run(item)}>
                <span>{item.title}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
