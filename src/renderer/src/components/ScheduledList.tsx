import { PanelLeft } from 'lucide-react'
import type { ScheduledItem } from '../../../shared/types'
import { formatWhen, shortDate } from '../lib'

interface Props {
  items: ScheduledItem[]
  /** Id of the item whose message is open. */
  selected: string | null
  /** Set with more than one account: rows say which account they belong to. */
  accountNames?: Map<string, string>
  sidebarHidden: boolean
  onShowSidebar: () => void
  onOpen: (item: ScheduledItem) => void
  onCancel: (item: ScheduledItem) => void
}

const SECTIONS: Array<{ title: string; test: (item: ScheduledItem) => boolean }> = [
  { title: 'No reply yet', test: (item) => item.kind === 'followup' && !!item.fired },
  { title: 'Sending later', test: (item) => item.kind === 'send' },
  { title: 'Snoozed', test: (item) => item.kind === 'snooze' },
  { title: 'Waiting for a reply', test: (item) => item.kind === 'followup' && !item.fired },
]

const ACTION: Record<ScheduledItem['kind'], string> = { snooze: 'Unsnooze', send: 'Edit', followup: 'Dismiss' }

/** Snoozed mail, queued sends, and reply reminders across every account, soonest first. */
export function ScheduledList({ items, selected, accountNames, sidebarHidden, onShowSidebar, onOpen, onCancel }: Props) {
  return (
    <section className="pane">
      <header className="list-header">
        <div className="list-titlebar drag">
          {sidebarHidden && (
            <button className="icon-button" title="Show sidebar" onClick={onShowSidebar}>
              <PanelLeft size={15} />
            </button>
          )}
          <div className="list-title">Scheduled</div>
        </div>
      </header>
      <div className="messages" tabIndex={0}>
        {items.length === 0 && <div className="list-empty">Nothing scheduled</div>}
        {SECTIONS.map(({ title, test }) => {
          const list = items.filter(test)
          if (!list.length) return null
          return (
            <div key={title}>
              <div className="list-section">{title}</div>
              {list.map((item) => (
                <div
                  key={item.id}
                  className={`row scheduled-row ${item.id === selected ? 'selected' : ''} ${item.mailbox ? '' : 'static'}`}
                  onMouseDown={(e) => e.button === 0 && item.mailbox && onOpen(item)}
                >
                  <div className="row-top">
                    <span className="row-from">{item.who || 'No recipients'}</span>
                    <span className="row-meta">{item.fired ? shortDate(new Date(item.due).toISOString()) : formatWhen(item.due)}</span>
                  </div>
                  <div className="scheduled-main">
                    <div className="row-subject">
                      {accountNames && <span className="folder-tag">{accountNames.get(item.account)}</span>}
                      {item.subject || '(no subject)'}
                    </div>
                    <button className="ghost" onMouseDown={(e) => e.stopPropagation()} onClick={() => onCancel(item)}>
                      {ACTION[item.kind]}
                    </button>
                  </div>
                  {item.error && <div className="scheduled-error">Not sent: {item.error}. Trying again soon.</div>}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
