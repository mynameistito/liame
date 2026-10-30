import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type MailboxLockObject,
  type MessageAddressObject,
  type MessageStructureObject,
  type SearchObject,
} from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import * as store from './store'
import type {
  AccountConfig,
  Address,
  Attachment,
  Mailbox,
  MailEvent,
  MessageDetail,
  MessagePage,
  MessageSummary,
  MoveResult,
  MoveTarget,
  SpecialUse,
} from '../shared/types'

const PAGE_SIZE = 50
/** Messages fetched the first time a mailbox syncs; older ones arrive as the list scrolls. */
const INITIAL_WINDOW = 300
const OLDER_BATCH = 100
const PREVIEW_BATCH = 60
/** Newest messages per mailbox whose source is downloaded ahead of time, so they open instantly. */
const BODY_PREFETCH = 40
/** Sources larger than this (mostly attachments) are fetched when opened, not kept. */
const MAX_CACHED_BODY = 2_000_000

/**
 * Connections: `main` runs syncs, previews and changes; `reader` only opens messages, so opening never
 * waits behind a sync of another folder.
 */
type Lane = 'main' | 'reader'

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
  private clients: Record<Lane, ImapFlow | null> = { main: null, reader: null }
  private connecting: Record<Lane, Promise<ImapFlow> | null> = { main: null, reader: null }
  private watcher: ImapFlow | null = null
  private watcherRetry: NodeJS.Timeout | null = null
  private stopped = false
  private mailboxes: Mailbox[] = []
  /** Highest INBOX UID already reported as new, so notifications only cover arrivals. Null until the watcher connects. */
  private inboxSeenUid: number | null = null
  private parsedCache = new Map<string, ParsedMail>()
  /** Running syncs by mailbox, so overlapping triggers share one pass. */
  private syncing = new Map<string, Promise<void>>()
  /** Message count on the server at the last sync, to know whether older mail is still uncached. */
  private serverCount = new Map<string, number>()
  /** Mailboxes whose previews are being filled in. */
  private filling = new Set<string>()

  constructor(
    readonly account: AccountConfig,
    private emit: Listener,
  ) {}

  static async test(account: Pick<AccountConfig, 'email' | 'password' | 'imap'>): Promise<void> {
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
    // Logging in takes a second or two, so the first message opened should not wait for it.
    void this.connection('reader').catch(() => {})
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.watcherRetry) clearTimeout(this.watcherRetry)
    const clients = [this.clients.main, this.clients.reader, this.watcher].filter((c): c is ImapFlow => !!c)
    this.clients = { main: null, reader: null }
    this.watcher = null
    await Promise.all(clients.map((c) => c.logout().catch(() => c.close())))
  }

  /**
   * The server's folder list, cached so the app opens offline. When the server is slow or unreachable the
   * cached list is returned after a short wait, and a 'mailboxes-changed' event follows once the real one arrives.
   */
  async listMailboxes(): Promise<Mailbox[]> {
    const cached = store.loadMailboxList(this.account.id)
    const fresh = this.fetchMailboxes()
    if (!cached) return fresh
    const first = await Promise.race([fresh.catch(() => null), new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))])
    if (first) return first
    fresh.then(() => this.emit({ type: 'mailboxes-changed' })).catch(() => {})
    if (!this.mailboxes.length) this.mailboxes = cached
    return cached
  }

  private async fetchMailboxes(): Promise<Mailbox[]> {
    const client = await this.connection()
    const list = await client.list({ statusQuery: { messages: true, unseen: true } })
    const selectable = list.filter((box) => !box.flags.has('\\Noselect') && !box.flags.has('\\NonExistent'))
    const shown = new Set(selectable.map((box) => box.path))
    this.mailboxes = selectable
      .map((box) => {
        const specialUse = box.specialUse ? SPECIAL_USE[box.specialUse] : undefined
        // Gmail keeps its system folders under a hidden "[Gmail]" parent; indent only under parents that are listed.
        const depth = specialUse ? 0 : box.parent.filter((_, i) => shown.has(box.parent.slice(0, i + 1).join(box.delimiter))).length
        return {
          path: box.path,
          name: box.path.toUpperCase() === 'INBOX' ? 'Inbox' : box.name,
          specialUse,
          unread: box.status?.unseen ?? 0,
          total: box.status?.messages ?? 0,
          depth,
        }
      })
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))
    store.saveMailboxList(this.account.id, this.mailboxes)
    return this.mailboxes
  }

  /** Reads the local copy. A mailbox that never synced waits for its first sync; scrolling past the cache pulls older mail. */
  async listMessages(path: string, offset = 0, limit = PAGE_SIZE, threads = false): Promise<MessagePage> {
    const id = this.account.id
    if (!store.mailboxState(id, path)) await this.sync(path)
    const read = () => (threads ? store.listThreads(id, path, offset, limit, this.threadExclusions()) : store.listMessages(id, path, offset, limit))
    let messages = read()
    if (messages.length < limit && this.hasOlderOnServer(path)) {
      await this.fetchOlder(path)
      messages = read()
    }
    return { mailbox: path, messages, hasMore: messages.length === limit || this.hasOlderOnServer(path) }
  }

  /** The server's Inbox path (always INBOX in practice; read from the folder list when known). */
  inboxPath(): string {
    return this.mailboxes.find((box) => box.specialUse === 'inbox')?.path ?? 'INBOX'
  }

  /** The conversation oldest first, one entry per message even when the server keeps copies in several folders. */
  getThread(thread: string): MessageSummary[] {
    const allMail = this.mailboxes.find((box) => box.specialUse === 'all')?.path
    const seen = new Map<string, MessageSummary>()
    for (const m of store.getThread(this.account.id, thread, this.threadExclusions())) {
      const id = m.messageId?.toLowerCase() ?? m.key
      const kept = seen.get(id)
      // Prefer the copy in a real folder over Gmail's All Mail.
      if (!kept || (kept.mailbox === allMail && m.mailbox !== allMail)) seen.set(id, m)
    }
    return [...seen.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
  }

  /** Conversations never pull in copies sitting in Trash or Spam. */
  private threadExclusions(): string[] {
    return this.mailboxes.filter((box) => box.specialUse === 'trash' || box.specialUse === 'junk').map((box) => box.path)
  }

  /** Brings the cached copy up to date: new mail, flag changes, and messages removed elsewhere. */
  sync(path: string): Promise<void> {
    const running = this.syncing.get(path)
    if (running) return running
    const pass = this.syncOnce(path).finally(() => this.syncing.delete(path))
    this.syncing.set(path, pass)
    return pass
  }

  private async syncOnce(path: string): Promise<void> {
    const id = this.account.id
    await this.withMailbox(path, async (client) => {
      // An already-selected mailbox keeps its old counts until the server speaks again; NOOP asks.
      await client.noop()
      const box = client.mailbox
      if (!box) return
      const validity = String(box.uidValidity)
      const modseq = box.highestModseq ? String(box.highestModseq) : null
      const state = store.mailboxState(id, path)
      // A new UIDVALIDITY means every cached UID may now point at a different message.
      if (state && state.uidvalidity !== validity) store.clearMailbox(id, path)
      const known = state?.uidvalidity === validity ? state : undefined
      this.serverCount.set(path, box.exists)
      let { low, high } = known ?? { low: 0, high: 0 }

      const range = store.uidRange(id, path)
      if (box.exists > 0) {
        const fresh: MessageSummary[] = []
        if (!known || high === 0) {
          const from = Math.max(1, box.exists - INITIAL_WINDOW + 1)
          for await (const msg of client.fetch(`${from}:*`, SUMMARY_QUERY)) fresh.push(this.toSummary(path, msg))
        } else {
          for await (const msg of client.fetch(`${high + 1}:*`, SUMMARY_QUERY, { uid: true })) {
            // "n:*" always returns the newest message, even when nothing is newer than n.
            if (msg.uid > high) fresh.push(this.toSummary(path, msg))
          }
        }
        store.upsertMessages(fresh)
        if (fresh.length) {
          high = Math.max(high, ...fresh.map((m) => m.uid))
          if (!low) low = Math.min(...fresh.map((m) => m.uid))
        }
      }

      if (range.count > 0) {
        // Flag changes made elsewhere: only what changed when the server tracks MODSEQ, else every cached flag.
        const changed: Array<{ uid: number; seen: boolean; flagged: boolean; answered: boolean }> = []
        const query = { uid: true, flags: true }
        const options = known?.modseq && modseq ? { uid: true, changedSince: BigInt(known.modseq) } : { uid: true }
        for await (const msg of client.fetch(`${range.min}:*`, query, options)) {
          const flags = msg.flags ?? new Set<string>()
          changed.push({ uid: msg.uid, seen: flags.has('\\Seen'), flagged: flags.has('\\Flagged'), answered: flags.has('\\Answered') })
        }
        store.updateFlags(id, path, changed)
        // Messages deleted or moved elsewhere.
        const onServer = new Set((await client.search({ uid: `${range.min}:*` }, { uid: true })) || [])
        store.deleteMessages(
          id,
          path,
          store.cachedUids(id, path).filter((uid) => !onServer.has(uid)),
        )
      }
      store.saveMailboxState(id, path, { uidvalidity: validity, modseq, low, high })
    })
    this.emit({ type: 'mailbox-synced', mailbox: path })
    this.fillPreviews(path)
  }

  private hasOlderOnServer(path: string): boolean {
    const count = this.serverCount.get(path)
    const state = store.mailboxState(this.account.id, path)
    if (count === undefined || !state || state.low <= 1) return false
    return store.countFrom(this.account.id, path, state.low) < count
  }

  private async fetchOlder(path: string): Promise<void> {
    const id = this.account.id
    const state = store.mailboxState(id, path)
    if (!state || state.low <= 1) return
    await this.withMailbox(path, async (client) => {
      const uids = ((await client.search({ uid: `1:${state.low - 1}` }, { uid: true })) || []).sort((a, b) => a - b).slice(-OLDER_BATCH)
      const older: MessageSummary[] = []
      if (uids.length) for await (const msg of client.fetch(uids, SUMMARY_QUERY, { uid: true })) older.push(this.toSummary(path, msg))
      store.upsertMessages(older)
      // Nothing below means the window now reaches the start of the mailbox.
      store.saveMailboxState(id, path, { ...state, low: uids.length ? uids[0] : 1 })
    })
    this.fillPreviews(path)
  }

  /** Fills previews batch by batch in the background, refreshing the list after each, until none are missing. */
  private fillPreviews(path: string): void {
    if (this.filling.has(path)) return
    this.filling.add(path)
    void (async () => {
      try {
        while (await this.fetchPreviews(path)) this.emit({ type: 'mailbox-synced', mailbox: path })
        await this.prefetchBodies(path)
      } catch {
        // Previews and prefetched bodies are a nicety; the next sync tries again.
      } finally {
        this.filling.delete(path)
      }
    })()
  }

  /** Fills in previews for the newest cached messages that lack one. Returns whether any were added. */
  private async fetchPreviews(path: string): Promise<boolean> {
    const id = this.account.id
    const missing = store.missingPreviews(id, path, PREVIEW_BATCH)
    if (!missing.length) return false
    await this.withMailbox(path, async (client) => {
      // Download only the readable body part, decoded, so long headers and inline CSS cannot crowd out the text.
      const parts: Array<{ uid: number; part: string; html: boolean }> = []
      const returned = new Set<number>()
      for await (const msg of client.fetch(missing, { uid: true, bodyStructure: true }, { uid: true })) {
        returned.add(msg.uid)
        const found = msg.bodyStructure ? textPart(msg.bodyStructure) : null
        if (found) parts.push({ uid: msg.uid, ...found })
        else store.setPreview(id, path, msg.uid, '')
      }
      // Messages deleted elsewhere are not returned; give them an empty preview so the batch still makes progress.
      for (const uid of missing) if (!returned.has(uid)) store.setPreview(id, path, uid, '')
      for (const { uid, part, html } of parts) {
        let text = ''
        try {
          const { content } = await client.download(String(uid), part, { uid: true, maxBytes: html ? 96_000 : 8_000 })
          if (content) text = await readText(content)
        } catch {
          // An unreadable part just leaves the preview empty.
        }
        store.setPreview(id, path, uid, cleanPreview(html ? htmlToText(text) : text))
      }
    })
    return true
  }

  async search(path: string, query: string): Promise<MessageSummary[]> {
    return this.withMailbox(path, async (client) => {
      // Gmail understands its own search syntax (from:, has:attachment, older_than:) and searches faster with it.
      const gmail = client.capabilities.has('X-GM-EXT-1')
      const found = await client.search(gmail ? { gmraw: query } : { or: [{ subject: query }, { from: query }, { to: query }, { body: query }] }, { uid: true })
      const uids = (found || []).sort((a, b) => b - a).slice(0, 100)
      if (uids.length === 0) return []
      // Results are real messages of this mailbox, so they join the local copy (and get previews there).
      const messages: MessageSummary[] = []
      for await (const msg of client.fetch(uids, SUMMARY_QUERY, { uid: true })) messages.push(this.toSummary(path, msg))
      store.upsertMessages(messages)
      return uids
    }).then(async (uids) => {
      if (!uids.length) return []
      await this.fetchPreviews(path)
      return store.getMessages(this.account.id, path, uids)
    })
  }

  searchLocal(query: string): MessageSummary[] {
    return store.search([this.account.id], query)
  }

  /** Opens a message from its cached source when there is one, otherwise from the server. */
  async getMessage(path: string, uid: number): Promise<MessageDetail> {
    const cached = store.getBody(this.account.id, path, uid)
    const row = cached && store.getMessages(this.account.id, path, [uid])[0]
    if (cached && row) return this.toDetail(path, uid, row, await simpleParser(cached))
    return this.withMailbox(
      path,
      async (client) => {
        const msg = await client.fetchOne(String(uid), { ...SUMMARY_QUERY, source: true }, { uid: true })
        if (!msg || !msg.source) throw new Error('Message not found. It may have been moved or deleted.')
        const validity = String(client.mailbox ? client.mailbox.uidValidity : '')
        if (msg.source.length <= MAX_CACHED_BODY) store.saveBody(this.account.id, path, uid, validity, msg.envelope?.messageId, msg.source)
        return this.toDetail(path, uid, this.toSummary(path, msg), await simpleParser(msg.source))
      },
      'reader',
    )
  }

  private toDetail(path: string, uid: number, summary: MessageSummary, parsed: ParsedMail): MessageDetail {
    this.rememberParsed(path, uid, parsed)
    const { html, attachments } = inlineImages(parsed)
    return {
      ...summary,
      cc: addresses(parsed.cc),
      bcc: addresses(parsed.bcc),
      replyTo: addresses(parsed.replyTo),
      inReplyTo: parsed.inReplyTo,
      messageId: parsed.messageId,
      references: toArray(parsed.references),
      html,
      text: parsed.text,
      attachments,
    }
  }

  /** Downloads the sources of the newest messages ahead of time, a few per lock so other work interleaves. */
  private async prefetchBodies(path: string): Promise<void> {
    const id = this.account.id
    const missing = store.missingBodies(id, path, BODY_PREFETCH)
    for (let i = 0; i < missing.length && !this.stopped; i += 10) {
      await this.withMailbox(path, async (client) => {
        const small: number[] = []
        for await (const msg of client.fetch(missing.slice(i, i + 10), { uid: true, size: true }, { uid: true })) {
          if ((msg.size ?? Infinity) <= MAX_CACHED_BODY) small.push(msg.uid)
        }
        if (!small.length) return
        const validity = String(client.mailbox ? client.mailbox.uidValidity : '')
        for await (const msg of client.fetch(small, { uid: true, envelope: true, source: true }, { uid: true })) {
          if (msg.source) store.saveBody(id, path, msg.uid, validity, msg.envelope?.messageId, msg.source)
        }
      })
    }
  }

  async setFlags(path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    await this.withMailbox(path, async (client) => {
      for (const [flag, name, on] of [['\\Seen', 'seen', flags.seen], ['\\Flagged', 'flagged', flags.flagged]] as const) {
        if (on === undefined) continue
        if (on) await client.messageFlagsAdd(uids, [flag], { uid: true })
        else await client.messageFlagsRemove(uids, [flag], { uid: true })
        // Cached only once the server took it, so a failure cannot leave the local copy disagreeing.
        store.setFlag(this.account.id, path, uids, name, on)
      }
    })
  }

  async move(path: string, uids: number[], target: MoveTarget): Promise<MoveResult | null> {
    const destination = typeof target === 'string' ? await this.pathFor(target) : 'path' in target ? target.path : await this.snoozedPath()
    const result = await this.withMailbox(path, async (client) => {
      if (destination === path) {
        // Deleting from Trash removes the message for good.
        if (target === 'trash') {
          await client.messageDelete(uids, { uid: true })
          store.deleteMessages(this.account.id, path, uids)
        }
        return null
      }
      const moved = await client.messageMove(uids, destination, { uid: true })
      store.moveMessages(
        this.account.id,
        path,
        destination,
        uids.map((uid) => [uid, moved && moved.uidMap ? moved.uidMap.get(uid) : undefined]),
      )
      // UIDPLUS tells us the new UIDs; without it the move cannot be undone precisely.
      const newUids = moved && moved.uidMap ? uids.map((uid) => moved.uidMap!.get(uid)).filter((uid): uid is number => uid !== undefined) : []
      return newUids.length === uids.length ? { account: this.account.id, from: path, to: destination, uids: newUids } : null
    })
    this.emit({ type: 'mailboxes-changed' })
    return result
  }

  /**
   * Moves snoozed messages back to `to` as unread, so they arrive like new mail. They are found by Message-ID,
   * since their UIDs can change while they wait. Returns false when none are left in `from` (moved by hand).
   */
  async returnSnoozed(from: string, messageIds: string[], to: string): Promise<boolean> {
    const found = await this.withMailbox(from, async (client) => {
      const hits = new Set<number>()
      for (const id of messageIds) for (const uid of (await client.search({ header: { 'message-id': id } }, { uid: true })) || []) hits.add(uid)
      const list = [...hits]
      if (!list.length) return list
      await client.messageFlagsRemove(list, ['\\Seen'], { uid: true })
      await client.messageMove(list, to, { uid: true })
      store.deleteMessages(this.account.id, from, list)
      return list
    })
    if (!found.length) return false
    this.emit({ type: 'mailboxes-changed' })
    void this.sync(to)
    return true
  }

  /**
   * Whether the conversation was answered anywhere on the server after `messageId`: a message that is not a draft,
   * comes from someone other than `sender`, and refers to it, or refers to an earlier message of the conversation
   * (`earlier`) and is dated no earlier than `since`. Referring to the message itself proves it came later; Date
   * headers only have whole seconds, hence the second of slack. Throws while offline, so nothing is decided on
   * stale data. Gmail's All Mail covers every label; elsewhere each folder but Drafts, Trash, and Junk is searched.
   */
  async hasReply(messageId: string, earlier: string[], since: number, sender: string): Promise<boolean> {
    const anchor = messageId.toLowerCase()
    const ids = [...new Map([messageId, ...earlier].map((id) => [id.toLowerCase(), id])).values()]
    // Long conversations are searched in batches, so the OR stays a reasonable size.
    const batches: SearchObject[][] = []
    for (let i = 0; i < ids.length; i += 20) {
      batches.push(ids.slice(i, i + 20).flatMap((id): SearchObject[] => [{ header: { 'in-reply-to': id } }, { header: { references: id } }]))
    }
    const boxes = await this.fetchMailboxes()
    const allMail = boxes.find((b) => b.specialUse === 'all')
    const searched = allMail ? [allMail] : boxes.filter((b) => b.specialUse !== 'drafts' && b.specialUse !== 'trash' && b.specialUse !== 'junk')
    for (const box of searched) {
      const answered = await this.withMailbox(box.path, async (client) => {
        const hits = new Set<number>()
        for (const or of batches) for (const uid of (await client.search({ draft: false, or }, { uid: true })) || []) hits.add(uid)
        const uids = [...hits]
        if (!uids.length) return false
        let found = false
        // Read every result: leaving the fetch early would leave the connection mid-command.
        for await (const msg of client.fetch(uids, { envelope: true, headers: ['references'] }, { uid: true })) {
          const from = msg.envelope?.from?.[0]?.address?.toLowerCase()
          if (!from || from === sender.toLowerCase()) continue
          const direct = `${msg.envelope?.inReplyTo ?? ''} ${msg.headers?.toString('utf8') ?? ''}`.toLowerCase().includes(anchor)
          const date = msg.envelope?.date ? new Date(msg.envelope.date).getTime() : 0
          if (direct || date >= since - 1000) found = true
        }
        return found
      })
      if (answered) return true
    }
    return false
  }

  /** The folder snoozed mail waits in, if there is one yet. */
  async findSnoozed(): Promise<string | undefined> {
    if (this.mailboxes.length === 0) await this.listMailboxes()
    return this.mailboxes.find((box) => box.path.toLowerCase() === 'snoozed' || box.name.toLowerCase() === 'snoozed')?.path
  }

  /** The folder snoozed mail waits in, created on first use. */
  async snoozedPath(): Promise<string> {
    const found = await this.findSnoozed()
    if (found) return found
    const client = await this.connection()
    const created = await client.mailboxCreate('Snoozed')
    await this.listMailboxes()
    return created.path
  }

  async markAllRead(path: string): Promise<void> {
    await this.withMailbox(path, async (client) => {
      if (client.mailbox && client.mailbox.exists > 0) await client.messageFlagsAdd('1:*', ['\\Seen'])
    })
    store.setFlag(this.account.id, path, 'all', 'seen', true)
    this.emit({ type: 'mailboxes-changed' })
  }

  /** Stores a draft in the Drafts folder, replacing the previous copy. Returns the new UID when the server reports it. */
  async saveDraft(raw: Buffer, replaceUid?: number): Promise<number | null> {
    const drafts = await this.pathFor('drafts')
    const client = await this.connection()
    const appended = await client.append(drafts, raw, ['\\Draft', '\\Seen'])
    if (replaceUid) await this.deleteDraft(replaceUid)
    this.emit({ type: 'mailboxes-changed' })
    void this.sync(drafts)
    return appended ? (appended.uid ?? null) : null
  }

  /** Attachments of a saved draft, to carry into its next version. */
  async draftAttachments(uid: number, partIds: number[]): Promise<Array<{ filename: string; content: Buffer }>> {
    const drafts = await this.pathFor('drafts')
    const out = []
    for (const partId of partIds) out.push(await this.attachment(drafts, uid, partId))
    return out
  }

  async deleteDraft(uid: number): Promise<void> {
    const drafts = await this.pathFor('drafts')
    await this.withMailbox(drafts, (client) => client.messageDelete([uid], { uid: true }))
    store.deleteMessages(this.account.id, drafts, [uid])
  }

  async inboxUnread(): Promise<number> {
    const client = await this.connection()
    const status = await client.status('INBOX', { unseen: true })
    return status ? (status.unseen ?? 0) : 0
  }

  /** Unread INBOX messages that arrived since the last call (or since the watcher connected). */
  async takeNewInbox(): Promise<MessageSummary[]> {
    if (this.inboxSeenUid === null) return []
    return this.withMailbox('INBOX', async (client) => {
      // Read under the lock, so overlapping arrival events cannot report the same messages twice.
      const since = this.inboxSeenUid ?? 0
      const fresh: MessageSummary[] = []
      for await (const msg of client.fetch(`${since + 1}:*`, SUMMARY_QUERY, { uid: true })) {
        // "n:*" always returns the newest message, even when nothing is newer than n.
        if (msg.uid > since) fresh.push(this.toSummary('INBOX', msg))
      }
      this.inboxSeenUid = Math.max(since, ...fresh.map((m) => m.uid))
      return fresh.filter((m) => !m.seen).sort((a, b) => b.uid - a.uid)
    })
  }

  async undoMove(move: MoveResult): Promise<void> {
    await this.withMailbox(move.to, async (client) => {
      const back = await client.messageMove(move.uids, move.from, { uid: true })
      store.moveMessages(
        this.account.id,
        move.to,
        move.from,
        move.uids.map((uid) => [uid, back && back.uidMap ? back.uidMap.get(uid) : undefined]),
      )
    })
    this.emit({ type: 'mailboxes-changed' })
    // Rows without a reported new UID come back with this sync.
    void this.sync(move.from)
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
    // Gmail has no Archive folder: archiving removes the Inbox label, which a move to All Mail does.
    const allMail = this.mailboxes.find((box) => box.specialUse === 'all')
    if (this.account.provider === 'gmail' && allMail) return allMail.path
    const client = await this.connection()
    const created = await client.mailboxCreate('Archive')
    await this.listMailboxes()
    return created.path
  }

  private toSummary(path: string, msg: FetchMessageObject): MessageSummary {
    const env = msg.envelope
    const flags = msg.flags ?? new Set<string>()
    return {
      key: store.messageKey(this.account.id, path, msg.uid),
      account: this.account.id,
      mailbox: path,
      uid: msg.uid,
      thread: threadKey(msg, path),
      messageId: env?.messageId,
      from: fromEnvelope(env?.from?.[0]) ?? fromEnvelope(env?.sender?.[0]) ?? { name: '', address: '' },
      to: (env?.to ?? []).map((a) => fromEnvelope(a)!).filter(Boolean),
      subject: env?.subject?.trim() || '(no subject)',
      date: new Date(env?.date ?? msg.internalDate ?? Date.now()).toISOString(),
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      hasAttachments: msg.bodyStructure ? hasAttachment(msg.bodyStructure) : false,
    }
  }

  private key(path: string, uid: number): string {
    return `${path}\u0000${uid}`
  }

  private rememberParsed(path: string, uid: number, parsed: ParsedMail): void {
    this.parsedCache.set(this.key(path, uid), parsed)
    if (this.parsedCache.size > 20) this.parsedCache.delete(this.parsedCache.keys().next().value!)
  }

  private async withMailbox<T>(path: string, fn: (client: ImapFlow) => Promise<T>, lane: Lane = 'main'): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.connection(lane)
      let lock: MailboxLockObject | undefined
      try {
        lock = await client.getMailboxLock(path)
        return await fn(client)
      } catch (error) {
        // A dropped socket surfaces as an error on the next command; reconnect once.
        if (attempt === 0 && !client.usable) {
          if (this.clients[lane] === client) this.clients[lane] = null
          continue
        }
        throw error
      } finally {
        lock?.release()
      }
    }
  }

  private async connection(lane: Lane = 'main'): Promise<ImapFlow> {
    const current = this.clients[lane]
    if (current?.usable) return current
    const pending = this.connecting[lane]
    if (pending) return pending
    const connecting = (async () => {
      const client = createClient(this.account)
      client.on('error', () => {})
      client.on('close', () => {
        if (this.clients[lane] === client) this.clients[lane] = null
      })
      await client.connect()
      // stop() ran while this was logging in; nothing would ever close it.
      if (this.stopped) {
        await client.logout().catch(() => client.close())
        throw new Error('Account stopped.')
      }
      this.clients[lane] = client
      return client
    })().finally(() => {
      this.connecting[lane] = null
    })
    this.connecting[lane] = connecting
    return connecting
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
      const inbox = await watcher.mailboxOpen('INBOX')
      // Everything already in INBOX at connect time is old news for notifications.
      if (this.inboxSeenUid === null) this.inboxSeenUid = Math.max(0, Number(inbox.uidNext ?? 1) - 1)
      this.watcher = watcher
      this.emit({ type: 'connection', status: 'online' })
    } catch {
      watcher.close()
      this.emit({ type: 'connection', status: 'offline' })
      this.watcherRetry = setTimeout(() => void this.startWatcher(), 15_000)
    }
  }
}

