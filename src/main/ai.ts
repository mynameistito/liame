import { createOpenAI } from '@ai-sdk/openai'
import { streamText, type LanguageModel, type ModelMessage } from 'ai'
import { createCodexAppServer, type CodexAppServerProvider } from 'ai-sdk-provider-codex-cli'
import { execFile } from 'node:child_process'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import type { AccountConfig, AiEvent, AiTask, MessageContext, RewriteMode, Settings } from '../shared/types'
import { openaiKey } from './settings'

const run = promisify(execFile)
const MAX_BODY = 12_000

let codex: { provider: CodexAppServerProvider; path: string } | null = null
let resolvedCodexPath: Promise<string> | null = null
const running = new Map<string, AbortController>()

/** Apps opened from Finder do not inherit the shell PATH (fnm, nvm, Homebrew), so ask a login shell once. */
function findCodex(): Promise<string> {
  resolvedCodexPath ??= run('/bin/zsh', ['-ilc', 'command -v codex'], { timeout: 10_000 })
    .then(({ stdout }) => stdout.trim().split('\n').pop() ?? '')
    .catch(() => '')
  return resolvedCodexPath
}

async function codexProvider(settings: Settings): Promise<CodexAppServerProvider> {
  const path = settings.ai.codexPath || (await findCodex())
  if (!path) throw new Error('Codex CLI not found. Install it with `npm i -g @openai/codex`, run `codex login`, or set its path in Settings.')
  if (codex?.path === path) return codex.provider
  await codex?.provider.close()
  const provider = createCodexAppServer({
    defaultSettings: {
      codexPath: path,
      env: { PATH: `${dirname(path)}:${process.env.PATH ?? '/usr/bin:/bin'}` },
      logger: false,
      // Codex is only used as a writer here: no shell, no file access, nothing to approve.
      sandboxPolicy: 'read-only',
      approvalPolicy: 'never',
      autoApprove: false,
      personality: 'none',
      effort: 'low',
      idleTimeoutMs: 15 * 60_000,
    },
  })
  codex = { provider, path }
  return provider
}

async function languageModel(settings: Settings): Promise<{ model: LanguageModel; system: 'base' | 'messages' }> {
  if (settings.ai.provider === 'openai') {
    if (!openaiKey(settings)) throw new Error('Add an OpenAI API key in Settings.')
    return { model: createOpenAI({ apiKey: openaiKey(settings) })(settings.ai.model || 'gpt-6-luna'), system: 'messages' }
  }
  const provider = await codexProvider(settings)
  return { model: provider(settings.ai.model || 'gpt-6-luna'), system: 'base' }
}

export async function listModels(settings: Settings): Promise<{ models: string[]; defaultModel?: string }> {
  if (settings.ai.provider === 'openai') return { models: ['gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5'], defaultModel: 'gpt-6-luna' }
  const provider = await codexProvider(settings)
  const { models, defaultModel } = await provider.listModels()
  return { models: models.filter((m) => !m.hidden).map((m) => m.id), defaultModel: defaultModel?.id }
}

/** Streams a task's output. `prepare` adds context first (the conversation, the brief's mail); Stop works during it too. */
export async function startTask(
  id: string,
  task: AiTask,
  settings: Settings,
  account: AccountConfig,
  emit: (event: AiEvent) => void,
  prepare: (task: AiTask) => Promise<AiTask> = async (t) => t,
) {
  const controller = new AbortController()
  running.set(id, controller)
  try {
    task = await prepare(task)
    if (controller.signal.aborted) return emit({ id, done: true })
    const { model, system } = await languageModel(settings)
    const instructions = systemPrompt(account)
    const messages = buildMessages(task)
    const result = streamText({
      model,
      messages,
      abortSignal: controller.signal,
      maxRetries: 1,
      // Codex takes its system prompt as base instructions so its own coding persona is replaced.
      ...(system === 'base'
        ? { providerOptions: { 'codex-app-server': { baseInstructions: instructions } } }
        : { system: instructions }),
    })
    for await (const delta of result.textStream) emit({ id, delta })
    emit({ id, done: true })
  } catch (error) {
    if (controller.signal.aborted) emit({ id, done: true })
    else emit({ id, error: describe(error) })
  } finally {
    running.delete(id)
  }
}

export function cancelTask(id: string): void {
  running.get(id)?.abort()
}

