import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AccountConfig, Draft, MessageSummary, ScheduledItem } from '../shared/types'
import type { MailService } from './mail'
import { checkRecipients, sendDraft, type StoredAttachment } from './send'
import * as store from './store'

/**
 * Snoozes, queued sends, and reply reminders. They run while Liame is open; anything that came due while it
 * was closed runs at the next launch.
 */
export interface SchedulerHost {
  account(id: string): AccountConfig | undefined
  service(id: string): MailService | undefined
  /** Brings an account's Inbox and Sent up to date, so replies are in the store before a reminder checks. */
  refresh(id: string): Promise<void>
  /** A system notification; clicking it opens the message when one is given. */
  notify(title: string, body: string, open?: { accountId: string; mailbox: string; uid: number }): void
  changed(): void
}

const RETRY_MS = 5 * 60_000
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

export function listItems(): ScheduledItem[] {
  return store.listScheduled().map((item) => {
    const where = locate(item)
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

/** Records a snooze for messages just moved to the Snoozed folder. `rows` are their summaries from before the move. */
export function addSnooze(account: string, rows: MessageSummary[], snoozed: string, uids: number[], restore: string, due: number): void {
  const newest = [...rows].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0]
  store.addScheduled({
    id: randomUUID(),
    account,
    kind: 'snooze',
    due,
    subject: newest?.subject ?? '',
    who: newest ? newest.from.name || newest.from.address : '',
    messageIds: rows.map((m) => m.messageId).filter((id): id is string => !!id),
    mailbox: snoozed,
    uids,
    restore,
  })
  host?.changed()
}

/** Snoozing again from the Snoozed folder moves the existing snooze to the new time. */
export function resnooze(account: string, mailbox: string, uids: number[], due: number): void {
  for (const item of store.listScheduled()) {
    if (item.kind === 'snooze' && item.account === account && item.mailbox === mailbox && item.uids?.some((uid) => uids.includes(uid))) {
      store.updateScheduled(item.id, { due })
    }
  }
  host?.changed()
}

/** Drops snoozes for messages that an undo moved back out of the Snoozed folder. */
export function forgetSnoozed(account: string, mailbox: string, uids: number[]): void {
  for (const item of store.listScheduled()) {
    if (item.kind === 'snooze' && item.account === account && item.mailbox === mailbox && item.uids?.some((uid) => uids.includes(uid))) {
      store.deleteScheduled(item.id)
    }
  }
  host?.changed()
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
 * Undoes an item: a snooze returns now, a reminder is dismissed, and a queued send comes back as a draft to edit.
 * The outbox copy of its attachments stays until the next launch, since the composer reads them from there.
 */
export async function cancel(id: string): Promise<{ account: string; draft: Draft } | null> {
  const item = store.getScheduled(id)
  if (!item) return null
  if (item.kind === 'snooze') await returnSnooze(item)
  store.deleteScheduled(id)
  host?.changed()
  return item.kind === 'send' && item.draft ? { account: item.account, draft: item.draft } : null
}

async function runDue(): Promise<void> {
  if (running || !host) return
  running = true
  try {
    const now = Date.now()
    for (const item of store.listScheduled()) {
      if (!host.service(item.account)) continue
      try {
        if (await run(item, now)) host.changed()
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
  await svc.returnSnoozed(item.mailbox, item.messageIds ?? [], item.uids ?? [], item.restore)
}

async function sendQueued(item: store.Scheduled): Promise<void> {
  const account = host?.account(item.account)
  if (!account || !item.draft) return
  try {
    const messageId = await sendDraft(account, item.draft, [])
    await rm(join(outbox(), item.id), { recursive: true, force: true })
    if (item.followUp) remindAfterSend(account, item.draft, messageId, item.followUp)
    void host?.service(item.account)?.sync('INBOX').catch(() => {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Tell once per failure streak, not on every retry.
    if (!item.error) host?.notify('Could not send a scheduled message', `${item.subject || '(no subject)'}: ${message}`)
    store.updateScheduled(item.id, { error: message, due: Date.now() + RETRY_MS })
    host?.changed()
    throw error
  }
}

/** A due reminder fires unless someone replied; a fired one goes away once a reply arrives. */
async function checkReminder(item: store.Scheduled, now: number): Promise<boolean> {
  if (!item.fired && item.due > now) return false
  if (!item.fired) await host?.refresh(item.account)
  const ref = item.messageId ? store.findMessage(item.account, item.messageId) : undefined
  const thread = ref?.thread ?? item.thread
  if (thread && item.sender && store.hasReply(item.account, thread, item.sentAt ?? 0, item.sender)) {
    store.deleteScheduled(item.id)
    return true
  }
  if (item.fired) return false
  store.updateScheduled(item.id, { fired: true })
  const where = locate(item)
  host?.notify('No reply yet', item.subject || '(no subject)', where && { accountId: item.account, ...where })
  return true
}

/** Where to open the item's message: the Snoozed copy, or the stored copy of the reminded message. */
function locate(item: store.Scheduled): { mailbox: string; uid: number } | undefined {
  if (item.kind === 'snooze' && item.mailbox && item.uids?.length) {
    // The store knows the current UID even when the server renumbered it.
    const id = item.messageIds?.[0]
    const found = id ? store.findMessage(item.account, id) : undefined
    if (found && found.mailbox === item.mailbox) return { mailbox: found.mailbox, uid: found.uid }
    return { mailbox: item.mailbox, uid: item.uids[0] }
  }
  if (item.kind === 'followup' && item.messageId) {
    const found = store.findMessage(item.account, item.messageId, allMailPaths(item.account))
    if (found) return { mailbox: found.mailbox, uid: found.uid }
  }
  return undefined
}

function allMailPaths(account: string): string[] {
  return (store.loadMailboxList(account) ?? []).filter((b) => b.specialUse === 'all').map((b) => b.path)
}

/** Outbox folders whose send is gone (sent, cancelled, or the account removed). */
async function cleanOutbox(): Promise<void> {
  const live = new Set(store.listScheduled().map((item) => item.id))
  const dirs = await readdir(outbox()).catch(() => [] as string[])
  for (const dir of dirs) if (!live.has(dir)) await rm(join(outbox(), dir), { recursive: true, force: true })
}
