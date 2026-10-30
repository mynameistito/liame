import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AiEvent, LiameApi, MailEvent } from '../shared/types'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`liame:${channel}`, ...args)

const api: LiameApi = {
  listAccounts: call('listAccounts'),
  saveAccount: call('saveAccount'),
  testAccount: call('testAccount'),
  removeAccount: call('removeAccount'),
  takePendingOpen: call('takePendingOpen'),
  listMailboxes: call('listMailboxes'),
  listMessages: call('listMessages'),
  previews: call('previews'),
  search: call('search'),
  getMessage: call('getMessage'),
  setFlags: call('setFlags'),
  move: call('move'),
  undoMove: call('undoMove'),
  markAllRead: call('markAllRead'),
  saveDraft: call('saveDraft'),
  contextMenu: call('contextMenu'),
  focusWindow: () => ipcRenderer.send('liame:focus'),
  setZoom: (factor) => webFrame.setZoomFactor(Math.min(1.4, Math.max(0.8, factor))),
  saveAttachment: call('saveAttachment'),
  pickAttachments: call('pickAttachments'),
  send: call('send'),
  openExternal: call('openExternal'),
  getSettings: call('getSettings'),
  saveSettings: call('saveSettings'),
  aiModels: call('aiModels'),
  aiStart: call('aiStart'),
  aiCancel: call('aiCancel'),
  classify: call('classify'),
  setLabel: call('setLabel'),
  onAi(listener) {
    const handler = (_: unknown, event: AiEvent) => listener(event)
    ipcRenderer.on('liame:ai', handler)
    return () => ipcRenderer.removeListener('liame:ai', handler)
  },
  onEvent(listener) {
    const handler = (_: unknown, event: MailEvent) => listener(event)
    ipcRenderer.on('liame:event', handler)
    return () => ipcRenderer.removeListener('liame:event', handler)
  },
}

contextBridge.exposeInMainWorld('liame', api)
