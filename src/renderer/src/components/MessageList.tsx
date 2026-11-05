import { Flag, PanelLeft, Paperclip, Search, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, type Ref, type RefObject } from 'react'
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
  searchState: 'local' | 'server' | 'complete' | 'failed'
  searchScope: string
  localSearchOnly: boolean
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
  /** Set in All Inboxes: rows say which account they belong to instead of which folder. */
  accountNames?: Map<string, string>
  sidebarHidden: boolean
  onShowSidebar: () => void
  onLoadMore: () => void
  searchRef: RefObject<HTMLInputElement | null>
  listRef: Ref<HTMLDivElement>
}

export function MessageList(props: Props) {
  const { listRef, title, unread, messages, selected, loading, error, query, filter, hasMore, showRecipient } = props
  const sentinel = useRef<HTMLDivElement>(null)
  // Rows keep stable event props while always invoking the latest selection/menu logic.
  const handlers = useRef(props)
  useLayoutEffect(() => {
    handlers.current = props
  })
  const onPick = useCallback<Props['onPick']>((key, mods) => handlers.current.onPick(key, mods), [])
  const onMenu = useCallback((key: string) => handlers.current.onRowMenu(key), [])
  const checked = new Set(props.checked)
  const searching = !!query.trim() && (props.searchState === 'local' || props.searchState === 'server')
  const activeKey = messages.some((m) => m.key === selected) ? selected : messages[0]?.key

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
            aria-label="Search mail"
            aria-describedby="search-scope"
            onChange={(e) => props.onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                props.onQuery('')
                e.currentTarget.blur()
              }
            }}
          />
          {query && (
            <button className="icon-button" aria-label="Clear search" style={{ width: 20, height: 20 }} onClick={() => props.onQuery('')}>
              <X size={12} />
            </button>
          )}
        </label>
        <div id="search-scope" className="search-status">
          {props.searchScope}
          {query.trim() && <div role="status" className={props.searchState === 'failed' ? 'failed' : undefined}>{props.searchState === 'local' ? 'Searching cached mail…' : props.searchState === 'server' ? 'Searching server…' : props.searchState === 'failed' ? 'Search incomplete' : props.localSearchOnly ? 'Cached results only' : 'Search complete'}</div>}
        </div>
        <div className="filters">
          {(['all', 'unread', 'flagged'] as const).map((f) => (
            <button key={f} aria-pressed={filter === f} className={`filter ${filter === f ? 'active' : ''}`} onClick={() => props.onFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="messages" ref={listRef} tabIndex={0} role="listbox" aria-label={`${title} messages`} aria-multiselectable="true" aria-activedescendant={activeKey ? `message-${encodeURIComponent(activeKey)}` : undefined} aria-busy={loading || searching}
        onKeyDown={(e) => {
          const key = (e.target as HTMLElement).closest<HTMLElement>('[data-message-key]')?.dataset.messageKey ?? activeKey
          if (e.key === ' ' && key) {
            e.preventDefault()
            e.stopPropagation()
            props.onPick(key, { meta: true, shift: e.shiftKey })
          }
        }}>
        {loading && messages.length === 0 && <Skeleton />}
        {!loading && messages.length === 0 && !error && (
          <div className="list-empty">{query.trim() ? searching ? 'Searching…' : props.localSearchOnly ? 'No cached matches' : 'No matches in searched mail' : filter === 'all' ? 'Nothing here' : `No ${filter} messages`}</div>
        )}
        {messages.map((m) => (
          <Row
            key={m.key}
            message={m}
            label={m.label ? props.labels.get(m.label) : undefined}
            folder={
              props.accountNames
                ? props.accountNames.get(m.account)
                : m.mailbox !== props.mailbox
                  ? (props.mailboxNames.get(m.mailbox) ?? m.mailbox)
                  : undefined
            }
            selected={m.key === selected}
            checked={checked.has(m.key)}
            actionSelected={checked.size > 1 ? checked.has(m.key) : m.key === selected}
            showRecipient={showRecipient}
            onPick={onPick}
            onMenu={onMenu}
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
  actionSelected: boolean
  showRecipient: boolean
  onPick: Props['onPick']
  onMenu: (key: string) => void
  /** Folder name, shown only for rows outside the open folder. */
  folder?: string
}

const Row = memo(function Row({ message: m, label, folder, selected, checked, actionSelected, showRecipient, onPick, onMenu }: RowProps) {
  const conversation = (m.threadCount ?? 1) > 1
  // A conversation row names everyone in it; a single message names its sender (or recipients in Sent).
  const who = showRecipient
    ? `To: ${m.to.map(displayName).join(', ') || 'No recipients'}`
    : conversation && m.participants?.length
      ? m.participants.map((name) => name.split(/\s+/)[0]).join(', ')
      : displayName(m.from)
  return (
    <button
      id={`message-${encodeURIComponent(m.key)}`}
      data-message-key={m.key}
      role="option"
      aria-selected={actionSelected}
      className={`row ${m.seen ? '' : 'unread'} ${selected ? 'selected' : ''} ${checked ? 'checked' : ''}`}
      onClick={(e) => {
        // Pointer selection already ran on mouse-down; keyboard and assistive activation emit a zero-detail click.
        if (e.detail === 0) onPick(m.key, { meta: e.metaKey, shift: e.shiftKey })
      }}
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
        <span className="row-from">
          {who}
          {conversation && <span className="thread-count">{m.threadCount}</span>}
        </span>
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
})

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
