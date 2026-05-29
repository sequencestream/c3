/**
 * Pure formatting helpers for mapping SDK message shapes to the wire protocol.
 * Kept dependency-free so it can be unit-tested in isolation.
 */

/**
 * Flatten an SDK `tool_result` content field into a single display string.
 * - string → returned as-is
 * - array  → text blocks joined by newline; non-text blocks JSON-stringified
 * - other  → JSON-stringified
 */
export function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: string; text?: string }
        if (b?.type === 'text' && typeof b.text === 'string') return b.text
        return JSON.stringify(c)
      })
      .join('\n')
  }
  return JSON.stringify(content)
}
