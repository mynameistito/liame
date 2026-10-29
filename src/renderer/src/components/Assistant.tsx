import { ArrowUp, CornerDownLeft, Sparkles, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChatTurn, MessageDetail } from '../../../shared/types'
import { aiStream, errorMessage, toContext } from '../lib'

const SUGGESTIONS = ['Summarize this', 'What do they want from me?', 'List action items and deadlines', 'Draft a reply', 'Translate to English']

interface Props {
  message: MessageDetail | null
  onClose: () => void
  onUseAsReply: (text: string) => void
}

export function Assistant({ message, onClose, onUseAsReply }: Props) {
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

  async function ask(text: string) {
    const question = text.trim()
    if (!question || streaming) return
    const history: ChatTurn[] = [...turns, { role: 'user', text: question }]
    setTurns([...history, { role: 'assistant', text: '' }])
    setInput('')
    setError('')
    setStreaming(true)
    const run = aiStream({ kind: 'ask', message: message ? toContext(message) : undefined, history }, (partial) =>
      setTurns([...history, { role: 'assistant', text: partial }]),
    )
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
        <button className="icon-button" title="Close  ⌘K" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="assistant-scroll" ref={scroller}>
        {message && <div className="context-chip">About: {message.subject}</div>}
        {turns.length === 0 && (
          <div className="suggestions">
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
            {turn.role === 'assistant' && turn.text && message && !(streaming && i === turns.length - 1) && (
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
          onKeyDown={(e) => {
            e.stopPropagation()
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