export async function closeAi(): Promise<void> {
  for (const controller of running.values()) controller.abort()
  await codex?.provider.close()
  codex = null
}

function systemPrompt(account: AccountConfig): string {
  return [
    `You write and edit email for ${account.name} <${account.email}>.`,
    'Write the way a busy, friendly professional writes: plain, direct, short. No filler, no flattery, no em dashes.',
    'Reply in the language of the email being answered, or of the text being edited.',
    'Never add a subject line, greeting placeholders, or a signature block unless asked. Sign off with just the first name only when the thread does that.',
    'If something you cannot know is needed (a date, a price, a decision), leave a short [bracketed placeholder] instead of inventing it.',
    'Output only the requested text, without quotes or commentary.',
  ].join('\n')
}

const REWRITE: Record<RewriteMode, string> = {
  improve: 'Improve the clarity and flow of this text. Keep the meaning, language, and roughly the length.',
  shorten: 'Make this text noticeably shorter while keeping every point that matters.',
  friendlier: 'Make this text warmer and friendlier without making it longer or gushing.',
  formal: 'Make this text more formal and polished, suitable for a client or someone senior.',
  fix: 'Fix spelling, grammar, and punctuation only. Change nothing else.',
}

function quoteMessage(m: MessageContext): string {
  return [`From: ${m.from}`, `To: ${m.to}`, `Date: ${m.date}`, `Subject: ${m.subject}`, '', m.text.slice(0, MAX_BODY)].join('\n')
}

/** The email, preceded by the rest of its conversation when there is one. */
function quoteWithConversation(m: MessageContext): string {
  const email = `<email>\n${quoteMessage(m)}\n</email>`
  if (!m.conversation?.length) return email
  const others = m.conversation.map((c) => `<message>\n${quoteMessage(c)}\n</message>`).join('\n')
  return `<conversation note="the other messages of this thread, oldest first">\n${others}\n</conversation>\n\n${email}`
}

function buildMessages(task: AiTask): ModelMessage[] {
  switch (task.kind) {
    case 'reply':
      return [
        {
          role: 'user',
          content: [
            'Write my reply to this email.',
            task.message.conversation?.length
              ? "The rest of the conversation comes first. Use it so the reply doesn't repeat or contradict what was already said."
              : '',
            task.instruction ? `What I want to say: ${task.instruction}` : 'Write the reply I would most likely send.',
            task.draft?.trim() ? `Build on what I already started writing:\n${task.draft.trim()}` : '',
            '',
            quoteWithConversation(task.message),
          ]
            .filter((line) => line !== '')
            .join('\n'),
        },
      ]
    case 'compose':
      return [
        {
          role: 'user',
          content: `Write a new email body.${task.subject ? ` Subject: ${task.subject}.` : ''}\nWhat it should say: ${task.instruction}`,
        },
      ]
    case 'brief':
      return [
        {
          role: 'user',
          content: [
            `Give me a short brief of my mail. It is now ${new Date().toString()}. Plain text, no headings or bold.`,
            'Start with what needs a reply or a decision from me, one line each: who, what they need, and any deadline.',
            'Then one line naming the rest that is worth reading. Skip newsletters, notifications, and receipts unless something in them needs action.',
            'End with replies I am still waiting for and what is coming up today. Leave that out entirely when there are none.',
            'If nothing at all needs a reply or decision, say just "Nothing urgent." and stop.',
            'Keep it under 150 words. Do not invent anything that is not in the list.',
            '',
            '<mail>',
            task.digest || 'No unread mail and nothing scheduled.',
            '</mail>',
          ].join('\n'),
        },
      ]
    case 'rewrite':
      return [{ role: 'user', content: `${REWRITE[task.mode]}\n\n<text>\n${task.text}\n</text>` }]
    case 'ask': {
      const context = task.message
        ? `I am looking at this email. Answer questions about it and its conversation, and when I ask for a reply or draft, write only the draft.\n\n${quoteWithConversation(task.message)}`
        : 'Help me with my email.'
      return [
        { role: 'user', content: context },
        { role: 'assistant', content: 'Understood.' },
        ...task.history.map((turn): ModelMessage => ({ role: turn.role, content: turn.text })),
      ]
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/auth|login|401|unauthor/i.test(message)) return 'The AI provider rejected the sign-in. For ChatGPT, run `codex login` in a terminal; for OpenAI, check the API key.'
  return message
}
