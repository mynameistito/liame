export type ZohoRegion = 'com' | 'eu' | 'in' | 'com.au' | 'jp' | 'ca'

export type MailProvider = 'zoho' | 'gmail' | 'imap'

export interface AccountConfig {
  id: string
  provider: MailProvider
  name: string
  email: string
  password: string
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
}

/** What the setup screen submits; a new account gets its id in the main process. */
export type AccountInput = Omit<AccountConfig, 'id'> & { id?: string }

/** Account shape exposed to the renderer. The password never leaves the main process. */
export type PublicAccount = Omit<AccountConfig, 'password'>

export interface AccountSummary extends PublicAccount {
  unread: number
  status: ConnectionStatus
}

export type ConnectionStatus = 'online' | 'offline' | 'connecting'

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash' | 'flagged' | 'all'

export interface Mailbox {
  path: string
  name: string
  specialUse?: SpecialUse
  unread: number
  total: number
  depth: number
}

export interface Address {
  name: string
  address: string
}

export interface MessageSummary {
  /** Unique across accounts and folders: account, mailbox, and UID. Use it for identity; uid alone repeats across folders. */
  key: string
  account: string
  mailbox: string
  uid: number
  /** Conversation key: Gmail's thread id, else the first Message-ID of the reply chain. */
  thread?: string
  messageId?: string
  from: Address
  to: Address[]
  subject: string
  date: string
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  preview?: string
  label?: string | null
  /** Set on conversation rows: every message of the conversation in this mailbox, newest first. */
  threadUids?: number[]
  /** Messages in the whole conversation across Inbox, Sent, Archive and other folders (not Trash or Spam). */
  threadCount?: number
  /** Distinct sender names in the conversation, oldest first. */
  participants?: string[]
}

export interface MessagePage {
  mailbox: string
  messages: MessageSummary[]
  /** More messages exist past this page, locally or on the server. */
  hasMore: boolean
}

export interface Attachment {
  filename: string
  contentType: string
  size: number
  partId: number
}

export interface MessageDetail extends MessageSummary {
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  inReplyTo?: string
  references: string[]
  html?: string
  text?: string
  attachments: Attachment[]
}

export interface Draft {
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  /** Absolute file paths picked in the composer. */
  attachments: string[]
  inReplyTo?: string
  references?: string[]
  /** UID of the saved copy in Drafts this draft replaces when saved again or sent. */
  draftUid?: number
  /** Attachments already stored in that saved copy (by mailparser index), carried into the next save or send. */
  kept?: Array<{ partId: number; filename: string }>
}

/** A snooze moves messages to the Snoozed folder until `snooze` (ms since epoch), then back to where they were. */
export type MoveTarget = SpecialUse | { path: string } | { snooze: number }

export type ScheduleKind = 'snooze' | 'send' | 'followup'

/** Something Liame does later: return a snoozed message, send a message, or remind about one without a reply. */
export interface ScheduledItem {
  id: string
  account: string
  kind: ScheduleKind
  /** When it runs, in ms since epoch. */
  due: number
  subject: string
  /** The sender of a snoozed or reminded message, or the recipients of a send. */
  who: string
  /** Where the message is now, for opening it; absent for sends and messages not found locally. */
  mailbox?: string
  uid?: number
  /** A reminder that came due with no reply. It stays listed until dismissed or answered. */
  fired?: boolean
  /** Why the last send attempt failed; it is retried. */
  error?: string
}

/** Options for sending: later instead of now, and a reminder when nobody replies within `followUp` ms. */
export interface SendOptions {
  at?: number
  followUp?: number
}

/** A native context-menu entry. `id` comes back when the item is chosen. */
export interface MenuItemSpec {
  id?: string
  label?: string
  separator?: boolean
  enabled?: boolean
  checked?: boolean
  accelerator?: string
  submenu?: MenuItemSpec[]
}

export interface MailEvent {
  type: 'new-mail' | 'mailboxes-changed' | 'mailbox-synced' | 'connection' | 'accounts-changed' | 'open-message' | 'scheduled-changed'
  accountId?: string
  mailbox?: string
  status?: ConnectionStatus
  /** For 'open-message': the message a clicked notification points at. */
  uid?: number
}

export type AiProvider = 'chatgpt' | 'openai'
export type LabelEngine = 'typesafe' | 'openai' | 'off'

export interface LabelDef {
  id: string
  name: string
  /** What belongs under this label, in plain words. The decision model reads it. */
  description: string
  color: string
}

export interface Snippet {
  id: string
  name: string
  body: string
}

export interface Prefs {
  /** When opening a message marks it read. */
  markRead: 'immediately' | 'delay' | 'never'
  /** What gets selected after archiving or deleting. */
  afterMove: 'next' | 'previous' | 'none'
  remoteImages: boolean
  notifications: boolean
  signature: string
  accent: string
  density: 'comfortable' | 'compact' | 'minimal'
  zoom: number
  darkenEmails: boolean
  /** Group messages that belong to one conversation into a single row. */
  conversations: boolean
}

/** Command id to key combos, only for commands the user rebound. */
export type ShortcutOverrides = Record<string, string[]>

export interface Settings {
  ai: { provider: AiProvider; model: string; codexPath: string; openaiKey: string }
  labels: { engine: LabelEngine; typesafeKey: string; list: LabelDef[] }
  snippets: Snippet[]
  prefs: Prefs
  shortcuts: ShortcutOverrides
}

