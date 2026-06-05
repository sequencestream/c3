/**
 * Claude → canonical message translation (ADR-0011, D3 embedded-result ruling).
 * Two pure entry points so the contract tests exercise the mapping without
 * spawning a real run or touching disk:
 *  - {@link ClaudeStreamTranslator}: live wire frames → canonical stream;
 *  - {@link transcriptToCanonical}: replayed history items → canonical history.
 *
 * Both fold a tool's return INTO its `tool_use` block (D3): there is no
 * standalone `tool_result` canonical block. A live `tool_result` frame or a
 * replayed `tool_result` item updates the matching `tool_use` block in place
 * (id-upsert), back-filling `result`. An orphan result (no prior `tool_use`)
 * synthesizes a `tool_use` block named `unknown` carrying just the result.
 */
import type { ServerToClient, TranscriptItem } from '@ccc/shared/protocol'
import type { CanonicalBlock, CanonicalMessage } from '../types.js'

/** Injectable clock so tests get deterministic `ts`; defaults to wall time. */
type Clock = () => number

/**
 * Stateful per-run translator: turns the {@link ServerToClient} frames
 * `runClaude` emits into a canonical stream. Tracks `tool_use` ids so a later
 * `tool_result` frame can re-emit the same block with `result` filled. Frames
 * that are not canonical messages (`notice`, `turn_end`, `user_text`, …) return
 * `null` — the driver handles stream lifecycle (close on `turn_end`) separately.
 */
export class ClaudeStreamTranslator {
  private sessionId = ''
  private readonly tools = new Map<string, { name: string; input: unknown }>()

  constructor(private readonly now: Clock = Date.now) {}

  setSessionId(id: string): void {
    this.sessionId = id
  }

  private wrap(role: CanonicalMessage['role'], blocks: CanonicalBlock[]): CanonicalMessage {
    return { vendor: 'claude', sessionId: this.sessionId, role, ts: this.now(), blocks }
  }

  translate(frame: ServerToClient): CanonicalMessage | null {
    switch (frame.type) {
      case 'user_text':
        return this.wrap('user', [{ type: 'text', text: frame.text }])
      case 'assistant_text':
        return this.wrap('assistant', [{ type: 'text', text: frame.text }])
      case 'tool_use':
        this.tools.set(frame.toolUseId, { name: frame.toolName, input: frame.input })
        return this.wrap('assistant', [
          { type: 'tool_use', id: frame.toolUseId, name: frame.toolName, input: frame.input },
        ])
      case 'tool_result': {
        const prior = this.tools.get(frame.toolUseId)
        return this.wrap('assistant', [
          {
            type: 'tool_use',
            id: frame.toolUseId,
            name: prior?.name ?? 'unknown',
            input: prior?.input ?? {},
            result: { content: frame.content, isError: frame.isError },
          },
        ])
      }
      default:
        return null
    }
  }
}

/**
 * Replayed history → canonical, with tool results folded into their `tool_use`
 * block in place (D3). The returned messages share block object identity with
 * the index, so a `tool_result` mutates the already-emitted `tool_use` block.
 */
export function transcriptToCanonical(
  items: TranscriptItem[],
  sessionId: string,
  now: Clock = Date.now,
): CanonicalMessage[] {
  const out: CanonicalMessage[] = []
  const toolBlocks = new Map<string, Extract<CanonicalBlock, { type: 'tool_use' }>>()
  const wrap = (role: CanonicalMessage['role'], blocks: CanonicalBlock[]): CanonicalMessage => ({
    vendor: 'claude',
    sessionId,
    role,
    ts: now(),
    blocks,
  })

  for (const item of items) {
    switch (item.kind) {
      case 'user':
        out.push(wrap('user', [{ type: 'text', text: item.text }]))
        break
      case 'assistant':
        out.push(wrap('assistant', [{ type: 'text', text: item.text }]))
        break
      case 'tool_use': {
        const block: Extract<CanonicalBlock, { type: 'tool_use' }> = {
          type: 'tool_use',
          id: item.toolUseId,
          name: item.toolName,
          input: item.input,
        }
        toolBlocks.set(item.toolUseId, block)
        out.push(wrap('assistant', [block]))
        break
      }
      case 'tool_result': {
        const block = toolBlocks.get(item.toolUseId)
        if (block) {
          block.result = { content: item.content, isError: item.isError }
        } else {
          out.push(
            wrap('assistant', [
              {
                type: 'tool_use',
                id: item.toolUseId,
                name: 'unknown',
                input: {},
                result: { content: item.content, isError: item.isError },
              },
            ]),
          )
        }
        break
      }
      default:
        // notice (and any future non-content kind) is not a canonical message.
        break
    }
  }
  return out
}
