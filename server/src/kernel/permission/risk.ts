/**
 * Vendor-neutral tool-risk normalizer — the permission-security boundary that
 * makes a tool permission request judgeable by advisors of ANY vendor.
 *
 * A consensus round may now include cross-vendor voters (a Codex advisor judging a
 * Claude session's request, and vice-versa). A voter must never be shown — or asked
 * to interpret — the requesting vendor's native tool name or raw input (a Claude
 * `Bash` vs a Codex `shell` are the same neutral intent but different vocabularies).
 * This module deterministically maps `(requesting vendor, native tool name, input)`
 * to a {@link NormalizedToolRisk}: a stable operation intent, a structurally-extracted
 * resource scope, and the four base risk axes (read/write/execute/network).
 *
 * ## Contract
 *
 * - **Deterministic.** Same inputs ⇒ same payload; no model, no clock, no I/O.
 * - **Fail-closed, never throws.** An unknown tool, a missing critical target, an
 *   invalid input shape, or any internal error returns `{ ok: false, reason }` with
 *   a STABLE reason code — the caller records every selected voter as an abstain
 *   (no advisor call) and the request defers to the human. A failure NEVER
 *   auto-allows and NEVER low-risk-defaults a value it could not derive.
 * - **Neutral only.** The payload carries no native tool name and no raw input
 *   verbatim. The gateway keeps the original tool name + input on its own
 *   execution / human-approval channel; only this neutral form crosses into a
 *   cross-vendor prompt.
 *
 * Extending c3 with a new native tool means adding a rule here first — until then
 * that tool safely degrades to abstain + human approval (it is never silently
 * auto-allowed by cross-vendor consensus).
 */
import type { NormalizedToolRisk, VendorId } from '@ccc/shared/protocol'

/** The normalizer ruleset version. Bump when a rule's risk classification changes. */
export const NORMALIZATION_VERSION = 1

/** Success ⇒ the neutral payload; failure ⇒ a stable reason code. Never thrown. */
export type NormalizationResult =
  | { ok: true; risk: NormalizedToolRisk }
  | { ok: false; reason: NormalizationFailureReason }

/** Stable, auditable failure codes (never free-form) so prompts/audit can key off them. */
export type NormalizationFailureReason =
  | 'unknown-tool'
  | 'missing-target'
  | 'invalid-input'
  | 'normalizer-error'

interface RiskRule {
  /** Stable neutral operation category (a machine key). */
  intent: string
  /** Short human description shown to voters alongside the intent. */
  description: string
  /** Neutral resource kind (`file` / `command` / `url` / `search` / `path` / `query`). */
  kind: string
  /** The four base risk axes for this operation category. */
  risks: { read: boolean; write: boolean; execute: boolean; network: boolean }
  /** Optional non-vendor-specific extra tags. */
  tags?: string[]
  /** Structurally extract the resource targets from the native input. */
  extract: (input: Record<string, unknown>) => string[]
  /** When true, an empty target list ⇒ `missing-target` failure (fail-closed). */
  requireTarget: boolean
}

