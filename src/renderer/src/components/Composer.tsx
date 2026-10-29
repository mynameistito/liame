import { LoaderCircle, Paperclip, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Draft, MessageContext, RewriteMode, Snippet } from '../../../shared/types'
import { aiStream, api, errorMessage } from '../lib'

interface Props {
  initial: Draft
  title: string
  /** The message being answered, when this is a reply. */
  context?: MessageContext
  /** Start writing a reply as soon as the composer opens. */
  autoDraft?: boolean
  snippets: Snippet[]
  onClose: () => void
  onSent: () => void
}

const REWRITES: Array<[RewriteMode, string]> = [
  ['improve', 'Improve'],
  ['shorten', 'Shorten'],
  ['friendlier', 'Friendlier'],
  ['formal', 'Formal'],
  ['fix', 'Fix spelling'],
]

export function Composer({ initial, title, context, autoDraft, snippets, onClose, onSent }: Props) {
  const [draft, setDraft] = useState(initial)
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [instruction, setInstruction] = useState('')
  const [writing, setWriting] = useState(false)
  const [selection, setSelection] = useState<[number, number]>([0, 0])
  const [snippetQuery, setSnippetQuery] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const body = useRef<HTMLTextAreaElement>(null)
  const to = useRef<HTMLInputElement>(null)
  const cancel = useRef<(() => void) | null>(null)

  // The quoted original sits at the end of a reply's body; AI output goes above it.
  const quote = initial.text
  const own = draft.text.endsWith(quote) ? draft.text.slice(0, draft.text.length - quote.length) : draft.text

  useEffect(() => {
    if (autoDraft) void write()
    else if (initial.to) {
      body.current?.focus()
      body.current?.setSelectionRange(0, 0)
    } else to.current?.focus()
    return () => cancel.current?.()
  }, [])

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const dirty = draft.text !== initial.text || draft.to !== initial.to || draft.subject !== initial.subject

  function close() {
    if (writing) cancel.current?.()
    // A native confirm() blocks the whole window in Electron, so ask inline instead.
    if (dirty && !confirmDiscard) return setConfirmDiscard(true)
    onClose()
  }

  async function stream(task: Parameters<typeof aiStream>[0], place: (text: string) => string) {
    setWriting(true)
    setError('')
    const run = aiStream(task, (text) => set({ text: place(text) }))
    cancel.current = run.cancel
    try {
      await run.done
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setWriting(false)
      cancel.current = null
      body.current?.focus()
    }
  }

  async function write() {
    if (writing) return
    const started = own.trim()
    if (context) {
      await stream({ kind: 'reply', message: context, instruction: instruction.trim() || undefined, draft: started }, (text) => `${text.trim()}${quote}`)
    } else {
      if (!instruction.trim()) return setError('Tell the AI what to write.')
      await stream({ kind: 'compose', instruction: instruction.trim(), subject: draft.subject }, (text) => text.trim())
    }
    setInstruction('')
  }

  async function rewrite(mode: RewriteMode) {
    const [start, end] = selection
    const text = draft.text.slice(start, end)
    if (!text.trim() || writing) return
    const before = draft.text.slice(0, start)
    const after = draft.text.slice(end)
    await stream({ kind: 'rewrite', text, mode }, (result) => `${before}${result}${after}`)
    setSelection([0, 0])
  }

  function insertSnippet(snippet: Snippet) {
    const el = body.current
    const at = el ? el.selectionStart : draft.text.length
    set({ text: draft.text.slice(0, at) + snippet.body + draft.text.slice(at) })
    setSnippetQuery(null)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + snippet.body.length, at + snippet.body.length)
    })
  }

  async function send() {
    if (sending || writing) return
    setSending(true)
    setError('')
    try {
      await api.send(draft)
      onSent()
    } catch (err) {
      setError(errorMessage(err))
      setSending(false)
    }
  }

  async function attach() {
    const files = await api.pickAttachments()
    if (files.length) set({ attachments: [...new Set([...draft.attachments, ...files])] })
  }

  function readSelection() {
    const el = body.current
    if (el) setSelection([el.selectionStart, el.selectionEnd])
  }

  // Window-level so the shortcuts work even when focus has fallen out of the composer (e.g. after the snippet picker closes).
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {})
  onKey.current = (e) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      void send()
    } else if (e.key === 'j' && e.metaKey) {
      e.preventDefault()
      setSnippetQuery((q) => (q === null ? '' : null))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (snippetQuery !== null) setSnippetQuery(null)
      else if (writing) cancel.current?.()
      else if (confirmDiscard) setConfirmDiscard(false)
      else close()
    } else if (e.key === 'Enter' && confirmDiscard) {
      e.preventDefault()
      onClose()
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [])

  const hasSelection = selection[1] > selection[0]
  const matches = snippetQuery === null ? [] : snippets.filter((s) => s.name.toLowerCase().includes(snippetQuery.toLowerCase()))

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="composer" onKeyDown={(e) => e.stopPropagation()}>
        <div className="composer-head">
          <span className="title">{draft.subject || title}</span>
          <button className="icon-button" title="Close  Esc" onClick={close}>
            <X size={15} />
          </button>
        </div>

        <div className="field">
          <label>To</label>
          <input ref={to} value={draft.to} onChange={(e) => set({ to: e.target.value })} spellCheck={false} />
          {!showCc && (
            <button className="link" onClick={() => setShowCc(true)}>
              Cc Bcc
            </button>
          )}
        </div>
        {showCc && (
          <>
            <div className="field">
              <label>Cc</label>
              <input value={draft.cc} onChange={(e) => set({ cc: e.target.value })} spellCheck={false} />
            </div>
            <div className="field">
              <label>Bcc</label>
              <input value={draft.bcc} onChange={(e) => set({ bcc: e.target.value })} spellCheck={false} />
            </div>
          </>
        )}
        <div className="field">
          <label>Subject</label>
          <input value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
        </div>

        <div className="ai-bar">
          <Sparkles size={14} />
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={context ? 'Tell AI what to reply, or press Enter to draft it' : 'Tell AI what to write'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey) {
                e.preventDefault()
                void write()
              }
            }}
            disabled={writing}
          />
          {writing ? (
            <button className="ghost" onClick={() => cancel.current?.()}>
              <Square size={10} fill="currentColor" /> Stop
            </button>
          ) : (
            <button className="ghost" onClick={write}>
              {context ? 'Draft reply' : 'Write'}
            </button>
          )}
        </div>

        <div className="body-wrap">
          <textarea
            ref={body}
            value={draft.text}
            readOnly={writing}
            className={writing ? 'writing' : undefined}
            onChange={(e) => set({ text: e.target.value })}
            // React's onSelect misses some keyboard selections, so read the range on every way it can change.
            onSelect={readSelection}
            onKeyUp={readSelection}
            onMouseUp={readSelection}
          />
          {snippetQuery !== null && (
            <div className="snippet-picker">
              <input
                autoFocus
                value={snippetQuery}
                placeholder="Insert snippet"
                onChange={(e) => setSnippetQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches[0]) {
                    e.preventDefault()
                    insertSnippet(matches[0])
                  }
                }}
              />
              {matches.map((s) => (
                <button key={s.id} onClick={() => insertSnippet(s)}>
                  <span>{s.name}</span>
                  <small>{s.body}</small>
                </button>
              ))}
              {matches.length === 0 && <div className="empty">No snippets. Add them in Settings.</div>}
            </div>
          )}
        </div>

        {draft.attachments.length > 0 && (
          <div className="composer-files">
            {draft.attachments.map((path) => (
              <span className="chip" key={path}>
                {path.split('/').pop()}
                <button className="icon-button" style={{ width: 18, height: 18 }} onClick={() => set({ attachments: draft.attachments.filter((p) => p !== path) })}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {confirmDiscard && (
          <div className="discard-bar">
            <span>Discard this message?</span>
            <span className="spacer" />
            <button className="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button className="ghost danger" autoFocus onClick={onClose}>
              Discard
            </button>
          </div>
        )}

        <div className="composer-foot">
          <button className="icon-button" title="Attach files" onClick={attach}>
            <Paperclip size={15} />
          </button>
          {hasSelection && !writing ? (
            <div className="rewrite">
              {REWRITES.map(([mode, label]) => (
                <button key={mode} onMouseDown={(e) => e.preventDefault()} onClick={() => rewrite(mode)}>
                  {label}
                </button>
              ))}
            </div>
          ) : error ? (
            <span className="error">{error}</span>
          ) : (
            <span className="hint-inline">{writing ? 'Writing…' : 'Select text to rewrite · ⌘J snippets'}</span>
          )}
          <span className="spacer" />
          <button className="primary" onClick={send} disabled={sending || writing || !draft.to.trim()}>
            {sending && <LoaderCircle size={13} className="spin" />}
            {sending ? 'Sending' : 'Send'}
            {!sending && <kbd>⌘↵</kbd>}
          </button>
        </div>
      </div>
    </div>
  )
}
