import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { AccountConfig, PublicAccount, ZohoRegion } from '../../../shared/types'
import { api, errorMessage } from '../lib'

const REGIONS: Array<{ id: ZohoRegion; label: string }> = [
  { id: 'eu', label: 'Europe (zoho.eu)' },
  { id: 'com', label: 'United States (zoho.com)' },
  { id: 'in', label: 'India (zoho.in)' },
  { id: 'com.au', label: 'Australia (zoho.com.au)' },
  { id: 'jp', label: 'Japan (zoho.jp)' },
  { id: 'ca', label: 'Canada (zohocloud.ca)' },
]

/** Zoho uses imappro/smtppro for custom-domain (organization) mailboxes, plain imap/smtp for @zohomail ones. */
function hostsFor(email: string, region: ZohoRegion) {
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

export function Setup({ onDone }: { onDone: (account: PublicAccount) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [region, setRegion] = useState<ZohoRegion>(guessRegion)
  const [override, setOverride] = useState<{ imap?: string; smtp?: string }>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const auto = hostsFor(email, region)
  const imapHost = override.imap ?? auto.imap
  const smtpHost = override.smtp ?? auto.smtp

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const account: AccountConfig = {
      name: name.trim() || email.split('@')[0],
      email: email.trim(),
      password,
      imap: { host: imapHost.trim(), port: 993, secure: true },
      smtp: { host: smtpHost.trim(), port: 465, secure: true },
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
        <p className="setup-lead">Connect your Zoho mailbox. Your password is encrypted with your macOS Keychain and stays on this Mac.</p>

        {error && <div className="error-banner">{error}</div>}

        <label className="setup-field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown to people you email" />
        </label>
        <label className="setup-field">
          <span>Email address</span>
          <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@domain.com" />
        </label>
        <label className="setup-field">
          <span>App password</span>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <small>
            Create one in Zoho Mail under My Account, Security, App Passwords. IMAP access must be on in Mail Settings.
          </small>
        </label>
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

        <details className="setup-advanced">
          <summary>Servers</summary>
          <label className="setup-field">
            <span>IMAP (SSL, port 993)</span>
            <input value={imapHost} onChange={(e) => setOverride((o) => ({ ...o, imap: e.target.value }))} />
          </label>
          <label className="setup-field">
            <span>SMTP (SSL, port 465)</span>
            <input value={smtpHost} onChange={(e) => setOverride((o) => ({ ...o, smtp: e.target.value }))} />
          </label>
        </details>

        <button className="primary" type="submit" disabled={busy || !email || !password}>
          {busy && <LoaderCircle size={14} className="spin" />}
          {busy ? 'Connecting' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
