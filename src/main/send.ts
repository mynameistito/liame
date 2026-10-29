import { createTransport } from 'nodemailer'
import { basename } from 'node:path'
import type { AccountConfig, Draft } from '../shared/types'

export async function sendDraft(account: AccountConfig, draft: Draft): Promise<void> {
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
    await transport.sendMail({
      from: { name: account.name, address: account.email },
      to,
      cc: splitAddresses(draft.cc),
      bcc: splitAddresses(draft.bcc),
      subject: draft.subject,
      text: draft.text,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      attachments: draft.attachments.map((path) => ({ path, filename: basename(path) })),
    })
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
