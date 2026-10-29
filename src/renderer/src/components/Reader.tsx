import {
  Archive,
  Flag,
  Forward,
  LoaderCircle,
  Mail,
  MailOpen,
  Moon,
  Paperclip,
  Reply,
  ReplyAll,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LabelDef, MessageDetail, MessageSummary } from '../../../shared/types'
import { api, avatarColor, displayName, fileSize, initials, longDate } from '../lib'

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
  onReply: (mode: ReplyMode) => void
  onArchive: () => void
  onTrash: () => void
  onToggleSeen: () => void
  onToggleFlag: () => void
}

export function Reader({ summary, detail, loading, error, mailbox, inTrash, labels, assistantOpen, ...actions }: Props) {
  const [darken, setDarken] = useState(true)
  // Original colors are a per-message escape hatch; every message opens darkened.
  useEffect(() => setDarken(true), [summary?.uid])

  if (!summary) {
    return (
      <main className="pane reader">
        <div className="toolbar drag" />
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
        <ToolButton title="Reply  R" onClick={() => actions.onReply('reply')} icon={<Reply size={16} />} />
        <ToolButton title="Reply all  A" onClick={() => actions.onReply('all')} icon={<ReplyAll size={16} />} />
        <ToolButton title="Forward  F" onClick={() => actions.onReply('forward')} icon={<Forward size={16} />} />
        <span className="sep" />
        <ToolButton title="Archive  E" onClick={actions.onArchive} icon={<Archive size={16} />} />
        <ToolButton title={inTrash ? 'Delete permanently  #' : 'Move to Trash  #'} onClick={actions.onTrash} icon={<Trash2 size={16} />} />
        <span className="sep" />
        <ToolButton
          title={message.seen ? 'Mark as unread  U' : 'Mark as read  U'}
          onClick={actions.onToggleSeen}
          icon={message.seen ? <Mail size={16} /> : <MailOpen size={16} />}
        />
        <ToolButton title={message.flagged ? 'Unflag  S' : 'Flag  S'} onClick={actions.onToggleFlag} on={message.flagged} icon={<Flag size={16} fill={message.flagged ? 'currentColor' : 'none'} />} />
        <span className="spacer" />
        <ToolButton title="Assistant  ⌘K" onClick={actions.onAssistant} on={assistantOpen} icon={<Sparkles size={15} />} />
        {detail?.html && (
          <ToolButton
            title={darken ? 'Show original colors' : 'Darken message'}
            onClick={() => setDarken((d) => !d)}
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
          {detail && (detail.html ? <EmailFrame html={detail.html} darken={darken} /> : <PlainText text={detail.text ?? ''} />)}

          {detail && detail.attachments.length > 0 && (
            <div className="attachments">
              {detail.attachments.map((file) => (
                <button key={file.partId} className="attachment" onClick={() => api.saveAttachment(mailbox, detail.uid, file.partId)} title="Save">
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
              <button className="ai" onClick={actions.onDraftReply}>
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

function EmailFrame({ html, darken }: { html: string; darken: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(120)
  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${BASE_CSS}${darken ? DARKEN_CSS : ''}</style></head><body>${html}</body></html>`,
    [html, darken],
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
