import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, screen, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AccountConfig,
  AccountInput,
  AccountSummary,
  AiTask,
  ClassifyItem,
  ConnectionStatus,
  Draft,
  Mailbox,
  MailEvent,
  MenuItemSpec,
  MoveResult,
  MoveTarget,
  SendOptions,
  SettingsPatch,
} from '../shared/types'
import { loadAccounts, storeAccounts, toPublic, upsert } from './account'
import { cancelTask, closeAi, listModels, startTask } from './ai'
import { classify, setLabel } from './labels'
import { MailService } from './mail'
import { addReminder, addSnooze, cancel, dropSnoozed, listItems, queueSend, remindAfterSend, startScheduler } from './schedule'
import { buildRaw, sendDraft } from './send'
import * as store from './store'
import { loadSettings, toPublicSettings, updateSettings } from './settings'

let window: BrowserWindow | null = null
/** For automated tests: no visible window, no Dock icon, no notifications, so nothing takes focus. */
const background = process.env.LIAME_BACKGROUND === '1'
let accounts: AccountConfig[] = []
const services = new Map<string, MailService>()
const statuses = new Map<string, ConnectionStatus>()
const unread = new Map<string, number>()

function send(event: MailEvent): void {
  window?.webContents.send('liame:event', event)
}

function accountOf(id: string): AccountConfig {
  const found = accounts.find((a) => a.id === id)
  if (!found) throw new Error('That account no longer exists.')
  return found
}

function service(id: string): MailService {
  const found = services.get(id)
  if (!found) throw new Error('That account no longer exists.')
  return found
}

/** Starts a mail service per account, stopping any for accounts that went away or changed. */
async function syncServices(): Promise<void> {
  for (const [id, svc] of services) {
    const current = accounts.find((a) => a.id === id)
    if (!current || svc.account !== current) {
      services.delete(id)
      statuses.delete(id)
      unread.delete(id)
      await svc.stop()
    }
  }
  for (const account of accounts) {
    if (services.has(account.id)) continue
    const svc = new MailService(account, (event) => onServiceEvent(account.id, event))
    services.set(account.id, svc)
    statuses.set(account.id, 'connecting')
    svc.start()
  }
  updateBadge()
  send({ type: 'accounts-changed' })
}

function onServiceEvent(accountId: string, event: MailEvent): void {
  send({ ...event, accountId })
  if (event.type === 'connection' && event.status) {
    statuses.set(accountId, event.status)
    if (event.status === 'online') {
      void refreshUnread(accountId)
      void syncBackground(accountId)
    }
    send({ type: 'accounts-changed' })
  }
  if (event.type === 'new-mail' && event.mailbox?.toUpperCase() === 'INBOX') {
    void announce(accountId)
    void services.get(accountId)?.sync('INBOX').catch(() => {})
  }
  if (event.type === 'mailboxes-changed') void refreshUnread(accountId)
}

/** Keeps the mailboxes conversations draw from (Inbox, Sent, Archive) current even when nobody is looking at them. */
async function syncBackground(accountId: string): Promise<void> {
  const svc = services.get(accountId)
  if (!svc) return
  const boxes = await svc.listMailboxes().catch(() => [])
  // Snoozed too, so a message moved out of it elsewhere drops off the Scheduled list.
  const wanted = (b: Mailbox) => b.specialUse === 'inbox' || b.specialUse === 'sent' || b.specialUse === 'archive' || b.path.toLowerCase() === 'snoozed'
  for (const box of boxes.filter(wanted)) {
    await svc.sync(box.path).catch(() => {})
  }
}

async function refreshUnread(accountId: string): Promise<void> {
  const count = await services.get(accountId)?.inboxUnread().catch(() => undefined)
  if (count === undefined || !services.has(accountId)) return
  unread.set(accountId, count)
  updateBadge()
  send({ type: 'accounts-changed' })
}

function updateBadge(): void {
  const total = [...unread.values()].reduce((a, b) => a + b, 0)
  app.dock?.setBadge(total > 0 ? String(total) : '')
}

/** New-mail notifications for every account, shown while Liame is in the background. */
async function announce(accountId: string): Promise<void> {
  const fresh = (await services.get(accountId)?.takeNewInbox().catch(() => [])) ?? []
  void refreshUnread(accountId)
  const { prefs } = await loadSettings()
  if (!fresh.length || !prefs.notifications || background || window?.isFocused() || !Notification.isSupported()) return
  const account = accounts.find((a) => a.id === accountId)
  const show = (title: string, body: string, uid?: number) => {
    const n = new Notification({ title, subtitle: accounts.length > 1 ? account?.email : undefined, body })
    n.on('click', () => openFromNotification({ type: 'open-message', accountId, mailbox: 'INBOX', uid }))
    n.show()
  }
  const sender = (m: (typeof fresh)[number]) => m.from.name || m.from.address
  if (fresh.length > 3) show(`${fresh.length} new messages`, fresh.slice(0, 3).map(sender).join(', '))
  else for (const m of fresh) show(sender(m), m.subject, m.uid)
}

