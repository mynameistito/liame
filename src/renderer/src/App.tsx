import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Draft,
  MailEvent,
  Mailbox,
  MessageContext,
  MessageDetail,
  MessageSummary,
  MenuItemSpec,
  MoveResult,
  MoveTarget,
  Prefs,
  AccountSummary,
  PublicSettings,
  ScheduledItem,
} from '../../shared/types'
import { COMMANDS, type CommandId, comboOf, formatCombo, isPlainKey, keymap, keysFor, toAccelerator } from './commands'
import { Assistant } from './components/Assistant'
import { Composer } from './components/Composer'
import { MessageList, type Filter } from './components/MessageList'
import { Palette, type PaletteItem } from './components/Palette'
import { Reader, type ReplyMode } from './components/Reader'
import { ScheduledList } from './components/ScheduledList'
import { Settings, type SettingsTab } from './components/Settings'
import { Setup } from './components/Setup'
import { Sidebar } from './components/Sidebar'
import { WhenPicker } from './components/WhenPicker'
import {
  AccountContext,
  api,
  classifyItem,
  type Contact,
  displayName,
  errorMessage,
  formatAddress,
  formatWhen,
  loadContacts,
  longDate,
  mailApi,
  rememberContacts,
  toContext,
  useAccount,
  usePersistent,
} from './lib'

/** The merged inbox of every account; not a real mailbox path. */
const UNIFIED = '\u0000all-inboxes'
/** Snoozes, queued sends, and reminders of every account; not a real mailbox path either. */
const SCHEDULED = '\u0000scheduled'

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
  conversations: true,
}

/** A message to show after switching to its account, e.g. from a notification click. */
interface OpenRequest {
  accountId: string
  mailbox: string
  uid?: number
  /** Distinguishes repeated clicks on the same message. */
  at: number
}

export function App() {
  const [accounts, setAccounts] = useState<AccountSummary[] | undefined>(undefined)
  const [activeId, setActiveId] = usePersistent('activeAccount', '')
  const [adding, setAdding] = useState(false)
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null)

  const reload = useCallback(() => api.listAccounts().then(setAccounts), [])
  useEffect(() => {
    const openMessage = (event: MailEvent | null) => {
      if (event?.type !== 'open-message' || !event.accountId) return
      setActiveId(event.accountId)
      setOpenRequest({ accountId: event.accountId, mailbox: event.mailbox ?? 'INBOX', uid: event.uid, at: Date.now() })
    }
    void reload()
    // A notification clicked while the window was closed is waiting in the main process.
    void api.takePendingOpen().then(openMessage)
    return api.onEvent((event) => {
      if (event.type === 'accounts-changed') void reload()
      openMessage(event)
    })
  }, [reload, setActiveId])

  const active = accounts?.find((a) => a.id === activeId) ?? accounts?.[0]
  const context = useMemo(() => (active ? { account: active, mail: mailApi(active.id) } : null), [active?.id])

  if (accounts === undefined) return null
  if (!active || !context || adding) {
    return (
      <Setup
        onDone={(account) => {
          setAdding(false)
          setActiveId(account.id)
          void reload()
        }}
        onCancel={active ? () => setAdding(false) : undefined}
      />
    )
  }
  return (
    <AccountContext.Provider value={{ ...context, account: active }}>
      <Mail
        // A fresh mount per account resets every list, selection and search.
        key={active.id}
        account={active}
        accounts={accounts}
        openRequest={openRequest?.accountId === active.id ? openRequest : null}
        onOpenHandled={() => setOpenRequest(null)}
        onSwitch={setActiveId}
        onAdd={() => setAdding(true)}
        onRemove={async (id) => {
          if (!(await api.removeAccount(id))) return
          if (id === active.id) setActiveId(accounts.find((a) => a.id !== id)?.id ?? '')
          void reload()
        }}
      />
    </AccountContext.Provider>
  )
}

