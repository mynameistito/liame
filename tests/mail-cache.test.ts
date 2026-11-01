import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageSummary } from '../src/shared/types'

const directory = mkdtempSync(join(tmpdir(), 'liame-cache-test-'))
mock.module('electron', () => ({ app: { getPath: () => directory } }))

// A server mailbox with a reused UID. Only the transport is fake; the cache and MIME parser are real.
let serverValidity = 11n
const serverFlags = new Set<string>()
mock.module('imapflow', () => ({
  ImapFlow: class extends EventEmitter {
    usable = true
    mailbox = { uidValidity: serverValidity }
    async connect() {}
    async logout() {}
    async getMailboxLock() {
      this.mailbox = { uidValidity: serverValidity }
      return { release() {} }
    }
    async messageFlagsAdd(_uids: number[], flags: string[]) { flags.forEach((flag) => serverFlags.add(flag)) }
    async messageFlagsRemove(_uids: number[], flags: string[]) { flags.forEach((flag) => serverFlags.delete(flag)) }
  },
}))

const store = await import('../src/main/store')
const { MailService } = await import('../src/main/mail')
const message = (uid: number, patch: Partial<MessageSummary> = {}): MessageSummary => ({
  key: `a/INBOX/${uid}`, account: 'a', mailbox: 'INBOX', uid, thread: 'conversation', messageId: `<${uid}@test>`,
  from: { name: `Sender ${uid}`, address: `sender${uid}@test` }, to: [], subject: `Message ${uid}`,
  date: new Date(1700000000000 + uid * 1000).toISOString(), seen: true, flagged: false, answered: false, hasAttachments: false,
  ...patch,
})

beforeEach(() => {
  store.removeAccount('a')
  store.removeAccount('b')
  serverFlags.clear()
  serverValidity = 11n
})
afterAll(() => {
  store.closeStore()
  rmSync(directory, { recursive: true })
})

test('conversation pages preserve tied-date ordering, folder flags, UIDs and deduplicated account-wide counts', () => {
  const date = '2026-10-01T12:00:00.000Z'
  store.upsertMessages([
    message(1, { seen: false, flagged: true }),
    message(2, { date }), message(3, { date }),
    message(4, { mailbox: 'Sent', messageId: '<2@test>' }),
    message(5, { mailbox: 'Sent' }),
    message(6, { mailbox: 'Trash', seen: false }),
    message(7, { account: 'b', seen: false }),
    message(8, { thread: 'other', date }),
  ])
  expect(store.listThreads('a', 'INBOX', 0, 1, ['Trash']).map((m) => m.uid)).toEqual([8])
  const [thread] = store.listThreads('a', 'INBOX', 1, 1, ['Trash'])
  expect(thread.uid).toBe(3)
  expect(thread.threadUids).toEqual([3, 2, 1])
  expect(thread.seen).toBe(false)
  expect(thread.flagged).toBe(true)
  expect(thread.threadCount).toBe(4)
  expect(new Set(thread.participants)).toEqual(new Set(['Sender 1', 'Sender 2', 'Sender 3', 'Sender 4', 'Sender 5']))
  store.setFlag('a', 'INBOX', [1], 'seen', true)
  store.deleteMessages('a', 'INBOX', [3])
  const [updated] = store.listThreads('a', 'INBOX', 1, 1, ['Trash'])
  expect(updated.uid).toBe(2)
  expect(updated.threadUids).toEqual([2, 1])
  expect(updated.seen).toBe(true)
  expect(store.listThreads('a', 'INBOX', 2, 1, [])).toEqual([])
})

test('an opened cached snapshot cannot mark a replacement UID read after UIDVALIDITY changes', async () => {
  store.upsertMessages([message(1, { seen: false })])
  store.saveMailboxState('a', 'INBOX', { uidvalidity: '11', modseq: null, low: 1, high: 1 })
  store.saveBody('a', 'INBOX', 1, '11', '<1@test>', Buffer.from('Subject: Old message\r\nMessage-ID: <1@test>\r\n\r\nOld body'))
  const service = new MailService({ id: 'a', provider: 'imap', name: 'Test', email: 'test@test', password: '', imap: { host: 'test', port: 993, secure: true }, smtp: { host: 'test', port: 465, secure: true } }, () => {})
  try {
    const snapshot = await service.getMessage('INBOX', 1)
    expect(snapshot.uidValidity).toBe('11')
    serverValidity = 12n
    await expect(service.setFlags('INBOX', [1], { seen: true }, snapshot.uidValidity)).rejects.toThrow('folder changed')
    expect(serverFlags.has('\\Seen')).toBe(false)
    expect(store.getMessages('a', 'INBOX', [1])[0].seen).toBe(false)
    await expect(service.setFlags('INBOX', [1], { seen: true }, '')).rejects.toThrow('folder changed')
    await service.setFlags('INBOX', [1], { seen: true }, '12')
    expect(serverFlags.has('\\Seen')).toBe(true)
    expect(store.getMessages('a', 'INBOX', [1])[0].seen).toBe(true)
    await service.setFlags('INBOX', [1], { seen: false })
    expect(serverFlags.has('\\Seen')).toBe(false)
  } finally {
    await service.stop()
  }
})
