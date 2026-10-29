import { app, safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LabelDef, PublicSettings, Settings, SettingsPatch } from '../shared/types'

const DEFAULT_LABELS: LabelDef[] = [
  { id: 'reply', name: 'To reply', color: '#3b8cff', description: 'A real person wrote to me directly and expects an answer, a decision, or an action from me.' },
  { id: 'fyi', name: 'FYI', color: '#94a3b8', description: 'A person sent this to keep me informed; no reply is needed.' },
  { id: 'meetings', name: 'Meetings', color: '#f472b6', description: 'Meeting invites, scheduling, rescheduling, and calendar updates.' },
  { id: 'receipts', name: 'Receipts', color: '#34d399', description: 'Receipts, invoices, payment confirmations, orders, bookings, and shipping updates.' },
  { id: 'notifications', name: 'Notifications', color: '#fbbf24', description: 'Automated messages from apps and services: alerts, CI results, sign-in notices, mentions, status changes.' },
  { id: 'newsletters', name: 'Newsletters', color: '#a78bfa', description: 'Newsletters, digests, product announcements, marketing, and promotions.' },
]

const DEFAULTS: Settings = {
  ai: { provider: 'chatgpt', model: '', codexPath: '', openaiKey: '' },
  labels: { engine: 'typesafe', typesafeKey: '', list: DEFAULT_LABELS },
  snippets: [
    { id: 'thanks', name: 'Thanks, will review', body: 'Thanks! I will take a look and get back to you by the end of the week.' },
    { id: 'call', name: 'Suggest a call', body: 'Would a quick call be easier? I am free most afternoons this week, just pick a time that works for you.' },
  ],
}

// Settings hold API keys, so they are encrypted with the Keychain-backed key like the account.
const file = () => join(app.getPath('userData'), 'settings.bin')
let cached: Settings | null = null

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached
  let stored: Partial<Settings> = {}
  if (existsSync(file())) {
    try {
      stored = JSON.parse((await safeStorage.decryptStringAsync(await readFile(file()))).result)
    } catch {
      stored = {}
    }
  }
  cached = {
    ai: { ...DEFAULTS.ai, ...stored.ai },
    labels: { ...DEFAULTS.labels, ...stored.labels },
    snippets: stored.snippets ?? DEFAULTS.snippets,
  }
  return cached
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await loadSettings()
  const next: Settings = {
    ai: { ...current.ai, ...withSecret(patch.ai, 'openaiKey', current.ai.openaiKey) },
    labels: { ...current.labels, ...withSecret(patch.labels, 'typesafeKey', current.labels.typesafeKey) },
    snippets: patch.snippets ?? current.snippets,
  }
  await writeFile(file(), await safeStorage.encryptStringAsync(JSON.stringify(next)), { mode: 0o600 })
  cached = next
  return next
}

/** Keys saved in Settings win; otherwise fall back to the environment the app was started from. */
export function openaiKey(s: Settings): string {
  return s.ai.openaiKey || process.env.OPENAI_API_KEY || ''
}

export function typesafeKey(s: Settings): string {
  return s.labels.typesafeKey || process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY || ''
}

export function toPublicSettings(s: Settings): PublicSettings {
  const { openaiKey: _openai, ...ai } = s.ai
  const { typesafeKey: _typesafe, ...labels } = s.labels
  return {
    ai: { ...ai, hasOpenaiKey: Boolean(openaiKey(s)) },
    labels: { ...labels, hasTypesafeKey: Boolean(typesafeKey(s)) },
    snippets: s.snippets,
  }
}

/** Empty strings leave a stored secret alone; null clears it. */
function withSecret<T extends object, K extends string>(patch: T | undefined, key: K, current: string) {
  if (!patch) return {}
  const value = (patch as Record<string, unknown>)[key]
  const rest = { ...patch } as Record<string, unknown>
  delete rest[key]
  if (value === null) return { ...rest, [key]: '' }
  if (typeof value === 'string' && value.trim()) return { ...rest, [key]: value.trim() }
  return { ...rest, [key]: current }
}
