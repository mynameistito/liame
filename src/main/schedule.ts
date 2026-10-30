import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AccountConfig, Draft, MessageSummary, ScheduledItem } from '../shared/types'
import type { MailService } from './mail'
import { buildRaw, checkRecipients, sendDraft, type StoredAttachment } from './send'
import * as store from './store'

/**
 * Snoozes, queued sends, and reply reminders. They run while Liame is open; anything that came due while it
 * was closed runs at the next launch.
 */
export interface SchedulerHost {
  account(id: string): AccountConfig | undefined
  service(id: string): MailService | undefined
  /** A system notification; clicking it opens the message when one is given. */
  notify(title: string, body: string, open?: { accountId: string; mailbox: string; uid: number }): void
  changed(): void
}

const RETRY_MS = 5 * 60_000
const RECHECK_MS = 10 * 60_000
/** When each fired reminder last asked the server for a reply. */
const lastAsked = new Map<string, number>()
let host: SchedulerHost | null = null
let running = false

const outbox = () => join(app.getPath('userData'), 'outbox')

export function startScheduler(h: SchedulerHost): void {
  host = h
  void cleanOutbox()
  // Give the accounts a moment to connect before the first run.
  setTimeout(() => void runDue(), 5_000)
  setInterval(() => void runDue(), 30_000)
}

/** Every item to show. A snooze whose messages were all moved out of Snoozed by hand is hidden; it ends at its time. */
export function listItems(): ScheduledItem[] {
  return store.listScheduled().flatMap((item) => {
    const where = locate(item)
    if (item.kind === 'snooze' && !where) return []
    return {
      id: item.id,
      account: item.account,
      kind: item.kind,
      due: item.due,
      subject: item.subject,
      who: item.who,
      mailbox: where?.mailbox,
      uid: where?.uid,
      fired: item.fired || undefined,
      error: item.error,
    }
  })
}

/**
 * Records a snooze for messages just moved to the Snoozed folder. Each message is tracked by its Message-ID,
 * so a message snoozed again moves to the new time on its own, and the snooze follows it through renumbering.
 * `restore` is the folder they came from. Snoozing again from Snoozed (no `restore`) keeps each message's own
 * folder, and fails for messages that came back while the request waited.
 */
export async function addSnooze(account: string, rows: MessageSummary[], snoozed: string, restore: string | undefined, due: number): Promise<void> {
  const earlier = await dropSnoozed(
    account,
    rows.map((m) => m.messageId!),
  )
  // Read after the drop, which waited for any return already under way.
  const present = new Set(store.findIn(account, snoozed, [...earlier.keys()]).map((m) => m.messageId!.toLowerCase()))
  const groups = new Map<string, MessageSummary[]>()
  for (const m of rows) {
    const id = m.messageId!.toLowerCase()
    if (!restore && !present.has(id)) continue
    const back = restore ?? earlier.get(id) ?? 'INBOX'
    groups.set(back, [...(groups.get(back) ?? []), m])
  }
  if (!groups.size) throw new Error('That message already came back.')
  for (const [back, list] of groups) {
    const newest = [...list].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0]
    store.addScheduled({
      id: randomUUID(),
      account,
      kind: 'snooze',
      due,
      subject: newest.subject,
      who: newest.from.name || newest.from.address,
      messageIds: list.map((m) => m.messageId!.toLowerCase()),
      mailbox: snoozed,
      restore: back,
    })
  }
  host?.changed()
}

/** Ends the snooze of these messages. Returns each one's Message-ID (lowercase) with the folder it was going back to. */
export async function dropSnoozed(account: string, messageIds: string[]): Promise<Map<string, string | undefined>> {
  const drop = new Map<string, string | undefined>(messageIds.map((id) => [id.toLowerCase(), undefined]))
  for (const { id } of store.listScheduled()) {
    await withItem(id, async () => {
      const item = store.getScheduled(id)
      if (item?.kind !== 'snooze' || item.account !== account || !item.messageIds?.some((m) => drop.has(m))) return
      for (const m of item.messageIds) if (drop.has(m)) drop.set(m, item.restore)
      const left = item.messageIds.filter((m) => !drop.has(m))
      if (left.length) store.updateScheduled(id, { messageIds: left })
      else store.deleteScheduled(id)
    })
  }
  host?.changed()
  return drop
}

/** Remembers to remind about a message unless someone other than its sender replies by `due`. */
export function addReminder(account: string, m: { messageId?: string; thread?: string; subject: string; from: string; who: string; date: number }, due: number): void {
  store.addScheduled({
    id: randomUUID(),
    account,
    kind: 'followup',
    due,
    subject: m.subject,
    who: m.who,
    messageId: m.messageId,
    thread: m.thread,
    sender: m.from,
    sentAt: m.date,
  })
  host?.changed()
}

