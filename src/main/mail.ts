import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type MailboxLockObject,
  type MessageAddressObject,
  type MessageStructureObject,
} from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import type {
  AccountConfig,
  Address,
  Attachment,
  Mailbox,
  MailEvent,
  MessageDetail,
  MessagePage,
  MessageSummary,
  SpecialUse,
} from '../shared/types'

const PAGE_SIZE = 50
const PREVIEW_BYTES = 12_000

const SPECIAL_USE: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
  '\\Flagged': 'flagged',
  '\\All': 'all',
}

const ORDER: SpecialUse[] = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'all', 'junk', 'trash']

type Listener = (event: MailEvent) => void

/**
 * One connection for commands and a second one parked in IDLE on INBOX, so new mail
 * shows up without polling and without the watcher losing its selected mailbox.
 */
export class MailService {
  private client: ImapFlow | null = null
  private connecting: Promise<ImapFlow> | null = null
  private watcher: ImapFlow | null = null
  private watcherRetry: NodeJS.Timeout | null = null
  private stopped = false
  private mailboxes: Mailbox[] = []
  private previewCache = new Map<string, string>()
  private parsedCache = new Map<string, ParsedMail>()

  constructor(
    private account: AccountConfig,
    private emit: Listener,
  ) {}

  static async test(account: AccountConfig): Promise<void> {
    const client = createClient(account)
    try {
      await client.connect()
    } finally {
      await client.logout().catch(() => client.close())
    }
  }

