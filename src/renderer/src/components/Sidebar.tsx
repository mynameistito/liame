import {
  Archive,
  File,
  Flag,
  Folder,
  Inbox,
  LogOut,
  type LucideIcon,
  Mails,
  OctagonAlert,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
} from 'lucide-react'
import type { LabelDef, Mailbox, MailEvent, PublicAccount, SpecialUse } from '../../../shared/types'

const ICONS: Record<SpecialUse, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: File,
  archive: Archive,
  junk: OctagonAlert,
  trash: Trash2,
  flagged: Flag,
  all: Mails,
}

interface Props {
  account: PublicAccount
  mailboxes: Mailbox[]
  current: string
  status: MailEvent['status']
  refreshing: boolean
  labels: LabelDef[]
  labelCounts: Record<string, number>
  activeLabel: string | null
  onLabel: (id: string | null) => void
  onSettings: () => void
  onSelect: (path: string) => void
  onCompose: () => void
  onRefresh: () => void
  onSignOut: () => void
}

export function Sidebar({ account, mailboxes, current, status, refreshing, labels, labelCounts, activeLabel, onLabel, onSettings, onSelect, onCompose, onRefresh, onSignOut }: Props) {
  const special = mailboxes.filter((box) => box.specialUse)
  const folders = mailboxes.filter((box) => !box.specialUse)

  return (
    <aside className="pane sidebar">
      <div className="sidebar-top drag">
        <button className="icon-button" title="Refresh" onClick={onRefresh}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
        </button>
      </div>

      <button className="compose-button" onClick={onCompose}>
        <SquarePen size={15} />
        New message
        <kbd>C</kbd>
      </button>

      <nav className="nav">
        {special.map((box) => (
          <Item key={box.path} box={box} icon={ICONS[box.specialUse!]} active={box.path === current && !activeLabel} onSelect={onSelect} />
        ))}
        {labels.length > 0 && <div className="nav-label">Labels</div>}
        {labels.map((label) => (
          <button key={label.id} className={`nav-item ${activeLabel === label.id ? 'active' : ''}`} onClick={() => onLabel(activeLabel === label.id ? null : label.id)}>
            <span className="label-dot" style={{ background: label.color }} />
            <span className="name">{label.name}</span>
            {labelCounts[label.id] > 0 && <span className="count">{labelCounts[label.id]}</span>}
          </button>
        ))}
        {folders.length > 0 && <div className="nav-label">Folders</div>}
        {folders.map((box) => (
          <Item key={box.path} box={box} icon={Folder} active={box.path === current && !activeLabel} onSelect={onSelect} />
        ))}
      </nav>

      <div className="account">
        <span className={`status-dot ${status ?? ''}`} title={status === 'online' ? 'Connected' : status} />
        <div className="account-text">
          <div className="account-name">{account.name}</div>
          <div className="account-email">{account.email}</div>
        </div>
        <button className="icon-button" title="Settings  ⌘," onClick={onSettings}>
          <SettingsIcon size={14} />
        </button>
        <button className="icon-button" title="Sign out" onClick={onSignOut}>
          <LogOut size={14} />
        </button>
      </div>
    </aside>
  )
}

function Item({ box, icon: Icon, active, onSelect }: { box: Mailbox; icon: LucideIcon; active: boolean; onSelect: (path: string) => void }) {
  // Unread counts only matter where new mail lands; elsewhere they are noise.
  const showCount = box.unread > 0 && box.specialUse !== 'trash' && box.specialUse !== 'sent' && box.specialUse !== 'drafts'
  return (
    <button
      className={`nav-item ${active ? 'active' : ''}`}
      style={{ paddingLeft: 10 + box.depth * 14 }}
      onClick={() => onSelect(box.path)}
    >
      <Icon size={15} strokeWidth={1.8} />
      <span className="name">{box.name}</span>
      {showCount && <span className={`count ${box.specialUse === 'inbox' ? 'unread' : ''}`}>{box.unread}</span>}
    </button>
  )
}
