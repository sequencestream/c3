/**
 * Cursor's native tool inventory, keyed by the **wrapper key** the CLI uses in
 * its stream: a `tool_call` frame carries no `name` field — the tool's identity
 * IS the single key under `tool_call` (`readToolCall`, `shellToolCall`, …), and
 * that key also holds the call's `args` and, once finished, its `result`.
 *
 * The six neutral categories below are what the risk layer reasons over, so a
 * new Cursor tool is classified by what it *does* rather than by what it is
 * called. `edit` covers anything that mutates files, `execute` anything that
 * runs code, `read`/`search` the two non-mutating filesystem shapes, `network`
 * anything that leaves the machine, and `meta` the in-conversation bookkeeping
 * tools that touch neither disk nor network.
 *
 * Only tools proven to exist in the CLI build are listed. An unlisted tool is
 * deliberately NOT given a default category: {@link cursorToolCategory} returns
 * `undefined` so the risk layer keeps it `unknown-tool` and fails closed.
 */

/** What a Cursor tool does, in vendor-neutral terms. */
export type CursorToolCategory = 'read' | 'search' | 'edit' | 'execute' | 'network' | 'meta'

/**
 * Wrapper key → neutral category. Sourced from the CLI build's own tool union;
 * every entry is a key the stream can actually emit.
 */
export const CURSOR_TOOL_CATEGORIES: Readonly<Record<string, CursorToolCategory>> = {
  // Read the filesystem without changing it.
  readToolCall: 'read',
  lsToolCall: 'read',
  readLintsToolCall: 'read',
  readMcpResourceToolCall: 'read',
  listMcpResourcesToolCall: 'read',
  getMcpToolsToolCall: 'read',

  // Locate things; non-mutating but broader than a single read.
  globToolCall: 'search',
  grepToolCall: 'search',
  semSearchToolCall: 'search',

  // Mutate files.
  editToolCall: 'edit',
  writeShellStdinToolCall: 'edit',
  deleteToolCall: 'edit',
  applyAgentDiffToolCall: 'edit',
  replaceEnvToolCall: 'edit',

  // Run code / drive the machine.
  shellToolCall: 'execute',
  computerUseToolCall: 'execute',
  setupVmEnvironmentToolCall: 'execute',
  startGrindExecutionToolCall: 'execute',
  recordScreenToolCall: 'execute',

  // Leave the machine.
  webSearchToolCall: 'network',
  webFetchToolCall: 'network',
  fetchToolCall: 'network',
  sendToolCall: 'network',
  generateImageToolCall: 'network',
  mcpToolCall: 'network',

  // In-conversation bookkeeping: no disk, no network.
  createPlanToolCall: 'meta',
  readTodosToolCall: 'meta',
  updateTodosToolCall: 'meta',
  askQuestionToolCall: 'meta',
  communicateUpdateToolCall: 'meta',
  summarizeToolCall: 'meta',
  reflectToolCall: 'meta',
  switchModeToolCall: 'meta',
  taskToolCall: 'meta',
  awaitToolCall: 'meta',
  replayToolCall: 'meta',
  partialToolCall: 'meta',
  truncatedToolCall: 'meta',
  aiAttributionToolCall: 'meta',
  reportBugfixResultsToolCall: 'meta',
  startGrindPlanningToolCall: 'meta',
}

/** Categories whose tools change state — everything else is read-only. */
const WRITE_CATEGORIES: ReadonlySet<CursorToolCategory> = new Set<CursorToolCategory>([
  'edit',
  'execute',
  'network',
])

/**
 * The neutral category of a native tool, or `undefined` when the tool is not in
 * the proven inventory. Callers must treat `undefined` as unknown-and-unsafe
 * rather than substituting a default.
 */
export function cursorToolCategory(wrapperKey: string): CursorToolCategory | undefined {
  return CURSOR_TOOL_CATEGORIES[wrapperKey]
}

/**
 * Whether a native tool changes state. Unknown tools answer `true`: the manifest
 * consumers gate writes on this, so an unrecognized tool must never be presented
 * as harmless.
 */
export function cursorToolIsWrite(wrapperKey: string): boolean {
  const category = cursorToolCategory(wrapperKey)
  return category === undefined || WRITE_CATEGORIES.has(category)
}

/**
 * The display name c3 shows for a native tool: the wrapper key minus its
 * `ToolCall` suffix (`readToolCall` → `read`). The raw key is preserved on the
 * block's `vendorExtra` so nothing is lost by the prettier name.
 */
export function cursorToolDisplayName(wrapperKey: string): string {
  return wrapperKey.endsWith('ToolCall') ? wrapperKey.slice(0, -'ToolCall'.length) : wrapperKey
}
