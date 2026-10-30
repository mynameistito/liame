import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { AccountInput, MailProvider, PublicAccount, ZohoRegion } from '../../../shared/types'
import { api, errorMessage } from '../lib'

const REGIONS: Array<{ id: ZohoRegion; label: string }> = [
  { id: 'eu', label: 'Europe (zoho.eu)' },
  { id: 'com', label: 'United States (zoho.com)' },
  { id: 'in', label: 'India (zoho.in)' },
  { id: 'com.au', label: 'Australia (zoho.com.au)' },
  { id: 'jp', label: 'Japan (zoho.jp)' },
  { id: 'ca', label: 'Canada (zohocloud.ca)' },
]

const PROVIDERS: Array<[MailProvider, string]> = [
  ['gmail', 'Gmail'],
  ['zoho', 'Zoho'],
  ['imap', 'Other IMAP'],
]

/** Zoho uses imappro/smtppro for custom-domain (organization) mailboxes, plain imap/smtp for @zohomail ones. */
function zohoHosts(email: string, region: ZohoRegion) {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  const personal = /^zoho(mail)?\./.test(domain)
  const base = region === 'ca' ? 'zohocloud.ca' : `zoho.${region}`
  return {
    imap: `${personal ? 'imap' : 'imappro'}.${base}`,
    smtp: `${personal ? 'smtp' : 'smtppro'}.${base}`,
  }
}

function guessRegion(): ZohoRegion {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (zone.startsWith('Europe/') || zone.startsWith('Africa/')) return 'eu'
  if (zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta') return 'in'
  if (zone.startsWith('Australia/')) return 'com.au'
  if (zone === 'Asia/Tokyo') return 'jp'
  return 'com'
}

function guessProvider(email: string): MailProvider | null {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail'
  if (/^zoho(mail)?\./.test(domain)) return 'zoho'
  return null
}

interface Props {
  onDone: (account: PublicAccount) => void
  /** Present when adding another account, so there is a way back to the mailbox. */
  onCancel?: () => void
}

export function Setup({ onDone, onCancel }: Props) {
  const [provider, setProvider] = useState<MailProvider>('gmail')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [region, setRegion] = useState<ZohoRegion>(guessRegion)
  const [override, setOverride] = useState<{ imap?: string; smtp?: string; imapPort?: string; smtpPort?: string }>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const auto =
    provider === 'gmail' ? { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' } : provider === 'zoho' ? zohoHosts(email, region) : { imap: '', smtp: '' }
  const imapHost = override.imap ?? auto.imap
  const smtpHost = override.smtp ?? auto.smtp
  const imapPort = Number(override.imapPort ?? 993)
  const smtpPort = Number(override.smtpPort ?? 465)

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const account: AccountInput = {
      provider,
      name: name.trim() || email.split('@')[0],
      email: email.trim(),
      // Google shows app passwords in groups of four ("abcd efgh ..."); the spaces are not part of it.
      password: provider === 'gmail' ? password.replace(/\s+/g, '') : password,
      // Only the STARTTLS ports (IMAP 143, SMTP 587/25) start in plain text and upgrade; every other port is TLS from the start.
      imap: { host: imapHost.trim(), port: imapPort, secure: imapPort !== 143 },
      smtp: { host: smtpHost.trim(), port: smtpPort, secure: smtpPort !== 587 && smtpPort !== 25 },
    }
    try {
      const result = await api.testAccount(account)
      if (!result.ok) throw new Error(result.error)
      onDone(await api.saveAccount(account))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="setup">
      <div className="setup-drag drag" />
      <form className="setup-card" onSubmit={submit}>
        <h1 className="wordmark">
          liame<span>.</span>
        </h1>
        <p className="setup-lead">
          {onCancel ? 'Add another mailbox.' : 'Connect your mailbox.'} Your password is encrypted with your macOS Keychain and stays on this Mac.
        </p>

        <div className="segmented setup-providers">
          {PROVIDERS.map(([id, label]) => (
            <button key={id} type="button" className={provider === id ? 'on' : ''} onClick={() => (setProvider(id), setOverride({}))}>
              {label}
            </button>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        <label className="setup-field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown to people you email" />
        </label>
        <label className="setup-field">
          <span>Email address</span>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            // Typing a gmail.com or zoho address picks the matching provider.
            onBlur={() => {
              const guess = guessProvider(email)
              if (guess && guess !== provider) (setProvider(guess), setOverride({}))
            }}
            placeholder={provider === 'gmail' ? 'you@gmail.com' : 'you@domain.com'}
          />
        </label>
        <label className="setup-field">
          <span>{provider === 'imap' ? 'Password' : 'App password'}</span>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          {provider === 'gmail' && (
            <small>
              Gmail needs an app password, not your Google password. Turn on 2-Step Verification, then create one at{' '}
              <a href="https://myaccount.google.com/apppasswords" onClick={(e) => (e.preventDefault(), api.openExternal('https://myaccount.google.com/apppasswords'))}>
                myaccount.google.com/apppasswords
              </a>
              .
            </small>
          )}
          {provider === 'zoho' && <small>Create one in Zoho Mail under My Account, Security, App Passwords. IMAP access must be on in Mail Settings.</small>}
        </label>
        {provider === 'zoho' && (
          <label className="setup-field">
            <span>Data center</span>
            <select value={region} onChange={(e) => setRegion(e.target.value as ZohoRegion)}>
              {REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <details className="setup-advanced" open={provider === 'imap'}>
          <summary>Servers</summary>
          <div className="setup-row">
            <label className="setup-field">
              <span>IMAP server</span>
              <input value={imapHost} required onChange={(e) => setOverride((o) => ({ ...o, imap: e.target.value }))} placeholder="imap.example.com" />
            </label>
            <label className="setup-field">
              <span>Port</span>
              <input value={override.imapPort ?? '993'} inputMode="numeric" onChange={(e) => setOverride((o) => ({ ...o, imapPort: e.target.value }))} />
            </label>
          </div>
          <div className="setup-row">
            <label className="setup-field">
              <span>SMTP server</span>
              <input value={smtpHost} required onChange={(e) => setOverride((o) => ({ ...o, smtp: e.target.value }))} placeholder="smtp.example.com" />
            </label>
            <label className="setup-field">
              <span>Port</span>
              <input value={override.smtpPort ?? '465'} inputMode="numeric" onChange={(e) => setOverride((o) => ({ ...o, smtpPort: e.target.value }))} />
            </label>
          </div>
        </details>

        <button className="primary" type="submit" disabled={busy || !email || !password || !imapHost || !smtpHost}>
          {busy && <LoaderCircle size={14} className="spin" />}
          {busy ? 'Connecting' : 'Connect'}
        </button>
        {onCancel && (
          <button type="button" className="setup-cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
      </form>
    </div>
  )
}
