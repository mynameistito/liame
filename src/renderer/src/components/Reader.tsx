import {
  Archive,
  Flag,
  Forward,
  LoaderCircle,
  Mail,
  MailOpen,
  Moon,
  PanelLeft,
  Paperclip,
  PenLine,
  Reply,
  ReplyAll,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LabelDef, MessageDetail, MessageSummary } from '../../../shared/types'
import type { CommandId } from '../commands'
import { api, avatarColor, displayName, fileSize, initials, longDate, useAccount } from '../lib'

export type ReplyMode = 'reply' | 'all' | 'forward'

interface Props {
  summary: MessageSummary | null
  detail: MessageDetail | null
  loading: boolean
  error: string
  mailbox: string
  inTrash: boolean
  labels: LabelDef[]
  assistantOpen: boolean
  onAssistant: () => void
  onDraftReply: () => void
  onLabel: (label: string | null) => void
  /** The first shortcut bound to a command, formatted for tooltips. */
  hint: (id: CommandId) => string
  darken: boolean
  onToggleDarken: () => void
  blockImages: boolean
  onLoadImages: () => void
  onReply: (mode: ReplyMode) => void
  onArchive: () => void
  onTrash: () => void
  onToggleSeen: () => void
  onToggleFlag: () => void
  listHidden: boolean
  onShowList: () => void
  inDrafts: boolean
  onEditDraft: () => void
  /** Set when several messages are picked; the reader then shows actions for all of them. */
  bulk?: BulkActions
}

export interface BulkActions {
  count: number
  allRead: boolean
  allFlagged: boolean
  onArchive: () => void
  onTrash: () => void
  onRead: (read: boolean) => void
  onFlag: (flagged: boolean) => void
  onMove: () => void
  onLabel: () => void
  onClear: () => void
}