/** Reminders and scheduling problems; unlike new mail, these show even while Liame is in front. */
async function notifyScheduled(title: string, body: string, open?: { accountId: string; mailbox: string; uid: number }): Promise<void> {
  const { prefs } = await loadSettings()
  if (!prefs.notifications || background || !Notification.isSupported()) return
  const n = new Notification({ title, body })
  if (open) n.on('click', () => openFromNotification({ type: 'open-message', ...open }))
  n.show()
}

/** A notification click waiting for a window: macOS keeps the app running after its window closes. */
let pendingOpen: MailEvent | null = null

function openFromNotification(event: MailEvent): void {
  if (window) {
    focusWindow()
    send(event)
    return
  }
  // The new window's renderer asks for this once it has mounted.
  pendingOpen = event
  createWindow()
}

function focusWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  app.focus({ steal: true })
}

function isSafeExternal(url: string): boolean {
  return /^(https?|mailto):/i.test(url)
}

const boundsFile = () => join(app.getPath('userData'), 'window.json')

function savedBounds(): Electron.Rectangle | undefined {
  try {
    if (!existsSync(boundsFile())) return undefined
    const bounds = JSON.parse(readFileSync(boundsFile(), 'utf8')) as Electron.Rectangle
    // Ignore positions on a display that is no longer attached.
    const visible = screen.getAllDisplays().some((d) => bounds.x >= d.bounds.x - 50 && bounds.x < d.bounds.x + d.bounds.width && bounds.y >= d.bounds.y - 50 && bounds.y < d.bounds.y + d.bounds.height)
    return visible ? bounds : undefined
  } catch {
    return undefined
  }
}

function createWindow(): void {
  const bounds = savedBounds()
  window = new BrowserWindow({
    width: bounds?.width ?? 1320,
    height: bounds?.height ?? 840,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 880,
    minHeight: 540,
    show: false,
    title: 'Liame',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      spellcheck: true,
      // A hidden window would otherwise pause its timers and animation frames.
      backgroundThrottling: !background,
    },
  })

  if (!background) window.once('ready-to-show', () => window?.show())
  window.on('close', () => {
    if (window && !window.isFullScreen()) void writeFile(boundsFile(), JSON.stringify(window.getNormalBounds()))
  })
  window.on('closed', () => (window = null))

  // Links clicked inside email bodies open in the default browser, never in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window?.webContents.getURL()) return
    event.preventDefault()
    if (isSafeExternal(url)) void shell.openExternal(url)
  })

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const, { role: 'forceReload' } as const]),
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function handle<Args extends unknown[], R>(channel: string, fn: (...args: Args) => Promise<R> | R): void {
  ipcMain.handle(`liame:${channel}`, (_event, ...args) => fn(...(args as Args)))
}

function summaries(): AccountSummary[] {
  return accounts.map((a) => ({ ...toPublic(a), unread: unread.get(a.id) ?? 0, status: statuses.get(a.id) ?? 'connecting' }))
}