/** Read one string field, trimmed; '' when absent/blank/non-string. */
function str(input: Record<string, unknown>, key: string): string {
  const v = input[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** A single non-empty string target, or [] — the common single-path/url/command shape. */
function single(value: string): string[] {
  return value ? [value] : []
}

/**
 * A shell command reaches every axis: it can read, write, execute, and touch the
 * network. We over-approximate to all-true — the reliable, fail-safe statement for
 * an opaque command (never under-state a shell's reach). Codex accepts an array of
 * argv tokens as `command`; join it into the neutral command line.
 */
function extractCommand(input: Record<string, unknown>): string[] {
  const c = input.command
  if (typeof c === 'string') return single(c.trim())
  if (Array.isArray(c)) {
    const joined = c
      .map((t) => (typeof t === 'string' ? t : String(t)))
      .join(' ')
      .trim()
    return single(joined)
  }
  return []
}

/**
 * Extract the file paths a Codex `apply_patch` touches from its patch header lines
 * (`*** Add File: <p>` / `*** Update File: <p>` / `*** Delete File: <p>`). Best-effort
 * and structural; an unparseable patch yields [] ⇒ `missing-target` (fail-closed).
 */
function extractPatchTargets(input: Record<string, unknown>): string[] {
  const patch = str(input, 'input') || str(input, 'patch')
  if (!patch) return []
  const out: string[] = []
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(patch)) !== null) {
    const p = m[1].trim()
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

const SHELL_RULE: RiskRule = {
  intent: 'execute-shell-command',
  description: 'Run a shell command',
  kind: 'command',
  risks: { read: true, write: true, execute: true, network: true },
  extract: extractCommand,
  requireTarget: true,
}

const CREATE_FILE_RULE: RiskRule = {
  intent: 'write-file',
  description: 'Create or overwrite a file',
  kind: 'file',
  risks: { read: false, write: true, execute: false, network: false },
  extract: (i) => single(str(i, 'file_path')),
  requireTarget: true,
}

const EDIT_FILE_RULE: RiskRule = {
  intent: 'edit-file',
  description: 'Read and modify an existing file',
  kind: 'file',
  risks: { read: true, write: true, execute: false, network: false },
  extract: (i) => single(str(i, 'file_path')),
  requireTarget: true,
}

const EDIT_NOTEBOOK_RULE: RiskRule = {
  intent: 'edit-file',
  description: 'Read and modify a notebook file',
  kind: 'file',
  risks: { read: true, write: true, execute: false, network: false },
  extract: (i) => single(str(i, 'notebook_path')),
  requireTarget: true,
}

const READ_FILE_RULE: RiskRule = {
  intent: 'read-file',
  description: 'Read a file',
  kind: 'file',
  risks: { read: true, write: false, execute: false, network: false },
  extract: (i) => single(str(i, 'file_path')),
  requireTarget: true,
}

const READ_NOTEBOOK_RULE: RiskRule = {
  intent: 'read-file',
  description: 'Read a notebook file',
  kind: 'file',
  risks: { read: true, write: false, execute: false, network: false },
  extract: (i) => single(str(i, 'notebook_path')),
  requireTarget: true,
}

const LIST_DIR_RULE: RiskRule = {
  intent: 'list-directory',
  description: 'List a directory',
  kind: 'path',
  risks: { read: true, write: false, execute: false, network: false },
  extract: (i) => single(str(i, 'path')),
  requireTarget: false,
}

const SEARCH_RULE: RiskRule = {
  intent: 'search-code',
  description: 'Search project files by pattern',
  kind: 'search',
  risks: { read: true, write: false, execute: false, network: false },
  extract: (i) => single(str(i, 'pattern')),
  requireTarget: false,
}

const WEB_FETCH_RULE: RiskRule = {
  intent: 'fetch-url',
  description: 'Fetch a remote URL',
  kind: 'url',
  risks: { read: true, write: false, execute: false, network: true },
  extract: (i) => single(str(i, 'url')),
  requireTarget: true,
}

const WEB_SEARCH_RULE: RiskRule = {
  intent: 'web-search',
  description: 'Search the web',
  kind: 'query',
  risks: { read: true, write: false, execute: false, network: true },
  extract: (i) => single(str(i, 'query')),
  requireTarget: true,
}

const PATCH_RULE: RiskRule = {
  intent: 'edit-file',
  description: 'Apply a patch to one or more files',
  kind: 'file',
  risks: { read: true, write: true, execute: false, network: false },
  extract: extractPatchTargets,
  requireTarget: true,
}

/**
 * Per-vendor native-tool → rule table. The requesting session's vendor selects the
 * namespace; the tool name selects the rule. A name absent from the vendor's table
 * ⇒ `unknown-tool` (fail-closed). Read-class tools are mapped too so consensus can
 * classify them if the SDK ever routes one here.
 */
const RULES: Record<VendorId, Record<string, RiskRule>> = {
  claude: {
    Bash: SHELL_RULE,
    Write: CREATE_FILE_RULE,
    Edit: EDIT_FILE_RULE,
    MultiEdit: EDIT_FILE_RULE,
    NotebookEdit: EDIT_NOTEBOOK_RULE,
    Read: READ_FILE_RULE,
    NotebookRead: READ_NOTEBOOK_RULE,
    LS: LIST_DIR_RULE,
    Glob: SEARCH_RULE,
    Grep: SEARCH_RULE,
    WebFetch: WEB_FETCH_RULE,
    WebSearch: WEB_SEARCH_RULE,
  },
  codex: {
    shell: SHELL_RULE,
    exec_command: SHELL_RULE,
    local_shell: SHELL_RULE,
    apply_patch: PATCH_RULE,
  },
}

/**
 * Normalize a tool permission request into a vendor-neutral risk payload, or a
 * stable failure reason. Pure and total — every path returns a value, and any
 * unexpected error is caught and reported as `normalizer-error` (never thrown into
 * the gateway's main run).
 */
export function normalizeToolRequest(
  vendor: VendorId,
  toolName: string,
  input: unknown,
): NormalizationResult {
  try {
    const rule = RULES[vendor]?.[toolName]
    if (!rule) return { ok: false, reason: 'unknown-tool' }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'invalid-input' }
    }
    const targets = rule.extract(input as Record<string, unknown>)
    if (rule.requireTarget && targets.length === 0) {
      return { ok: false, reason: 'missing-target' }
    }
    return {
      ok: true,
      risk: {
        operationIntent: `${rule.intent}: ${rule.description}`,
        resourceScope: { kind: rule.kind, targets },
        risks: { ...rule.risks, ...(rule.tags ? { tags: rule.tags } : {}) },
        normalizationVersion: NORMALIZATION_VERSION,
      },
    }
  } catch {
    return { ok: false, reason: 'normalizer-error' }
  }
}
