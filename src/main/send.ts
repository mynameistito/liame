import { createTransport } from 'nodemailer'
import { basename } from 'node:path'
import type { AccountConfig, Draft } from '../shared/types'

export interface StoredAttachment {
  filename: string
  content: Buffer
}

function mailOptions(account: AccountConfig, draft: Draft, stored: StoredAttachment[]) {
  return {
    from: { name: account.name, address: account.email },
    to: splitAddresses(draft.to),
    cc: splitAddresses(draft.cc),
    bcc: splitAddresses(draft.bcc),
    subject: draft.subject,
    text: draft.text,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    // Stored ones first, so after a save they keep their positions in the new copy.
    attachments: [...stored, ...draft.attachments.map((path) => ({ path, filename: basename(path) }))],
  }
}

/** The raw RFC 822 message, for storing in Drafts. */
export async function buildRaw(account: AccountConfig, draft: Draft, stored: StoredAttachment[]): Promise<Buffer> {
  // The stream transport keeps the Bcc header, so a resumed draft still has it.
  const info = await createTransport({ streamTransport: true, buffer: true }).sendMail(mailOptions(account, draft, stored))
  return info.message as Buffer
}

export async function sendDraft(account: AccountConfig, draft: Draft, stored: StoredAttachment[]): Promise<void> {
  const to = splitAddresses(draft.to)
  if (to.length === 0) throw new Error('Add at least one recipient.')

  const transport = createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.email, pass: account.password },
    name: account.email.split('@')[1],
  })

  try {
    // Zoho's SMTP server files a copy in Sent on its own, so there is no IMAP append here.
    await transport.sendMail(mailOptions(account, draft, stored))
  } finally {
    transport.close()
  }
}

function splitAddresses(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
}