export function Reader({ summary, detail, loading, error, mailbox, inTrash, labels, assistantOpen, hint, darken, blockImages, bulk, ...actions }: Props) {
  const { mail } = useAccount()
  const showList = actions.listHidden && (
    <ToolButton title={`Show message list  ${hint('toggleList')}`} onClick={actions.onShowList} icon={<PanelLeft size={16} />} />
  )

  if (bulk) {
    return (
      <main className="pane reader">
        <div className="toolbar drag">{showList}</div>
        <div className="empty-reader">
          <div className="bulk">
            <div className="bulk-count">{bulk.count} messages selected</div>
            <div className="bulk-actions">
              <button onClick={bulk.onArchive}>
                <Archive size={14} /> Archive <kbd>{hint('archive')}</kbd>
              </button>
              <button onClick={bulk.onTrash}>
                <Trash2 size={14} /> {inTrash ? 'Delete' : 'Trash'} <kbd>{hint('trash')}</kbd>
              </button>
              <button onClick={() => bulk.onRead(!bulk.allRead)}>
                {bulk.allRead ? <Mail size={14} /> : <MailOpen size={14} />} Mark {bulk.allRead ? 'unread' : 'read'} <kbd>{hint('toggleRead')}</kbd>
              </button>
              <button onClick={() => bulk.onFlag(!bulk.allFlagged)}>
                <Flag size={14} /> {bulk.allFlagged ? 'Unflag' : 'Flag'} <kbd>{hint('toggleFlag')}</kbd>
              </button>
              <button onClick={bulk.onMove}>
                Move to… <kbd>{hint('moveTo')}</kbd>
              </button>
              {labels.length > 0 && (
                <button onClick={bulk.onLabel}>
                  Label… <kbd>{hint('labelAs')}</kbd>
                </button>
              )}
            </div>
            <button className="bulk-clear" onClick={bulk.onClear}>
              Clear selection <kbd>{hint('clearSelection')}</kbd>
            </button>
          </div>
        </div>
      </main>
    )
  }

  if (!summary) {
    return (
      <main className="pane reader">
        <div className="toolbar drag">{showList}</div>
        <div className="empty-reader">
          <div>
            <Mail size={28} strokeWidth={1.2} />
            <div>No message selected</div>
          </div>
        </div>
      </main>
    )
  }

  const message = detail ?? summary
  const recipients = [...message.to, ...(detail?.cc ?? [])]

  return (
    <main className="pane reader">
      <div className="toolbar drag">
        {showList}
        <ToolButton title={`Reply  ${hint('reply')}`} onClick={() => actions.onReply('reply')} icon={<Reply size={16} />} />
        <ToolButton title={`Reply all  ${hint('replyAll')}`} onClick={() => actions.onReply('all')} icon={<ReplyAll size={16} />} />
        <ToolButton title={`Forward  ${hint('forward')}`} onClick={() => actions.onReply('forward')} icon={<Forward size={16} />} />
        <span className="sep" />
        <ToolButton title={`Archive  ${hint('archive')}`} onClick={actions.onArchive} icon={<Archive size={16} />} />
        <ToolButton title={`${inTrash ? 'Delete permanently' : 'Move to Trash'}  ${hint('trash')}`} onClick={actions.onTrash} icon={<Trash2 size={16} />} />
        <span className="sep" />
        <ToolButton
          title={`${message.seen ? 'Mark as unread' : 'Mark as read'}  ${hint('toggleRead')}`}
          onClick={actions.onToggleSeen}
          icon={message.seen ? <Mail size={16} /> : <MailOpen size={16} />}
        />
        <ToolButton title={`${message.flagged ? 'Unflag' : 'Flag'}  ${hint('toggleFlag')}`} onClick={actions.onToggleFlag} on={message.flagged} icon={<Flag size={16} fill={message.flagged ? 'currentColor' : 'none'} />} />
        <span className="spacer" />
        <ToolButton title={`Assistant  ${hint('assistant')}`} onClick={actions.onAssistant} on={assistantOpen} icon={<Sparkles size={15} />} />
        {detail?.html && (
          <ToolButton
            title={darken ? 'Show original colors' : 'Darken message'}
            onClick={actions.onToggleDarken}
            icon={darken ? <Sun size={15} /> : <Moon size={15} />}
          />
        )}
      </div>

      <div className="reader-scroll">
        <article className="reader-inner">
          <h1 className="subject">{message.subject}</h1>
          <div className="sender">
            <div className="avatar" style={avatarColor(message.from)}>
              {initials(message.from)}
            </div>
            <div className="sender-main">
              <div className="sender-name">
                {displayName(message.from)}
                {message.from.name && <span className="sender-address">{message.from.address}</span>}
              </div>
              <div className="sender-to" title={recipients.map((r) => r.address).join(', ')}>
                to {recipients.length ? recipients.map(displayName).join(', ') : 'undisclosed recipients'}
              </div>
            </div>
            <div className="sender-meta">
              <div className="sender-date">{longDate(message.date)}</div>
              {labels.length > 0 && (
                <select
                  className="label-select"
                  // Labels live on the list summary; the fetched detail never carries one.
                  value={summary.label ?? ''}
                  style={{ color: labels.find((l) => l.id === summary.label)?.color }}
                  onChange={(e) => actions.onLabel(e.target.value || null)}
                  title="Label"
                >
                  <option value="">No label</option>
                  {labels.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {error && <div className="error-banner" style={{ margin: 0 }}>{error}</div>}
          {loading && !detail && <LoaderCircle size={16} className="spin" color="var(--text-3)" />}
          {detail?.html && blockImages && hasRemoteImages(detail.html) && (
            <div className="images-bar">
              Remote images are blocked.
              <button className="ghost" onClick={actions.onLoadImages}>
                Load images
              </button>
            </div>
          )}
          {detail && (detail.html ? <EmailFrame html={detail.html} darken={darken} blockImages={blockImages} /> : <PlainText text={detail.text ?? ''} />)}

          {detail && detail.attachments.length > 0 && (
            <div className="attachments">
              {detail.attachments.map((file) => (
                <button key={file.partId} className="attachment" onClick={() => mail.saveAttachment(mailbox, detail.uid, file.partId)} title="Save">
                  <Paperclip size={15} />
                  <div style={{ minWidth: 0 }}>
                    <div className="attachment-name">{file.filename}</div>
                    <div className="attachment-size">{fileSize(file.size)}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {detail && (
            <div className="reply-bar">
              {actions.inDrafts && (
                <button className="ai" onClick={actions.onEditDraft} title={hint('editDraft')}>
                  <PenLine size={14} /> Edit draft
                </button>
              )}
              <button className={actions.inDrafts ? undefined : 'ai'} onClick={actions.onDraftReply} title={hint('draftReply')}>
                <Sparkles size={14} /> Draft reply
              </button>
              <button onClick={() => actions.onReply('reply')}>
                <Reply size={14} /> Reply
              </button>
              <button onClick={() => actions.onReply('all')}>
                <ReplyAll size={14} /> Reply all
              </button>
              <button onClick={() => actions.onReply('forward')}>
                <Forward size={14} /> Forward
              </button>
            </div>
          )}
        </article>
      </div>
    </main>
  )
}

function ToolButton({ title, icon, onClick, on }: { title: string; icon: ReactNode; onClick: () => void; on?: boolean }) {
  return (
    <button className={`icon-button ${on ? 'on' : ''}`} title={title} onClick={onClick}>
      {icon}
    </button>
  )
}

const BASE_CSS = `
html { background: #fff; }
body { margin: 0; padding: 0; color: #1d1d1f; background: #fff;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
  word-wrap: break-word; overflow-wrap: anywhere; overflow-x: auto; }
img { max-width: 100%; height: auto; }
a { color: #0a63d6; }
blockquote { margin: 0 0 0 4px; padding-left: 12px; border-left: 2px solid #d2d2d7; color: #515154; }
pre { white-space: pre-wrap; }
`

// Inverting the whole document and then re-inverting media turns white mail into true black
// without hand-tuning every newsletter's colors.
const DARKEN_CSS = `
html { background: #000; }
body { filter: invert(1) hue-rotate(180deg); }
img, video, picture, canvas, svg image, [style*="background-image"], [background] { filter: invert(1) hue-rotate(180deg); }
`

function hasRemoteImages(html: string): boolean {
  return /<img[^>]+src\s*=\s*["']?https?:|url\(\s*["']?https?:|background\s*=\s*["']?https?:/i.test(html)
}

// Inherits the window CSP; this narrows images to inline data so trackers and remote pictures never load.
const BLOCK_IMAGES = `<meta http-equiv="Content-Security-Policy" content="img-src data: blob:">`

function EmailFrame({ html, darken, blockImages }: { html: string; darken: boolean; blockImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">${blockImages ? BLOCK_IMAGES : ''}<base target="_blank"><style>${BASE_CSS}${darken ? DARKEN_CSS : ''}</style></head><body>${html}</body></html>`,
    [html, darken, blockImages],
  )

  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let observer: ResizeObserver | undefined
    const fit = () => {
      const doc = frame.contentDocument
      if (doc?.documentElement) setHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0))
    }
    const onLoad = () => {
      fit()
      const body = frame.contentDocument?.body
      if (body) {
        observer = new ResizeObserver(fit)
        observer.observe(body)
      }
    }
    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      observer?.disconnect()
    }
  }, [srcDoc])

  return (
    <iframe
      ref={ref}
      className="body-frame"
      title="Message"
      // No allow-scripts: mail content can never run code. Same-origin only lets the app measure its height.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      style={{ height, borderRadius: darken ? 0 : 8 }}
    />
  )
}

const URL_PATTERN = /(https?:\/\/[^\s<>"')\]]+)/g

function PlainText({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN)
  return (
    <div className="body-text">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} onClick={(e) => (e.preventDefault(), api.openExternal(part))}>
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </div>
  )
}
