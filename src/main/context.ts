import type { Address, MessageContext, ScheduledItem } from '../shared/types'
import type { MailService } from './mail'
import * as store from './store'

/** How many other messages of a conversation the AI reads, newest kept. */
const MAX_OTHERS = 6
const MAX_OTHER_BODY = 2_000

/**
 * The rest of the message's conversation, oldest first, so a drafted reply knows what was already said.
 * Quoted history is cut from each body, since the conversation itself is there.
 */
export async function withConversation(svc: MailService, m: MessageContext): Promise<MessageContext> {
  if (!m.thread) return m
  const own = m.messageId?.toLowerCase()
  const others = svc
    .getThread(m.thread)
    .filter((x) => !own || x.messageId?.toLowerCase() !== own)
    .slice(-MAX_OTHERS)
  const conversation: MessageContext[] = []
  for (const x of others) {
    const detail = await svc.getMessage(x.mailbox, x.uid).catch(() => null)
    // A stored UID can point at another message after the folder changed on the server; then the body is not this one.
    if (detail && x.messageId && detail.messageId?.toLowerCase() !== x.messageId.toLowerCase()) continue
    conversation.push({
      from: format(x.from),
      to: x.to.map(format).join(', '),
      date: new Date(x.date).toUTCString(),
      subject: x.subject,
      text: withoutQuotes(detail?.text ?? x.preview ?? '').slice(0, MAX_OTHER_BODY),
    })
  }
  return conversation.length ? { ...m, conversation } : m
}

/** Unread inbox mail from the last two days on every account, plus what is scheduled, as plain text for the brief. */
export function dailyDigest(services: MailService[], scheduled: ScheduledItem[], now = Date.now()): string {
  const since = now - 2 * 86_400_000
  const lines: string[] = []
  for (const svc of services) {
    const unread = store.unreadSince(svc.account.id, svc.inboxPath(), since, 40)
    lines.push(`## ${svc.account.email}: ${unread.length} unread in the inbox`)
    for (const m of unread) lines.push(`- ${when(Date.parse(m.date))} | ${format(m.from)} | ${m.subject} | ${(m.preview ?? '').slice(0, 200)}`)
  }
  const waiting = scheduled.filter((item) => item.kind === 'followup' && item.fired)
  const today = scheduled.filter((item) => !item.fired && item.due < now + 86_400_000)
  if (waiting.length) {
    lines.push('## Sent or reminded messages still waiting for a reply')
    for (const item of waiting) lines.push(`- ${item.subject} (with ${item.who})`)
  }
  if (today.length) {
    lines.push('## Coming up in the next 24 hours')
    const what = { snooze: 'snoozed message returns', send: 'scheduled send', followup: 'reply reminder' }
    for (const item of today) lines.push(`- ${when(item.due)}: ${what[item.kind]}: ${item.subject} (${item.who})`)
  }
  return lines.join('\n')
}

/** Local time, the way the brief's reader thinks of it. */
function when(at: number): string {
  return new Date(at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function format(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address
}

/** Drops quoted lines and everything from an "On … wrote:" line on. */
function withoutQuotes(text: string): string {
  const lines = text.split('\n')
  const cut = lines.findIndex((line) => /^On .+wrote:\s*$/.test(line.trim()))
  return (cut === -1 ? lines : lines.slice(0, cut))
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()
}
