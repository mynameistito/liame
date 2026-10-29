import type { ShortcutOverrides } from '../../shared/types'

export type CommandId =
  | 'palette'
  | 'compose'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'draftReply'
  | 'archive'
  | 'trash'
  | 'undo'
  | 'toggleRead'
  | 'toggleFlag'
  | 'next'
  | 'previous'
  | 'search'
  | 'assistant'
  | 'refresh'
  | 'goInbox'
  | 'filterAll'
  | 'filterUnread'
  | 'filterFlagged'
  | 'toggleDarken'
  | 'loadImages'
  | 'settings'
  | 'shortcuts'
  | 'send'
  | 'snippets'

export interface CommandDef {
  id: CommandId
  title: string
  group: 'Message' | 'Compose' | 'Navigate' | 'View' | 'App'
  keys: string[]
  /** Composer-only commands are handled inside the composer and hidden from the palette. */
  composer?: boolean
  /** May run while a text field has focus. Everything else leaves text-editing keys (⌘⌫, ⌘Z) alone. */
  global?: boolean
}

export const COMMANDS: CommandDef[] = [
  { id: 'palette', title: 'Command palette', group: 'App', keys: ['Meta+k'], global: true },
  { id: 'compose', title: 'New message', group: 'Compose', keys: ['c', 'Meta+n'], global: true },
  { id: 'reply', title: 'Reply', group: 'Message', keys: ['r', 'Meta+r'] },
  { id: 'replyAll', title: 'Reply all', group: 'Message', keys: ['a', 'Shift+Meta+r'] },
  { id: 'forward', title: 'Forward', group: 'Message', keys: ['f'] },
  { id: 'draftReply', title: 'Draft reply with AI', group: 'Message', keys: ['d'] },
  { id: 'archive', title: 'Archive', group: 'Message', keys: ['e'] },
  { id: 'trash', title: 'Move to Trash', group: 'Message', keys: ['#', 'Backspace', 'Delete', 'Meta+Backspace'] },
  { id: 'undo', title: 'Undo archive or delete', group: 'Message', keys: ['Meta+z'] },
  { id: 'toggleRead', title: 'Mark read / unread', group: 'Message', keys: ['u'] },
  { id: 'toggleFlag', title: 'Flag / unflag', group: 'Message', keys: ['s'] },
  { id: 'next', title: 'Next message', group: 'Navigate', keys: ['j', 'ArrowDown'] },
  { id: 'previous', title: 'Previous message', group: 'Navigate', keys: ['k', 'ArrowUp'] },
  { id: 'goInbox', title: 'Go to Inbox', group: 'Navigate', keys: ['Meta+1'], global: true },
  { id: 'search', title: 'Search', group: 'Navigate', keys: ['/', 'Meta+f'], global: true },
  { id: 'filterAll', title: 'Show all messages', group: 'View', keys: [] },
  { id: 'filterUnread', title: 'Show unread only', group: 'View', keys: [] },
  { id: 'filterFlagged', title: 'Show flagged only', group: 'View', keys: [] },
  { id: 'toggleDarken', title: 'Toggle original email colors', group: 'View', keys: [] },
  { id: 'loadImages', title: 'Load remote images', group: 'View', keys: [] },
  { id: 'assistant', title: 'Toggle assistant', group: 'App', keys: ['Meta+i'], global: true },
  { id: 'refresh', title: 'Check for new mail', group: 'App', keys: ['Shift+Meta+n'], global: true },
  { id: 'settings', title: 'Settings', group: 'App', keys: ['Meta+,'], global: true },
  { id: 'shortcuts', title: 'Keyboard shortcuts', group: 'App', keys: ['?'] },
  { id: 'send', title: 'Send message', group: 'Compose', keys: ['Meta+Enter'], composer: true },
  { id: 'snippets', title: 'Insert snippet', group: 'Compose', keys: ['Meta+j'], composer: true },
]

export function keysFor(id: CommandId, overrides: ShortcutOverrides): string[] {
  return overrides[id] ?? COMMANDS.find((c) => c.id === id)?.keys ?? []
}

/** Combo to command, for the commands in one scope (main window or composer). */
export function keymap(overrides: ShortcutOverrides, composer: boolean): Map<string, CommandId> {
  const map = new Map<string, CommandId>()
  for (const c of COMMANDS) if (Boolean(c.composer) === composer) for (const k of keysFor(c.id, overrides)) map.set(k, c.id)
  return map
}

const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta']

/**
 * Canonical combo for a key event, e.g. "Shift+Meta+r", "#", "ArrowDown".
 * Shift is folded into printable symbols ("#" not "Shift+3") but kept for letters and named keys.
 */
export function comboOf(e: KeyboardEvent): string | null {
  if (MODIFIERS.includes(e.key)) return null
  let key = e.key
  // Option changes the produced character on macOS (⌥E is ´), so read the physical key instead.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase()
  else if (e.altKey && /^Digit\d$/.test(e.code)) key = e.code.slice(5)
  const letter = /^[a-z]$/i.test(key)
  const named = key.length > 1
  if (letter) key = key.toLowerCase()
  const mods = [
    e.ctrlKey && 'Control',
    e.altKey && 'Alt',
    e.shiftKey && (letter || named || e.metaKey || e.ctrlKey) && 'Shift',
    e.metaKey && 'Meta',
  ].filter(Boolean)
  return [...mods, key].join('+')
}

const SYMBOLS: Record<string, string> = {
  Meta: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↵',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ' ': 'Space',
}

export function formatCombo(combo: string): string {
  const parts = combo.split('+')
  // A trailing "+" key splits into an empty last part.
  if (combo.endsWith('++')) parts.splice(-2, 2, '+')
  return parts.map((p) => SYMBOLS[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join('')
}

/** True when the key should not fire while typing in a field (no modifier, so it would type text). */
export function isPlainKey(combo: string): boolean {
  return !/(Meta|Control|Alt)\+/.test(combo)
}
