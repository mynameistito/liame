import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Draft,
  Mailbox,
  MailEvent,
  MessageContext,
  MessageDetail,
  MessageSummary,
  MenuItemSpec,
  MoveResult,
  MoveTarget,
  Prefs,
  PublicAccount,
  PublicSettings,
} from '../../shared/types'
import { COMMANDS, type CommandId, comboOf, formatCombo, isPlainKey, keymap, keysFor, toAccelerator } from './commands'
import { Assistant } from './components/Assistant'
import { Composer } from './components/Composer'
import { MessageList, type Filter } from './components/MessageList'
import { Palette, type PaletteItem } from './components/Palette'
import { Reader, type ReplyMode } from './components/Reader'
import { Settings, type SettingsTab } from './components/Settings'
import { Setup } from './components/Setup'
import { Sidebar } from './components/Sidebar'
import { api, classifyItem, type Contact, displayName, errorMessage, formatAddress, loadContacts, longDate, rememberContacts, toContext, usePersistent } from './lib'

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
  /** Messages picked for a bulk action (⌘-click, ⇧-click, x). Empty means actions apply to the open message. */
  const [checked, setChecked] = useState<number[]>([])
  const [paletteQuery, setPaletteQuery] = useState('')
  const [contacts, setContacts] = useState<Record<string, Contact>>(loadContacts)
  const [sections, setSections] = usePersistent<string[]>('sections', [])
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [layout, setLayout] = usePersistent('layout', { sidebar: 228, list: 372, assistant: 340, sidebarHidden: false, listHidden: false })

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
  /** A message to open once its mailbox has loaded (from a notification click). */
  const pendingOpen = useRef<{ path: string; uid: number } | null>(null)
  const focusSearch = useRef(false)
  const openRef = useRef<(uid: number) => void>(() => {})

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
          // Keep older rows only when this page does not reach the start of the mailbox; otherwise it is the whole list.
          return reset || page.nextBefore === 0 ? fresh : [...fresh, ...old.filter((m) => m.uid < oldest)]
        })
        if (reset) setNextBefore(page.nextBefore)
        void loadPreviews(path, page.messages)
        setContacts(rememberContacts(page.messages.flatMap((m) => [m.from, ...m.to]), account.email))
        if (pendingOpen.current?.path === path) {
          openRef.current(pendingOpen.current.uid)
          pendingOpen.current = null
        }
      } catch (err) {
        setListError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [loadPreviews, account.email],
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
    setChecked([])
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
      const show = (title: string, body: string, uid?: number) => {
        const n = new Notification(title, { body })
        n.onclick = () => {
          api.focusWindow()
          // Anything that could hide the message goes: label view, filters, search, bulk picks.
          setActiveLabel(null)
          setFilter('all')
          setQuery('')
          setResults(null)
          setChecked([])
          if (uid !== undefined) pendingOpen.current = { path: inbox.path, uid }
          if (currentRef.current === inbox.path) void refreshList(inbox.path, false)
          else setCurrent(inbox.path)
        }
      }
      if (fresh.length > 3) show(`${fresh.length} new messages`, fresh.slice(0, 3).map((m) => displayName(m.from)).join(', '))
      else for (const m of fresh) show(displayName(m.from), m.subject, m.uid)
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
  openRef.current = (uid) => void open(uid)

  /** What actions apply to: the picked messages, or else the open one. */
  const targets = useMemo(() => (checked.length > 1 ? checked : selected !== null ? [selected] : []), [checked, selected])

  /** Click handling for rows: plain opens, ⌘ toggles a pick, ⇧ picks a range from the open message. */
  const pick = useCallback(
    (uid: number, mods: { meta: boolean; shift: boolean }) => {
      if (mods.shift && selected !== null) {
        const a = visible.findIndex((m) => m.uid === selected)
        const b = visible.findIndex((m) => m.uid === uid)
        if (a !== -1 && b !== -1) setChecked(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.uid))
        return
      }
      if (mods.meta) {
        const base = checked.length === 0 && selected !== null && selected !== uid ? [selected] : checked
        const next = base.includes(uid) ? base.filter((x) => x !== uid) : [...base, uid]
        // A single remaining pick is just the open message.
        if (next.length === 1) {
          setChecked([])
          void open(next[0])
        } else setChecked(next)
        return
      }
      setChecked([])
      void open(uid)
    },
    [selected, visible, checked, open],
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
    async (target: MoveTarget, uids: number[] = targets) => {
      if (uids.length === 0) return
      const gone = new Set(uids)
      const { afterMove } = prefsRef.current
      // The neighbour is found among what stays, next to the open message (or the first picked one).
      const anchor = visible.findIndex((m) => m.uid === (selected !== null && gone.has(selected) ? selected : uids[0]))
      const after = visible.slice(anchor + 1).find((m) => !gone.has(m.uid))
      const before = visible.slice(0, Math.max(0, anchor)).reverse().find((m) => !gone.has(m.uid))
      const neighbour = afterMove === 'none' ? undefined : afterMove === 'previous' ? (before ?? after) : (after ?? before)
      const openGone = selected === null || gone.has(selected)
      setMessages((list) => list.filter((m) => !gone.has(m.uid)))
      setResults((r) => r && r.filter((m) => !gone.has(m.uid)))
      setChecked([])
      if (openGone) {
        setDetail(null)
        if (neighbour) void open(neighbour.uid)
        else setSelected(null)
      }
      try {
        const moved = await api.move(current, uids, target)
        setLastMove(moved)
        const permanent = target === 'trash' && box?.specialUse === 'trash'
        const where = typeof target === 'string' ? target : (mailboxes.find((b) => b.path === target.path)?.name ?? target.path)
        const verb = permanent
          ? 'deleted'
          : target === 'archive'
            ? 'archived'
            : target === 'trash'
              ? 'moved to Trash'
              : target === 'junk'
                ? 'marked as junk'
                : `moved to ${where}`
        const text = uids.length > 1 ? `${uids.length} messages ${verb}` : verb.charAt(0).toUpperCase() + verb.slice(1)
        notify(text, Boolean(moved))
      } catch (err) {
        notify(errorMessage(err))
        void refreshList(current, false)
      }
    },
    [targets, selected, visible, current, box, mailboxes, open, notify, refreshList],
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

  /** Set a flag on the targets; with no value given, flips it (set unless all already have it). */
  const toggle = useCallback(
    async (flag: 'seen' | 'flagged', force?: boolean, uids: number[] = targets) => {
      const list = source.filter((x) => uids.includes(x.uid))
      if (list.length === 0) return
      const value = force ?? !list.every((m) => m[flag])
      const changed = list.filter((m) => m[flag] !== value).map((m) => m.uid)
      if (changed.length === 0) return
      patchMessages(changed, (x) => ({ ...x, [flag]: value }))
      if (flag === 'seen') {
        setMailboxes((boxes) => boxes.map((b) => (b.path === current ? { ...b, unread: Math.max(0, b.unread + (value ? -1 : 1) * changed.length) } : b)))
      }
      try {
        await api.setFlags(current, changed, { [flag]: value })
      } catch (err) {
        notify(errorMessage(err))
      }
    },
    [source, targets, current, patchMessages, notify],
  )

  const markAllRead = useCallback(async () => {
    const path = current
    patchMessages(
      [...messages, ...(results ?? [])].filter((m) => !m.seen).map((m) => m.uid),
      (m) => ({ ...m, seen: true }),
    )
    setMailboxes((boxes) => boxes.map((b) => (b.path === path ? { ...b, unread: 0 } : b)))
    try {
      await api.markAllRead(path)
      notify('Marked all as read')
    } catch (err) {
      notify(errorMessage(err))
      void refreshList(path, false)
    }
  }, [current, messages, results, patchMessages, notify, refreshList])

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
    (label: string | null, uids: number[] = targets) => {
      const list = source.filter((x) => uids.includes(x.uid))
      if (list.length === 0) return
      patchMessages(
        list.map((m) => m.uid),
        (x) => ({ ...x, label }),
      )
      for (const m of list) void api.setLabel(classifyItem(m), label)
    },
    [source, targets, patchMessages],
  )

  const editDraft = useCallback(() => {
    if (!detail) return
    setComposer({
      title: 'Draft',
      draft: {
        to: detail.to.map(formatAddress).join(', '),
        cc: detail.cc.map(formatAddress).join(', '),
        bcc: detail.bcc.map(formatAddress).join(', '),
        subject: detail.subject === '(no subject)' ? '' : detail.subject,
        text: detail.text ?? '',
        attachments: [],
        kept: detail.attachments.map((a) => ({ partId: a.partId, filename: a.filename })),
        inReplyTo: detail.inReplyTo,
        references: detail.references,
        draftUid: detail.uid,
      },
    })
  }, [detail])

  const compose = useCallback(
    () => setComposer({ draft: { ...EMPTY_DRAFT, text: signatureBlock(prefsRef.current.signature) }, title: 'New message' }),
    [],
  )

  const hasTargets = targets.length > 0
  const hasDetail = detail !== null && detail.uid === selected
  const single = checked.length <= 1
  const inDrafts = box?.specialUse === 'drafts'
  const toggleSidebar = () => setLayout((l) => ({ ...l, sidebarHidden: !l.sidebarHidden }))
  const toggleList = () => setLayout((l) => ({ ...l, listHidden: !l.listHidden }))
  const openPalette = (query = '') => (setPaletteQuery(query), setPaletteOpen(true))
  const commands: Record<Exclude<CommandId, 'send' | 'snippets' | 'saveDraft'>, { run: () => void; enabled?: boolean }> = {
    palette: { run: () => openPalette() },
    compose: { run: compose },
    reply: { run: () => reply('reply'), enabled: hasDetail && single },
    replyAll: { run: () => reply('all'), enabled: hasDetail && single },
    forward: { run: () => reply('forward'), enabled: hasDetail && single },
    draftReply: { run: () => reply('reply', { autoDraft: true }), enabled: hasDetail && single },
    editDraft: { run: editDraft, enabled: hasDetail && single && inDrafts },
    archive: { run: () => void move('archive'), enabled: hasTargets },
    trash: { run: () => void move('trash'), enabled: hasTargets },
    junk: { run: () => void move('junk'), enabled: hasTargets && box?.specialUse !== 'junk' },
    moveTo: { run: () => openPalette('Move to '), enabled: hasTargets },
    labelAs: { run: () => openPalette('Label as '), enabled: hasTargets && labelList.length > 0 },
    undo: { run: () => void undo(), enabled: lastMove !== null },
    toggleRead: { run: () => void toggle('seen'), enabled: hasTargets },
    toggleFlag: { run: () => void toggle('flagged'), enabled: hasTargets },
    toggleSelect: {
      run: () => selected !== null && setChecked((list) => (list.includes(selected) ? list.filter((x) => x !== selected) : [...list, selected])),
      enabled: selected !== null,
    },
    selectAll: { run: () => setChecked(visible.map((m) => m.uid)), enabled: visible.length > 0 },
    clearSelection: { run: () => setChecked([]), enabled: checked.length > 0 },
    markAllRead: { run: () => void markAllRead(), enabled: (box?.unread ?? 0) > 0 || messages.some((m) => !m.seen) },
    next: { run: () => (step(1), listRef.current?.focus()) },
    previous: { run: () => (step(-1), listRef.current?.focus()) },
    goInbox: {
      run: () => {
        const inbox = mailboxes.find((b) => b.specialUse === 'inbox')
        if (inbox) (setActiveLabel(null), setCurrent(inbox.path))
      },
    },
    search: {
      run: () => {
        if (fitted.listShown) return searchRef.current?.focus()
        focusSearch.current = true
        // Bring the list back: unhide it, or close the assistant that squeezed it out.
        if (layout.listHidden) toggleList()
        else setAssistantOpen(false)
      },
    },
    filterAll: { run: () => setFilter('all') },
    filterUnread: { run: () => setFilter('unread') },
    filterFlagged: { run: () => setFilter('flagged') },
    toggleDarken: { run: () => setDarken((d) => !d), enabled: Boolean(hasDetail && detail?.html) },
    loadImages: { run: () => setImagesAllowed(selected), enabled: Boolean(hasDetail && detail?.html && !prefs.remoteImages) },
    toggleSidebar: { run: toggleSidebar },
    toggleList: { run: toggleList },
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
      if (!combo || !id || id === 'send' || id === 'snippets' || id === 'saveDraft') return
      const target = e.target as HTMLElement
      if (target.matches('input, textarea, select') && (isPlainKey(combo) || !COMMANDS.find((c) => c.id === id)?.global)) return
      const command = commandsRef.current[id]
      // A disabled command lets the key through (Enter, Escape, ⌘A keep their usual meaning).
      if (command.enabled === false) return
      e.preventDefault()
      command.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [composer, settingsTab, paletteOpen, mainKeys])

  const folders = mailboxes.filter((b) => b.path !== current)
  const paletteItems = (): PaletteItem[] => [
    ...COMMANDS.filter((c) => !c.composer && c.id !== 'palette').map((c) => {
      const command = commands[c.id as keyof typeof commands]
      return { id: c.id, title: c.title, group: c.group, hint: hint(c.id), disabled: command.enabled === false, run: command.run }
    }),
    ...mailboxes.map((b) => ({
      id: `box:${b.path}`,
      title: `Go to ${b.path.toUpperCase() === 'INBOX' ? 'Inbox' : b.path}`,
      group: 'Mailboxes',
      run: () => (setActiveLabel(null), setCurrent(b.path)),
    })),
    ...(hasTargets
      ? folders.map((b) => ({ id: `move:${b.path}`, title: `Move to ${b.path.toUpperCase() === 'INBOX' ? 'Inbox' : b.path}`, group: 'Move', run: () => void move({ path: b.path }) }))
      : []),
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
    ...(hasTargets
      ? [
          ...labelList.map((l) => ({ id: `set-label:${l.id}`, title: `Label as ${l.name}`, group: 'Labels', run: () => setLabel(l.id) })),
          { id: 'set-label:none', title: 'Label as none', group: 'Labels', run: () => setLabel(null) },
        ]
      : []),
  ]

  /** Native right-click menu for a row; the row joins the selection first if it is not part of it. */
  const rowMenu = async (uid: number) => {
    const inSelection = targets.includes(uid)
    if (!inSelection) {
      setChecked([])
      void open(uid)
    }
    const uids = inSelection ? targets : [uid]
    const list = source.filter((m) => uids.includes(m.uid))
    const many = uids.length > 1
    const acc = (id: CommandId) => toAccelerator(keysFor(id, overrides)[0])
    const items: MenuItemSpec[] = [
      ...(many
        ? [{ label: `${uids.length} messages selected`, enabled: false }]
        : [
            // Replies need the loaded message, which only the already-open row has.
            { id: 'reply', label: 'Reply', accelerator: acc('reply'), enabled: hasDetail && detail?.uid === uid },
            { id: 'replyAll', label: 'Reply All', accelerator: acc('replyAll'), enabled: hasDetail && detail?.uid === uid },
            { id: 'forward', label: 'Forward', accelerator: acc('forward'), enabled: hasDetail && detail?.uid === uid },
            { id: 'draftReply', label: 'Draft Reply with AI', accelerator: acc('draftReply'), enabled: hasDetail && detail?.uid === uid },
          ]),
      { separator: true },
      { id: 'archive', label: 'Archive', accelerator: acc('archive') },
      { id: 'trash', label: box?.specialUse === 'trash' ? 'Delete Permanently' : 'Move to Trash', accelerator: acc('trash') },
      { id: 'junk', label: 'Mark as Junk', accelerator: acc('junk'), enabled: box?.specialUse !== 'junk' },
      { label: 'Move To', submenu: folders.map((b) => ({ id: `move:${b.path}`, label: b.path.toUpperCase() === 'INBOX' ? 'Inbox' : b.path })) },
      { separator: true },
      { id: 'read', label: list.every((m) => m.seen) ? 'Mark as Unread' : 'Mark as Read', accelerator: acc('toggleRead') },
      { id: 'flag', label: list.every((m) => m.flagged) ? 'Unflag' : 'Flag', accelerator: acc('toggleFlag') },
      ...(labelList.length
        ? [
            {
              label: 'Label',
              submenu: [
                { id: 'label:', label: 'None', checked: list.every((m) => !m.label) },
                { separator: true },
                ...labelList.map((l) => ({ id: `label:${l.id}`, label: l.name, checked: list.every((m) => m.label === l.id) })),
              ],
            },
          ]
        : []),
    ]
    const chosen = await api.contextMenu(items)
    if (!chosen) return
    if (chosen === 'reply') reply('reply')
    else if (chosen === 'replyAll') reply('all')
    else if (chosen === 'forward') reply('forward')
    else if (chosen === 'draftReply') reply('reply', { autoDraft: true })
    else if (chosen === 'archive' || chosen === 'trash' || chosen === 'junk') void move(chosen, uids)
    else if (chosen.startsWith('move:')) void move({ path: chosen.slice(5) }, uids)
    else if (chosen === 'read') void toggle('seen', undefined, uids)
    else if (chosen === 'flag') void toggle('flagged', undefined, uids)
    else if (chosen.startsWith('label:')) setLabel(chosen.slice(6) || null, uids)
  }

  // Appearance preferences apply to the whole window.
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--accent', prefs.accent)
    root.setProperty('--accent-soft', `color-mix(in srgb, ${prefs.accent} 16%, transparent)`)
    // Light accents (Graphite) need dark text on filled buttons.
    root.setProperty('--on-accent', prefs.accent === '#e5e5ea' ? '#000' : '#fff')
    api.setZoom(prefs.zoom)
  }, [prefs.accent, prefs.zoom])

  // Shrink panes (assistant, then list, then sidebar) so the reader keeps its minimum in narrow windows.
  const fitted = useMemo(() => {
    let over =
      (layout.sidebarHidden ? 0 : layout.sidebar) + (layout.listHidden ? 0 : layout.list) + (assistantOpen ? layout.assistant : 0) + 360 - windowWidth
    const shrink = (width: number, min: number, shown: boolean) => {
      if (!shown || over <= 0) return width
      const cut = Math.min(over, Math.max(0, width - min))
      over -= cut
      return width - cut
    }
    const assistant = shrink(layout.assistant, 280, assistantOpen)
    const list = shrink(layout.list, 280, !layout.listHidden)
    const sidebar = shrink(layout.sidebar, 180, !layout.sidebarHidden)
    // Still too tight with the assistant open: give the list's space to the reader until the window grows.
    const listShown = !layout.listHidden && !(over > 0 && assistantOpen)
    return { sidebar, list, assistant, listShown }
  }, [layout, assistantOpen, windowWidth])

  // The search field only exists while the list is shown.
  useEffect(() => {
    if (fitted.listShown && focusSearch.current) {
      focusSearch.current = false
      searchRef.current?.focus()
    }
  }, [fitted.listShown])

  const columns = [
    !layout.sidebarHidden && `${fitted.sidebar}px`,
    fitted.listShown && `${fitted.list}px`,
    'minmax(0, 1fr)',
    assistantOpen && `${fitted.assistant}px`,
  ]
    .filter(Boolean)
    .join(' ')
  const contactList = useMemo(() => Object.values(contacts), [contacts])

  async function refreshAll() {
    setRefreshing(true)
    await Promise.all([refreshMailboxes(), refreshList(current, false)])
    setRefreshing(false)
  }

  return (
    <div
      className={`app density-${prefs.density} ${assistantOpen ? 'with-assistant' : ''} ${layout.sidebarHidden ? 'no-sidebar' : ''} ${fitted.listShown ? '' : 'no-list'}`}
      style={{ gridTemplateColumns: columns }}
    >
      {!layout.sidebarHidden && (
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
        onHide={toggleSidebar}
        collapsed={sections}
        onToggleCollapsed={(key) => setSections((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]))}
        composeHint={hint('compose')}
        onSelect={(path) => {
          setActiveLabel(null)
          setCurrent(path)
        }}
        onCompose={compose}
        onRefresh={refreshAll}
        onSignOut={onSignOut}
      />
      )}
      {fitted.listShown && (
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
        onPick={pick}
        onRowMenu={(uid) => void rowMenu(uid)}
        checked={checked}
        sidebarHidden={layout.sidebarHidden}
        onShowSidebar={toggleSidebar}
        onLoadMore={loadMore}
      />
      )}
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
        listHidden={!fitted.listShown}
        onShowList={() => (layout.listHidden ? toggleList() : setAssistantOpen(false))}
        inDrafts={inDrafts}
        onEditDraft={editDraft}
        bulk={
          checked.length > 1
            ? {
                count: checked.length,
                allRead: source.filter((m) => checked.includes(m.uid)).every((m) => m.seen),
                allFlagged: source.filter((m) => checked.includes(m.uid)).every((m) => m.flagged),
                onArchive: () => void move('archive'),
                onTrash: () => void move('trash'),
                onRead: (read) => void toggle('seen', read),
                onFlag: (flagged) => void toggle('flagged', flagged),
                onMove: () => openPalette('Move to '),
                onLabel: () => openPalette('Label as '),
                onClear: () => setChecked([]),
              }
            : undefined
        }
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
          contacts={contactList}
          onDraftSaved={() => {
            notify('Draft saved')
            if (inDrafts) void refreshList(current, false)
          }}
          onClose={() => setComposer(null)}
          onSent={() => {
            const wasDraft = composer.draft.draftUid !== undefined
            setComposer(null)
            notify('Sent')
            if (wasDraft && inDrafts) void refreshList(current, false)
            else if (detail) patchMessages([detail.uid], (m) => ({ ...m, answered: true }))
          }}
        />
      )}
      {paletteOpen && <Palette items={paletteItems()} initialQuery={paletteQuery} onClose={() => setPaletteOpen(false)} />}
      {!layout.sidebarHidden && (
        <Resizer
          at={fitted.sidebar}
          min={180}
          max={360}
          onResize={(w) => setLayout((l) => ({ ...l, sidebar: w }))}
          onCollapse={toggleSidebar}
          onReset={() => setLayout((l) => ({ ...l, sidebar: 228 }))}
        />
      )}
      {fitted.listShown && (
        <Resizer
          at={fitted.list}
          offset={layout.sidebarHidden ? 0 : fitted.sidebar}
          min={280}
          max={640}
          onResize={(w) => setLayout((l) => ({ ...l, list: w }))}
          onCollapse={toggleList}
          onReset={() => setLayout((l) => ({ ...l, list: 372 }))}
        />
      )}
      {assistantOpen && (
        <Resizer
          at={fitted.assistant}
          fromRight
          min={280}
          max={560}
          onResize={(w) => setLayout((l) => ({ ...l, assistant: w }))}
          onCollapse={() => setAssistantOpen(false)}
          onReset={() => setLayout((l) => ({ ...l, assistant: 340 }))}
        />
      )}
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

