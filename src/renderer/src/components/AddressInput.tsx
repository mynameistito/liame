import { useState, type Ref } from 'react'
import type { Contact } from '../lib'

interface Props {
  value: string
  onChange: (value: string) => void
  contacts: Contact[]
  ref?: Ref<HTMLInputElement>
}

/** A comma-separated address field that completes the last entry from known contacts. */
export function AddressInput({ value, onChange, contacts, ref }: Props) {
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)

  const lastComma = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'))
  const head = value.slice(0, lastComma + 1)
  const term = value.slice(lastComma + 1).trim().toLowerCase()
  const already = new Set(
    head
      .split(/[,;]/)
      .map((part) => (part.match(/<([^>]+)>/)?.[1] ?? part).trim().toLowerCase())
      .filter(Boolean),
  )
  const matches =
    term.length < 1
      ? []
      : contacts
          .filter((c) => !already.has(c.address.toLowerCase()) && (c.address.toLowerCase().includes(term) || c.name.toLowerCase().includes(term)))
          .slice(0, 6)
  const showing = open && matches.length > 0

  function complete(contact: Contact) {
    const entry = contact.name ? `${contact.name} <${contact.address}>` : contact.address
    onChange(`${head ? `${head.trimEnd()} ` : ''}${entry}, `)
    setActive(0)
  }

  return (
    <div className="address-input">
      <input
        ref={ref}
        value={value}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!showing) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(matches.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            complete(matches[active])
          } else if (e.key === 'Escape') {
            // The composer leaves Escape alone while this list is open (see Composer's key handler).
            e.preventDefault()
            setOpen(false)
          }
        }}
      />
      {showing && (
        <div className="suggest">
          {matches.map((c, i) => (
            <button
              key={c.address}
              className={i === active ? 'active' : ''}
              // mousedown, not click, so the input does not blur first.
              onMouseDown={(e) => {
                e.preventDefault()
                complete(c)
              }}
              onMouseMove={() => setActive(i)}
            >
              <span>{c.name || c.address}</span>
              {c.name && <small>{c.address}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
