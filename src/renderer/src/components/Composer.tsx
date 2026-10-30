import { LoaderCircle, Paperclip, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AiTask, Draft, MessageContext, RewriteMode, ShortcutOverrides, Snippet } from '../../../shared/types'
import { AddressInput } from './AddressInput'
import { comboOf, formatCombo, isPlainKey, keymap, keysFor } from '../commands'
import { aiStream, api, type Contact, errorMessage, useAccount } from '../lib'

interface Props {
  initial: Draft
  title: string
  /** The message being answered, when this is a reply. */
  context?: MessageContext
  /** Start writing a reply as soon as the composer opens. */
  autoDraft?: boolean
  snippets: Snippet[]
  shortcuts: ShortcutOverrides
  contacts: Contact[]
  onClose: () => void
  onSent: () => void
  onDraftSaved: () => void
}

const REWRITES: Array<[RewriteMode, string]> = [
  ['improve', 'Improve'],
  ['shorten', 'Shorten'],
  ['friendlier', 'Friendlier'],
  ['formal', 'Formal'],
  ['fix', 'Fix spelling'],
]

export function Composer({ initial, title, context, autoDraft, snippets, shortcuts, contacts, onClose, onSent, onDraftSaved }: Props) {
  const [draft, setDraft] = useState(initial)
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [instruction, setInstruction] = useState('')
  const [writing, setWriting] = useState(false)
  const [selection, setSelection] = useState<[number, number]>([0, 0])
  const { account, mail } = useAccount()
  const [snippetQuery, setSnippetQuery] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [saved, setSaved] = useState(initial)
  const [savingDraft, setSavingDraft] = useState(false)
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
  const dirty =
    (['to', 'cc', 'bcc', 'subject', 'text'] as const).some((k) => draft[k] !== saved[k]) ||
    draft.attachments.length !== saved.attachments.length ||
    (draft.kept?.length ?? 0) !== (saved.kept?.length ?? 0)

  function close() {
    if (writing) cancel.current?.()
    // A native confirm() blocks the whole window in Electron, so ask inline instead.
    if (dirty && !confirmDiscard) return setConfirmDiscard(true)
    onClose()
  }

  /** Saves to the Drafts folder, replacing the earlier copy. Returns false when saving failed. */
  async function saveDraft(): Promise<boolean> {
    if (savingDraft) return false
    setSavingDraft(true)
    setError('')
    const submitted = draft
    try {
      const uid = await mail.saveDraft(submitted)
      // The new copy holds every attachment (stored ones first), so they are all "kept" from now on.
      const stored = uid
        ? {
            draftUid: uid,
            kept: [...(submitted.kept ?? []).map((k) => k.filename), ...submitted.attachments.map((p) => p.split('/').pop() ?? 'attachment')].map((filename, partId) => ({ partId, filename })),
            attachments: [] as string[],
          }
        : { draftUid: undefined }
      // Only the ids change; text typed while the save was in flight stays.
      setDraft((current) => ({
        ...current,
        ...stored,
        attachments: uid ? current.attachments.filter((p) => !submitted.attachments.includes(p)) : current.attachments,
      }))
      setSaved({ ...submitted, ...stored })
      onDraftSaved()
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setSavingDraft(false)
    }
  }

  async function saveAndClose() {
    if (await saveDraft()) onClose()
    else setConfirmDiscard(false)
  }

  async function stream(task: AiTask, place: (text: string) => string) {
    setWriting(true)
    setError('')
    const run = aiStream(account.id, task, (text) => set({ text: place(text) }))
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
      await stream({ kind: 'compose', instruction: instruction.trim(), subject: draft.subject }, (text) => `${text.trim()}${quote}`)
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
      await mail.send(draft)
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
  const keys = keymap(shortcuts, true)
  onKey.current = (e) => {
    const combo = comboOf(e) ?? ''
    // Everything in the composer is a text field, so single keys always type.
    const command = isPlainKey(combo) ? undefined : keys.get(combo)
    if (command === 'send') {
      e.preventDefault()
      void send()
    } else if (command === 'snippets') {
      e.preventDefault()
      setSnippetQuery((q) => (q === null ? '' : null))
    } else if (command === 'saveDraft') {
      e.preventDefault()
      void saveDraft()
    } else if (e.key === 'Escape') {
      // An open address suggestion list handles its own Escape.
      if ((e.target as HTMLElement).closest?.('.address-input')?.querySelector('.suggest')) return
      e.preventDefault()
      if (snippetQuery !== null) setSnippetQuery(null)
      else if (writing) cancel.current?.()
      else if (confirmDiscard) setConfirmDiscard(false)
      else close()
    } else if (e.key === 'Enter' && confirmDiscard) {
      // Enter takes the safe choice.
      e.preventDefault()
      void saveAndClose()
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
          <AddressInput ref={to} value={draft.to} onChange={(v) => set({ to: v })} contacts={contacts} />
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
              <AddressInput value={draft.cc} onChange={(v) => set({ cc: v })} contacts={contacts} />
            </div>
            <div className="field">
              <label>Bcc</label>
              <AddressInput value={draft.bcc} onChange={(v) => set({ bcc: v })} contacts={contacts} />
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

        {(draft.attachments.length > 0 || (draft.kept?.length ?? 0) > 0) && (
          <div className="composer-files">
            {draft.kept?.map((k) => (
              <span className="chip" key={`kept-${k.partId}`}>
                {k.filename}
                <button
                  className="icon-button"
                  style={{ width: 18, height: 18 }}
                  // Attachment ids are rewritten when a save lands, so hold changes until it does.
                  disabled={savingDraft}
                  onClick={() => set({ kept: draft.kept?.filter((x) => x.partId !== k.partId) })}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            {draft.attachments.map((path) => (
              <span className="chip" key={path}>
                {path.split('/').pop()}
                <button className="icon-button" style={{ width: 18, height: 18 }} disabled={savingDraft} onClick={() => set({ attachments: draft.attachments.filter((p) => p !== path) })}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {confirmDiscard && (
          <div className="discard-bar">
            <span>Save this message as a draft?</span>
            <span className="spacer" />
            <button className="ghost" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button className="ghost danger" onClick={onClose}>
              Discard
            </button>
            <button className="primary small" autoFocus onClick={saveAndClose} disabled={savingDraft}>
              {savingDraft ? 'Saving' : 'Save draft'}
            </button>
          </div>
        )}

        <div className="composer-foot">
          <button className="icon-button" title="Attach files" onClick={attach} disabled={savingDraft}>
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
            <span className="hint-inline">{writing ? 'Writing…' : `Select text to rewrite · ${formatCombo(keysFor('snippets', shortcuts)[0] ?? '')} snippets · ${formatCombo(keysFor('saveDraft', shortcuts)[0] ?? '')} save draft`}</span>
          )}
          <span className="spacer" />
          <button className="primary" onClick={send} disabled={sending || writing || !draft.to.trim()}>
            {sending && <LoaderCircle size={13} className="spin" />}
            {sending ? 'Sending' : 'Send'}
            {!sending && keysFor('send', shortcuts)[0] && <kbd>{formatCombo(keysFor('send', shortcuts)[0])}</kbd>}
          </button>
        </div>
      </div>
    </div>
  )
}