interface ResizerProps {
  /** Current width of the pane being resized. */
  at: number
  /** Left edge of that pane, when it is not the first column. */
  offset?: number
  /** The pane sits against the right edge (the assistant). */
  fromRight?: boolean
  min: number
  max: number
  onResize: (width: number) => void
  /** Dragging well past the minimum hides the pane. */
  onCollapse: () => void
  onReset: () => void
}

function Resizer({ at, offset = 0, fromRight, min, max, onResize, onCollapse, onReset }: ResizerProps) {
  const start = (e: React.MouseEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const move = (ev: MouseEvent) => {
      const width = at + (fromRight ? x0 - ev.clientX : ev.clientX - x0)
      if (width < min - 80) {
        stop()
        onCollapse()
        return
      }
      onResize(Math.min(max, Math.max(min, width)))
    }
    const stop = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
      document.body.classList.remove('resizing')
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
  }
  return (
    <div
      className="resizer"
      style={fromRight ? { right: at - 3 } : { left: offset + at - 3 }}
      onMouseDown={start}
      onDoubleClick={onReset}
      title="Drag to resize, double-click to reset"
    />
  )
}

/** Leading blank lines leave room to type above the signature. */
function signatureBlock(signature: string): string {
  return signature.trim() ? `\n\n${signature.trim()}` : ''
}

function prefix(tag: 'Re' | 'Fwd', subject: string): string {
  const pattern = tag === 'Re' ? /^re:/i : /^(fwd?|fw):/i
  return pattern.test(subject.trim()) ? subject : `${tag}: ${subject}`
}
