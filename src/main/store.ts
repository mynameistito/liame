import { app } from 'electron'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Address, Mailbox, MessageSummary } from '../shared/types'

/**
 * Local copy of message headers, flags, and previews for every account. Message bodies stay on the
 * server. Lists and search read from here, so they are instant and work while offline.
 */
let db: DatabaseSync | null = null

function open(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(join(app.getPath('userData'), 'mail.db'))
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      account TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT,
      thread TEXT NOT NULL,
      date INTEGER NOT NULL,
      from_name TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL DEFAULT '',
      recipients TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '',
      seen INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0,
      answered INTEGER NOT NULL DEFAULT 0,
      attachments INTEGER NOT NULL DEFAULT 0,
      preview TEXT,
      UNIQUE (account, mailbox, uid)
    );
    CREATE INDEX IF NOT EXISTS messages_by_date ON messages (account, mailbox, date DESC);
    CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (account, thread);
    CREATE TABLE IF NOT EXISTS mailbox_list (
      account TEXT PRIMARY KEY,
      mailboxes TEXT NOT NULL
    );
    -- low/high bound the contiguous window synced from the server. Rows added by searches or local moves
    -- can sit outside it, so they never decide where the next sync or backfill starts.
    CREATE TABLE IF NOT EXISTS mailbox_state (
      account TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      uidvalidity TEXT NOT NULL,
      modseq TEXT,
      low_uid INTEGER NOT NULL DEFAULT 0,
      high_uid INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account, mailbox)
    );
    -- Contentless index: rows are found by id, values come from messages.
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(subject, people, preview, content='', contentless_delete=1);
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, subject, people, preview)
      VALUES (new.id, new.subject, new.from_name || ' ' || new.from_address || ' ' || new.recipients, coalesce(new.preview, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF subject, preview, from_name, from_address, recipients ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.id;
      INSERT INTO messages_fts (rowid, subject, people, preview)
      VALUES (new.id, new.subject, new.from_name || ' ' || new.from_address || ' ' || new.recipients, coalesce(new.preview, ''));
    END;
  `)
  return db
}

export function closeStore(): void {
  db?.close()
  db = null
}

interface Row {
  account: string
  mailbox: string
  uid: number
  message_id: string | null
  thread: string
  date: number
  from_name: string
  from_address: string
  recipients: string
  subject: string
  seen: number
  flagged: number
  answered: number
  attachments: number
  preview: string | null
}

export function messageKey(account: string, mailbox: string, uid: number): string {
  return `${account}/${mailbox}/${uid}`
}

function toSummary(row: Row): MessageSummary {
  return {
    key: messageKey(row.account, row.mailbox, row.uid),
    account: row.account,
    mailbox: row.mailbox,
    uid: row.uid,
    messageId: row.message_id ?? undefined,
    thread: row.thread,
    from: { name: row.from_name, address: row.from_address },
    to: JSON.parse(row.recipients) as Address[],
    subject: row.subject,
    date: new Date(row.date).toISOString(),
    seen: row.seen === 1,
    flagged: row.flagged === 1,
    answered: row.answered === 1,
    hasAttachments: row.attachments === 1,
    preview: row.preview ?? undefined,
  }
}

function transaction(fn: () => void): void {
  const d = open()
  d.exec('BEGIN')
  try {
    fn()
    d.exec('COMMIT')
  } catch (error) {
    d.exec('ROLLBACK')
    throw error
  }
}

/** Inserts new messages and refreshes flags of known ones; a known preview is kept. */
export function upsertMessages(messages: MessageSummary[]): void {
  if (!messages.length) return
  const insert = open().prepare(`
    INSERT INTO messages (account, mailbox, uid, message_id, thread, date, from_name, from_address, recipients, subject, seen, flagged, answered, attachments, preview)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account, mailbox, uid) DO UPDATE SET
      seen = excluded.seen, flagged = excluded.flagged, answered = excluded.answered,
      thread = excluded.thread, preview = coalesce(excluded.preview, messages.preview)
  `)
  transaction(() => {
    for (const m of messages) {
      insert.run(
        m.account,
        m.mailbox,
        m.uid,
        m.messageId ?? null,
        m.thread ?? `uid:${m.mailbox}:${m.uid}`,
        Date.parse(m.date),
        m.from.name,
        m.from.address,
        JSON.stringify(m.to),
        m.subject,
        m.seen ? 1 : 0,
        m.flagged ? 1 : 0,
        m.answered ? 1 : 0,
        m.hasAttachments ? 1 : 0,
        m.preview ?? null,
      )
    }
  })
}

export function updateFlags(account: string, mailbox: string, changes: Array<{ uid: number; seen: boolean; flagged: boolean; answered: boolean }>): void {
  if (!changes.length) return
  const update = open().prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE account = ? AND mailbox = ? AND uid = ?')
  transaction(() => {
    for (const c of changes) update.run(c.seen ? 1 : 0, c.flagged ? 1 : 0, c.answered ? 1 : 0, account, mailbox, c.uid)
  })
}

export function setFlag(account: string, mailbox: string, uids: number[] | 'all', flag: 'seen' | 'flagged', on: boolean): void {
  const d = open()
  if (uids === 'all') {
    d.prepare(`UPDATE messages SET ${flag} = ? WHERE account = ? AND mailbox = ?`).run(on ? 1 : 0, account, mailbox)
    return
  }
  const update = d.prepare(`UPDATE messages SET ${flag} = ? WHERE account = ? AND mailbox = ? AND uid = ?`)
  transaction(() => {
    for (const uid of uids) update.run(on ? 1 : 0, account, mailbox, uid)
  })
}

export function setPreview(account: string, mailbox: string, uid: number, preview: string): void {
  open().prepare('UPDATE messages SET preview = ? WHERE account = ? AND mailbox = ? AND uid = ?').run(preview, account, mailbox, uid)
}

export function deleteMessages(account: string, mailbox: string, uids: number[]): void {
  if (!uids.length) return
  const remove = open().prepare('DELETE FROM messages WHERE account = ? AND mailbox = ? AND uid = ?')
  transaction(() => {
    for (const uid of uids) remove.run(account, mailbox, uid)
  })
}

/** Moves cached rows to their new mailbox and UIDs; rows without a known new UID are dropped and come back on the next sync. */
export function moveMessages(account: string, from: string, to: string, moves: Array<[number, number | undefined]>): void {
  const d = open()
  const relocate = d.prepare('UPDATE OR REPLACE messages SET mailbox = ?, uid = ? WHERE account = ? AND mailbox = ? AND uid = ?')
  const remove = d.prepare('DELETE FROM messages WHERE account = ? AND mailbox = ? AND uid = ?')
  transaction(() => {
    for (const [uid, next] of moves) {
      if (next === undefined) remove.run(account, from, uid)
      else relocate.run(to, next, account, from, uid)
    }
  })
}

export function clearMailbox(account: string, mailbox: string): void {
  const d = open()
  d.prepare('DELETE FROM messages WHERE account = ? AND mailbox = ?').run(account, mailbox)
  d.prepare('DELETE FROM mailbox_state WHERE account = ? AND mailbox = ?').run(account, mailbox)
}

export function saveMailboxList(account: string, mailboxes: Mailbox[]): void {
  open().prepare('INSERT INTO mailbox_list (account, mailboxes) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET mailboxes = excluded.mailboxes').run(account, JSON.stringify(mailboxes))
}

export function loadMailboxList(account: string): Mailbox[] | null {
  const row = open().prepare('SELECT mailboxes FROM mailbox_list WHERE account = ?').get(account) as { mailboxes: string } | undefined
  return row ? (JSON.parse(row.mailboxes) as Mailbox[]) : null
}

export function removeAccount(account: string): void {
  const d = open()
  d.prepare('DELETE FROM mailbox_list WHERE account = ?').run(account)
  d.prepare('DELETE FROM messages WHERE account = ?').run(account)
  d.prepare('DELETE FROM mailbox_state WHERE account = ?').run(account)
}

export interface MailboxState {
  uidvalidity: string
  modseq: string | null
  /** Lowest and highest UID of the window synced from the server; 0 before any message was synced. */
  low: number
  high: number
}

export function mailboxState(account: string, mailbox: string): MailboxState | undefined {
  return open().prepare('SELECT uidvalidity, modseq, low_uid AS low, high_uid AS high FROM mailbox_state WHERE account = ? AND mailbox = ?').get(account, mailbox) as
    | MailboxState
    | undefined
}

export function saveMailboxState(account: string, mailbox: string, state: MailboxState): void {
  open()
    .prepare(
      `INSERT INTO mailbox_state (account, mailbox, uidvalidity, modseq, low_uid, high_uid) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account, mailbox) DO UPDATE SET uidvalidity = excluded.uidvalidity, modseq = excluded.modseq, low_uid = excluded.low_uid, high_uid = excluded.high_uid`,
    )
    .run(account, mailbox, state.uidvalidity, state.modseq, state.low, state.high)
}

/** Cached messages from the synced window's low edge up, to compare with the server's count. */
export function countFrom(account: string, mailbox: string, low: number): number {
  return (open().prepare('SELECT count(*) AS n FROM messages WHERE account = ? AND mailbox = ? AND uid >= ?').get(account, mailbox, low) as { n: number }).n
}

export function uidRange(account: string, mailbox: string): { min: number; max: number; count: number } {
  const row = open().prepare('SELECT min(uid) AS min, max(uid) AS max, count(*) AS count FROM messages WHERE account = ? AND mailbox = ?').get(account, mailbox) as {
    min: number | null
    max: number | null
    count: number
  }
  return { min: row.min ?? 0, max: row.max ?? 0, count: row.count }
}

export function cachedUids(account: string, mailbox: string): number[] {
  return (open().prepare('SELECT uid FROM messages WHERE account = ? AND mailbox = ?').all(account, mailbox) as Array<{ uid: number }>).map((r) => r.uid)
}

export function missingPreviews(account: string, mailbox: string, limit: number): number[] {
  return (
    open().prepare('SELECT uid FROM messages WHERE account = ? AND mailbox = ? AND preview IS NULL ORDER BY date DESC LIMIT ?').all(account, mailbox, limit) as Array<{ uid: number }>
  ).map((r) => r.uid)
}

export function listMessages(account: string, mailbox: string, offset: number, limit: number): MessageSummary[] {
  const rows = open().prepare('SELECT * FROM messages WHERE account = ? AND mailbox = ? ORDER BY date DESC, uid DESC LIMIT ? OFFSET ?').all(account, mailbox, limit, offset) as unknown as Row[]
  return rows.map(toSummary)
}

export function getMessages(account: string, mailbox: string, uids: number[]): MessageSummary[] {
  const get = open().prepare('SELECT * FROM messages WHERE account = ? AND mailbox = ? AND uid = ?')
  return uids.map((uid) => get.get(account, mailbox, uid) as Row | undefined).filter((r): r is Row => !!r).map(toSummary)
}

/**
 * Full-text search over subject, people, and preview for the given accounts. Each word matches as a prefix,
 * so "inv ola" finds "Invoice from Ola".
 */
export function search(accounts: string[], query: string, limit = 200): MessageSummary[] {
  const words = query.match(/[\p{L}\p{N}@._-]+/gu) ?? []
  if (!words.length || !accounts.length) return []
  const match = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ')
  const params: SQLInputValue[] = [match, ...accounts, limit]
  const rows = open()
    .prepare(
      `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? AND m.account IN (${accounts.map(() => '?').join(',')})
       ORDER BY m.date DESC LIMIT ?`,
    )
    .all(...params) as unknown as Row[]
  return rows.map(toSummary)
}
