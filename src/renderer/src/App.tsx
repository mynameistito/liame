import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Draft,
  Mailbox,
  MailEvent,
  MessageContext,
  MessageDetail,
  MessageSummary,
  MoveResult,
  Prefs,
  PublicAccount,
  PublicSettings,
  SpecialUse,
} from '../../shared/types'
import { COMMANDS, type CommandId, comboOf, formatCombo, isPlainKey, keymap, keysFor } from './commands'
import { Assistant } from './components/Assistant'
import { Composer } from './components/Composer'
import { MessageList, type Filter } from './components/MessageList'
import { Palette, type PaletteItem } from './components/Palette'
import { Reader, type ReplyMode } from './components/Reader'
import { Settings, type SettingsTab } from './components/Settings'
import { Setup } from './components/Setup'
import { Sidebar } from './components/Sidebar'
import { api, classifyItem, displayName, errorMessage, formatAddress, longDate, toContext } from './lib'

const EMPTY_DRAFT: Draft = { to: '', cc: '', bcc: '', subject: '', text: '', attachments: [] }

const DEFAULT_PREFS: Prefs = {
  markRead: 'immediately',
  afterMove: 'next',
  remoteImages: true,
  notifications: true,
  signature: '',
  accent: '#3b8cff',
  density: 'comfortable',
  zoom: 1,
  darkenEmails: true,
}

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
  const [searchRun, setSearchRun] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [composer, setComposer] = useState<{ draft: Draft; title: string; context?: MessageContext; autoDraft?: boolean } | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [status, setStatus] = useState<MailEvent['status']>('connecting')
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<{ text: string; undo?: boolean } | null>(null)
  const [lastMove, setLastMove] = useState<MoveResult | null>(null)
  const [darken, setDarken] = useState(true)
  const [imagesAllowed, setImagesAllowed] = useState<number | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const currentRef = useRef(current)
  currentRef.current = current
  const detailRequest = useRef(0)
  const loadingMore = useRef(false)
  const classifying = useRef(new Set<string>())
  const mailboxesRef = useRef(mailboxes)
  mailboxesRef.current = mailboxes
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const inboxMaxUid = useRef(0)

  const prefs = settings?.prefs ?? DEFAULT_PREFS
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const overrides = settings?.shortcuts ?? {}
  const hint = useCallback((id: CommandId) => (keysFor(id, overrides)[0] ? formatCombo(keysFor(id, overrides)[0]) : ''), [overrides])

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

  const notify = useCallback((text: string, undo = false) => {
    const next = { text, undo }
    setToast(next)
    window.setTimeout(() => setToast((t) => (t === next ? null : t)), undo ? 6000 : 2600)
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
        // In the foreground there is nothing to announce, so mail seen here moves the notification baseline.
        if ((!inboxMaxUid.current || document.hasFocus()) && mailboxesRef.current.find((b) => b.path === path)?.specialUse === 'inbox') {
          inboxMaxUid.current = Math.max(0, ...page.messages.map((m) => m.uid))
        }
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
    // Background notifications: fetch the newest inbox page and announce unread mail newer than the last one seen.
    const announce = async (mailbox: string) => {
      const inbox = mailboxesRef.current.find((b) => b.specialUse === 'inbox')
      if (!prefsRef.current.notifications || document.hasFocus() || !inbox || inbox.path.toUpperCase() !== mailbox.toUpperCase()) return
      const page = await api.listMessages(inbox.path).catch(() => null)
      if (!page) return
      const fresh = page.messages.filter((m) => m.uid > inboxMaxUid.current && !m.seen)
      inboxMaxUid.current = Math.max(inboxMaxUid.current, ...page.messages.map((m) => m.uid))
      if (fresh.length > 3) new Notification(`${fresh.length} new messages`, { body: fresh.slice(0, 3).map((m) => displayName(m.from)).join(', '), silent: false })
      else for (const m of fresh) new Notification(displayName(m.from), { body: m.subject })
    }
    const off = api.onEvent((event) => {
      if (event.type === 'connection') setStatus(event.status)
      if (event.type === 'new-mail' && event.mailbox) void announce(event.mailbox)
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
  }, [query, current, loadPreviews, searchRun])

  const open = useCallback(
    async (uid: number) => {
      setSelected(uid)
      if (detail?.uid === uid) return
      const request = ++detailRequest.current
      setDetail(null)
      setDetailError('')
      setDetailLoading(true)
      setDarken(prefsRef.current.darkenEmails)
      setImagesAllowed(null)
      try {
        const message = await api.getMessage(current, uid)
        if (request !== detailRequest.current) return
        setDetail(message)
        const { markRead } = prefsRef.current
        if (!message.seen && markRead !== 'never') {
          if (markRead === 'delay') {
            await new Promise((resolve) => window.setTimeout(resolve, 2000))
            // Only count it as read if it is still the open message.
            if (selectedRef.current !== uid || request !== detailRequest.current) return
          }
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
      const { afterMove } = prefsRef.current
      const neighbour =
        afterMove === 'none' ? undefined : afterMove === 'previous' ? (visible[index - 1] ?? visible[index + 1]) : (visible[index + 1] ?? visible[index - 1])
      setMessages((list) => list.filter((m) => m.uid !== uid))
      setResults((r) => r && r.filter((m) => m.uid !== uid))
      setDetail(null)
      if (neighbour) void open(neighbour.uid)
      else setSelected(null)
      try {
        const moved = await api.move(current, [uid], target)
        setLastMove(moved)
        const permanent = target === 'trash' && box?.specialUse === 'trash'
        notify(permanent ? 'Deleted' : target === 'archive' ? 'Archived' : 'Moved to Trash', Boolean(moved))
      } catch (err) {
        notify(errorMessage(err))
        void refreshList(current, false)
      }
    },
    [selected, visible, current, box, open, notify, refreshList],
  )

  const undo = useCallback(async () => {
    if (!lastMove) return
    const move = lastMove
    setLastMove(null)
    try {
      await api.undoMove(move)
      notify('Moved back')
      if (currentRef.current === move.to) {
        // The moved copy is gone from here; drop it rather than wait for the next refresh.
        setMessages((list) => list.filter((m) => !move.uids.includes(m.uid)))
        setResults((r) => r && r.filter((m) => !move.uids.includes(m.uid)))
        if (selectedRef.current !== null && move.uids.includes(selectedRef.current)) setSelected(null)
      }
      if (currentRef.current === move.from) void refreshList(move.from, false)
      setSearchRun((n) => n + 1)
    } catch (err) {
      notify(errorMessage(err))
    }
  }, [lastMove, notify, refreshList])

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
      draft.text = `${signatureBlock(prefsRef.current.signature)}${draft.text}`
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

  const compose = useCallback(
    () => setComposer({ draft: { ...EMPTY_DRAFT, text: signatureBlock(prefsRef.current.signature) }, title: 'New message' }),
    [],
  )

  const hasMessage = summary !== null
  const hasDetail = detail !== null && detail.uid === selected
  const commands: Record<Exclude<CommandId, 'send' | 'snippets'>, { run: () => void; enabled?: boolean }> = {
    palette: { run: () => setPaletteOpen(true) },
    compose: { run: compose },
    reply: { run: () => reply('reply'), enabled: hasDetail },
    replyAll: { run: () => reply('all'), enabled: hasDetail },
    forward: { run: () => reply('forward'), enabled: hasDetail },
    draftReply: { run: () => reply('reply', { autoDraft: true }), enabled: hasDetail },
    archive: { run: () => void move('archive'), enabled: hasMessage },
    trash: { run: () => void move('trash'), enabled: hasMessage },
    undo: { run: () => void undo(), enabled: lastMove !== null },
    toggleRead: { run: () => void toggle('seen'), enabled: hasMessage },
    toggleFlag: { run: () => void toggle('flagged'), enabled: hasMessage },
    next: { run: () => (step(1), listRef.current?.focus()) },
    previous: { run: () => (step(-1), listRef.current?.focus()) },
    goInbox: {
      run: () => {
        const inbox = mailboxes.find((b) => b.specialUse === 'inbox')
        if (inbox) (setActiveLabel(null), setCurrent(inbox.path))
      },
    },
    search: { run: () => searchRef.current?.focus() },
    filterAll: { run: () => setFilter('all') },
    filterUnread: { run: () => setFilter('unread') },
    filterFlagged: { run: () => setFilter('flagged') },
    toggleDarken: { run: () => setDarken((d) => !d), enabled: Boolean(hasDetail && detail?.html) },
    loadImages: { run: () => setImagesAllowed(selected), enabled: Boolean(hasDetail && detail?.html && !prefs.remoteImages) },
    assistant: { run: () => setAssistantOpen((open) => !open) },
    refresh: { run: () => void refreshAll() },
    settings: { run: () => setSettingsTab('general') },
    shortcuts: { run: () => setSettingsTab('shortcuts') },
  }
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  const mainKeys = useMemo(() => keymap(overrides, false), [overrides])

  // One handler for every rebindable shortcut. Plain keys are ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (composer || settingsTab || paletteOpen) return
      const combo = comboOf(e)
      const id = combo ? mainKeys.get(combo) : undefined
      if (!combo || !id || id === 'send' || id === 'snippets') return
      const target = e.target as HTMLElement
      if (target.matches('input, textarea, select') && (isPlainKey(combo) || !COMMANDS.find((c) => c.id === id)?.global)) return
      const command = commandsRef.current[id]
      e.preventDefault()
      if (command.enabled !== false) command.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [composer, settingsTab, paletteOpen, mainKeys])

  const paletteItems = (): PaletteItem[] => [
    ...COMMANDS.filter((c) => !c.composer && c.id !== 'palette').map((c) => {
      const command = commands[c.id as keyof typeof commands]
      return { id: c.id, title: c.title, group: c.group, hint: hint(c.id), disabled: command.enabled === false, run: command.run }
    }),
    ...mailboxes.map((b) => ({
      id: `box:${b.path}`,
      title: `Go to ${b.name}`,
      group: 'Mailboxes',
      run: () => (setActiveLabel(null), setCurrent(b.path)),
    })),
    ...labelList.map((l) => ({
      id: `label:${l.id}`,
      title: `Show ${l.name}`,
      group: 'Labels',
      run: () => {
        setActiveLabel(l.id)
        const inbox = mailboxes.find((b) => b.specialUse === 'inbox')
        if (inbox && current !== inbox.path) setCurrent(inbox.path)
      },
    })),
    ...(selected !== null
      ? labelList.map((l) => ({ id: `set-label:${l.id}`, title: `Label as ${l.name}`, group: 'Labels', run: () => setLabel(l.id) }))
      : []),
  ]

  // Appearance preferences apply to the whole window.
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--accent', prefs.accent)
    root.setProperty('--accent-soft', `color-mix(in srgb, ${prefs.accent} 16%, transparent)`)
    // Light accents (Graphite) need dark text on filled buttons.
    root.setProperty('--on-accent', prefs.accent === '#e5e5ea' ? '#000' : '#fff')
    api.setZoom(prefs.zoom)
  }, [prefs.accent, prefs.zoom])

  async function refreshAll() {
    setRefreshing(true)
    await Promise.all([refreshMailboxes(), refreshList(current, false)])
    setRefreshing(false)
  }

  return (
    <div className={`app density-${prefs.density} ${assistantOpen ? 'with-assistant' : ''}`}>
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
        onSettings={() => setSettingsTab('general')}
        composeHint={hint('compose')}
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
        hint={hint}
        darken={darken}
        onToggleDarken={() => setDarken((d) => !d)}
        blockImages={!prefs.remoteImages && imagesAllowed !== selected}
        onLoadImages={() => setImagesAllowed(selected)}
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
          closeHint={hint('assistant')}
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
          shortcuts={overrides}
          onClose={() => setComposer(null)}
          onSent={() => {
            setComposer(null)
            notify('Sent')
            if (detail) patchMessages([detail.uid], (m) => ({ ...m, answered: true }))
          }}
        />
      )}
      {paletteOpen && <Palette items={paletteItems()} onClose={() => setPaletteOpen(false)} />}
      {settingsTab && settings && (
        <Settings
          settings={settings}
          initialTab={settingsTab}
          onClose={() => setSettingsTab(null)}
          onSaved={(next) => {
            setSettings(next)
            setSettingsTab(null)
            // Labels may have changed; let the inbox be labeled again against the new set.
            classifying.current.clear()
            setMessages((list) => list.map((m) => ({ ...m, label: undefined })))
            notify('Settings saved')
          }}
        />
      )}
      {toast && (
        <div className="toast">
          {toast.text}
          {toast.undo && lastMove && (
            <button onClick={() => void undo()}>
              Undo <kbd>{hint('undo')}</kbd>
            </button>
          )}
        </div>
      )}
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

/** Leading blank lines leave room to type above the signature. */
function signatureBlock(signature: string): string {
  return signature.trim() ? `\n\n${signature.trim()}` : ''
}

function prefix(tag: 'Re' | 'Fwd', subject: string): string {
  const pattern = tag === 'Re' ? /^re:/i : /^(fwd?|fw):/i
  return pattern.test(subject.trim()) ? subject : `${tag}: ${subject}`
}
