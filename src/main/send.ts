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

export function checkRecipients(draft: Draft): void {
  if (splitAddresses(draft.to).length === 0) throw new Error('Add at least one recipient.')
}

/** Sends the draft and returns the Message-ID it went out with. */
export async function sendDraft(account: AccountConfig, draft: Draft, stored: StoredAttachment[]): Promise<string> {
  checkRecipients(draft)

  const transport = createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.email, pass: account.password },
    name: account.email.split('@')[1],
  })

  try {
    // Zoho and Gmail both file a copy in Sent on their own, so there is no IMAP append here.
    const info = await transport.sendMail(mailOptions(account, draft, stored))
    return info.messageId
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