  start(): void {
    this.stopped = false
    void this.startWatcher()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.watcherRetry) clearTimeout(this.watcherRetry)
    const clients = [this.client, this.watcher].filter((c): c is ImapFlow => !!c)
    this.client = this.watcher = null
    await Promise.all(clients.map((c) => c.logout().catch(() => c.close())))
  }

  async listMailboxes(): Promise<Mailbox[]> {
    const client = await this.connection()
    const list = await client.list({ statusQuery: { messages: true, unseen: true } })
    this.mailboxes = list
      .filter((box) => !box.flags.has('\\Noselect') && !box.flags.has('\\NonExistent'))
      .map((box) => ({
        path: box.path,
        name: box.path.toUpperCase() === 'INBOX' ? 'Inbox' : box.name,
        specialUse: box.specialUse ? SPECIAL_USE[box.specialUse] : undefined,
        unread: box.status?.unseen ?? 0,
        total: box.status?.messages ?? 0,
        depth: box.parent.length,
      }))
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    return this.mailboxes
  }

  async listMessages(path: string, before?: number): Promise<MessagePage> {
    return this.withMailbox(path, async (client) => {
      // An already-selected mailbox keeps its old EXISTS count until the server speaks again; NOOP asks.
      await client.noop()
      const total = client.mailbox ? client.mailbox.exists : 0
      if (total === 0) return { mailbox: path, total, messages: [], nextBefore: 0 }
      const end = Math.min(before ?? total, total)
      const start = Math.max(1, end - PAGE_SIZE + 1)
      const messages: MessageSummary[] = []
      for await (const msg of client.fetch(`${start}:${end}`, SUMMARY_QUERY)) messages.push(this.toSummary(path, msg))
      messages.sort((a, b) => b.uid - a.uid)
      return { mailbox: path, total, messages, nextBefore: start - 1 }
    })
  }

  async previews(path: string, uids: number[]): Promise<Record<number, string>> {
    const out: Record<number, string> = {}
    const missing = uids.filter((uid) => {
      const cached = this.previewCache.get(this.key(path, uid))
      if (cached !== undefined) out[uid] = cached
      return cached === undefined
    })
    if (missing.length === 0) return out
    await this.withMailbox(path, async (client) => {
      const sources: Array<[number, Buffer]> = []
      for await (const msg of client.fetch(missing, { uid: true, source: { maxLength: PREVIEW_BYTES } }, { uid: true })) {
        if (msg.source) sources.push([msg.uid, msg.source])
      }
      for (const [uid, source] of sources) {
        const preview = await parsePreview(source)
        this.previewCache.set(this.key(path, uid), preview)
        out[uid] = preview
      }
    })
    return out
  }

  async search(path: string, query: string): Promise<MessageSummary[]> {
    return this.withMailbox(path, async (client) => {
      const found = await client.search(
        { or: [{ subject: query }, { from: query }, { to: query }, { body: query }] },
        { uid: true },
      )
      const uids = (found || []).sort((a, b) => b - a).slice(0, 100)
      if (uids.length === 0) return []
      const messages: MessageSummary[] = []
      for await (const msg of client.fetch(uids, SUMMARY_QUERY, { uid: true })) messages.push(this.toSummary(path, msg))
      return messages.sort((a, b) => b.uid - a.uid)
    })
  }

  async getMessage(path: string, uid: number): Promise<MessageDetail> {
    return this.withMailbox(path, async (client) => {
      const msg = await client.fetchOne(String(uid), { ...SUMMARY_QUERY, source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error('Message not found. It may have been moved or deleted.')
      const parsed = await simpleParser(msg.source)
      this.rememberParsed(path, uid, parsed)
      const summary = this.toSummary(path, msg)
      const { html, attachments } = inlineImages(parsed)
      return {
        ...summary,
        cc: addresses(parsed.cc),
        replyTo: addresses(parsed.replyTo),
        messageId: parsed.messageId,
        references: toArray(parsed.references),
        html,
        text: parsed.text,
        attachments,
      }
    })
  }

  async setFlags(path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    await this.withMailbox(path, async (client) => {
      for (const [flag, on] of [['\\Seen', flags.seen], ['\\Flagged', flags.flagged]] as const) {
        if (on === undefined) continue
        if (on) await client.messageFlagsAdd(uids, [flag], { uid: true })
        else await client.messageFlagsRemove(uids, [flag], { uid: true })
      }
    })
  }

  async move(path: string, uids: number[], target: SpecialUse): Promise<void> {
    const destination = await this.pathFor(target)
    await this.withMailbox(path, async (client) => {
      if (destination === path) {
        // Deleting from Trash removes the message for good.
        if (target === 'trash') await client.messageDelete(uids, { uid: true })
        return
      }
      await client.messageMove(uids, destination, { uid: true })
    })
    this.emit({ type: 'mailboxes-changed' })
  }

  async attachment(path: string, uid: number, partId: number): Promise<{ filename: string; content: Buffer }> {
    let parsed = this.parsedCache.get(this.key(path, uid))
    if (!parsed) {
      await this.getMessage(path, uid)
      parsed = this.parsedCache.get(this.key(path, uid))
    }
    const file = parsed?.attachments[partId]
    if (!file) throw new Error('Attachment not found.')
    return { filename: file.filename || 'attachment', content: file.content }
  }

  private async pathFor(target: SpecialUse): Promise<string> {
    if (this.mailboxes.length === 0) await this.listMailboxes()
    const found = this.mailboxes.find((box) => box.specialUse === target)
    if (found) return found.path
    if (target !== 'archive') throw new Error(`No ${target} folder on this account.`)
    const client = await this.connection()
    const created = await client.mailboxCreate('Archive')
    await this.listMailboxes()
    return created.path
  }

  private toSummary(path: string, msg: FetchMessageObject): MessageSummary {
    const env = msg.envelope
    const flags = msg.flags ?? new Set<string>()
    return {
      uid: msg.uid,
      messageId: env?.messageId,
      from: fromEnvelope(env?.from?.[0]) ?? fromEnvelope(env?.sender?.[0]) ?? { name: '', address: '' },
      to: (env?.to ?? []).map((a) => fromEnvelope(a)!).filter(Boolean),
      subject: env?.subject?.trim() || '(no subject)',
      date: new Date(env?.date ?? msg.internalDate ?? Date.now()).toISOString(),
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      hasAttachments: msg.bodyStructure ? hasAttachment(msg.bodyStructure) : false,
      preview: this.previewCache.get(this.key(path, msg.uid)),
    }
  }

  private key(path: string, uid: number): string {
    return `${path}\u0000${uid}`
  }

  private rememberParsed(path: string, uid: number, parsed: ParsedMail): void {
    this.parsedCache.set(this.key(path, uid), parsed)
    if (this.parsedCache.size > 20) this.parsedCache.delete(this.parsedCache.keys().next().value!)
  }

  private async withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.connection()
      let lock: MailboxLockObject | undefined
      try {
        lock = await client.getMailboxLock(path)
        return await fn(client)
      } catch (error) {
        // A dropped socket surfaces as an error on the next command; reconnect once.
        if (attempt === 0 && !client.usable) {
          this.client = null
          continue
        }
        throw error
      } finally {
        lock?.release()
      }
    }
  }

  private async connection(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const client = createClient(this.account)
      client.on('error', () => {})
      client.on('close', () => {
        if (this.client === client) this.client = null
      })
      await client.connect()
      this.client = client
      return client
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async startWatcher(): Promise<void> {
    if (this.stopped) return
    this.emit({ type: 'connection', status: 'connecting' })
    // The watcher never sends commands, so let it drop into IDLE right away instead of after imapflow's 15s default.
    const watcher = createClient(this.account, { autoIdleDelay: 1_000 })
    watcher.on('error', () => {})
    watcher.on('exists', (data) => {
      if (data.count > data.prevCount) this.emit({ type: 'new-mail', mailbox: data.path })
    })
    watcher.on('close', () => {
      if (this.watcher !== watcher || this.stopped) return
      this.watcher = null
      this.emit({ type: 'connection', status: 'offline' })
      this.watcherRetry = setTimeout(() => void this.startWatcher(), 5_000)
    })
    try {
      await watcher.connect()
      await watcher.mailboxOpen('INBOX')
      this.watcher = watcher
      this.emit({ type: 'connection', status: 'online' })
    } catch {
      watcher.close()
      this.emit({ type: 'connection', status: 'offline' })
      this.watcherRetry = setTimeout(() => void this.startWatcher(), 15_000)
    }
  }
}

