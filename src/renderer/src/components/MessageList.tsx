import { Flag, PanelLeft, Paperclip, Search, X } from 'lucide-react'
import { useEffect, useRef, type Ref, type RefObject } from 'react'
import type { LabelDef, MessageSummary } from '../../../shared/types'
import { displayName, shortDate } from '../lib'

export type Filter = 'all' | 'unread' | 'flagged'

interface Props {
  title: string
  unread: number
  messages: MessageSummary[]
  /** Key of the open message. */
  selected: string | null
  loading: boolean
  error: string
  query: string
  filter: Filter
  hasMore: boolean
  showRecipient: boolean
  labels: Map<string, LabelDef>
  onQuery: (query: string) => void
  onFilter: (filter: Filter) => void
  /** Click on a row; ⌘ and ⇧ pick messages for bulk actions instead of opening. */
  onPick: (key: string, mods: { meta: boolean; shift: boolean }) => void
  onRowMenu: (key: string) => void
  checked: string[]
  /** The open folder; rows from other folders (search results) show where they live. */
  mailbox: string
  mailboxNames: Map<string, string>
  sidebarHidden: boolean
  onShowSidebar: () => void
  onLoadMore: () => void
  searchRef: RefObject<HTMLInputElement | null>
  listRef: Ref<HTMLDivElement>
}

export function MessageList(props: Props) {
  const { listRef, title, unread, messages, selected, loading, error, query, filter, hasMore, showRecipient } = props
  const sentinel = useRef<HTMLDivElement>(null)

  // Fetch the next page when the end of the list scrolls into view.
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore) return
    const observer = new IntersectionObserver((entries) => entries[0].isIntersecting && props.onLoadMore(), { rootMargin: '400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, props.onLoadMore, messages.length])

  // Keep the selected row visible during keyboard navigation.
  useEffect(() => {
    document.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <section className="pane">
      <header className="list-header">
        <div className="list-titlebar drag">
          {props.sidebarHidden && (
            <button className="icon-button" title="Show sidebar" onClick={props.onShowSidebar}>
              <PanelLeft size={15} />
            </button>
          )}
          <div className="list-title">
            {title}
            {unread > 0 && <span className="list-subtitle">{unread} unread</span>}
          </div>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            ref={props.searchRef}
            value={query}
            placeholder="Search"
            onChange={(e) => props.onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                props.onQuery('')
                e.currentTarget.blur()
              }
            }}
          />
          {query && (
            <button className="icon-button" style={{ width: 20, height: 20 }} onClick={() => props.onQuery('')}>
              <X size={12} />
            </button>
          )}
        </label>
        <div className="filters">
          {(['all', 'unread', 'flagged'] as const).map((f) => (
            <button key={f} className={`filter ${filter === f ? 'active' : ''}`} onClick={() => props.onFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="messages" ref={listRef} tabIndex={0}>
        {loading && messages.length === 0 && <Skeleton />}
        {!loading && messages.length === 0 && !error && (
          <div className="list-empty">{query ? 'No results' : filter === 'all' ? 'Nothing here' : `No ${filter} messages`}</div>
        )}
        {messages.map((m) => (
          <Row
            key={m.key}
            message={m}
            label={m.label ? props.labels.get(m.label) : undefined}
            folder={m.mailbox !== props.mailbox ? (props.mailboxNames.get(m.mailbox) ?? m.mailbox) : undefined}
            selected={m.key === selected}
            checked={props.checked.includes(m.key)}
            showRecipient={showRecipient}
            onPick={props.onPick}
            onMenu={props.onRowMenu}
          />
        ))}
        {hasMore && <div ref={sentinel} className="list-loading">Loading</div>}
      </div>
    </section>
  )
}

interface RowProps {
  message: MessageSummary
  label?: LabelDef
  selected: boolean
  checked: boolean
  showRecipient: boolean
  onPick: Props['onPick']
  onMenu: (key: string) => void
  /** Folder name, shown only for rows outside the open folder. */
  folder?: string
}

function Row({ message: m, label, folder, selected, checked, showRecipient, onPick, onMenu }: RowProps) {
  const who = showRecipient ? `To: ${m.to.map(displayName).join(', ') || 'No recipients'}` : displayName(m.from)
  return (
    <button
      className={`row ${m.seen ? '' : 'unread'} ${selected ? 'selected' : ''} ${checked ? 'checked' : ''}`}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        // Shift-click would otherwise select text across rows.
        if (e.shiftKey) e.preventDefault()
        onPick(m.key, { meta: e.metaKey, shift: e.shiftKey })
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(m.key)
      }}
      tabIndex={-1}
    >
      {!m.seen && <span className="row-dot" />}
      <div className="row-top">
        <span className="row-from">{who}</span>
        <span className="row-meta">
          {m.hasAttachments && <Paperclip size={12} />}
          {m.flagged && <Flag size={12} className="flag" fill="currentColor" />}
          {shortDate(m.date)}
        </span>
      </div>
      <div className="row-subject">
        {folder && <span className="folder-tag">{folder}</span>}
        {label && (
          <span className="label-tag">
            <i style={{ background: label.color }} />
            {label.name}
          </span>
        )}
        {m.subject}
      </div>
      <div className="row-preview">{m.preview ?? ''}</div>
    </button>
  )
}

function Skeleton() {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <div className="skeleton" key={i}>
          <span style={{ width: `${40 + ((i * 13) % 25)}%` }} />
          <span style={{ width: `${65 + ((i * 7) % 25)}%` }} />
          <span style={{ width: '90%', marginBottom: 0 }} />
        </div>
      ))}
    </>
  )
}
