import { createContext, useContext, useEffect, useState } from 'react'
import type { Address, AiTask, ClassifyItem, Draft, LiameApi, MessageContext, MessageDetail, MessageSummary, MoveResult, MoveTarget, PublicAccount } from '../../shared/types'

declare global {
  interface Window {
    liame: LiameApi
  }
}

export const api = window.liame

/** The mail calls of the API with the account filled in. */
export function mailApi(accountId: string) {
  return {
    listMailboxes: () => api.listMailboxes(accountId),
    listMessages: (mailbox: string, offset?: number, limit?: number) => api.listMessages(accountId, mailbox, offset, limit),
    sync: (mailbox: string) => api.sync(accountId, mailbox),
    search: (mailbox: string, query: string) => api.search(accountId, mailbox, query),
    searchLocal: (query: string) => api.searchLocal([accountId], query),
    getMessage: (mailbox: string, uid: number) => api.getMessage(accountId, mailbox, uid),
    setFlags: (mailbox: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) => api.setFlags(accountId, mailbox, uids, flags),
    move: (mailbox: string, uids: number[], target: MoveTarget) => api.move(accountId, mailbox, uids, target),
    undoMove: (move: MoveResult) => api.undoMove(accountId, move),
    markAllRead: (mailbox: string) => api.markAllRead(accountId, mailbox),
    saveDraft: (draft: Draft) => api.saveDraft(accountId, draft),
    send: (draft: Draft) => api.send(accountId, draft),
    saveAttachment: (mailbox: string, uid: number, partId: number) => api.saveAttachment(accountId, mailbox, uid, partId),
  }
}

export type MailApi = ReturnType<typeof mailApi>

/** The account the window is showing, for components deep in the tree (composer, reader, assistant). */
export const AccountContext = createContext<{ account: PublicAccount; mail: MailApi } | null>(null)

export function useAccount() {
  const value = useContext(AccountContext)
  if (!value) throw new Error('useAccount needs an AccountContext provider.')
  return value
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const fullDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const long = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function shortDate(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  if (date.getTime() >= startOfToday) return time.format(date)
  if (date.getTime() >= startOfToday - day) return 'Yesterday'
  if (date.getTime() >= startOfToday - 6 * day) return weekday.format(date)
  if (date.getFullYear() === now.getFullYear()) return dayMonth.format(date)
  return fullDate.format(date)
}

export function longDate(iso: string): string {
  return long.format(new Date(iso))
}

export function displayName(a: Address): string {
  return a.name || a.address.split('@')[0] || 'Unknown'
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

export function initials(a: Address): string {
  const parts = displayName(a)
    .replace(/["'()]/g, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

/** A muted, stable color per sender so avatars are distinguishable without being loud. */
export function avatarColor(a: Address): { background: string; color: string } {
  let hash = 0
  for (const ch of a.address.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  const hue = Math.abs(hash) % 360
  return { background: `hsl(${hue} 28% 14%)`, color: `hsl(${hue} 45% 72%)` }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // IPC wraps main-process errors as "Error invoking remote method 'x': Error: ...".
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}

/** Run an AI task in the main process and receive the growing text as it streams. */
export function aiStream(accountId: string, task: AiTask, onText: (text: string) => void): { done: Promise<string>; cancel: () => void } {
  const id = crypto.randomUUID()
  let text = ''
  const done = new Promise<string>((resolve, reject) => {
    const off = api.onAi((event) => {
      if (event.id !== id) return
      if (event.delta) {
        text += event.delta
        onText(text)
      }
      if (event.error) {
        off()
        reject(new Error(event.error))
      } else if (event.done) {
        off()
        resolve(text)
      }
    })
    api.aiStart(id, task, accountId).catch((err) => {
      off()
      reject(err)
    })
  })
  return { done, cancel: () => void api.aiCancel(id) }
}

export function toContext(m: MessageDetail): MessageContext {
  return {
    from: formatAddress(m.from),
    to: [...m.to, ...m.cc].map(formatAddress).join(', '),
    date: longDate(m.date),
    subject: m.subject,
    text: m.text ?? '',
  }
}

export function classifyItem(m: MessageSummary): ClassifyItem {
  return { uid: m.uid, messageId: m.messageId, from: formatAddress(m.from), subject: m.subject, preview: m.preview ?? '' }
}

/** UI state that should survive restarts (pane widths, collapsed sections). Local to this Mac, so localStorage is enough. */
export function usePersistent<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`liame.${key}`)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(`liame.${key}`, JSON.stringify(value))
    } catch {
      // Losing a pane width is harmless.
    }
  }, [key, value])
  return [value, setValue]
}

export interface Contact {
  name: string
  address: string
  count: number
}

const CONTACTS_KEY = 'liame.contacts'

export function loadContacts(): Record<string, Contact> {
  try {
    return JSON.parse(localStorage.getItem(CONTACTS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** Remember everyone seen in loaded mail, most frequent first, for To/Cc autocomplete. */
export function rememberContacts(addresses: Address[], self: string): Record<string, Contact> {
  const contacts = loadContacts()
  for (const a of addresses) {
    const key = a.address.toLowerCase()
    if (!key || key === self.toLowerCase() || /no-?reply|notifications?@|mailer-daemon/i.test(key)) continue
    const known = contacts[key]
    contacts[key] = { address: a.address, name: a.name || known?.name || '', count: (known?.count ?? 0) + 1 }
  }
  const trimmed = Object.fromEntries(
    Object.entries(contacts)
      .sort((x, y) => y[1].count - x[1].count)
      .slice(0, 2000),
  )
  try {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(trimmed))
  } catch {
    // Autocomplete is a convenience.
  }
  return trimmed
}