// threadId is Gmail's X-GM-THRID (or OBJECTID THREADID); references builds conversations elsewhere.
const SUMMARY_QUERY = { uid: true, flags: true, envelope: true, internalDate: true, bodyStructure: true, threadId: true, headers: ['references'] }

/**
 * Messages of one conversation share a key: the server's thread id when it has one, otherwise the first
 * Message-ID in the reply chain (References, then In-Reply-To), otherwise the message's own Message-ID.
 */
function threadKey(msg: FetchMessageObject, path: string): string {
  if (msg.threadId) return `t:${msg.threadId}`
  const references = msg.headers?.toString('utf8').match(/<[^<>\s]+>/)?.[0]
  const root = references ?? msg.envelope?.inReplyTo?.match(/<[^<>\s]+>/)?.[0] ?? msg.envelope?.messageId
  return root ? `m:${root.toLowerCase()}` : `u:${path}:${msg.uid}`
}

function createClient(account: Pick<AccountConfig, 'email' | 'password' | 'imap'>, extra: Partial<ImapFlowOptions> = {}): ImapFlow {
  return new ImapFlow({
    ...extra,
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.email, pass: account.password },
    logger: false,
    // Fail fast when offline instead of imapflow's 90 second default; the cached copy covers the gap.
    connectionTimeout: 15_000,
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

/** The part to preview: the first inline text/plain, else the first inline text/html. */
function textPart(root: MessageStructureObject): { part: string; html: boolean } | null {
  let html: string | null = null
  const walk = (node: MessageStructureObject): string | null => {
    if (node.disposition === 'attachment') return null
    const part = node.part ?? '1'
    if (node.type === 'text/plain') return part
    if (node.type === 'text/html' && !html) html = part
    for (const child of node.childNodes ?? []) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  const plain = walk(root)
  if (plain) return { part: plain, html: false }
  return html ? { part: html, html: true } : null
}

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

function cleanPreview(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*>/.test(line) && !/^On .+ wrote:\s*$/.test(line.trim()))
    .join(' ')
    .replace(/\[(?:image|cid):[^\]]*\]/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[-=_*~]{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", zwnj: '', shy: '' }

function htmlToText(html: string): string {
  return html
    // Downloads are capped, so a style block or tag can be unclosed; drop those to the end too.
    .replace(/<(head|style|script|title)\b[\s\S]*?(<\/\1>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<[^>]*$/, ' ')
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
