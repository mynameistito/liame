import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Draft, Mailbox, MailEvent, MessageContext, MessageDetail, MessageSummary, PublicAccount, PublicSettings, SpecialUse } from '../../shared/types'
import { Assistant } from './components/Assistant'
import { Composer } from './components/Composer'
import { MessageList, type Filter } from './components/MessageList'
import { Reader, type ReplyMode } from './components/Reader'
import { Settings } from './components/Settings'
import { Setup } from './components/Setup'
import { Sidebar } from './components/Sidebar'
import { api, classifyItem, displayName, errorMessage, formatAddress, longDate, toContext } from './lib'

const EMPTY_DRAFT: Draft = { to: '', cc: '', bcc: '', subject: '', text: '', attachments: [] }

export function App() {
  const [account, setAccount] = useState<PublicAccount | null | undefined>(undefined)

  useEffect(() => {
    api.getAccount().then(setAccount)
  }, [])

  if (account === undefined) return null
  if (account === null) return <Setup onDone={setAccount} />
  return (
    <Mail
      account={account}
      onSignOut={async () => {
        await api.signOut()
        setAccount(null)
      }}
    />
  )
}

function Mail({ account, onSignOut }: { account: PublicAccount; onSignOut: () => void }) {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [current, setCurrent] = useState('')
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [nextBefore, setNextBefore] = useState(0)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<MessageDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageSummary[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [composer, setComposer] = useState<{ draft: Draft; title: string; context?: MessageContext; autoDraft?: boolean } | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [status, setStatus] = useState<MailEvent['status']>('connecting')
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState('')

  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const currentRef = useRef(current)
  currentRef.current = current
  const detailRequest = useRef(0)
  const loadingMore = useRef(false)
  const classifying = useRef(new Set<string>())

  const box = mailboxes.find((b) => b.path === current)
  const source = results ?? messages
  const labelList = settings?.labels.list ?? []
  const labelMap = useMemo(() => new Map(labelList.map((l) => [l.id, l])), [labelList])
  const labelCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of messages) if (m.label && !m.seen) counts[m.label] = (counts[m.label] ?? 0) + 1
    return counts
  }, [messages])
  const visible = useMemo(
    () =>
      source.filter((m) => {
        if (activeLabel && m.label !== activeLabel) return false
        // Keep the open message in the Unread view after it gets marked read.
        if (filter === 'unread') return !m.seen || m.uid === selected
        if (filter === 'flagged') return m.flagged
        return true
      }),
    [source, filter, selected, activeLabel],
  )
  const summary = source.find((m) => m.uid === selected) ?? null

  const notify = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((t) => (t === text ? '' : t)), 2600)
  }, [])

  const patchMessages = useCallback((uids: number[], patch: (m: MessageSummary) => MessageSummary) => {
    const apply = (list: MessageSummary[]) => list.map((m) => (uids.includes(m.uid) ? patch(m) : m))
    setMessages(apply)
    setResults((r) => r && apply(r))
    setDetail((d) => (d && uids.includes(d.uid) ? { ...d, ...patch(d) } : d))
  }, [])

  const refreshMailboxes = useCallback(async () => {
    try {
      const boxes = await api.listMailboxes()
      setMailboxes(boxes)
      setCurrent((path) => path || boxes.find((b) => b.specialUse === 'inbox')?.path || boxes[0]?.path || '')
    } catch (err) {
      setListError(errorMessage(err))
    }
  }, [])

  const loadPreviews = useCallback(async (path: string, list: MessageSummary[]) => {
    const missing = list.filter((m) => m.preview === undefined).map((m) => m.uid)
    for (let i = 0; i < missing.length; i += 25) {
      const previews = await api.previews(path, missing.slice(i, i + 25)).catch(() => ({}) as Record<number, string>)
      if (currentRef.current !== path) return
      const add = (items: MessageSummary[]) => items.map((m) => (m.uid in previews ? { ...m, preview: previews[m.uid] } : m))
      setMessages(add)
      setResults((r) => r && add(r))
    }
  }, [])

  /** Reload the newest page and keep anything older that was already scrolled into view. */
  const refreshList = useCallback(
    async (path: string, reset: boolean) => {
      if (!path) return
      if (reset) {
        setMessages([])
        setLoading(true)
      }
      setListError('')
      try {
        const page = await api.listMessages(path)
        if (currentRef.current !== path) return
        setMessages((old) => {
          const known = new Map(old.map((m) => [m.uid, m.preview]))
          const fresh = page.messages.map((m) => ({ ...m, preview: m.preview ?? known.get(m.uid) }))
          const oldest = fresh.at(-1)?.uid ?? 0
          return reset ? fresh : [...fresh, ...old.filter((m) => m.uid < oldest)]
        })
        if (reset) setNextBefore(page.nextBefore)
        void loadPreviews(path, page.messages)
      } catch (err) {
        setListError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [loadPreviews],
  )

  const loadMore = useCallback(async () => {
    if (!nextBefore || loadingMore.current || results) return
    loadingMore.current = true
    const path = current
    try {
      const page = await api.listMessages(path, nextBefore)
      if (currentRef.current !== path) return
      setMessages((old) => [...old, ...page.messages.filter((m) => !old.some((o) => o.uid === m.uid))])
      setNextBefore(page.nextBefore)
      void loadPreviews(path, page.messages)
    } catch (err) {
      notify(errorMessage(err))
    } finally {
      loadingMore.current = false
    }
  }, [current, nextBefore, results, loadPreviews, notify])

  // Mailboxes and settings on start, then the selected mailbox whenever it changes.
  useEffect(() => {
    void refreshMailboxes()
    void api.getSettings().then(setSettings)
  }, [refreshMailboxes])

  // Label inbox mail in the background once its preview is known. Stored labels come back instantly;
  // only new messages reach the decision model.
  useEffect(() => {
    if (box?.specialUse !== 'inbox' || !settings) return
    const pending = messages.filter((m) => m.label === undefined && m.preview !== undefined && !classifying.current.has(`${current}:${m.uid}`))
    if (pending.length === 0) return
    pending.forEach((m) => classifying.current.add(`${current}:${m.uid}`))
    const path = current
    api
      .classify(pending.map(classifyItem))
      .then((labels) => {
        if (currentRef.current !== path) return
        const apply = (list: MessageSummary[]) => list.map((m) => (m.uid in labels ? { ...m, label: labels[m.uid] } : m))
        setMessages(apply)
        setResults((r) => r && apply(r))
      })
      .catch(() => pending.forEach((m) => classifying.current.delete(`${path}:${m.uid}`)))
  }, [messages, box?.specialUse, current, settings])

  useEffect(() => {
    setSelected(null)
    setDetail(null)
    setQuery('')
    setResults(null)
    void refreshList(current, true)
  }, [current, refreshList])

  // Server push from the IDLE connection, plus a refresh whenever the window comes back to front.
  useEffect(() => {
    // The watcher may have connected before this window subscribed.
    void api.getStatus().then(setStatus)
    const off = api.onEvent((event) => {
      if (event.type === 'connection') setStatus(event.status)
      if (event.type === 'new-mail' || event.type === 'mailboxes-changed') void refreshMailboxes()
      if (event.type === 'new-mail' && currentRef.current.toUpperCase() === event.mailbox?.toUpperCase()) {
        void refreshList(currentRef.current, false)
      }
    })
    const onFocus = () => {
      void refreshMailboxes()
      void refreshList(currentRef.current, false)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshMailboxes, refreshList])

  // Debounced server-side search in the current mailbox.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      return
    }
    const path = current
    const timer = window.setTimeout(async () => {
      try {
        const found = await api.search(path, q)
        if (currentRef.current !== path) return
        setResults(found)
        void loadPreviews(path, found)
      } catch (err) {
        setListError(errorMessage(err))
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, current, loadPreviews])

  const open = useCallback(
    async (uid: number) => {
      setSelected(uid)
      if (detail?.uid === uid) return
      const request = ++detailRequest.current
      setDetail(null)
      setDetailError('')
      setDetailLoading(true)
      try {
        const message = await api.getMessage(current, uid)
        if (request !== detailRequest.current) return
        setDetail(message)
        if (!message.seen) {
          patchMessages([uid], (m) => ({ ...m, seen: true }))
          setMailboxes((boxes) => boxes.map((b) => (b.path === current ? { ...b, unread: Math.max(0, b.unread - 1) } : b)))
          await api.setFlags(current, [uid], { seen: true })
        }
      } catch (err) {
        if (request === detailRequest.current) setDetailError(errorMessage(err))
      } finally {
        if (request === detailRequest.current) setDetailLoading(false)
      }
    },
    [current, detail, patchMessages],
  )

  const step = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const index = visible.findIndex((m) => m.uid === selected)
      const next = visible[Math.min(visible.length - 1, Math.max(0, index === -1 ? 0 : index + delta))]
      if (next) void open(next.uid)
    },
    [visible, selected, open],
  )

  const move = useCallback(
    async (target: SpecialUse) => {
      if (selected === null) return
      const uid = selected
      const index = visible.findIndex((m) => m.uid === uid)
      const neighbour = visible[index + 1] ?? visible[index - 1]
      setMessages((list) => list.filter((m) => m.uid !== uid))
      setResults((r) => r && r.filter((m) => m.uid !== uid))
      setDetail(null)
      if (neighbour) void open(neighbour.uid)
      else setSelected(null)
      try {
        await api.move(current, [uid], target)
        const permanent = target === 'trash' && box?.specialUse === 'trash'
        notify(permanent ? 'Deleted' : target === 'archive' ? 'Archived' : 'Moved to Trash')
      } catch (err) {
        notify(errorMessage(err))
        void refreshList(current, false)
      }
    },
    [selected, visible, current, box, open, notify, refreshList],
  )

  const toggle = useCallback(
    async (flag: 'seen' | 'flagged') => {
      const m = source.find((x) => x.uid === selected)
      if (!m) return
      const value = !m[flag]
      patchMessages([m.uid], (x) => ({ ...x, [flag]: value }))
      if (flag === 'seen') {
        setMailboxes((boxes) => boxes.map((b) => (b.path === current ? { ...b, unread: Math.max(0, b.unread + (value ? -1 : 1)) } : b)))
      }
      try {
        await api.setFlags(current, [m.uid], { [flag]: value })
      } catch (err) {
        notify(errorMessage(err))
      }
    },
    [source, selected, current, patchMessages, notify],
  )

  const reply = useCallback(
    (mode: ReplyMode, ai?: { autoDraft?: boolean; text?: string }) => {
      if (!detail) return
      const draft = buildReply(detail, mode, account.email)
      if (ai?.text) draft.text = `${ai.text.trim()}${draft.text}`
      setComposer({
        draft,
        title: mode === 'forward' ? 'Forward' : 'Reply',
        context: mode === 'forward' ? undefined : toContext(detail),
        autoDraft: ai?.autoDraft,
      })
    },
    [detail, account.email],
  )

  const setLabel = useCallback(
    (label: string | null) => {
      const m = source.find((x) => x.uid === selected)
      if (!m) return
      patchMessages([m.uid], (x) => ({ ...x, label }))
      void api.setLabel(classifyItem(m), label)
    },
    [source, selected, patchMessages],
  )

  const compose = useCallback(() => setComposer({ draft: EMPTY_DRAFT, title: 'New message' }), [])

  // Single-key shortcuts in the spirit of Mail and Gmail; ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composer || showSettings) return
      if (e.metaKey && e.key === 'k') {
        e.preventDefault()
        setAssistantOpen((open) => !open)
        return
      }
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
        return
      }
      const target = e.target as HTMLElement
      if (target.matches('input, textarea, select')) return
      const key = e.key
      if (e.metaKey) {
        if (key === 'n') compose()
        else if (key === 'f') searchRef.current?.focus()
        else if (key === 'r') reply(e.shiftKey ? 'all' : 'reply')
        else if (key === 'Backspace') void move('trash')
        else return
        e.preventDefault()
        return
      }
      if (e.ctrlKey || e.altKey) return
      const actions: Record<string, () => void> = {
        j: () => step(1),
        ArrowDown: () => step(1),
        k: () => step(-1),
        ArrowUp: () => step(-1),
        e: () => void move('archive'),
        '#': () => void move('trash'),
        Backspace: () => void move('trash'),
        Delete: () => void move('trash'),
        u: () => void toggle('seen'),
        s: () => void toggle('flagged'),
        r: () => reply('reply'),
        a: () => reply('all'),
        f: () => reply('forward'),
        d: () => reply('reply', { autoDraft: true }),
        c: compose,
        '/': () => searchRef.current?.focus(),
      }
      const action = actions[key]
      if (!action) return
      e.preventDefault()
      action()
      if (key.startsWith('Arrow') || key === 'j' || key === 'k') listRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [composer, showSettings, compose, reply, step, move, toggle])

  async function refreshAll() {
    setRefreshing(true)
    await Promise.all([refreshMailboxes(), refreshList(current, false)])
    setRefreshing(false)
  }

  return (
    <div className={`app ${assistantOpen ? 'with-assistant' : ''}`}>
      <Sidebar
        account={account}
        mailboxes={mailboxes}
        current={current}
        status={status}
        refreshing={refreshing}
        labels={labelList}
        labelCounts={labelCounts}
        activeLabel={activeLabel}
        onLabel={(id) => {
          setActiveLabel(id)
          const inbox = mailboxes.find((b) => b.specialUse === 'inbox')
          if (id && inbox && current !== inbox.path) setCurrent(inbox.path)
        }}
        onSettings={() => setShowSettings(true)}
        onSelect={(path) => {
          setActiveLabel(null)
          setCurrent(path)
        }}
        onCompose={compose}
        onRefresh={refreshAll}
        onSignOut={onSignOut}
      />
      <MessageList
        listRef={listRef}
        searchRef={searchRef}
        title={(activeLabel && labelMap.get(activeLabel)?.name) || box?.name || ''}
        labels={labelMap}
        unread={box?.specialUse === 'inbox' ? box.unread : 0}
        messages={visible}
        selected={selected}
        loading={loading}
        error={listError}
        query={query}
        filter={filter}
        hasMore={!results && nextBefore > 0}
        showRecipient={box?.specialUse === 'sent' || box?.specialUse === 'drafts'}
        onQuery={setQuery}
        onFilter={setFilter}
        onSelect={(uid) => void open(uid)}
        onLoadMore={loadMore}
      />
      <Reader
        summary={summary}
        detail={detail?.uid === selected ? detail : null}
        loading={detailLoading}
        error={detailError}
        mailbox={current}
        inTrash={box?.specialUse === 'trash'}
        labels={labelList}
        assistantOpen={assistantOpen}
        onAssistant={() => setAssistantOpen((open) => !open)}
        onDraftReply={() => reply('reply', { autoDraft: true })}
        onLabel={setLabel}
        onReply={reply}
        onArchive={() => void move('archive')}
        onTrash={() => void move('trash')}
        onToggleSeen={() => void toggle('seen')}
        onToggleFlag={() => void toggle('flagged')}
      />
      {assistantOpen && (
        <Assistant
          message={detail?.uid === selected ? detail : null}
          onClose={() => setAssistantOpen(false)}
          onUseAsReply={(text) => reply('reply', { text })}
        />
      )}
      {composer && (
        <Composer
          initial={composer.draft}
          title={composer.title}
          context={composer.context}
          autoDraft={composer.autoDraft}
          snippets={settings?.snippets ?? []}
          onClose={() => setComposer(null)}
          onSent={() => {
            setComposer(null)
            notify('Sent')
            if (detail) patchMessages([detail.uid], (m) => ({ ...m, answered: true }))
          }}
        />
      )}
      {showSettings && settings && (
        <Settings
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(next) => {
            setSettings(next)
            setShowSettings(false)
            // Labels may have changed; let the inbox be labeled again against the new set.
            classifying.current.clear()
            setMessages((list) => list.map((m) => ({ ...m, label: undefined })))
            notify('Settings saved')
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function buildReply(m: MessageDetail, mode: ReplyMode, self: string): Draft {
  const me = self.toLowerCase()
  const quoted = (m.text ?? '').trimEnd()
  const references = [...m.references, ...(m.messageId ? [m.messageId] : [])]

  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ----------',
      `From: ${formatAddress(m.from)}`,
      `Date: ${longDate(m.date)}`,
      `Subject: ${m.subject}`,
      `To: ${m.to.map(formatAddress).join(', ')}`,
    ].join('\n')
    return { ...EMPTY_DRAFT, subject: prefix('Fwd', m.subject), text: `\n\n${header}\n\n${quoted}` }
  }

  const primary = m.replyTo.length ? m.replyTo : [m.from]
  // Replying to your own sent message goes to its original recipients.
  const to = primary.every((a) => a.address.toLowerCase() === me) ? m.to : primary
  const seen = new Set([me, ...to.map((a) => a.address.toLowerCase())])
  const cc =
    mode === 'all'
      ? [...m.to, ...m.cc].filter((a) => {
          const key = a.address.toLowerCase()
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      : []
  const attribution = `On ${longDate(m.date)}, ${displayName(m.from)} wrote:`
  const body = quoted
    .split('\n')
    .map((line) => (line.startsWith('>') ? `>${line}` : `> ${line}`))
    .join('\n')

  return {
    ...EMPTY_DRAFT,
    to: to.map(formatAddress).join(', '),
    cc: cc.map(formatAddress).join(', '),
    subject: prefix('Re', m.subject),
    text: `\n\n${attribution}\n${body}`,
    inReplyTo: m.messageId,
    references,
  }
}

function prefix(tag: 'Re' | 'Fwd', subject: string): string {
  const pattern = tag === 'Re' ? /^re:/i : /^(fwd?|fw):/i
  return pattern.test(subject.trim()) ? subject : `${tag}: ${subject}`
}
