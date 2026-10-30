import {
  Archive,
  ChevronRight,
  File,
  Flag,
  Folder,
  Inbox,
  LogOut,
  type LucideIcon,
  Mails,
  OctagonAlert,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  SquarePen,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { AccountSummary, LabelDef, Mailbox, MailEvent, MailProvider, PublicAccount, SpecialUse } from '../../../shared/types'

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
  /** Section keys ('mailboxes', 'labels', 'folders') and folder paths that are folded. */
  collapsed: string[]
  onToggleCollapsed: (key: string) => void
  onLabel: (id: string | null) => void
  onSettings: () => void
  onHide: () => void
  composeHint: string
  onSelect: (path: string) => void
  onCompose: () => void
  onRefresh: () => void
  accounts: AccountSummary[]
  activeAccount: string
  onSwitchAccount: (id: string) => void
  onAddAccount: () => void
  onRemoveAccount: (id: string) => void
}

const PROVIDER_NAMES: Record<MailProvider, string> = { gmail: 'Gmail', zoho: 'Zoho', imap: 'IMAP' }

export function Sidebar(props: Props) {
  const { account, mailboxes, current, refreshing, labels, labelCounts, activeLabel, collapsed, onToggleCollapsed } = props
  const special = mailboxes.filter((box) => box.specialUse)
  const folders = mailboxes.filter((box) => !box.specialUse)
  const isOpen = (key: string) => !collapsed.includes(key)

  // Folders come sorted by path, so a folder's children follow it with a greater depth.
  const visibleFolders: Array<{ box: Mailbox; hasChildren: boolean }> = []
  let hideBelow: number | null = null
  folders.forEach((box, i) => {
    if (hideBelow !== null && box.depth > hideBelow) return
    hideBelow = null
    const hasChildren = (folders[i + 1]?.depth ?? -1) > box.depth
    visibleFolders.push({ box, hasChildren })
    if (hasChildren && collapsed.includes(box.path)) hideBelow = box.depth
  })

  return (
    <aside className="pane sidebar">
      <div className="sidebar-top drag">
        <button className="icon-button" title="Check for new mail" onClick={props.onRefresh}>
          <RefreshCw size={15} className={refreshing ? 'spin' : undefined} />
        </button>
        <button className="icon-button" title="Hide sidebar" onClick={props.onHide}>
          <PanelLeftClose size={15} />
        </button>
      </div>

      <button className="compose-button" onClick={props.onCompose}>
        <SquarePen size={15} />
        New message
        <kbd>{props.composeHint}</kbd>
      </button>

      <nav className="nav">
        <Section title="Mailboxes" open={isOpen('mailboxes')} onToggle={() => onToggleCollapsed('mailboxes')}>
          {special.map((box) => (
            <Item key={box.path} box={box} icon={ICONS[box.specialUse!]} active={box.path === current && !activeLabel} onSelect={props.onSelect} />
          ))}
        </Section>
        {labels.length > 0 && (
          <Section title="Labels" open={isOpen('labels')} onToggle={() => onToggleCollapsed('labels')}>
            {labels.map((label) => (
              <button key={label.id} className={`nav-item ${activeLabel === label.id ? 'active' : ''}`} onClick={() => props.onLabel(activeLabel === label.id ? null : label.id)}>
                <span className="label-dot" style={{ background: label.color }} />
                <span className="name">{label.name}</span>
                {labelCounts[label.id] > 0 && <span className="count">{labelCounts[label.id]}</span>}
              </button>
            ))}
          </Section>
        )}
        {folders.length > 0 && (
          <Section title="Folders" open={isOpen('folders')} onToggle={() => onToggleCollapsed('folders')}>
            {visibleFolders.map(({ box, hasChildren }) => (
              <Item
                key={box.path}
                box={box}
                icon={Folder}
                active={box.path === current && !activeLabel}
                onSelect={props.onSelect}
                folded={hasChildren ? collapsed.includes(box.path) : undefined}
                onFold={() => onToggleCollapsed(box.path)}
              />
            ))}
          </Section>
        )}
      </nav>

      <div className="accounts">
        {props.accounts.map((a) => (
          <button key={a.id} className={`account ${a.id === props.activeAccount ? 'active' : ''}`} onClick={() => props.onSwitchAccount(a.id)}>
            <span className={`status-dot ${a.status}`} title={a.status === 'online' ? 'Connected' : a.status} />
            <div className="account-text">
              <div className="account-name">{a.email}</div>
              <div className="account-email">{PROVIDER_NAMES[a.provider]}</div>
            </div>
            {/* The open account's unread count is already on Inbox. */}
            {a.id !== props.activeAccount && a.unread > 0 && <span className="count">{a.unread}</span>}
          </button>
        ))}
        <div className="account-actions">
          <button className="add-account" onClick={props.onAddAccount}>
            <Plus size={13} /> Add account
          </button>
          <span className="spacer" />
          <button className="icon-button" title="Settings" onClick={props.onSettings}>
            <SettingsIcon size={14} />
          </button>
          <button className="icon-button" title={`Remove ${account.email}`} onClick={() => props.onRemoveAccount(props.activeAccount)}>
            <LogOut size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}

function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <button className={`nav-label ${open ? 'open' : ''}`} onClick={onToggle}>
        <ChevronRight size={11} className="chevron" />
        {title}
      </button>
      {open && children}
    </>
  )
}

interface ItemProps {
  box: Mailbox
  icon: LucideIcon
  active: boolean
  onSelect: (path: string) => void
  /** Defined only for folders with subfolders. */
  folded?: boolean
  onFold?: () => void
}

function Item({ box, icon: Icon, active, onSelect, folded, onFold }: ItemProps) {
  // Unread counts only matter where new mail lands; elsewhere they are noise.
  const showCount = box.unread > 0 && box.specialUse !== 'trash' && box.specialUse !== 'sent' && box.specialUse !== 'drafts'
  return (
    <button className={`nav-item ${active ? 'active' : ''}`} style={{ paddingLeft: 10 + box.depth * 14 }} onClick={() => onSelect(box.path)}>
      <Icon size={15} strokeWidth={1.8} />
      <span className="name">{box.name}</span>
      {showCount && <span className={`count ${box.specialUse === 'inbox' ? 'unread' : ''}`}>{box.unread}</span>}
      {folded !== undefined && (
        <span
          className={`fold ${folded ? '' : 'open'}`}
          title={folded ? 'Show subfolders' : 'Hide subfolders'}
          onClick={(e) => {
            e.stopPropagation()
            onFold?.()
          }}
        >
          <ChevronRight size={12} />
        </span>
      )}
    </button>
  )
}
