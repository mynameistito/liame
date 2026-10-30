import { useEffect, useMemo, useRef, useState } from 'react'
import { formatWhen, laterTimes } from '../lib'

interface Props {
  title: string
  onPick: (at: number) => void
  onClose: () => void
}

/** Picks a future time: presets on number keys, or any date and time. */
export function WhenPicker({ title, onPick, onClose }: Props) {
  const choices = useMemo(() => laterTimes(), [])
  const [active, setActive] = useState(0)
  const [custom, setCustom] = useState('')
  const customAt = custom ? new Date(custom).getTime() : NaN
  const customOk = Number.isFinite(customAt) && customAt > Date.now()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])

  function pick(at: number) {
    onClose()
    // Let the picker unmount first so focus and key handling return to the window.
    requestAnimationFrame(() => onPick(at))
  }

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="palette when"
        tabIndex={-1}
        ref={box}
        onKeyDown={(e) => {
          e.stopPropagation()
          if ((e.target as HTMLElement).tagName === 'INPUT') {
            if (e.key === 'Escape') onClose()
            return
          }
          const n = Number(e.key)
          if (n >= 1 && n <= choices.length) pick(choices[n - 1].at)
          else if (e.key === 'ArrowDown') setActive((i) => Math.min(choices.length - 1, i + 1))
          else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
          else if (e.key === 'Enter') pick(choices[active].at)
          else if (e.key === 'Escape') onClose()
          else return
          e.preventDefault()
        }}
      >
        <div className="palette-group">{title}</div>
        <div className="palette-list">
          {choices.map((c, i) => (
            <button key={c.label} className={`palette-item ${i === active ? 'active' : ''}`} onMouseMove={() => setActive(i)} onClick={() => pick(c.at)}>
              <span>{c.label}</span>
              <span className="when-time">
                {formatWhen(c.at)} <kbd>{i + 1}</kbd>
              </span>
            </button>
          ))}
        </div>
        <form
          className="when-custom"
          onSubmit={(e) => {
            e.preventDefault()
            if (customOk) pick(customAt)
          }}
        >
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Pick a date and time" />
          <button className="primary small" disabled={!customOk}>
            Set
          </button>
        </form>
      </div>
    </div>
  )
}
