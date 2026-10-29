import { LoaderCircle, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { AiProvider, LabelDef, LabelEngine, PublicSettings, SettingsPatch, Snippet } from '../../../shared/types'
import { api, errorMessage } from '../lib'

interface Props {
  settings: PublicSettings
  onClose: () => void
  onSaved: (settings: PublicSettings) => void
}

const COLORS = ['#3b8cff', '#94a3b8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb7185', '#2dd4bf']

export function Settings({ settings, onClose, onSaved }: Props) {
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

        <div className="settings-body">
          <section>
            <h2>AI</h2>
            <div className="segmented">
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

          <section>
            <h2>Smart labels</h2>
            <p className="hint">
              New inbox mail is sorted into one of these labels with the AI SDK decisions API. Write each description the way you would explain it to an assistant. When you
              change a label by hand, later decisions see it as an example.
            </p>
            <label className="setup-field">
              <span>Decision model</span>
              <select value={engine} onChange={(e) => setEngine(e.target.value as LabelEngine)}>
                <option value="typesafe">TypeSafe Jev (fast, about $0.04 per million tokens)</option>
                <option value="openai">OpenAI (uses the API key above)</option>
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
                  <button
                    className="swatch"
                    style={{ background: l.color }}
                    title="Change color"
                    onClick={() => patchLabel(l.id, { color: COLORS[(COLORS.indexOf(l.color) + 1) % COLORS.length] })}
                  />
                  <input className="name" value={l.name} onChange={(e) => patchLabel(l.id, { name: e.target.value })} placeholder="Name" />
                  <input className="grow" value={l.description} onChange={(e) => patchLabel(l.id, { description: e.target.value })} placeholder="What belongs here" />
                  <button className="icon-button" title="Remove" onClick={() => setLabels((list) => list.filter((x) => x.id !== l.id))}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              <button
                className="ghost add"
                onClick={() => setLabels((list) => [...list, { id: crypto.randomUUID().slice(0, 8), name: '', description: '', color: COLORS[list.length % COLORS.length] }])}
              >
                <Plus size={13} /> Add label
              </button>
            </div>
          </section>

          <section>
            <h2>Snippets</h2>
            <p className="hint">Insert with ⌘J while writing.</p>
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
