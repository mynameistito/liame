export type ZohoRegion = 'com' | 'eu' | 'in' | 'com.au' | 'jp' | 'ca'

export interface AccountConfig {
  name: string
  email: string
  password: string
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; secure: boolean }
}

/** Account shape exposed to the renderer. The password never leaves the main process. */
export type PublicAccount = Omit<AccountConfig, 'password'>

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
  uid: number
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
}

export interface MessagePage {
  mailbox: string
  total: number
  messages: MessageSummary[]
  /** Highest sequence number not yet loaded, 0 when the list is complete. */
  nextBefore: number
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

export type MoveTarget = SpecialUse | { path: string }

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
  type: 'new-mail' | 'mailboxes-changed' | 'connection'
  mailbox?: string
  status?: 'online' | 'offline' | 'connecting'
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

export interface AiEvent {
  id: string
  delta?: string
  done?: boolean
  error?: string
}

export interface ClassifyItem {
  uid: number
  messageId?: string
  from: string
  subject: string
  preview: string
}

export interface LiameApi {
  getAccount(): Promise<PublicAccount | null>
  getStatus(): Promise<MailEvent['status']>
  saveAccount(account: AccountConfig): Promise<PublicAccount>
  testAccount(account: AccountConfig): Promise<{ ok: true } | { ok: false; error: string }>
  signOut(): Promise<void>
  listMailboxes(): Promise<Mailbox[]>
  listMessages(mailbox: string, before?: number): Promise<MessagePage>
  previews(mailbox: string, uids: number[]): Promise<Record<number, string>>
  search(mailbox: string, query: string): Promise<MessageSummary[]>
  getMessage(mailbox: string, uid: number): Promise<MessageDetail>
  setFlags(mailbox: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>
  move(mailbox: string, uids: number[], target: MoveTarget): Promise<MoveResult | null>
  markAllRead(mailbox: string): Promise<void>
  saveDraft(draft: Draft): Promise<number | null>
  contextMenu(items: MenuItemSpec[]): Promise<string | null>
  focusWindow(): void
  undoMove(move: MoveResult): Promise<void>
  setZoom(factor: number): void
  saveAttachment(mailbox: string, uid: number, partId: number): Promise<void>
  pickAttachments(): Promise<string[]>
  send(draft: Draft): Promise<void>
  openExternal(url: string): Promise<void>
  getSettings(): Promise<PublicSettings>
  saveSettings(patch: SettingsPatch): Promise<PublicSettings>
  aiModels(): Promise<{ models: string[]; defaultModel?: string }>
  aiStart(id: string, task: AiTask): Promise<void>
  aiCancel(id: string): Promise<void>
  onAi(listener: (event: AiEvent) => void): () => void
  classify(items: ClassifyItem[]): Promise<Record<number, string | null>>
  setLabel(item: ClassifyItem, label: string | null): Promise<void>
  onEvent(listener: (event: MailEvent) => void): () => void
}
