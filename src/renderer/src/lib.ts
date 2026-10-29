import type { Address, AiTask, ClassifyItem, LiameApi, MessageContext, MessageDetail, MessageSummary } from '../../shared/types'

declare global {
  interface Window {
    liame: LiameApi
  }
}

export const api = window.liame

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
export function aiStream(task: AiTask, onText: (text: string) => void): { done: Promise<string>; cancel: () => void } {
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
    api.aiStart(id, task).catch((err) => {
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
