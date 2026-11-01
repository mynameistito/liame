import { expect, test } from 'bun:test'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import type { MessageSummary } from '../src/shared/types'

// The list imports formatting helpers from the renderer API module; rendering does not call IPC.
if (!globalThis.window) Object.assign(globalThis, { window: { liame: {} } })
const { MessageList } = await import('../src/renderer/src/components/MessageList')
const message = (uid: number): MessageSummary => ({
  key: `a/My Folder/${uid}`, account: 'a', mailbox: 'My Folder', uid, thread: `${uid}`, messageId: `<${uid}@test>`,
  from: { name: 'Sender', address: 'sender@test' }, to: [], subject: `Message ${uid}`,
  date: '2026-10-01T12:00:00Z', seen: false, flagged: false, answered: false, hasAttachments: false,
})
const noop = () => {}
const props: ComponentProps<typeof MessageList> = {
  title: 'Inbox', unread: 0, messages: [message(1), message(2), message(3)], selected: message(1).key,
  loading: false, error: '', query: '', searchState: 'complete', searchScope: 'All accounts · cached mail only',
  localSearchOnly: true, filter: 'unread', hasMore: false, showRecipient: false,
  labels: new Map(), onQuery: noop, onFilter: noop, onPick: noop, onRowMenu: noop,
  checked: [], mailbox: 'INBOX', mailboxNames: new Map(), sidebarHidden: false,
  onShowSidebar: noop, onLoadMore: noop, searchRef: createRef(), listRef: createRef(),
}

test('message list exposes action selection, active row and filter without whitespace in ID references', () => {
  const html = renderToStaticMarkup(<MessageList {...props} checked={[message(2).key, message(3).key]} />)
  expect(html).toContain('role="listbox"')
  expect(html).toContain('aria-activedescendant="message-a%2FMy%20Folder%2F1"')
  expect(html).toContain('id="message-a%2FMy%20Folder%2F1" role="option" aria-selected="false"')
  expect(html).toContain('id="message-a%2FMy%20Folder%2F2" role="option" aria-selected="true"')
  expect(html).toContain('aria-pressed="true" class="filter active"')
})

test('pending, cached-only and failed searches do not claim a completed empty server search', () => {
  const render = (searchState: typeof props.searchState, localSearchOnly = true, error = '') =>
    renderToStaticMarkup(<MessageList {...props} messages={[]} query="missing" searchState={searchState} localSearchOnly={localSearchOnly} error={error} />)
  expect(render('server', false)).toContain('Searching server…')
  expect(render('server', false)).not.toContain('No matches in searched mail')
  expect(render('complete')).toContain('No cached matches')
  expect(render('complete', false)).toContain('No matches in searched mail')
  expect(render('failed', false, 'Disconnected')).toContain('Search incomplete')
  expect(render('failed', false, 'Disconnected')).not.toContain('No matches in searched mail')
})
