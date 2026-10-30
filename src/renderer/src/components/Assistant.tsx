import { ArrowUp, CornerDownLeft, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AiTask, ChatTurn, MessageDetail } from '../../../shared/types'
import { aiStream, errorMessage, toContext, useAccount } from '../lib'

const SUGGESTIONS = ['Summarize this', 'What do they want from me?', 'List action items and deadlines', 'Draft a reply', 'Translate to English']

interface Props {
  message: MessageDetail | null
  onClose: () => void
  closeHint: string
  onUseAsReply: (text: string) => void
  /** Nonzero and new each time the daily brief is asked for from outside (the command palette); cleared through onBriefStarted. */
  briefRequest: number
  onBriefStarted: () => void
}

/** Turns about the daily brief rather than one message. */
const BRIEF = '\u0000brief'

/** A chat turn and what it is about: the brief, or the key of the message that was open. */
interface Turn extends ChatTurn {
  id: string
  about: string
}

export function Assistant({ message, onClose, closeHint, onUseAsReply, briefRequest, onBriefStarted }: Props) {
  const { account } = useAccount()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const cancel = useRef<(() => void) | null>(null)
  const streamingAbout = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  // A new message starts a new conversation about it. Only a real change counts, not React replaying the effect.
  // The brief is about all mail, so it stays (and keeps streaming); everything about the previous message goes.
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    const key = message?.key ?? ''
    if (shownFor.current === key) return
    shownFor.current = key
    if (streamingAbout.current !== null && streamingAbout.current !== BRIEF) cancel.current?.()
    setTurns((list) => list.filter((t) => t.about === BRIEF))
    setError('')
    inputRef.current?.focus()
  }, [message?.key])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [turns])

  // Each request runs once (the ref survives React's effect replay), after any answer still streaming is stopped.
  const briefDone = useRef(0)
  useEffect(() => {
    if (!briefRequest || briefDone.current === briefRequest) return
    if (streaming) return void cancel.current?.()
    briefDone.current = briefRequest
    onBriefStarted()
    void ask('Daily brief', true)
  }, [briefRequest, streaming])

  /** Asks a question, or with `brief` runs the daily brief, which follow-up questions can then refer to. */
  async function ask(text: string, brief = false) {
    const question = text.trim()
    if (!question || streaming) return
    const about = brief ? BRIEF : (message?.key ?? '')
    const id = String(Date.now())
    // A question sees the brief and what was said about this message, nothing about other messages.
    const history: ChatTurn[] = [...turns.filter((t) => t.about === BRIEF || t.about === about), { role: 'user' as const, text: question }].map(
      ({ role, text }) => ({ role, text }),
    )
    setTurns((list) => [...list, { id: `${id}:q`, role: 'user', text: question, about }, { id: `${id}:a`, role: 'assistant', text: '', about }])
    setInput('')
    setError('')
    setStreaming(true)
    streamingAbout.current = about
    const task: AiTask = brief ? { kind: 'brief' } : { kind: 'ask', message: message ? toContext(message) : undefined, history }
    const run = aiStream(account.id, task, (partial) => setTurns((list) => list.map((t) => (t.id === `${id}:a` ? { ...t, text: partial } : t))))
    cancel.current = run.cancel
    try {
      await run.done
    } catch (err) {
      setError(errorMessage(err))
      setTurns((list) => list.filter((t) => !t.id.startsWith(`${id}:`)))
    } finally {
      setStreaming(false)
      streamingAbout.current = null
      cancel.current = null
    }
  }

  return (
    <aside className="pane assistant">
      <div className="toolbar drag">
        <Sparkles size={15} color="var(--accent)" />
        <span className="assistant-title">Assistant</span>
        <span className="spacer" />
        <button className="icon-button" title={`Close  ${closeHint}`} onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="assistant-scroll" ref={scroller}>
        {message && <div className="context-chip">About: {message.subject}</div>}
        {turns.length === 0 && (
          <div className="suggestions">
            <button onClick={() => ask('Daily brief', true)}>Daily brief: what needs me today</button>
            {SUGGESTIONS.filter((s) => message || !/this|them|reply/i.test(s)).map((s) => (
              <button key={s} onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((turn, i) => (
          <div key={turn.id} className={`turn ${turn.role}`}>
            {turn.text || <span className="typing">Thinking</span>}
            {/* Only an answer about the open message can become its reply. */}
            {turn.role === 'assistant' && turn.text && message && turn.about === message.key && !(streaming && i === turns.length - 1) && (
              <button className="use-reply" onClick={() => onUseAsReply(turn.text)}>
                <CornerDownLeft size={12} /> Use as reply
              </button>
            )}
          </div>
        ))}
        {error && <div className="error-banner" style={{ margin: '8px 0' }}>{error}</div>}
      </div>

      <div className="assistant-input">
        <textarea
          ref={inputRef}
          value={input}
          rows={1}
          placeholder={message ? 'Ask about this email' : 'Ask anything'}
          onChange={(e) => setInput(e.target.value)}
          // No stopPropagation: the window's shortcut handler already ignores plain keys in fields, and ⌘ shortcuts must still work here.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask(input)
            } else if (e.key === 'Escape') onClose()
          }}
        />
        {streaming ? (
          <button className="send-round" title="Stop" onClick={() => cancel.current?.()}>
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="send-round" title="Send" disabled={!input.trim()} onClick={() => ask(input)}>
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </aside>
  )
}
