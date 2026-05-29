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

/**
 * Detect any of the XML-ish wrapper tags Claude Code stores in transcript user
 * messages. Used as a cheap guard so plain user text passes through untouched.
 */
const TRANSCRIPT_TAG_RE =
  /<\/?(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder)>/

/**
 * Normalize a transcript user-message text for display.
 *
 * Claude Code wraps slash-command invocations and local-command output in
 * XML-ish tags inside the stored user message, e.g.
 *   <command-name>/clear</command-name>
 *   <command-message>clear</command-message>
 *   <command-args>foo</command-args>
 * Rendered verbatim these leak as literal markup. This collapses a command
 * invocation to a single `/clear foo` line, keeps local-command stdout as its
 * inner text, and strips injected blocks (caveats, system reminders) that carry
 * no meaning for the user. Text with no such tags is returned unchanged.
 */
export function normalizeTranscriptText(text: string): string {
  if (!TRANSCRIPT_TAG_RE.test(text)) return text

  let out = text
  // Drop blocks that are noise for the reader.
  out = out.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  out = out.replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
  // Keep local-command output, just unwrap it.
  out = out.replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, '$1')

  // Collapse a slash-command invocation into a single "/name args" line.
  const name = out.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (name) {
    const args = out.match(/<command-args>([\s\S]*?)<\/command-args>/)
    out = out.replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    out = out.replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    const cmd = name[1].trim()
    const arg = args?.[1]?.trim() ?? ''
    const cmdLine = arg ? `${cmd} ${arg}` : cmd
    // Trim the leftover body so removed tags don't leave blank lines, but keep
    // any internal newlines (e.g. multi-line local-command stdout) intact.
    const rest = out.trim()
    out = rest ? `${cmdLine}\n${rest}` : cmdLine
  }

  return out.trim()
}
