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
  type: 'new-mail' | 'mailboxes-changed' | 'connection' | 'accounts-changed' | 'open-message'
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
  listAccounts(): Promise<AccountSummary[]>
  saveAccount(account: AccountInput): Promise<PublicAccount>
  testAccount(account: AccountInput): Promise<{ ok: true } | { ok: false; error: string }>
  /** Asks for confirmation natively; resolves false when the user keeps the account. */
  removeAccount(accountId: string): Promise<boolean>
  listMailboxes(accountId: string): Promise<Mailbox[]>
  listMessages(accountId: string, mailbox: string, before?: number): Promise<MessagePage>
  previews(accountId: string, mailbox: string, uids: number[]): Promise<Record<number, string>>
  search(accountId: string, mailbox: string, query: string): Promise<MessageSummary[]>
  getMessage(accountId: string, mailbox: string, uid: number): Promise<MessageDetail>
  setFlags(accountId: string, mailbox: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>
  move(accountId: string, mailbox: string, uids: number[], target: MoveTarget): Promise<MoveResult | null>
  markAllRead(accountId: string, mailbox: string): Promise<void>
  saveDraft(accountId: string, draft: Draft): Promise<number | null>
  undoMove(accountId: string, move: MoveResult): Promise<void>
  saveAttachment(accountId: string, mailbox: string, uid: number, partId: number): Promise<void>
  send(accountId: string, draft: Draft): Promise<void>
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
  classify(items: ClassifyItem[]): Promise<Record<number, string | null>>
  setLabel(item: ClassifyItem, label: string | null): Promise<void>
  onEvent(listener: (event: MailEvent) => void): () => void
}