/** Reminder bookkeeping for a message that was just sent. */
export function remindAfterSend(account: AccountConfig, draft: Draft, messageId: string, followUp: number): void {
  // The store's thread key for mail without a server thread id; Gmail's comes from the stored copy once Sent syncs.
  const root = draft.references?.[0] ?? draft.inReplyTo ?? messageId
  const now = Date.now()
  addReminder(
    account.id,
    { messageId, thread: `m:${root.toLowerCase()}`, subject: draft.subject, from: account.email, who: draft.to, date: now },
    now + followUp,
  )
}

/** Queues a draft. Its attachments are copied into the outbox, so they are still there when it sends. */
export async function queueSend(account: AccountConfig, draft: Draft, kept: StoredAttachment[], due: number, followUp?: number): Promise<void> {
  checkRecipients(draft)
  const id = randomUUID()
  const files: string[] = []
  // One folder per file keeps each file's own name, which becomes the attachment's name.
  const place = async (name: string) => {
    const dir = join(outbox(), id, String(files.length))
    await mkdir(dir, { recursive: true })
    return join(dir, basename(name))
  }
  for (const file of kept) {
    const path = await place(file.filename)
    await writeFile(path, file.content)
    files.push(path)
  }
  for (const source of draft.attachments) {
    const path = await place(source)
    await copyFile(source, path)
    files.push(path)
  }
  store.addScheduled({
    id,
    account: account.id,
    kind: 'send',
    due,
    subject: draft.subject,
    who: draft.to,
    draft: { ...draft, attachments: files, kept: undefined, draftUid: undefined },
    followUp,
  })
  host?.changed()
}

/**
 * Undoes an item: a snooze returns now, a reminder is dismissed, and a queued send goes to Drafts and comes back
 * to edit, so closing the composer keeps it. The outbox copy of its attachments stays until the next launch.
 */
export function cancel(id: string): Promise<{ account: string; draft: Draft } | null> {
  return withItem(id, async () => {
    const item = store.getScheduled(id)
    if (!item) throw new Error('That already happened.')
    let edit: { account: string; draft: Draft } | null = null
    if (item.kind === 'snooze') await returnSnooze(item)
    if (item.kind === 'send' && item.draft) edit = { account: item.account, draft: await toDrafts(item.account, item.draft) }
    store.deleteScheduled(id)
    host?.changed()
    return edit
  })
}

/** Saves a queued message in Drafts. The returned draft points at that copy, the way the composer's own save does. */
async function toDrafts(accountId: string, draft: Draft): Promise<Draft> {
  const account = host?.account(accountId)
  const svc = host?.service(accountId)
  if (!account || !svc) throw new Error('That account no longer exists.')
  const uid = await svc.saveDraft(await buildRaw(account, draft, []), undefined)
  if (!uid) return draft
  return { ...draft, draftUid: uid, kept: draft.attachments.map((path, partId) => ({ partId, filename: basename(path) })), attachments: [] }
}

/** Runs one item at a time, so a cancel or a new snooze never overlaps the scheduler working on the same item. */
const inFlight = new Map<string, Promise<unknown>>()
function withItem<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (inFlight.get(id) ?? Promise.resolve()).catch(() => {}).then(fn)
  inFlight.set(id, next)
  const clear = () => {
    if (inFlight.get(id) === next) inFlight.delete(id)
  }
  next.then(clear, clear)
  return next
}

async function runDue(): Promise<void> {
  if (running || !host) return
  running = true
  try {
    for (const { id } of store.listScheduled()) {
      if (inFlight.has(id)) continue
      try {
        // Read again under the lock: the item may have been cancelled or moved since the list was read.
        const changed = await withItem(id, async () => {
          const item = store.getScheduled(id)
          return item && host?.service(item.account) ? run(item, Date.now()) : false
        })
        if (changed) host.changed()
      } catch {
        // Offline or the server refused; the next run tries again. Sends record why (see sendQueued).
      }
    }
  } finally {
    running = false
  }
}

/** Runs the item if it is due; true when something changed. */
async function run(item: store.Scheduled, now: number): Promise<boolean> {
  if (item.kind === 'followup') return checkReminder(item, now)
  if (item.due > now) return false
  if (item.kind === 'snooze') await returnSnooze(item)
  else await sendQueued(item)
  store.deleteScheduled(item.id)
  return true
}