/** Settings as the renderer sees them: secrets replaced by whether they are set. */
export interface PublicSettings {
  ai: { provider: AiProvider; model: string; codexPath: string; hasOpenaiKey: boolean }
  labels: { engine: LabelEngine; hasTypesafeKey: boolean; list: LabelDef[] }
  snippets: Snippet[]
  prefs: Prefs
  shortcuts: ShortcutOverrides
}

/** Partial update; a secret is only changed when a non-empty value is sent, and cleared with null. */
export interface SettingsPatch {
  ai?: Partial<{ provider: AiProvider; model: string; codexPath: string; openaiKey: string | null }>
  labels?: Partial<{ engine: LabelEngine; typesafeKey: string | null; list: LabelDef[] }>
  snippets?: Snippet[]
  prefs?: Partial<Prefs>
  shortcuts?: ShortcutOverrides
}

/** Where a move put the messages, so it can be undone. Null when the server cannot report new UIDs. */
export interface MoveResult {
  account: string
  from: string
  to: string
  uids: number[]
}

export interface MessageContext {
  from: string
  to: string
  date: string
  subject: string
  text: string
  /** Its conversation, for the main process to read the other messages from. */
  thread?: string
  messageId?: string
  /** The conversation's other messages, oldest first; filled in by the main process. */
  conversation?: MessageContext[]
}

export type RewriteMode = 'improve' | 'shorten' | 'friendlier' | 'formal' | 'fix'

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
}

export type AiTask =
  | { kind: 'reply'; message: MessageContext; instruction?: string; draft?: string }
  | { kind: 'compose'; instruction: string; subject?: string }
  | { kind: 'rewrite'; text: string; mode: RewriteMode }
  | { kind: 'ask'; message?: MessageContext; history: ChatTurn[] }
  /** A short rundown of unread mail and what is scheduled, across accounts. The main process fills in `digest`. */
  | { kind: 'brief'; digest?: string }

export interface AiEvent {
  id: string
  delta?: string
  done?: boolean
  error?: string
}

export interface ClassifyItem {
  /** MessageSummary.key; results come back under it. */
  key: string
  messageId?: string
  from: string
  subject: string
  preview: string
}

export interface LiameApi {
  listAccounts(): Promise<AccountSummary[]>
  saveAccount(account: AccountInput): Promise<PublicAccount>
  testAccount(account: AccountInput): Promise<{ ok: true } | { ok: false; error: string }>
  /** Asks for confirmation natively; resolves false when the user keeps the account. */
  removeAccount(accountId: string): Promise<boolean>
  /** A notification click that arrived while no window was open. */
  takePendingOpen(): Promise<MailEvent | null>
  listMailboxes(accountId: string): Promise<Mailbox[]>
  /** Reads the local store; the first call for a mailbox waits for its initial sync. With threads, one row per conversation. */
  listMessages(accountId: string, mailbox: string, offset?: number, limit?: number, threads?: boolean): Promise<MessagePage>
  /** Every account's inbox merged by date (conversation rows when threads is set). */
  listUnified(offset?: number, limit?: number, threads?: boolean): Promise<MessagePage>
  syncInboxes(): Promise<void>
  markAllInboxesRead(): Promise<void>
  /** Every message of a conversation across the account's folders (not Trash or Spam), oldest first. */
  getThread(accountId: string, thread: string): Promise<MessageSummary[]>
  /** Brings the local copy of a mailbox up to date; a 'mailbox-synced' event follows. */
  sync(accountId: string, mailbox: string): Promise<void>
  /** Server-side search in one mailbox (finds body text the local index does not have). */
  search(accountId: string, mailbox: string, query: string): Promise<MessageSummary[]>
  /** Instant search over every synced folder of the given accounts. */
  searchLocal(accountIds: string[], query: string): Promise<MessageSummary[]>
  getMessage(accountId: string, mailbox: string, uid: number): Promise<MessageDetail>
  setFlags(accountId: string, mailbox: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>
  move(accountId: string, mailbox: string, uids: number[], target: MoveTarget): Promise<MoveResult | null>
  markAllRead(accountId: string, mailbox: string): Promise<void>
  saveDraft(accountId: string, draft: Draft): Promise<number | null>
  undoMove(accountId: string, move: MoveResult): Promise<void>
  saveAttachment(accountId: string, mailbox: string, uid: number, partId: number): Promise<void>
  /** Sends now, or queues the message when `options.at` is set. */
  send(accountId: string, draft: Draft, options?: SendOptions): Promise<void>
  /** Reminds about a message at `due` unless someone replies first. */
  remind(accountId: string, mailbox: string, uid: number, due: number): Promise<void>
  listScheduled(): Promise<ScheduledItem[]>
  /** Snoozes return now, reminders are dismissed, and a queued send comes back as a draft for the composer. */
  cancelScheduled(id: string): Promise<{ account: string; draft: Draft } | null>
  contextMenu(items: MenuItemSpec[]): Promise<string | null>
  focusWindow(): void
  setZoom(factor: number): void
  pickAttachments(): Promise<string[]>
  openExternal(url: string): Promise<void>
  getSettings(): Promise<PublicSettings>
  saveSettings(patch: SettingsPatch): Promise<PublicSettings>
  aiModels(): Promise<{ models: string[]; defaultModel?: string }>
  aiStart(id: string, task: AiTask, accountId: string): Promise<void>
  aiCancel(id: string): Promise<void>
  onAi(listener: (event: AiEvent) => void): () => void
  classify(items: ClassifyItem[]): Promise<Record<string, string | null>>
  setLabel(item: ClassifyItem, label: string | null): Promise<void>
  onEvent(listener: (event: MailEvent) => void): () => void
}