interface MailProps {
  account: AccountSummary
  accounts: AccountSummary[]
  openRequest: OpenRequest | null
  /** Clears the request so a later remount of this account does not open it again. */
  onOpenHandled: () => void
  onSwitch: (id: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
}

function Mail({ account, accounts, openRequest, onOpenHandled, onSwitch, onAdd, onRemove }: MailProps) {
  const { mail } = useAccount()
  // In All Inboxes a message can belong to any account; its actions, replies, and AI run as that account.
  const contexts = useMemo(() => new Map(accounts.map((a) => [a.id, { account: a, mail: mailApi(a.id) }])), [accounts])
  const contextsRef = useRef(contexts)
  contextsRef.current = contexts
  const mailFor = (id: string) => contextsRef.current.get(id)?.mail ?? mail
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  /** Folders of the other accounts, for moving their messages out of All Inboxes. */
  const [otherBoxes, setOtherBoxes] = useState<Record<string, Mailbox[]>>({})
  const boxesOf = (id: string) => (id === account.id ? mailboxes : (otherBoxes[id] ?? []))
  const [current, setCurrent] = useState('')
  const [messages, setMessages] = useState<MessageSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  /** Key of the open message (see MessageSummary.key). */
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<MessageDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  /** The open conversation, oldest first, when it has more than the open message. */
  const [thread, setThread] = useState<MessageSummary[] | null>(null)
  /** Bodies of conversation messages the reader has expanded. */
  const [expanded, setExpanded] = useState<Record<string, MessageDetail | 'loading'>>({})
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageSummary[] | null>(null)
  const [searchRun, setSearchRun] = useState(0)
  const [searchState, setSearchState] = useState<'local' | 'server' | 'complete' | 'failed'>('complete')
  const [filter, setFilter] = useState<Filter>('all')
  const [composer, setComposer] = useState<{ account: string; draft: Draft; title: string; context?: MessageContext; autoDraft?: boolean } | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [briefRequest, setBriefRequest] = useState(0)
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [toast, setToast] = useState<{ text: string; undo?: boolean } | null>(null)
  /** One result per folder the last archive/delete touched, for undo. */
  const [lastMove, setLastMove] = useState<MoveResult[] | null>(null)
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([])
  const [whenPicker, setWhenPicker] = useState<{ title: string; onPick: (at: number) => void } | null>(null)
  const [darken, setDarken] = useState(true)
  const [imagesAllowed, setImagesAllowed] = useState<string | null>(null)
  /** Messages picked for a bulk action (⌘-click, ⇧-click, x). Empty means actions apply to the open message. */
  const [checked, setChecked] = useState<string[]>([])
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
  const autoReadRequest = useRef<number | null>(null)
  const loadingMore = useRef(false)
  const confirmingDelete = useRef(false)
  const classifying = useRef(new Set<string>())
  const mailboxesRef = useRef(mailboxes)
  mailboxesRef.current = mailboxes
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  /** A message to open once its mailbox has loaded (from a notification click). */
  const pendingOpen = useRef<{ path: string; uid: number } | null>(null)
  const focusSearch = useRef(false)
  const openRef = useRef<(key: string, row?: MessageSummary) => void>(() => {})

  const prefs = settings?.prefs ?? DEFAULT_PREFS
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const overrides = settings?.shortcuts ?? {}
  const hint = useCallback((id: CommandId) => (keysFor(id, overrides)[0] ? formatCombo(keysFor(id, overrides)[0]) : ''), [overrides])

  const box = mailboxes.find((b) => b.path === current)
  const source = results ?? messages
  const labelList = settings?.labels.list ?? []
  const labelMap = useMemo(() => new Map(labelList.map((l) => [l.id, l])), [labelList])
  const mailboxNames = useMemo(() => new Map(mailboxes.map((b) => [b.path, b.name])), [mailboxes])
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.email])), [accounts])
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
        if (filter === 'unread') return !m.seen || m.key === selected
        if (filter === 'flagged') return m.flagged
        return true
      }),
    [source, filter, selected, activeLabel],
  )
  const summary = source.find((m) => m.key === selected) ?? null
  const sourceRef = useRef(source)
  sourceRef.current = source
  const detailRef = useRef(detail)
  detailRef.current = detail

  const notify = useCallback((text: string, undo = false) => {
    const next = { text, undo }
    setToast(next)
    window.setTimeout(() => setToast((t) => (t === next ? null : t)), undo ? 6000 : 2600)
  }, [])

  const patchMessages = useCallback((keys: string[], patch: (m: MessageSummary) => MessageSummary) => {
    const apply = (list: MessageSummary[]) => list.map((m) => (keys.includes(m.key) ? patch(m) : m))
    setMessages(apply)
    setResults((r) => r && apply(r))
    setDetail((d) => (d && keys.includes(d.key) ? { ...d, ...patch(d) } : d))
  }, [])

  const refreshMailboxes = useCallback(async () => {
    try {
      const boxes = await mail.listMailboxes()
      setMailboxes(boxes)
      setCurrent((path) => path || boxes.find((b) => b.specialUse === 'inbox')?.path || boxes[0]?.path || '')
    } catch (err) {
      setListError(errorMessage(err))
    }
  }, [])

  /** Reloads the folder lists of the other accounts (or just `ids`), which All Inboxes needs for moving their mail. */
  const loadOtherBoxes = useCallback(
    (ids = [...contextsRef.current.keys()].filter((id) => id !== account.id)) => {
      for (const id of ids) {
        void api
          .listMailboxes(id)
          .then((boxes) => setOtherBoxes((all) => ({ ...all, [id]: boxes })))
          .catch(() => {})
      }
    },
    [account.id],
  )

  /** All Inboxes syncs every account's inbox; a folder syncs itself. */
  const syncView = (path: string) => (path === SCHEDULED ? Promise.resolve() : path === UNIFIED ? api.syncInboxes() : mail.sync(path))

  /** Conversations group every folder but Drafts, where each draft stands alone. */
  const threadedFor = (path: string) => prefsRef.current.conversations && mailboxesRef.current.find((b) => b.path === path)?.specialUse !== 'drafts'

  /** Rereads the local copy, keeping as many rows as are loaded. Labels the renderer already knows survive. */
  const refreshList = useCallback(
    async (path: string, reset: boolean) => {
      if (!path || path === SCHEDULED) return
      if (reset) {
        setMessages([])
        setLoading(true)
      }
      setListError('')
      try {
        const loaded = reset ? 0 : messagesRef.current.length
        const limit = Math.max(50, loaded)
        const page = path === UNIFIED ? await api.listUnified(0, limit, prefsRef.current.conversations) : await mail.listMessages(path, 0, limit, threadedFor(path))
        if (currentRef.current !== path) return
        setMessages((old) => {
          const labels = new Map(old.map((m) => [m.key, m.label]))
          return page.messages.map((m) => ({ ...m, label: labels.get(m.key) }))
        })
        setHasMore(page.hasMore)
        // A new message in a conversation gives its row a new key; follow the conversation, not the old key.
        const keys = new Set(page.messages.map((m) => m.key))
        const byThread = (key: string) => {
          const thread = messagesRef.current.find((m) => m.key === key)?.thread
          return thread ? page.messages.find((m) => m.thread === thread)?.key : undefined
        }
        const open = selectedRef.current
        if (open && !keys.has(open)) {
          const next = byThread(open)
          if (next) openRef.current(next, page.messages.find((m) => m.key === next))
        } else if (open) {
          // Same row, but the conversation may have grown (a reply landed in Sent): reread it.
          const row = page.messages.find((m) => m.key === open)
          if (row?.thread) {
            void mailFor(row.account).getThread(row.thread).then((conversation) => {
              if (selectedRef.current === row.key) setThread(conversation.length > 1 ? conversation : null)
            })
          }
        }
        setChecked((list) => list.map((key) => (keys.has(key) ? key : (byThread(key) ?? key))))
        setContacts(rememberContacts(page.messages.flatMap((m) => [m.from, ...m.to]), account.email))
        if (pendingOpen.current?.path === path) {
          // The new rows are not rendered yet, so hand open() the row itself. A message outside this page
          // (older, or not cached yet) still opens from its folder and UID.
          const { uid } = pendingOpen.current
          const key = `${account.id}/${path}/${uid}`
          openRef.current(key, page.messages.find((m) => m.key === key) ?? stubRow(account.id, path, uid))
          pendingOpen.current = null
        }
      } catch (err) {
        setListError(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [account.email, account.id],
  )
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore.current || results) return
    loadingMore.current = true
    const path = current
    try {
      const offset = messagesRef.current.length
      const page = path === UNIFIED ? await api.listUnified(offset, 50, prefsRef.current.conversations) : await mail.listMessages(path, offset, undefined, threadedFor(path))
      if (currentRef.current !== path) return
      setMessages((old) => [...old, ...page.messages.filter((m) => !old.some((o) => o.key === m.key))])
      setHasMore(page.hasMore)
    } catch (err) {
      notify(errorMessage(err))
    } finally {
      loadingMore.current = false
    }
  }, [current, hasMore, results, notify])

  const loadScheduled = useCallback(() => void api.listScheduled().then(setScheduled).catch(() => {}), [])

  // Mailboxes and settings on start, then the selected mailbox whenever it changes.
  useEffect(() => {
    void refreshMailboxes()
    void api.getSettings().then(setSettings)
    loadScheduled()
  }, [refreshMailboxes, loadScheduled])

  // Label inbox mail in the background once its preview is known. Stored labels come back instantly;
  // only new messages reach the decision model.
  useEffect(() => {
    if ((box?.specialUse !== 'inbox' && current !== UNIFIED) || !settings) return
    const pending = messages.filter((m) => m.label === undefined && m.preview !== undefined && !classifying.current.has(m.key))
    if (pending.length === 0) return
    pending.forEach((m) => classifying.current.add(m.key))
    const path = current
    api
      .classify(pending.map(classifyItem))
      .then((labels) => {
        if (currentRef.current !== path) return
        const apply = (list: MessageSummary[]) => list.map((m) => (m.key in labels ? { ...m, label: labels[m.key] } : m))
        setMessages(apply)
        setResults((r) => r && apply(r))
      })
      .catch(() => pending.forEach((m) => classifying.current.delete(m.key)))
  }, [messages, box?.specialUse, current, settings])

  // A mailbox opens from the local copy at once, then syncs with the server in the background.
  useEffect(() => {
    setSelected(null)
    setChecked([])
    setDetail(null)
    setQuery('')
    setResults(null)
    if (current === SCHEDULED) {
      setMessages([])
      setHasMore(false)
      return
    }
    if (!current) return
    void refreshList(current, true).then(() => syncView(current).catch((err) => setListError(errorMessage(err))))
  }, [current, refreshList])

  // Server push and finished syncs update the open list; returning to the window checks the server again.
  // Notifications are shown by the main process for every account.
  useEffect(() => {
    const off = api.onEvent((event) => {
      if (event.type === 'scheduled-changed') return void loadScheduled()
      // Moves and syncs change where snoozed and reminded messages are, and whether a snooze still holds any.
      if (event.type === 'mailboxes-changed' || event.type === 'mailbox-synced') loadScheduled()
      if (currentRef.current === UNIFIED && event.type === 'mailbox-synced') return void refreshList(UNIFIED, false)
      if (event.accountId !== account.id) {
        if (currentRef.current === UNIFIED && event.type === 'mailboxes-changed' && event.accountId) loadOtherBoxes([event.accountId])
        return
      }
      if (event.type === 'new-mail' || event.type === 'mailboxes-changed') void refreshMailboxes()
      // Conversation rows draw on other folders (a reply lands in Sent), so any finished sync rereads the open list.
      if (event.type === 'mailbox-synced' && (currentRef.current === event.mailbox || threadedFor(currentRef.current))) {
        void refreshList(currentRef.current, false)
      }
    })
    const onFocus = () => {
      void refreshMailboxes()
      if (currentRef.current === UNIFIED) loadOtherBoxes()
      if (currentRef.current) void syncView(currentRef.current).catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [account.id, refreshMailboxes, refreshList, loadOtherBoxes, loadScheduled])

  // A clicked notification: clear anything that could hide the message, then open it once its mailbox loads.
  useEffect(() => {
    if (!openRequest || !mailboxes.length) return
    const target = mailboxes.find((b) => b.path.toUpperCase() === openRequest.mailbox.toUpperCase())
    if (!target) return
    setActiveLabel(null)
    setFilter('all')
    setQuery('')
    setResults(null)
    setChecked([])
    if (openRequest.uid !== undefined) pendingOpen.current = { path: target.path, uid: openRequest.uid }
    if (currentRef.current === target.path) void mail.sync(target.path).then(() => refreshList(target.path, false))
    else setCurrent(target.path)
    onOpenHandled()
    // Each request runs once; `at` changes for every new click.
  }, [openRequest?.at, mailboxes.length > 0])

  // Search: instant results from the local copy of every folder, then the server's body-text matches in this one.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearchState('complete')
      return
    }
    const path = current
    setSearchState('local')
    setListError('')
    let stale = false
    let remoteTimer: number | undefined
    const timer = window.setTimeout(async () => {
      try {
        const local = path === UNIFIED ? await api.searchLocal(accounts.map((a) => a.id), q) : await mail.searchLocal(q)
        if (stale || currentRef.current !== path) return
        setResults(local)
        // The server can only search one folder; All Inboxes stays with the local results.
        if (path === UNIFIED) {
          setSearchState('complete')
          return
        }
        setSearchState('server')
        // Show cheap local matches early without issuing more IMAP searches while typing.
        remoteTimer = window.setTimeout(async () => {
          try {
            const remote = await mail.search(path, q)
            if (stale || currentRef.current !== path) return
            const known = new Set(local.map((m) => m.key))
            setResults([...local, ...remote.filter((m) => !known.has(m.key))].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)))
            setSearchState('complete')
          } catch (err) {
            if (!stale && currentRef.current === path) {
              setSearchState('failed')
              setListError(errorMessage(err))
            }
          }
        }, 140)
      } catch (err) {
        if (!stale && currentRef.current === path) {
          setSearchState('failed')
          setListError(errorMessage(err))
        }
      }
    }, 60)
    return () => {
      stale = true
      window.clearTimeout(timer)
      window.clearTimeout(remoteTimer)
    }
  }, [query, current, searchRun])

  const open = useCallback(
    async (key: string, row?: MessageSummary) => {
      setSelected(key)
      if (detail?.key === key) return
      const target = sourceRef.current.find((m) => m.key === key) ?? row
      if (!target) return
      const request = ++detailRequest.current
      autoReadRequest.current = request
      setDetail(null)
      setThread(null)
      setExpanded({})
      setDetailError('')
      setDetailLoading(true)
      setDarken(prefsRef.current.darkenEmails)
      setImagesAllowed(null)
      try {
        const [message, conversation] = await Promise.all([
          mailFor(target.account).getMessage(target.mailbox, target.uid),
          // A local read; the row's count can lag behind a folder that synced after it was listed.
          target.thread ? mailFor(target.account).getThread(target.thread) : Promise.resolve(null),
        ])
        if (request !== detailRequest.current) return
        setDetail(message)
        setThread(conversation && conversation.length > 1 ? conversation : null)
        const { markRead } = prefsRef.current
        if (markRead !== 'never') {
          if (markRead === 'delay') {
            await new Promise((resolve) => window.setTimeout(resolve, 2000))
            // Only count it as read if it is still the open message.
            if (selectedRef.current !== key || request !== detailRequest.current) return
          }
          // Explicit read/unread actions take precedence over this open's automatic write.
          if (autoReadRequest.current !== request) return
          // Validate the displayed UID generation before changing either server or local flags.
          await mailFor(target.account).setFlags(target.mailbox, target.threadUids ?? [target.uid], { seen: true }, message.uidValidity)
          if (selectedRef.current !== key || request !== detailRequest.current || autoReadRequest.current !== request) return
          // A manual action or sync may have marked it read while the server write was pending.
          const latest = sourceRef.current.find((m) => m.key === key) ?? (detailRef.current?.key === key ? detailRef.current : message)
          if (!latest.seen) {
            patchMessages([key], (m) => ({ ...m, seen: true }))
            if (target.account === account.id)
              setMailboxes((boxes) => boxes.map((b) => (b.path === target.mailbox ? { ...b, unread: Math.max(0, b.unread - 1) } : b)))
          }
        }
      } catch (err) {
        if (request === detailRequest.current) setDetailError(errorMessage(err))
      } finally {
        if (request === detailRequest.current) setDetailLoading(false)
      }
    },
    [detail, patchMessages],
  )
  openRef.current = (key, row) => void open(key, row)

  /** What actions apply to: the picked messages, or else the open one. */
  const targets = useMemo(() => (checked.length > 1 ? checked : selected !== null ? [selected] : []), [checked, selected])

  /** Click handling for rows: plain opens, ⌘ toggles a pick, ⇧ picks a range from the open message. */
  const pick = useCallback(
    (key: string, mods: { meta: boolean; shift: boolean }) => {
      if (mods.shift && selected !== null) {
        const a = visible.findIndex((m) => m.key === selected)
        const b = visible.findIndex((m) => m.key === key)
        if (a !== -1 && b !== -1) setChecked(visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.key))
        return
      }
      if (mods.meta) {
        const base = checked.length === 0 && selected !== null && selected !== key ? [selected] : checked
        const next = base.includes(key) ? base.filter((x) => x !== key) : [...base, key]
        // A single remaining pick is just the open message.
        if (next.length === 1) {
          setChecked([])
          void open(next[0])
        } else setChecked(next)
        return
      }
      setChecked([])
      void open(key)
    },
    [selected, visible, checked, open],
  )

  const step = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const index = visible.findIndex((m) => m.key === selected)
      const next = visible[Math.min(visible.length - 1, Math.max(0, index === -1 ? 0 : index + delta))]
      if (next) void open(next.key)
    },
    [visible, selected, open],
  )

  /** UIDs to act on, grouped by account and folder (the server acts per folder). A conversation row stands for all its messages there. */
  const byMailbox = (keys: string[]) => {
    const groups = new Map<string, { account: string; mailbox: string; uids: number[] }>()
    for (const m of rowsFor(keys)) {
      const id = `${m.account}/${m.mailbox}`
      const group = groups.get(id) ?? { account: m.account, mailbox: m.mailbox, uids: [] }
      group.uids.push(...(m.threadUids ?? [m.uid]))
      groups.set(id, group)
    }
    return [...groups.values()]
  }

  /** List rows for the keys, plus the open message when it has no list row (opened from a notification). */
  const rowsFor = (keys: string[]) => {
    const rows = sourceRef.current.filter((m) => keys.includes(m.key))
    const open = detailRef.current
    if (open && keys.includes(open.key) && !rows.some((m) => m.key === open.key)) rows.push(open)
    return rows
  }

  /** Folders the messages can move to: their account's, other than the one they are all in. None when they span accounts. */
  useEffect(() => {
    if (current === UNIFIED) loadOtherBoxes()
  }, [current, accounts.length, account.id])

  const foldersFor = (keys: string[]) => {
    const rows = rowsFor(keys)
    const ids = new Set(rows.map((m) => m.account))
    if (ids.size !== 1) return []
    const sources = new Set(rows.map((m) => m.mailbox))
    return boxesOf(rows[0].account).filter((b) => !(sources.size === 1 && sources.has(b.path)))
  }

  const move = useCallback(
    async (target: MoveTarget, keys: string[] = targets) => {
      if (keys.length === 0 || confirmingDelete.current) return
      const gone = new Set(keys)
      const groups = byMailbox(keys)
      let permanentCount = 0
      if (target === 'trash') {
        confirmingDelete.current = true
        try {
          // Search can include Trash even when another folder is open. Resolve missing account folders before deciding.
          const boxes = new Map(await Promise.all([...new Set(groups.map((g) => g.account))].map(async (id) =>
            [id, boxesOf(id).length ? boxesOf(id) : await mailFor(id).listMailboxes()] as const,
          )))
          permanentCount = groups.reduce((total, g) => total + (boxes.get(g.account)?.find((b) => b.path === g.mailbox)?.specialUse === 'trash' ? new Set(g.uids).size : 0), 0)
          if (permanentCount > 0 && !(await api.confirmPermanentDelete(permanentCount))) return
        } catch (err) {
          notify(errorMessage(err))
          return
        } finally {
          confirmingDelete.current = false
        }
      }
      const { afterMove } = prefsRef.current
      // The neighbour is found among what stays, next to the open message (or the first picked one).
      const anchor = visible.findIndex((m) => m.key === (selected !== null && gone.has(selected) ? selected : keys[0]))
      const after = visible.slice(anchor + 1).find((m) => !gone.has(m.key))
      const before = visible.slice(0, Math.max(0, anchor)).reverse().find((m) => !gone.has(m.key))
      const neighbour = afterMove === 'none' ? undefined : afterMove === 'previous' ? (before ?? after) : (after ?? before)
      const openGone = selected === null || gone.has(selected)
      setMessages((list) => list.filter((m) => !gone.has(m.key)))
      setResults((r) => r && r.filter((m) => !gone.has(m.key)))
      setChecked([])
      if (openGone) {
        setDetail(null)
        if (neighbour) void open(neighbour.key)
        else setSelected(null)
      }
      try {
        const moved: MoveResult[] = []
        for (const group of groups) {
          const result = await mailFor(group.account).move(group.mailbox, group.uids, target)
          if (result) moved.push(result)
        }
        // Undo only when every folder's move can be reversed exactly.
        setLastMove(moved.length === groups.length ? moved : null)
        // Snoozing again from the Snoozed folder leaves the messages where they are.
        if (typeof target === 'object' && 'snooze' in target) void refreshList(current, false)
        if (permanentCount > 0) {
          const movedCount = groups.reduce((total, g) => total + new Set(g.uids).size, 0) - permanentCount
          notify(`${permanentCount} ${permanentCount === 1 ? 'message' : 'messages'} permanently deleted${movedCount ? `; ${movedCount} moved to Trash` : ''}`)
          return
        }
        const where =
          typeof target === 'string' || !('path' in target) ? '' : (boxesOf(groups[0].account).find((b) => b.path === target.path)?.name ?? target.path)
        const verb = typeof target === 'object' && 'snooze' in target
            ? `snoozed until ${formatWhen(target.snooze)}`
            : target === 'archive'
            ? 'archived'
            : target === 'trash'
              ? 'moved to Trash'
              : target === 'junk'
                ? 'marked as junk'
                : `moved to ${where}`
        const text = keys.length > 1 ? `${keys.length} messages ${verb}` : verb.charAt(0).toUpperCase() + verb.slice(1)
        notify(text, moved.length === groups.length && moved.length > 0)
      } catch (err) {
        notify(errorMessage(err))
        void refreshList(current, false)
      }
    },
    [targets, selected, visible, current, mailboxes, otherBoxes, open, notify, refreshList],
  )

  const undo = useCallback(async () => {
    if (!lastMove) return
    const moves = lastMove
    setLastMove(null)
    try {
      for (const move of moves) await mailFor(move.account).undoMove(move)
      notify('Moved back')
      const gone = new Set(moves.flatMap((move) => move.uids.map((uid) => `${move.account}/${move.to}/${uid}`)))
      // The moved copies are gone from where they went; drop them rather than wait for the next sync.
      setMessages((list) => list.filter((m) => !gone.has(m.key)))
      setResults((r) => r && r.filter((m) => !gone.has(m.key)))
      if (selectedRef.current !== null && gone.has(selectedRef.current)) setSelected(null)
      if (moves.some((move) => move.from === currentRef.current)) void refreshList(currentRef.current, false)
      setSearchRun((n) => n + 1)
    } catch (err) {
      notify(errorMessage(err))
    }
  }, [lastMove, notify, refreshList, account.id])

  /** Set a flag on the targets; with no value given, flips it (set unless all already have it). */
  const toggle = useCallback(
    async (flag: 'seen' | 'flagged', force?: boolean, keys: string[] = targets) => {
      const list = rowsFor(keys)
      if (list.length === 0) return
      const value = force ?? !list.every((m) => m[flag])
      if (flag === 'seen' && !value && keys.includes(selectedRef.current!)) autoReadRequest.current = null
      const changed = list.filter((m) => m[flag] !== value)
      if (changed.length === 0) return
      patchMessages(
        changed.map((m) => m.key),
        (x) => ({ ...x, [flag]: value }),
      )
      const groups = byMailbox(changed.map((m) => m.key))
      if (flag === 'seen') {
        const here = (path: string) => groups.find((g) => g.account === account.id && g.mailbox === path)?.uids.length ?? 0
        setMailboxes((boxes) => boxes.map((b) => (here(b.path) ? { ...b, unread: Math.max(0, b.unread + (value ? -1 : 1) * here(b.path)) } : b)))
      }
      try {
        for (const group of groups) await mailFor(group.account).setFlags(group.mailbox, group.uids, { [flag]: value })
      } catch (err) {
        notify(errorMessage(err))
      }
    },
    [source, targets, patchMessages, notify],
  )

  const markAllRead = useCallback(async () => {
    const path = current
    const unified = path === UNIFIED
    patchMessages(
      // In All Inboxes only the inboxes are marked, not search results from other folders.
      [...messages, ...(results ?? [])].filter((m) => !m.seen && (unified ? m.mailbox.toUpperCase() === 'INBOX' : m.mailbox === path)).map((m) => m.key),
      (m) => ({ ...m, seen: true }),
    )
    setMailboxes((boxes) => boxes.map((b) => (b.path === path || (unified && b.specialUse === 'inbox') ? { ...b, unread: 0 } : b)))
    try {
      if (unified) await api.markAllInboxesRead()
      else await mail.markAllRead(path)
      notify('Marked all as read')
    } catch (err) {
      notify(errorMessage(err))
      void refreshList(path, false)
    }
  }, [current, messages, results, patchMessages, notify, refreshList])

  const reply = useCallback(
    (mode: ReplyMode, ai?: { autoDraft?: boolean; text?: string }) => {
      if (!detail) return
      const from = contextsRef.current.get(detail.account)?.account ?? account
      const draft = buildReply(detail, mode, from.email)
      draft.text = `${signatureBlock(prefsRef.current.signature)}${draft.text}`
      if (ai?.text) draft.text = `${ai.text.trim()}${draft.text}`
      setComposer({
        account: from.id,
        draft,
        title: mode === 'forward' ? 'Forward' : 'Reply',
        context: mode === 'forward' ? undefined : toContext(detail),
        autoDraft: ai?.autoDraft,
      })
    },
    [detail, account.email],
  )

  const setLabel = useCallback(
    (label: string | null, keys: string[] = targets) => {
      const list = rowsFor(keys)
      if (list.length === 0) return
      patchMessages(
        list.map((m) => m.key),
        (x) => ({ ...x, label }),
      )
      for (const m of list) void api.setLabel(classifyItem(m), label)
    },
    [source, targets, patchMessages],
  )

  const toggleExpanded = useCallback(async (key: string) => {
    const m = thread?.find((x) => x.key === key)
    if (!m) return
    if (expanded[key]) {
      setExpanded(({ [key]: _gone, ...rest }) => rest)
      return
    }
    setExpanded((e) => ({ ...e, [key]: 'loading' }))
    try {
      const message = await mailFor(m.account).getMessage(m.mailbox, m.uid)
      setExpanded((e) => (key in e ? { ...e, [key]: message } : e))
    } catch (err) {
      setExpanded(({ [key]: _gone, ...rest }) => rest)
      notify(errorMessage(err))
    }
  }, [thread, expanded, notify])

  const editDraft = useCallback(() => {
    if (!detail || detail.mailbox !== mailboxes.find((b) => b.specialUse === 'drafts')?.path) return
    setComposer({
      account: detail.account,
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
  }, [detail, mailboxes])

  const compose = useCallback(
    () => setComposer({ account: account.id, draft: { ...EMPTY_DRAFT, text: signatureBlock(prefsRef.current.signature) }, title: 'New message' }),
    [account.id],
  )

  const hasTargets = targets.length > 0
  const hasDetail = detail !== null && detail.key === selected
  const single = checked.length <= 1
  const draftsPath = mailboxes.find((b) => b.specialUse === 'drafts')?.path
  // Whether the open message is a draft depends on its own folder, not the folder being viewed.
  const inDrafts = Boolean(detail && draftsPath && detail.mailbox === draftsPath)
  const toggleSidebar = () => setLayout((l) => ({ ...l, sidebarHidden: !l.sidebarHidden }))
  const toggleList = () => setLayout((l) => ({ ...l, listHidden: !l.listHidden }))
  const openPalette = (query = '') => (setPaletteQuery(query), setPaletteOpen(true))
  const snooze = (keys = targets) => setWhenPicker({ title: 'Snooze until', onPick: (at) => void move({ snooze: at }, keys) })
  function remindMe() {
    if (!detail) return
    const { account: id, mailbox, uid } = detail
    setWhenPicker({
      title: 'Remind me if no reply by',
      onPick: (at) =>
        void mailFor(id)
          .remind(mailbox, uid, at)
          .then(() => notify(`Reminder set for ${formatWhen(at)}`))
          .catch((err) => notify(errorMessage(err))),
    })
  }
  const openScheduled = (item: ScheduledItem) => {
    if (!item.mailbox || item.uid === undefined) return
    const row = stubRow(item.account, item.mailbox, item.uid)
    void open(row.key, row)
  }
  async function cancelScheduled(item: ScheduledItem) {
    try {
      const result = await api.cancelScheduled(item.id)
      if (result) {
        setComposer({ account: result.account, draft: result.draft, title: 'Edit scheduled message' })
        notify('Moved to Drafts')
      }
      else notify(item.kind === 'snooze' ? 'Moved back' : 'Reminder dismissed')
    } catch (err) {
      notify(errorMessage(err))
    }
  }
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
    moveTo: { run: () => openPalette('Move to '), enabled: hasTargets && foldersFor(targets).length > 0 },
    snooze: { run: () => snooze(), enabled: hasTargets },
    remindMe: { run: remindMe, enabled: hasDetail && single },
    labelAs: { run: () => openPalette('Label as '), enabled: hasTargets && labelList.length > 0 },
    undo: { run: () => void undo(), enabled: lastMove !== null },
    toggleRead: { run: () => void toggle('seen'), enabled: hasTargets },
    toggleFlag: { run: () => void toggle('flagged'), enabled: hasTargets },
    toggleSelect: {
      run: () => selected !== null && setChecked((list) => (list.includes(selected) ? list.filter((x) => x !== selected) : [...list, selected])),
      enabled: selected !== null,
    },
    selectAll: { run: () => setChecked(visible.map((m) => m.key)), enabled: visible.length > 0 },
    clearSelection: { run: () => setChecked([]), enabled: checked.length > 0 },
    markAllRead: {
      run: () => void markAllRead(),
      enabled: (current === UNIFIED ? accounts.some((a) => a.unread > 0) : (box?.unread ?? 0) > 0) || messages.some((m) => !m.seen),
    },
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
        if (layout.listHidden) toggleList()
        // Close the assistant when the list would still not fit next to it, even at minimum widths.
        if (assistantOpen && windowWidth < (layout.sidebarHidden ? 0 : 180) + 280 + 280 + 360) setAssistantOpen(false)
      },
    },
    filterAll: { run: () => setFilter('all') },
    filterUnread: { run: () => setFilter('unread') },
    filterFlagged: { run: () => setFilter('flagged') },
    toggleDarken: { run: () => setDarken((d) => !d), enabled: Boolean(hasDetail && detail?.html) },
    loadImages: { run: () => setImagesAllowed(selected), enabled: Boolean(hasDetail && detail?.html && !prefs.remoteImages) },
    nextAccount: {
      run: () => onSwitch(accounts[(accounts.findIndex((a) => a.id === account.id) + 1) % accounts.length].id),
      enabled: accounts.length > 1,
    },
    toggleSidebar: { run: toggleSidebar },
    toggleList: { run: toggleList },
    assistant: { run: () => setAssistantOpen((open) => !open) },
    brief: { run: () => (setAssistantOpen(true), setBriefRequest(Date.now())) },
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
      if (composer || settingsTab || paletteOpen || whenPicker) return
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
  }, [composer, settingsTab, paletteOpen, whenPicker, mainKeys])

  const paletteItems = (): PaletteItem[] => [
    ...COMMANDS.filter((c) => !c.composer && c.id !== 'palette').map((c) => {
      const command = commands[c.id as keyof typeof commands]
      const deleting = c.id === 'trash' && rowsFor(targets).some((m) => boxesOf(m.account).find((b) => b.path === m.mailbox)?.specialUse === 'trash')
      return { id: c.id, title: deleting ? 'Delete permanently…' : c.title, group: c.group, hint: hint(c.id), disabled: command.enabled === false, run: command.run }
    }),
    ...accounts
      .filter((a) => a.id !== account.id)
      .map((a) => ({ id: `account:${a.id}`, title: `Switch to ${a.email}`, group: 'Accounts', run: () => onSwitch(a.id) })),
    ...(accounts.length > 1 ? [{ id: 'box:unified', title: 'Go to All Inboxes', group: 'Mailboxes', run: () => (setActiveLabel(null), setCurrent(UNIFIED)) }] : []),
    ...(scheduled.length ? [{ id: 'box:scheduled', title: 'Go to Scheduled', group: 'Mailboxes', run: () => (setActiveLabel(null), setCurrent(SCHEDULED)) }] : []),
    ...mailboxes.map((b) => ({
      id: `box:${b.path}`,
      title: `Go to ${b.path.toUpperCase() === 'INBOX' ? 'Inbox' : b.path}`,
      group: 'Mailboxes',
      run: () => (setActiveLabel(null), setCurrent(b.path)),
    })),
    ...(hasTargets
      ? foldersFor(targets).map((b) => ({ id: `move:${b.path}`, title: `Move to ${b.path.toUpperCase() === 'INBOX' ? 'Inbox' : b.path}`, group: 'Move', run: () => void move({ path: b.path }) }))
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
  const rowMenu = async (key: string) => {
    const inSelection = targets.includes(key)
    if (!inSelection) {
      setChecked([])
      void open(key)
    }
    const keys = inSelection ? targets : [key]
    const list = source.filter((m) => keys.includes(m.key))
    const many = keys.length > 1
    const acc = (id: CommandId) => toAccelerator(keysFor(id, overrides)[0])
    const items: MenuItemSpec[] = [
      ...(many
        ? [{ label: `${keys.length} messages selected`, enabled: false }]
        : [
            // Replies need the loaded message, which only the already-open row has.
            { id: 'reply', label: 'Reply', accelerator: acc('reply'), enabled: hasDetail && detail?.key === key },
            { id: 'replyAll', label: 'Reply All', accelerator: acc('replyAll'), enabled: hasDetail && detail?.key === key },
            { id: 'forward', label: 'Forward', accelerator: acc('forward'), enabled: hasDetail && detail?.key === key },
            { id: 'draftReply', label: 'Draft Reply with AI', accelerator: acc('draftReply'), enabled: hasDetail && detail?.key === key },
          ]),
      { separator: true },
      { id: 'archive', label: 'Archive', accelerator: acc('archive') },
      { id: 'trash', label: list.some((m) => boxesOf(m.account).find((b) => b.path === m.mailbox)?.specialUse === 'trash') ? 'Delete Permanently…' : 'Move to Trash', accelerator: acc('trash') },
      { id: 'junk', label: 'Mark as Junk', accelerator: acc('junk'), enabled: box?.specialUse !== 'junk' },
      { id: 'snooze', label: 'Snooze…', accelerator: acc('snooze') },
      { label: 'Move To', enabled: foldersFor(keys).length > 0, submenu: foldersFor(keys).map((b) => ({ id: `move:${b.path}`, label: b.path.toUpperCase() === 'INBOX' ? 'Inbox' : b.path })) },
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
    else if (chosen === 'archive' || chosen === 'trash' || chosen === 'junk') void move(chosen, keys)
    else if (chosen === 'snooze') snooze(keys)
    else if (chosen.startsWith('move:')) void move({ path: chosen.slice(5) }, keys)
    else if (chosen === 'read') void toggle('seen', undefined, keys)
    else if (chosen === 'flag') void toggle('flagged', undefined, keys)
    else if (chosen.startsWith('label:')) setLabel(chosen.slice(6) || null, keys)
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
      (layout.sidebarHidden ? 0 : layout.sidebar) + (layout.listHidden ? 0 : layout.list) + (assistantOpen ? layout.assistant : 0) + 420 - windowWidth
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
    // Sync brings in server changes; its 'mailbox-synced' event rereads the list.
    await Promise.all([refreshMailboxes(), syncView(current).catch((err) => setListError(errorMessage(err)))])
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
        status={account.status}
        accounts={accounts}
        activeAccount={account.id}
        onSwitchAccount={onSwitch}
        onAddAccount={onAdd}
        onRemoveAccount={onRemove}
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
        unified={accounts.length > 1 ? { active: current === UNIFIED, unread: accounts.reduce((n, a) => n + a.unread, 0) } : null}
        onUnified={() => (setActiveLabel(null), setCurrent(UNIFIED))}
        scheduled={
          scheduled.length ? { active: current === SCHEDULED, total: scheduled.length, due: scheduled.filter((item) => item.fired).length } : null
        }
        onScheduled={() => (setActiveLabel(null), setCurrent(SCHEDULED))}
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
      />
      )}
      {fitted.listShown && current === SCHEDULED && (
        <ScheduledList
          items={scheduled}
          selected={scheduled.find((item) => item.mailbox && stubRow(item.account, item.mailbox, item.uid ?? 0).key === selected)?.id ?? null}
          accountNames={accounts.length > 1 ? accountNames : undefined}
          sidebarHidden={layout.sidebarHidden}
          onShowSidebar={toggleSidebar}
          onOpen={openScheduled}
          onCancel={(item) => void cancelScheduled(item)}
        />
      )}
      {fitted.listShown && current !== SCHEDULED && (
      <MessageList
        listRef={listRef}
        searchRef={searchRef}
        title={current === UNIFIED ? 'All Inboxes' : (activeLabel && labelMap.get(activeLabel)?.name) || box?.name || ''}
        labels={labelMap}
        mailbox={current}
        mailboxNames={mailboxNames}
        accountNames={current === UNIFIED ? accountNames : undefined}
        unread={box?.specialUse === 'inbox' ? box.unread : 0}
        messages={visible}
        selected={selected}
        loading={loading}
        error={listError}
        query={query}
        searchState={searchState}
        searchScope={current === UNIFIED ? 'All accounts · cached mail only' : `All cached folders · server: ${box?.name || current}`}
        localSearchOnly={current === UNIFIED}
        filter={filter}
        hasMore={!results && hasMore}
        showRecipient={box?.specialUse === 'sent' || box?.specialUse === 'drafts'}
        onQuery={setQuery}
        onFilter={setFilter}
        onPick={pick}
        onRowMenu={(key) => void rowMenu(key)}
        checked={checked}
        sidebarHidden={layout.sidebarHidden}
        onShowSidebar={toggleSidebar}
        onLoadMore={loadMore}
      />
      )}
      <AccountContext.Provider value={contexts.get(detail?.account ?? summary?.account ?? account.id) ?? { account, mail }}>
      <Reader
        // A message opened from outside the list (a notification for an older message) still shows.
        summary={summary ?? (detail?.key === selected ? detail : null)}
        detail={detail?.key === selected ? detail : null}
        loading={detailLoading}
        error={detailError}
        mailbox={current}
        inTrash={rowsFor(targets).some((m) => boxesOf(m.account).find((b) => b.path === m.mailbox)?.specialUse === 'trash')}
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
        onSnooze={() => snooze()}
        onRemind={remindMe}
        onToggleSeen={() => void toggle('seen')}
        onToggleFlag={() => void toggle('flagged')}
        listHidden={!fitted.listShown}
        onShowList={() => (layout.listHidden ? toggleList() : setAssistantOpen(false))}
        inDrafts={inDrafts}
        onEditDraft={editDraft}
        thread={detail?.key === selected ? thread : null}
        expanded={expanded}
        onToggleMessage={(key) => void toggleExpanded(key)}
        bulk={
          checked.length > 1
            ? {
                count: checked.length,
                allRead: source.filter((m) => checked.includes(m.key)).every((m) => m.seen),
                allFlagged: source.filter((m) => checked.includes(m.key)).every((m) => m.flagged),
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
      </AccountContext.Provider>
      {assistantOpen && (
        <AccountContext.Provider value={contexts.get(detail?.account ?? account.id) ?? { account, mail }}>
        <Assistant
          message={detail?.key === selected ? detail : null}
          onClose={() => setAssistantOpen(false)}
          closeHint={hint('assistant')}
          onUseAsReply={(text) => reply('reply', { text })}
          briefRequest={briefRequest}
          onBriefStarted={() => setBriefRequest(0)}
        />
        </AccountContext.Provider>
      )}
      {composer && (
        <AccountContext.Provider value={contexts.get(composer.account) ?? { account, mail }}>
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
            if (box?.specialUse === 'drafts') void refreshList(current, false)
          }}
          onClose={() => setComposer(null)}
          onSent={(at) => {
            const wasDraft = composer.draft.draftUid !== undefined
            setComposer(null)
            notify(at ? `Scheduled for ${formatWhen(at)}` : 'Sent')
            if (wasDraft && box?.specialUse === 'drafts') void refreshList(current, false)
            else if (detail) patchMessages([detail.key], (m) => ({ ...m, answered: true }))
          }}
        />
        </AccountContext.Provider>
      )}
      {paletteOpen && <Palette items={paletteItems()} initialQuery={paletteQuery} onClose={() => setPaletteOpen(false)} />}
      {whenPicker && <WhenPicker title={whenPicker.title} onPick={whenPicker.onPick} onClose={() => setWhenPicker(null)} />}
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
            if (next.prefs.conversations !== prefsRef.current.conversations) {
              prefsRef.current = next.prefs
              void refreshList(currentRef.current, true)
            }
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

/** Enough of a summary for open() to fetch a message known only by folder and UID. */
function stubRow(account: string, mailbox: string, uid: number): MessageSummary {
  return {
    key: `${account}/${mailbox}/${uid}`,
    account,
    mailbox,
    uid,
    from: { name: '', address: '' },
    to: [],
    subject: '',
    date: new Date().toISOString(),
    // Read-state comes from the fetched message, which open() checks as well.
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
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
