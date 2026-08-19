/**
 * The one deny pattern set every memory write passes through.
 *
 * A memory is a short learned statement a human would recognize as their own
 * words. Two shapes are therefore refused before anything is persisted:
 *
 *  - **Credential shapes.** A memory row is read back into a model's context on
 *    demand and lives in a file the user backs up; a token that lands here is a
 *    second copy of the credential in a place nobody audits. Detection is
 *    conservative by construction — it recognizes shapes, it cannot prove prose
 *    is safe — so the domain documentation states plainly that memory is not a
 *    secret vault.
 *  - **Artifact shapes.** Code fences, tool-call / tool-result framing and
 *    role-prefixed transcript lines. These are the raw material the memory is
 *    supposed to be a conclusion ABOUT. Accepting them would turn the table into
 *    the transcript store this capability deliberately is not.
 *
 * A rejection names the CATEGORY and never echoes the matched text — an error
 * message that quotes the secret defeats the check that produced it.
 */

/** Why a write was refused. Carried to the caller instead of the matched text. */
export type MemoryGuardReason = 'credential' | 'artifact'

/**
 * Credential shapes: private-key blocks, bearer tokens, vendor access tokens and
 * credential-name assignments. The assignment rule demands a secret-LOOKING
 * value (12+ token characters), so ordinary prose that merely mentions a
 * credential by name — "token 由环境变量注入" — stays writable.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bc3k_[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:api[_-]?key|secret|password|passwd|token|credential|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/i,
]

/**
 * Artifact shapes: markdown code fences, XML-ish tool-call framing (the MCP /
 * vendor conventions plus this harness's own `antml:` tags) and role-prefixed
 * transcript lines. Anchored at a line start so a sentence containing the word
 * "user" is not mistaken for a transcript.
 */
const ARTIFACT_PATTERNS: readonly RegExp[] = [
  /```/,
  /~~~/,
  /<\/?(?:antml:[a-z_]+|function_calls|function_results|invoke|tool_use|tool_result|tool_call)\b/i,
  /(^|\n)\s*(?:user|assistant|human|system|tool)\s*:\s/i,
  /(^|\n)\s*\{\s*"(?:role|tool_use_id|tool_name|type)"\s*:/,
]

/**
 * Inspect one user-supplied field. Returns the category that refused it, or
 * `null` when the text is acceptable. Never returns the matched substring.
 */
export function detectMemoryGuardViolation(value: string): MemoryGuardReason | null {
  for (const p of CREDENTIAL_PATTERNS) if (p.test(value)) return 'credential'
  for (const p of ARTIFACT_PATTERNS) if (p.test(value)) return 'artifact'
  return null
}

/** The human-facing reason text for a refused write, safe to return over MCP. */
export function memoryGuardMessage(reason: MemoryGuardReason, field: string): string {
  return reason === 'credential'
    ? `${field} 疑似包含凭据(私钥/令牌/密钥赋值),已拒绝写入。记忆不是密钥库,请改写成不含凭据的结论。`
    : `${field} 疑似包含代码块或工具调用/对话转录片段,已拒绝写入。请只写一句可复述的结论,不要粘贴代码、命令、提示词、工具输入输出或对话原文。`
}