async function returnSnooze(item: store.Scheduled): Promise<void> {
  const svc = host?.service(item.account)
  if (!svc || !item.mailbox || !item.restore) return
  // False means the messages were moved out of Snoozed by hand; the snooze is simply over.
  await svc.returnSnoozed(item.mailbox, item.messageIds ?? [], item.restore)
}

async function sendQueued(item: store.Scheduled): Promise<void> {
  const account = host?.account(item.account)
  if (!account || !item.draft) return
  let messageId: string
  try {
    messageId = await sendDraft(account, item.draft, [])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Tell once per failure streak, not on every retry.
    if (!item.error) host?.notify('Could not send a scheduled message', `${item.subject || '(no subject)'}: ${message}`)
    store.updateScheduled(item.id, { error: message, due: Date.now() + RETRY_MS })
    host?.changed()
    throw error
  }
  // Gone from the queue before anything else can fail, so it is never sent twice. Leftover files go at next launch.
  store.deleteScheduled(item.id)
  await rm(join(outbox(), item.id), { recursive: true, force: true }).catch(() => {})
  if (item.followUp) remindAfterSend(account, item.draft, messageId, item.followUp)
  void host?.service(item.account)?.sync('INBOX').catch(() => {})
}

/** A due reminder fires unless someone replied; a fired one goes away once a reply arrives. */
async function checkReminder(item: store.Scheduled, now: number): Promise<boolean> {
  if (!item.fired && item.due > now) return false
  // The server is asked before firing, and now and then afterwards for replies in folders Liame does not sync.
  const ask = !item.fired || now - (lastAsked.get(item.id) ?? 0) > RECHECK_MS
  if (ask) lastAsked.set(item.id, now)
  if (await answered(item, ask)) {
    store.deleteScheduled(item.id)
    return true
  }
  if (item.fired) return false
  store.updateScheduled(item.id, { fired: true })
  const where = locate(item)
  host?.notify('No reply yet', item.subject || '(no subject)', where && { accountId: item.account, ...where })
  return true
}

/**
 * The local copy answers quickly when a reply is already stored. Before a reminder fires (`ask`), the server
 * decides, since replies can land in folders Liame does not sync; offline that throws and the next run tries again.
 */
async function answered(item: store.Scheduled, ask: boolean): Promise<boolean> {
  if (!item.sender) return false
  const account = host?.account(item.account)
  const ref = item.messageId ? store.findMessage(item.account, item.messageId) : undefined
  const thread = ref?.thread ?? item.thread
  const skip = specialPaths(item.account, ['drafts', 'trash', 'junk'])
  // My own messages only count once they are in Sent, so a draft parked anywhere else is not an answer.
  const sent = specialPaths(item.account, ['sent'])
  if (thread && store.hasReply(item.account, thread, item.sentAt ?? 0, item.sender, skip, account?.email ?? '', sent)) return true
  if (!ask || !item.messageId) return false
  // Replies to earlier messages of the conversation count too, when they came after this one.
  const earlier = thread ? store.getThread(item.account, thread, []).flatMap((m) => m.messageId ?? []) : []
  if (thread?.startsWith('m:')) earlier.push(thread.slice(2))
  return (await host?.service(item.account)?.hasReply(item.messageId, earlier, item.sentAt ?? 0, item.sender)) ?? false
}

/** Where to open the item's message: a snoozed message still in Snoozed, or the stored copy of the reminded message. */
function locate(item: store.Scheduled): { mailbox: string; uid: number } | undefined {
  if (item.kind === 'snooze' && item.mailbox) {
    const found = store.findIn(item.account, item.mailbox, item.messageIds ?? [])[0]
    return found && { mailbox: found.mailbox, uid: found.uid }
  }
  if (item.kind === 'followup' && item.messageId) {
    const found = store.findMessage(item.account, item.messageId, specialPaths(item.account, ['all']))
    if (found) return { mailbox: found.mailbox, uid: found.uid }
  }
  return undefined
}

function specialPaths(account: string, uses: string[]): string[] {
  return (store.loadMailboxList(account) ?? []).filter((b) => b.specialUse && uses.includes(b.specialUse)).map((b) => b.path)
}

/** Outbox folders whose send is gone (sent, cancelled, or the account removed). */
async function cleanOutbox(): Promise<void> {
  const live = new Set(store.listScheduled().map((item) => item.id))
  const dirs = await readdir(outbox()).catch(() => [] as string[])
  for (const dir of dirs) if (!live.has(dir)) await rm(join(outbox(), dir), { recursive: true, force: true })
}
