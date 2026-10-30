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
  /** Set when the daily brief is asked for from outside (the command palette); cleared through onBriefStarted. */
  briefRequest: boolean
  onBriefStarted: () => void
}

export function Assistant({ message, onClose, closeHint, onUseAsReply, briefRequest, onBriefStarted }: Props) {
  const { account } = useAccount()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState('')
  const cancel = useRef<(() => void) | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  // A new message starts a new conversation.
  useEffect(() => {
    cancel.current?.()
    setTurns([])
    setError('')
    inputRef.current?.focus()
  }, [message?.uid])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [turns])

  useEffect(() => {
    if (!briefRequest) return
    onBriefStarted()
    void ask('Daily brief', true)
  }, [briefRequest])

  /** Asks a question, or with `brief` runs the daily brief, which follow-up questions can then refer to. */
  async function ask(text: string, brief = false) {
    const question = text.trim()
    if (!question || streaming) return
    const history: ChatTurn[] = [...turns, { role: 'user', text: question }]
    setTurns([...history, { role: 'assistant', text: '' }])
    setInput('')
    setError('')
    setStreaming(true)
    const task: AiTask = brief ? { kind: 'brief' } : { kind: 'ask', message: message ? toContext(message) : undefined, history }
    const run = aiStream(account.id, task, (partial) => setTurns([...history, { role: 'assistant', text: partial }]))
    cancel.current = run.cancel
    try {
      await run.done
    } catch (err) {
      setError(errorMessage(err))
      setTurns(history)
    } finally {
      setStreaming(false)
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
          <div key={i} className={`turn ${turn.role}`}>
            {turn.text || <span className="typing">Thinking</span>}
            {turn.role === 'assistant' && turn.text && message && turns[i - 1]?.text !== 'Daily brief' && !(streaming && i === turns.length - 1) && (
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