function registerIpc(): void {
  handle('listAccounts', () => summaries())
  handle('takePendingOpen', () => {
    const event = pendingOpen
    pendingOpen = null
    return event
  })
  handle('testAccount', async (next: AccountInput) => {
    try {
      await MailService.test(next)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: describe(error, next.provider) }
    }
  })
  handle('saveAccount', async (input: AccountInput) => {
    const { list, account } = upsert(accounts, input)
    await storeAccounts(list)
    accounts = list
    await syncServices()
    return toPublic(account)
  })
  handle('removeAccount', async (id: string) => {
    const account = accountOf(id)
    const { response } = await dialog.showMessageBox(window!, {
      type: 'question',
      buttons: ['Remove', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove ${account.email} from Liame?`,
      detail: 'Your mail stays on the server. You can add the account again later with its password.',
    })
    if (response !== 0) return false
    accounts = accounts.filter((a) => a.id !== id)
    await storeAccounts(accounts)
    store.removeAccount(id)
    await syncServices()
    return true
  })
  handle('listMailboxes', async (id: string) => {
    const boxes = await service(id).listMailboxes()
    const inbox = boxes.find((box) => box.specialUse === 'inbox' || box.path.toUpperCase() === 'INBOX')
    if (inbox) {
      unread.set(id, inbox.unread)
      updateBadge()
      send({ type: 'accounts-changed' })
    }
    return boxes
  })
  handle('listMessages', (id: string, path: string, offset?: number, limit?: number, threads?: boolean) =>
    service(id).listMessages(path, offset, limit, threads),
  )
  handle('getThread', (id: string, thread: string) => service(id).getThread(thread))
  handle('listUnified', async (offset: number = 0, limit: number = 50, threads: boolean = false) => {
    // Each inbox is already sorted by date; read enough of each to fill this page, then merge.
    const pages = await Promise.all([...services.values()].map((svc) => svc.listMessages(svc.inboxPath(), 0, offset + limit, threads).catch(() => null)))
    const merged = pages
      .flatMap((page) => page?.messages ?? [])
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    return {
      mailbox: '',
      messages: merged.slice(offset, offset + limit),
      hasMore: merged.length > offset + limit || pages.some((page) => page?.hasMore),
    }
  })
  handle('syncInboxes', async () => {
    await Promise.all([...services.values()].map((svc) => svc.sync(svc.inboxPath()).catch(() => {})))
  })
  handle('markAllInboxesRead', async () => {
    await Promise.all([...services.values()].map((svc) => svc.markAllRead(svc.inboxPath())))
  })
  handle('sync', (id: string, path: string) => service(id).sync(path))
  handle('search', (id: string, path: string, query: string) => service(id).search(path, query))
  handle('searchLocal', (ids: string[], query: string) => store.search(ids.filter((id) => services.has(id)), query))
  handle('getMessage', (id: string, path: string, uid: number) => service(id).getMessage(path, uid))
  handle('setFlags', async (id: string, path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) => {
    await service(id).setFlags(path, uids, flags)
    // Reading mail changes this account's count in the switcher and the Dock badge.
    if (flags.seen !== undefined) void refreshUnread(id)
  })
  handle('move', async (id: string, path: string, uids: number[], target: MoveTarget) => {
    if (typeof target === 'string' || !('snooze' in target)) return service(id).move(path, uids, target)
    const svc = service(id)
    // Snoozed mail is found again by Message-ID, so every message needs one.
    const rows = store.getMessages(id, path, uids)
    if (rows.length < uids.length) throw new Error('This folder is still syncing. Try again in a moment.')
    if (rows.some((m) => !m.messageId)) throw new Error('This message has no Message-ID, so Liame cannot find it again to bring it back.')
    const snoozed = await svc.snoozedPath()
    // Snoozing again from Snoozed moves nothing; the messages just get a new time.
    const result = path === snoozed ? null : await svc.move(path, uids, target)
    await addSnooze(id, rows, snoozed, path === snoozed ? undefined : path, target.snooze)
    // Servers without UIDPLUS give no new UIDs; the synced folder shows where the messages are.
    void svc
      .sync(snoozed)
      .catch(() => {})
      .then(() => send({ type: 'scheduled-changed' }))
    return result
  })
  handle('markAllRead', (id: string, path: string) => service(id).markAllRead(path))
  handle('saveDraft', async (id: string, draft: Draft) => {
    return service(id).saveDraft(await buildRaw(accountOf(id), draft, await keptAttachments(id, draft)), draft.draftUid)
  })
  handle('undoMove', async (id: string, move: MoveResult) => {
    // Undoing a snooze ends it. (Undoing a move out of Snoozed needs nothing: the snooze is still recorded.)
    const undoesSnooze = move.to === (await service(id).findSnoozed())
    const ids = undoesSnooze ? store.getMessages(id, move.to, move.uids).flatMap((m) => m.messageId ?? []) : []
    await service(id).undoMove(move)
    if (ids.length) await dropSnoozed(id, ids)
  })
  handle('saveAttachment', async (id: string, path: string, uid: number, partId: number) => {
    const file = await service(id).attachment(path, uid, partId)
    const result = await dialog.showSaveDialog(window!, { defaultPath: join(app.getPath('downloads'), file.filename) })
    if (!result.canceled && result.filePath) await writeFile(result.filePath, file.content)
  })
  handle('send', async (id: string, draft: Draft, options: SendOptions = {}) => {
    const account = accountOf(id)
    const kept = await keptAttachments(id, draft)
    if (options.at) await queueSend(account, draft, kept, options.at, options.followUp)
    else {
      const messageId = await sendDraft(account, draft, kept)
      if (options.followUp) remindAfterSend(account, draft, messageId, options.followUp)
    }
    // A sent or queued draft should not linger in Drafts.
    if (draft.draftUid) await service(id).deleteDraft(draft.draftUid).catch(() => {})
  })
  handle('remind', (id: string, path: string, uid: number, due: number) => {
    const m = store.getMessages(id, path, [uid])[0]
    if (!m) throw new Error('That message is not available offline yet.')
    addReminder(id, { messageId: m.messageId, thread: m.thread, subject: m.subject, from: m.from.address, who: m.from.name || m.from.address, date: Date.parse(m.date) }, due)
  })
  handle('listScheduled', () => listItems().filter((item) => services.has(item.account)))
  handle('cancelScheduled', (itemId: string) => cancel(itemId))
  handle('contextMenu', (items: MenuItemSpec[]) => popupMenu(items))
  ipcMain.on('liame:focus', focusWindow)
  handle('pickAttachments', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
  handle('openExternal', async (url: string) => {
    if (isSafeExternal(url)) await shell.openExternal(url)
  })
  handle('getSettings', async () => toPublicSettings(await loadSettings()))
  handle('saveSettings', async (patch: SettingsPatch) => toPublicSettings(await updateSettings(patch)))
  handle('aiModels', async () => listModels(await loadSettings()))
  handle('aiStart', async (taskId: string, task: AiTask, id: string) => {
    const settings = await loadSettings()
    // Streams back over liame:ai events; the invoke itself returns right away.
    void startTask(taskId, task, settings, accountOf(id), (event) => window?.webContents.send('liame:ai', event))
  })
  handle('aiCancel', (taskId: string) => cancelTask(taskId))
  handle('classify', async (items: ClassifyItem[]) => classify(items, await loadSettings()))
  handle('setLabel', (item: ClassifyItem, label: string | null) => setLabel(item, label))
}

/** Loads the attachments a reopened draft still carries from its saved copy. */
function keptAttachments(id: string, draft: Draft) {
  if (!draft.draftUid || !draft.kept?.length) return Promise.resolve([])
  return service(id).draftAttachments(
    draft.draftUid,
    draft.kept.map((k) => k.partId),
  )
}

/** Shows a native menu and resolves with the chosen item's id, or null when dismissed. */
function popupMenu(items: MenuItemSpec[]): Promise<string | null> {
  return new Promise((resolve) => {
    const build = (list: MenuItemSpec[]): Electron.MenuItemConstructorOptions[] =>
      list.map((item) =>
        item.separator
          ? { type: 'separator' }
          : {
              label: item.label,
              enabled: item.enabled !== false,
              type: item.submenu ? 'submenu' : item.checked === undefined ? 'normal' : 'checkbox',
              checked: item.checked,
              // Shown as a hint only; the renderer owns the actual key handling.
              accelerator: item.accelerator,
              registerAccelerator: false,
              submenu: item.submenu ? build(item.submenu) : undefined,
              click: item.id ? () => resolve(item.id!) : undefined,
            },
      )
    // Clicks can land after the close callback, so give them a moment before resolving null.
    Menu.buildFromTemplate(build(items)).popup({ window: window ?? undefined, callback: () => setTimeout(() => resolve(null), 100) })
  })
}

function describe(error: unknown, provider?: AccountInput['provider']): string {
  if (error && typeof error === 'object') {
    const e = error as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string }
    if (e.authenticationFailed) {
      if (provider === 'gmail') return 'Sign-in failed. Gmail needs an app password (2-Step Verification on), not your Google password.'
      if (provider === 'zoho') return 'Sign-in failed. Check the address and use a Zoho app-specific password.'
      return 'Sign-in failed. Check the address and password.'
    }
    if (e.code === 'ENOTFOUND') return 'Could not reach the server. Check the host name and your connection.'
    if (e.responseText) return e.responseText
    if (e.message) return e.message
  }
  return String(error)
}

app.setName('Liame')
nativeTheme.themeSource = 'dark'

app.whenReady().then(async () => {
  if (background) app.dock?.hide()
  buildMenu()
  registerIpc()
  accounts = await loadAccounts()
  await syncServices()
  createWindow()
  startScheduler({
    account: (id) => accounts.find((a) => a.id === id),
    service: (id) => services.get(id),
    notify: notifyScheduled,
    changed: () => send({ type: 'scheduled-changed' }),
  })
  // New mail is pushed over IDLE; this catches changes made elsewhere (other devices, the webmail).
  setInterval(() => accounts.forEach((a) => void syncBackground(a.id)), 3 * 60_000)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const svc of services.values()) void svc.stop()
  void closeAi()
  store.closeStore()
})
