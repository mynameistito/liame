import { LoaderCircle, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { AiProvider, LabelDef, LabelEngine, Prefs, PublicSettings, SettingsPatch, ShortcutOverrides, Snippet } from '../../../shared/types'
import { COMMANDS, type CommandId, comboOf, formatCombo, keysFor } from '../commands'
import { api, errorMessage } from '../lib'

export type SettingsTab = 'general' | 'appearance' | 'ai' | 'labels' | 'snippets' | 'shortcuts'

interface Props {
  settings: PublicSettings
  initialTab?: SettingsTab
  onClose: () => void
  onSaved: (settings: PublicSettings) => void
}

const TABS: Array<[SettingsTab, string]> = [
  ['general', 'General'],
  ['appearance', 'Appearance'],
  ['ai', 'AI'],
  ['labels', 'Labels'],
  ['snippets', 'Snippets'],
  ['shortcuts', 'Shortcuts'],
]

const COLORS = ['#3b8cff', '#94a3b8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#2dd4bf']
const ACCENTS: Array<[string, string]> = [
  ['#3b8cff', 'Blue'],
  ['#8b7cff', 'Violet'],
  ['#34c77b', 'Green'],
  ['#ff9f0a', 'Orange'],
  ['#ff5c8a', 'Pink'],
  ['#e5e5ea', 'Graphite'],
]

export function Settings({ settings, initialTab = 'general', onClose, onSaved }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [prefs, setPrefs] = useState<Prefs>(settings.prefs)
  const [shortcuts, setShortcuts] = useState<ShortcutOverrides>(settings.shortcuts)
  const [provider, setProvider] = useState<AiProvider>(settings.ai.provider)
  const [model, setModel] = useState(settings.ai.model)
  const [codexPath, setCodexPath] = useState(settings.ai.codexPath)
  const [openaiKey, setOpenaiKey] = useState('')
  const [engine, setEngine] = useState<LabelEngine>(settings.labels.engine)
  const [typesafeKey, setTypesafeKey] = useState('')
  const [labels, setLabels] = useState<LabelDef[]>(settings.labels.list)
  const [snippets, setSnippets] = useState<Snippet[]>(settings.snippets)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const setPref = <K extends keyof Prefs>(key: K, value: Prefs[K]) => setPrefs((p) => ({ ...p, [key]: value }))

  async function loadModels() {
    setLoadingModels(true)
    setError('')
    try {
      // Models depend on the provider, so save the provider choice first.
      await api.saveSettings({ ai: { provider, codexPath, openaiKey: openaiKey || undefined } })
      const result = await api.aiModels()
      setModels(result.models)
      if (!model && result.defaultModel) setModel(result.defaultModel)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingModels(false)
    }
  }

  async function save() {
    setSaving(true)
    setError('')
    const patch: SettingsPatch = {
      ai: { provider, model: model.trim(), codexPath: codexPath.trim(), openaiKey: openaiKey || undefined },
      labels: {
        engine,
        typesafeKey: typesafeKey || undefined,
        list: labels.filter((l) => l.name.trim()).map((l) => ({ ...l, name: l.name.trim(), description: l.description.trim() })),
      },
      snippets: snippets.filter((s) => s.name.trim() && s.body.trim()),
      prefs,
      shortcuts,
    }
    try {
      onSaved(await api.saveSettings(patch))
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  const patchLabel = (id: string, patch: Partial<LabelDef>) => setLabels((list) => list.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  const patchSnippet = (id: string, patch: Partial<Snippet>) => setSnippets((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet settings" onKeyDown={(e) => (e.key === 'Escape' && onClose(), e.stopPropagation())}>
        <div className="composer-head">
          <span className="title">Settings</span>
          <button className="icon-button" title="Close  Esc" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="settings-tabs">
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'general' && (
            <section>
              <Row label="Mark as read">
                <select value={prefs.markRead} onChange={(e) => setPref('markRead', e.target.value as Prefs['markRead'])}>
                  <option value="immediately">When opened</option>
                  <option value="delay">After 2 seconds open</option>
                  <option value="never">Only with U</option>
                </select>
              </Row>
              <Row label="After archive or delete">
                <select value={prefs.afterMove} onChange={(e) => setPref('afterMove', e.target.value as Prefs['afterMove'])}>
                  <option value="next">Open the next (older) message</option>
                  <option value="previous">Open the previous (newer) message</option>
                  <option value="none">Return to the list</option>
                </select>
              </Row>
              <Row label="Conversations" hint="Group replies into one row per conversation, and show the whole conversation when you open it.">
                <Toggle on={prefs.conversations} onChange={(v) => setPref('conversations', v)} />
              </Row>
              <Row label="Remote images" hint="Blocking stops senders from seeing when you open their mail. Load them per message from the reader.">
                <Toggle on={prefs.remoteImages} onChange={(v) => setPref('remoteImages', v)} labels={['Blocked', 'Loaded']} />
              </Row>
              <Row label="Notifications" hint="Shows a macOS notification for new inbox mail while Liame is in the background.">
                <Toggle on={prefs.notifications} onChange={(v) => setPref('notifications', v)} />
              </Row>
              <label className="setup-field">
                <span>Signature</span>
                <textarea rows={3} value={prefs.signature} onChange={(e) => setPref('signature', e.target.value)} placeholder="Added to new messages and replies" />
              </label>
            </section>
          )}

          {tab === 'appearance' && (
            <section>
              <Row label="Accent">
                <div className="accents">
                  {ACCENTS.map(([color, name]) => (
                    <button key={color} title={name} className={`accent ${prefs.accent === color ? 'on' : ''}`} style={{ background: color }} onClick={() => setPref('accent', color)} />
                  ))}
                </div>
              </Row>
              <Row label="Message list">
                <div className="segmented">
                  {(['comfortable', 'compact', 'minimal'] as const).map((d) => (
                    <button key={d} className={prefs.density === d ? 'on' : ''} onClick={() => setPref('density', d)}>
                      {d === 'comfortable' ? 'Two-line preview' : d === 'compact' ? 'One-line preview' : 'No preview'}
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="Text size">
                <div className="segmented">
                  {[0.9, 1, 1.1, 1.2].map((z) => (
                    <button key={z} className={prefs.zoom === z ? 'on' : ''} onClick={() => setPref('zoom', z)}>
                      {Math.round(z * 100)}%
                    </button>
                  ))}
                </div>
              </Row>
              <Row label="HTML email" hint="Darkening inverts light newsletters to true black. You can switch per message with the sun button.">
                <Toggle on={prefs.darkenEmails} onChange={(v) => setPref('darkenEmails', v)} labels={['Original colors', 'Darkened']} />
              </Row>
            </section>
          )}

          {tab === 'ai' && (
            <section>
              <div className="segmented" style={{ marginBottom: 14 }}>
                <button className={provider === 'chatgpt' ? 'on' : ''} onClick={() => setProvider('chatgpt')}>
                  ChatGPT subscription
                </button>
                <button className={provider === 'openai' ? 'on' : ''} onClick={() => setProvider('openai')}>
                  OpenAI API key
                </button>
              </div>
              {provider === 'chatgpt' ? (
                <label className="setup-field">
                  <span>Codex CLI</span>
                  <input value={codexPath} onChange={(e) => setCodexPath(e.target.value)} placeholder="Found automatically" spellCheck={false} />
                  <small>
                    Uses your ChatGPT plan through the official Codex CLI. Sign in once with <code>codex login</code>. Codex runs read-only here: no shell, no files.
                  </small>
                </label>
              ) : (
                <label className="setup-field">
                  <span>OpenAI API key</span>
                  <input type="password" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} placeholder={settings.ai.hasOpenaiKey ? 'Set (saved or OPENAI_API_KEY). Type to replace' : 'sk-...'} />
                </label>
              )}
              <label className="setup-field">
                <span>Model</span>
                <div className="inline">
                  <input list="liame-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Default" spellCheck={false} />
                  <datalist id="liame-models">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <button className="ghost" onClick={loadModels} disabled={loadingModels}>
                    {loadingModels ? <LoaderCircle size={13} className="spin" /> : 'Load models'}
                  </button>
                </div>
              </label>
            </section>
          )}

          {tab === 'labels' && (
            <section>
              <p className="hint">
                New inbox mail is sorted into one of these labels with the AI SDK decisions API. Write each description the way you would explain it to an assistant. When
                you change a label by hand, later decisions see it as an example.
              </p>
              <label className="setup-field">
                <span>Decision model</span>
                <select value={engine} onChange={(e) => setEngine(e.target.value as LabelEngine)}>
                  <option value="typesafe">TypeSafe Jev (fast, about $0.04 per million tokens)</option>
                  <option value="openai">OpenAI (uses the API key from the AI tab)</option>
                  <option value="off">Off</option>
                </select>
              </label>
              {engine === 'typesafe' && (
                <label className="setup-field">
                  <span>TypeSafe API key</span>
                  <input type="password" value={typesafeKey} onChange={(e) => setTypesafeKey(e.target.value)} placeholder={settings.labels.hasTypesafeKey ? 'Set (saved or TYPESAFE_API_KEY). Type to replace' : 'From console.typesafe.ai'} />
                </label>
              )}
              <div className="rows">
                {labels.map((l) => (
                  <div className="edit-row" key={l.id}>
                    <button className="swatch" style={{ background: l.color }} title="Change color" onClick={() => patchLabel(l.id, { color: COLORS[(COLORS.indexOf(l.color) + 1) % COLORS.length] })} />
                    <input className="name" value={l.name} onChange={(e) => patchLabel(l.id, { name: e.target.value })} placeholder="Name" />
                    <input className="grow" value={l.description} onChange={(e) => patchLabel(l.id, { description: e.target.value })} placeholder="What belongs here" />
                    <button className="icon-button" title="Remove" onClick={() => setLabels((list) => list.filter((x) => x.id !== l.id))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <button className="ghost add" onClick={() => setLabels((list) => [...list, { id: crypto.randomUUID().slice(0, 8), name: '', description: '', color: COLORS[list.length % COLORS.length] }])}>
                  <Plus size={13} /> Add label
                </button>
              </div>
            </section>
          )}

          {tab === 'snippets' && (
            <section>
              <p className="hint">Insert with {formatCombo(keysFor('snippets', shortcuts)[0] ?? 'Meta+j')} while writing.</p>
              <div className="rows">
                {snippets.map((s) => (
                  <div className="edit-row snippet" key={s.id}>
                    <input className="name" value={s.name} onChange={(e) => patchSnippet(s.id, { name: e.target.value })} placeholder="Name" />
                    <textarea className="grow" value={s.body} onChange={(e) => patchSnippet(s.id, { body: e.target.value })} placeholder="Text" rows={2} />
                    <button className="icon-button" title="Remove" onClick={() => setSnippets((list) => list.filter((x) => x.id !== s.id))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <button className="ghost add" onClick={() => setSnippets((list) => [...list, { id: crypto.randomUUID().slice(0, 8), name: '', body: '' }])}>
                  <Plus size={13} /> Add snippet
                </button>
              </div>
            </section>
          )}

          {tab === 'shortcuts' && <ShortcutEditor overrides={shortcuts} onChange={setShortcuts} />}
        </div>

        <div className="composer-foot">
          {error ? <span className="error">{error}</span> : <span className="spacer" />}
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pref-row">
      <div className="pref-label">
        {label}
        {hint && <small>{hint}</small>}
      </div>
      <div className="pref-control">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange, labels }: { on: boolean; onChange: (on: boolean) => void; labels?: [string, string] }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="knob" />
      {labels && <span className="toggle-label">{on ? labels[1] : labels[0]}</span>}
    </button>
  )
}

function ShortcutEditor({ overrides, onChange }: { overrides: ShortcutOverrides; onChange: (next: ShortcutOverrides) => void }) {
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [notice, setNotice] = useState('')

  // While recording, the next key press (other than Esc) becomes the shortcut. Capture phase so nothing else reacts.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') return setRecording(null)
      const combo = comboOf(e)
      if (!combo) return
      const target = COMMANDS.find((c) => c.id === recording)!
      const next: ShortcutOverrides = { ...overrides }
      // A key belongs to one command per scope; take it from whoever had it.
      const owner = COMMANDS.find((c) => c.id !== recording && Boolean(c.composer) === Boolean(target.composer) && keysFor(c.id, next).includes(combo))
      if (owner) next[owner.id] = keysFor(owner.id, next).filter((k) => k !== combo)
      next[recording] = [...keysFor(recording, next).filter((k) => k !== combo), combo]
      setNotice(owner ? `${formatCombo(combo)} moved from “${owner.title}”.` : '')
      onChange(next)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, overrides, onChange])

  const groups = [...new Set(COMMANDS.map((c) => c.group))]
  return (
    <section className="shortcuts">
      <div className="shortcuts-head">
        <p className="hint">Click + and press the new keys. Single keys only work outside text fields.</p>
        <button className="ghost" onClick={() => (onChange({}), setNotice('All shortcuts reset.'))} disabled={Object.keys(overrides).length === 0}>
          <RotateCcw size={12} /> Reset all
        </button>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {groups.map((group) => (
        <div key={group} className="shortcut-group">
          <h3>{group}</h3>
          {COMMANDS.filter((c) => c.group === group).map((c) => {
            const keys = keysFor(c.id, overrides)
            return (
              <div key={c.id} className="shortcut-row">
                <span className="shortcut-title">{c.title}</span>
                <div className="shortcut-keys">
                  {keys.map((k) => (
                    <span key={k} className="keycap">
                      {formatCombo(k)}
                      <button title="Remove" onClick={() => onChange({ ...overrides, [c.id]: keys.filter((x) => x !== k) })}>
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  <button className={`keycap add ${recording === c.id ? 'recording' : ''}`} onClick={() => setRecording(recording === c.id ? null : c.id)}>
                    {recording === c.id ? 'Press keys…' : <Plus size={11} />}
                  </button>
                  {c.id in overrides && (
                    <button
                      className="icon-button reset"
                      title="Reset to default"
                      onClick={() => {
                        const next = { ...overrides }
                        delete next[c.id]
                        // The defaults come back, so take them from any command that holds them now.
                        for (const other of COMMANDS) {
                          if (other.id === c.id || Boolean(other.composer) !== Boolean(c.composer)) continue
                          const held = keysFor(other.id, next)
                          if (held.some((k) => c.keys.includes(k))) next[other.id] = held.filter((k) => !c.keys.includes(k))
                        }
                        onChange(next)
                      }}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </section>
  )
}
