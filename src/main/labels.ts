import { createOpenAI } from '@ai-sdk/openai'
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai'
import { experimental_decide, type Experimental_DecisionModel } from 'ai'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClassifyItem, Settings } from '../shared/types'
import { openaiKey, typesafeKey } from './settings'

interface Stored {
  label: string | null
  source: 'ai' | 'user'
}

interface Store {
  messages: Record<string, Stored>
  /** The user's own corrections, shown to the model as examples of how they sort mail. */
  corrections: Array<{ from: string; subject: string; label: string | null }>
}

const NONE = 'none'
const MIN_PROBABILITY = 0.5
const CONCURRENCY = 4
const file = () => join(app.getPath('userData'), 'labels.json')
let store: Store | null = null
let saveTimer: NodeJS.Timeout | null = null

async function load(): Promise<Store> {
  if (store) return store
  store = { messages: {}, corrections: [] }
  if (existsSync(file())) {
    try {
      store = { ...store, ...JSON.parse(await readFile(file(), 'utf8')) }
    } catch {
      // A corrupt cache only costs a re-classification.
    }
  }
  return store!
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void writeFile(file(), JSON.stringify(store)), 500)
}

function keyOf(item: ClassifyItem): string {
  return item.messageId || `${item.from}\u0000${item.subject}`
}

function decisionModel(settings: Settings): Experimental_DecisionModel | null {
  const engine = settings.labels.engine
  if (engine === 'typesafe' && typesafeKey(settings)) return createTypeSafeAi({ apiKey: typesafeKey(settings) }).decisionModel('jev-latest')
  if (engine === 'openai' && openaiKey(settings)) return createOpenAI({ apiKey: openaiKey(settings) }).decisionModel('gpt-6-luna')
  return null
}

/** Returns a label (or null) for every item: stored answers first, then one decision call per new message. */
export async function classify(items: ClassifyItem[], settings: Settings): Promise<Record<string, string | null>> {
  const s = await load()
  const valid = new Set(settings.labels.list.map((l) => l.id))
  const out: Record<string, string | null> = {}
  const todo: ClassifyItem[] = []
  for (const item of items) {
    const stored = s.messages[keyOf(item)]
    if (stored) out[item.key] = stored.label && valid.has(stored.label) ? stored.label : null
    else todo.push(item)
  }

  const model = decisionModel(settings)
  if (!model || todo.length === 0 || settings.labels.list.length === 0) return out

  const criteria: Record<string, string> = Object.fromEntries(settings.labels.list.map((l) => [l.id, `${l.name}: ${l.description}`]))
  criteria[NONE] = 'None of these labels clearly fits.'
  const instructions = {
    task: 'Which label fits this email best?',
    examples: s.corrections.slice(-12),
  }

  let next = 0
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++]
      try {
        const { answers } = await experimental_decide({
          model,
          state: { from: item.from, subject: item.subject, preview: item.preview.slice(0, 1200) },
          questions: { label: { type: 'choice', instructions, criteria } },
          maxRetries: 1,
        })
        const { choice, probabilities } = answers.label
        const p = probabilities?.[choice] ?? 1
        const label = choice !== NONE && p >= MIN_PROBABILITY ? choice : null
        s.messages[keyOf(item)] = { label, source: 'ai' }
        out[item.key] = label
      } catch {
        // Leave it unlabeled and try again next time the list loads.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
  save()
  return out
}

export async function setLabel(item: ClassifyItem, label: string | null): Promise<void> {
  const s = await load()
  s.messages[keyOf(item)] = { label, source: 'user' }
  s.corrections = [...s.corrections.filter((c) => !(c.from === item.from && c.subject === item.subject)), { from: item.from, subject: item.subject, label }].slice(-50)
  save()
}