const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true }

function createClient(account: AccountConfig, extra: Partial<ImapFlowOptions> = {}): ImapFlow {
  return new ImapFlow({
    ...extra,
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.email, pass: account.password },
    logger: false,
  })
}

function rank(box: Mailbox): number {
  const index = box.specialUse ? ORDER.indexOf(box.specialUse) : -1
  return index === -1 ? ORDER.length : index
}

function fromEnvelope(a?: MessageAddressObject): Address | undefined {
  if (!a?.address) return undefined
  return { name: a.name ?? '', address: a.address }
}

function addresses(value?: AddressObject | AddressObject[]): Address[] {
  return toArray(value)
    .flatMap((group) => group.value)
    .filter((a) => a.address)
    .map((a) => ({ name: a.name, address: a.address! }))
}

function toArray<T>(value?: T | T[]): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function hasAttachment(node: MessageStructureObject): boolean {
  if (node.disposition === 'attachment') return true
  return (node.childNodes ?? []).some(hasAttachment)
}

async function parsePreview(source: Buffer): Promise<string> {
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextLinks: true })
    // mailparser's own HTML-to-text uppercases headings and draws rules, which reads loud in a list.
    const text = parsed.html ? htmlToText(parsed.html) : (parsed.text ?? '')
    return text
      .split('\n')
      .filter((line) => !/^\s*>/.test(line) && !/^On .+ wrote:\s*$/.test(line.trim()))
      .join(' ')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[-=_*~]{3,}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220)
  } catch {
    return ''
  }
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", zwnj: '', shy: '' }

function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, name: string) => {
      if (name[0] === '#') {
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : match
      }
      return ENTITIES[name.toLowerCase()] ?? match
    })
    .replace(/[\u200b-\u200d\u034f\u00ad]/g, '')
}

/** Swap cid: references for data URIs so inline images render, and keep them out of the attachment list. */
function inlineImages(parsed: ParsedMail): { html?: string; attachments: Attachment[] } {
  let html = parsed.html || undefined
  const attachments: Attachment[] = []
  parsed.attachments.forEach((file, partId) => {
    const cid = file.contentId?.replace(/^<|>$/g, '')
    if (html && cid && html.includes(`cid:${cid}`)) {
      const uri = `data:${file.contentType};base64,${file.content.toString('base64')}`
      html = html.split(`cid:${cid}`).join(uri)
      return
    }
    attachments.push({ filename: file.filename || 'attachment', contentType: file.contentType, size: file.size, partId })
  })
  return { html, attachments }
}
