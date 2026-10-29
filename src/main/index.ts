import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountConfig, AiTask, ClassifyItem, Draft, MailEvent, MenuItemSpec, MoveResult, MoveTarget, SettingsPatch } from '../shared/types'
import { clearAccount, loadAccount, storeAccount, toPublic } from './account'
import { cancelTask, closeAi, listModels, startTask } from './ai'
import { classify, setLabel } from './labels'
import { MailService } from './mail'
import { buildRaw, sendDraft } from './send'
import { loadSettings, toPublicSettings, updateSettings } from './settings'

let window: BrowserWindow | null = null
let account: AccountConfig | null = null
let mail: MailService | null = null
let status: MailEvent['status'] = 'connecting'

function emit(event: MailEvent): void {
  if (event.type === 'connection') status = event.status
  window?.webContents.send('liame:event', event)
}

function service(): MailService {
  if (!mail) throw new Error('No account is configured.')
  return mail
}

async function useAccount(next: AccountConfig | null): Promise<void> {
  await mail?.stop()
  account = next
  mail = next ? new MailService(next, emit) : null
  mail?.start()
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
    },
  })

  window.once('ready-to-show', () => window?.show())
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

function registerIpc(): void {
  handle('getAccount', () => (account ? toPublic(account) : null))
  handle('getStatus', () => status)
  handle('testAccount', async (next: AccountConfig) => {
    try {
      await MailService.test(next)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: describe(error) }
    }
  })
  handle('saveAccount', async (next: AccountConfig) => {
    await storeAccount(next)
    await useAccount(next)
    return toPublic(next)
  })
  handle('signOut', async () => {
    await clearAccount()
    await useAccount(null)
    app.dock?.setBadge('')
  })
  handle('listMailboxes', async () => {
    const boxes = await service().listMailboxes()
    const unread = boxes.find((box) => box.specialUse === 'inbox' || box.path.toUpperCase() === 'INBOX')?.unread ?? 0
    app.dock?.setBadge(unread > 0 ? String(unread) : '')
    return boxes
  })
  handle('listMessages', (path: string, before?: number) => service().listMessages(path, before))
  handle('previews', (path: string, uids: number[]) => service().previews(path, uids))
  handle('search', (path: string, query: string) => service().search(path, query))
  handle('getMessage', (path: string, uid: number) => service().getMessage(path, uid))
  handle('setFlags', (path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) =>
    service().setFlags(path, uids, flags),
  )
  handle('move', (path: string, uids: number[], target: MoveTarget) => service().move(path, uids, target))
  handle('markAllRead', (path: string) => service().markAllRead(path))
  handle('saveDraft', async (draft: Draft) => {
    if (!account) throw new Error('No account is configured.')
    return service().saveDraft(await buildRaw(account, draft), draft.draftUid)
  })
  handle('contextMenu', (items: MenuItemSpec[]) => popupMenu(items))
  ipcMain.on('liame:focus', () => {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    app.focus({ steal: true })
  })
  handle('undoMove', (move: MoveResult) => service().undoMove(move))
  handle('saveAttachment', async (path: string, uid: number, partId: number) => {
    const file = await service().attachment(path, uid, partId)
    const result = await dialog.showSaveDialog(window!, { defaultPath: join(app.getPath('downloads'), file.filename) })
    if (!result.canceled && result.filePath) await writeFile(result.filePath, file.content)
  })
  handle('pickAttachments', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
  handle('send', async (draft: Draft) => {
    if (!account) throw new Error('No account is configured.')
    await sendDraft(account, draft)
    // A sent draft should not linger in Drafts.
    if (draft.draftUid) await service().deleteDraft(draft.draftUid).catch(() => {})
  })
  handle('openExternal', async (url: string) => {
    if (isSafeExternal(url)) await shell.openExternal(url)
  })
  handle('getSettings', async () => toPublicSettings(await loadSettings()))
  handle('saveSettings', async (patch: SettingsPatch) => toPublicSettings(await updateSettings(patch)))
  handle('aiModels', async () => listModels(await loadSettings()))
  handle('aiStart', async (id: string, task: AiTask) => {
    if (!account) throw new Error('No account is configured.')
    const settings = await loadSettings()
    // Streams back over liame:ai events; the invoke itself returns right away.
    void startTask(id, task, settings, account, (event) => window?.webContents.send('liame:ai', event))
  })
  handle('aiCancel', (id: string) => cancelTask(id))
  handle('classify', async (items: ClassifyItem[]) => classify(items, await loadSettings()))
  handle('setLabel', (item: ClassifyItem, label: string | null) => setLabel(item, label))
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
              type: item.checked === undefined ? 'normal' : 'checkbox',
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

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string }
    if (e.authenticationFailed) return 'Sign-in failed. Check the address and use a Zoho app-specific password.'
    if (e.code === 'ENOTFOUND') return 'Could not reach the server. Check the host name and your connection.'
    if (e.responseText) return e.responseText
    if (e.message) return e.message
  }
  return String(error)
}

app.setName('Liame')
nativeTheme.themeSource = 'dark'

app.whenReady().then(async () => {
  buildMenu()
  registerIpc()
  await useAccount(await loadAccount())
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void mail?.stop()
  void closeAi()
})
