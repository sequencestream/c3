/**
 * Schedule auto-naming.
 *
 * On create, the server derives a short, human-readable `name` from the task
 * content (`command` for `command` schedules, `prompt` for `llm` schedules)
 * via the agent SDK. The client never supplies a name.
 *
 * Resilience: any LLM failure (timeout, empty result, throw) falls back to a
 * deterministic name derived from the task content, so `name` is always a
 * non-empty string. The LLM call is injected via `deps.invokeLlm` to keep the
 * generator unit-testable without the network.
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { CreateScheduleInput, ScheduleType } from '@ccc/shared/protocol'
import { findClaudeExecutable } from '../claude.js'

/** Max characters for a generated/fallback name. */
const MAX_NAME_LEN = 60

/** Wall-clock budget for the naming LLM call. */
const NAMING_TIMEOUT_MS = 15_000

function readStringField(config: unknown, key: string): string {
  if (config && typeof config === 'object' && key in config) {
    const v = (config as Record<string, unknown>)[key]
    if (typeof v === 'string') return v
  }
  return ''
}

/** Collapse whitespace, strip wrapping quotes, and clamp to MAX_NAME_LEN. */
function tidy(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim()
  // Strip a single layer of wrapping quotes the model sometimes adds.
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim()
  if (s.length > MAX_NAME_LEN) s = s.slice(0, MAX_NAME_LEN).trim()
  return s
}

/**
 * Deterministic, network-free name. Always returns a non-empty string:
 * - command → truncated command
 * - llm     → first sentence of the prompt
 * - empty   → a sensible default per type
 */
export function fallbackName(type: ScheduleType, config: unknown): string {
  if (type === 'command') {
    const cmd = tidy(readStringField(config, 'command'))
    return cmd || 'Command task'
  }
  const prompt = readStringField(config, 'prompt')
  // First sentence: up to the first sentence-ending punctuation or newline.
  const firstSentence = prompt.split(/(?<=[.!?。!?])|\n/)[0] ?? ''
  const tidied = tidy(firstSentence) || tidy(prompt)
  return tidied || 'LLM task'
}

/** Injectable LLM invocation; returns the model's raw text (may be empty). */
export type InvokeLlm = (prompt: string) => Promise<string>

export interface GenerateNameDeps {
  invokeLlm?: InvokeLlm
}

/** Default LLM invocation: a minimal, tool-free query() with a hard timeout. */
const defaultInvokeLlm: InvokeLlm = async (prompt) => {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), NAMING_TIMEOUT_MS)
  timer.unref()
  const claudePath = findClaudeExecutable()
  try {
    const q = query({
      prompt,
      options: {
        disallowedTools: ['Bash', 'Edit', 'Write', 'Read', 'Task', 'WebFetch', 'WebSearch'],
        permissionMode: 'default',
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      },
    })
    let text = ''
    for await (const m of q) {
      if (abort.signal.aborted) break
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string }
            if (b.type === 'text' && typeof b.text === 'string') text += b.text
          }
        }
      } else if (m.type === 'result') {
        break
      }
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

function buildNamingPrompt(type: ScheduleType, config: unknown): string {
  const body =
    type === 'command'
      ? `Shell command:\n${readStringField(config, 'command')}`
      : `LLM prompt:\n${readStringField(config, 'prompt')}`
  return [
    'Generate a concise, human-readable title for the scheduled task below.',
    'Rules: at most 6 words, plain English, no surrounding quotes, no trailing punctuation.',
    'Reply with the title only — nothing else.',
    '',
    body,
  ].join('\n')
}

/**
 * Produce a schedule name from its task content. Always resolves to a
 * non-empty string; on any LLM failure it falls back to {@link fallbackName}.
 */
export async function generateScheduleName(
  input: Pick<CreateScheduleInput, 'type' | 'config'>,
  deps: GenerateNameDeps = {},
): Promise<string> {
  const invoke = deps.invokeLlm ?? defaultInvokeLlm
  try {
    const raw = await invoke(buildNamingPrompt(input.type, input.config))
    const name = tidy(raw)
    if (name) return name
  } catch {
    // fall through to deterministic fallback
  }
  return fallbackName(input.type, input.config)
}
