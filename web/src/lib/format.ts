/** Pretty-print a tool input/result value, falling back to String() on cycles. */
export function fmt(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// Collapse a multi-line string into a single line (newlines/extra whitespace removed).
// Truncation with "..." is handled by CSS (text-overflow: ellipsis).
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
