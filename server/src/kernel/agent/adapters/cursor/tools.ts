/**
 * Cursor's native tool inventory, keyed by the name the SDK stream carries.
 *
 * A `tool_call` message names its tool with the discriminant of the SDK's own
 * `ToolCall` union (`read`, `shell`, `semSearch`, …), so these keys are both the
 * wire identity and the console-visible name — there is no wrapper key to strip
 * and no display translation to do.
 *
 * The six neutral categories below are what the risk layer reasons over, so a
 * new Cursor tool is classified by what it *does* rather than by what it is
 * called. `edit` covers anything that mutates files, `execute` anything that
 * runs code, `read`/`search` the two non-mutating filesystem shapes, `network`
 * anything that leaves the machine, and `meta` the in-conversation bookkeeping
 * tools that touch neither disk nor network.
 *
 * Only tools present in the SDK's `ToolCall` union are listed. An unlisted tool
 * is deliberately NOT given a default category: {@link cursorToolCategory}
 * returns `undefined` so the risk layer keeps it `unknown-tool` and fails closed.
 */

/** What a Cursor tool does, in vendor-neutral terms. */
export type CursorToolCategory = 'read' | 'search' | 'edit' | 'execute' | 'network' | 'meta'

/**
 * Tool name → neutral category. Sourced from the SDK's `ToolCall` union; every
 * entry is a name the stream can actually emit.
 */
export const CURSOR_TOOL_CATEGORIES: Readonly<Record<string, CursorToolCategory>> = {
  // Read the filesystem without changing it.
  read: 'read',
  ls: 'read',
  readLints: 'read',

  // Locate things; non-mutating but broader than a single read.
  glob: 'search',
  grep: 'search',
  semSearch: 'search',

  // Mutate files.
  write: 'edit',
  edit: 'edit',
  delete: 'edit',

  // Run code / drive the machine.
  shell: 'execute',
  recordScreen: 'execute',

  // Leave the machine. `mcp` is the model's call into an attached MCP server:
  // where it goes is the server's business, so it is treated as network-reaching.
  mcp: 'network',
  generateImage: 'network',

  // In-conversation bookkeeping: no disk, no network.
  task: 'meta',
  createPlan: 'meta',
  updateTodos: 'meta',

  // The headless conversation's own question to the human: c3 intercepts it and
  // answers via a `--resume` subprocess, never as a write or a network call.
  askQuestion: 'meta',
}

/** Categories whose tools change state — everything else is read-only. */
const WRITE_CATEGORIES: ReadonlySet<CursorToolCategory> = new Set<CursorToolCategory>([
  'edit',
  'execute',
  'network',
])

/**
 * The neutral category of a native tool, or `undefined` when the tool is not in
 * the SDK's union. Callers must treat `undefined` as unknown-and-unsafe rather
 * than substituting a default.
 */
export function cursorToolCategory(name: string): CursorToolCategory | undefined {
  return CURSOR_TOOL_CATEGORIES[name]
}

/**
 * Whether a native tool changes state. Unknown tools answer `true`: the manifest
 * consumers gate writes on this, so an unrecognized tool must never be presented
 * as harmless.
 */
export function cursorToolIsWrite(name: string): boolean {
  const category = cursorToolCategory(name)
  return category === undefined || WRITE_CATEGORIES.has(category)
}
