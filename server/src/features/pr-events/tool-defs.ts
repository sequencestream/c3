/**
 * Shared, framing-free definitions for the `publish_pr_event` MCP tool, kept ONE
 * source so the two MCP surfaces that expose it never drift:
 *  - the in-process Claude SDK MCP server (`publish-tool.ts`, `createSdkMcpServer`),
 *  - the localhost HTTP MCP route for driver-path vendors (`transport/pr-event-mcp`,
 *    codex; 2026-06-20).
 *
 * This module owns the zod input shape (the source of the vendor-neutral
 * {@link PrOperationEvent} contract), the description advertised in the system
 * prompt, the safety normalization (strip tokens / raw CLI output / absolute
 * paths), and the core publish logic. The MCP framing — tool registration, the
 * per-run binding closure that supplies workspacePath + sessionId — lives in each
 * surface.
 *
 * c3 NEVER executes a PR operation. The model uses its OWN tools to create /
 * review / merge / close / comment on a PR and then calls this tool to publish
 * ONE event; a schedule may subscribe and trigger its follow-up action.
 */
import { z } from 'zod'
import { PR_OPERATIONS, PR_OPERATION_RESULTS, type PrOperationEvent } from '@ccc/shared/protocol'

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface PrEventToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): PrEventToolResult['content'] => [{ type: 'text' as const, text: s }]

// ---- Zod input shape (raw shape; both `tool()` and `registerTool` accept it) ----

export const publishPrEventSchema = {
  operation: z
    .enum(PR_OPERATIONS)
    .describe('PR 操作类型:create(创建)/review(评审)/merge(合并)/close(关闭)/comment(评论)。'),
  result: z.enum(PR_OPERATION_RESULTS).describe('操作结果:success(成功)/failure(失败)。'),
  pr: z
    .object({
      number: z.number().int().optional().describe('PR 编号(若平台提供)'),
      id: z.string().optional().describe('PR 的平台内部 id(若有)'),
      url: z.string().optional().describe('PR 的网页链接'),
      title: z.string().optional().describe('PR 标题'),
      state: z.string().optional().describe('PR 状态(如 open/merged/closed)'),
    })
    .optional()
    .describe('PR 标识(全部可选,供应商中立)'),
  repo: z
    .object({
      provider: z.string().optional().describe("代码托管商,默认 'github',可为 'gitlab' 等"),
      host: z.string().optional().describe('托管主机名(如 github.com)'),
      owner: z.string().optional().describe('仓库归属(组织/用户)'),
      name: z.string().optional().describe('仓库名'),
    })
    .optional()
    .describe('仓库上下文(全部可选,供应商中立)'),
  ref: z
    .object({
      head: z.string().optional().describe('源分支名'),
      base: z.string().optional().describe('目标分支名'),
    })
    .optional()
    .describe('分支信息'),
  association: z
    .object({
      intentId: z.string().optional().describe('关联的 c3 意图 id,供监听器把事件关联回工作项'),
    })
    .optional()
    .describe('关联信息'),
  errorSummary: z
    .string()
    .optional()
    .describe(
      '仅 result=failure 时有意义:简短的失败原因摘要(自然语言)。' +
        '切勿包含令牌、密钥、命令行原始输出或绝对路径——服务端会做安全归一化。',
    ),
}

export type PublishPrEventArgs = {
  operation: PrOperationEvent['operation']
  result: PrOperationEvent['result']
  pr?: PrOperationEvent['pr']
  repo?: PrOperationEvent['repo']
  ref?: PrOperationEvent['ref']
  association?: PrOperationEvent['association']
  errorSummary?: string
}

// ---- Description string (advertised in the system prompt) ----

export const publishPrEventDesc =
  '发布一条供应商中立的「PR 操作事件」。你应先用自己的工具(gh CLI / GitHub MCP 等)完成 ' +
  'PR 的创建/评审/合并/关闭/评论,操作完成或失败后调用本工具发布对应事件;' +
  'c3 本身不执行任何 PR 操作。事件包含 operation、result、pr、repo、ref、association,' +
  '供订阅了 pr:operation 的 Schedule 匹配并触发后续动作。' +
  '失败时可在 errorSummary 给出简短原因,勿放令牌/密钥/命令行原始输出/绝对路径(服务端会归一化)。'

// ---- Safety normalization (strip tokens / raw CLI output / absolute paths) ----

const REDACTED = '[redacted]'
const MAX_ERROR_SUMMARY_LEN = 500
const MAX_FIELD_LEN = 256

/** Token / secret patterns redacted from any free-text field before it leaves c3. */
const SECRET_PATTERNS: RegExp[] = [
  // GitHub / GitLab personal-access & app tokens.
  /\bgh[opusr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  // OpenAI / Anthropic-style keys.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // key=value / key: value secrets.
  /\b(?:token|secret|password|passwd|api[-_]?key|authorization)\b\s*[:=]\s*\S+/gi,
  // `bearer <token>` (space-separated).
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // JWTs.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Long hex blobs (e.g. raw OAuth/40+ char hashes).
  /\b[0-9a-fA-F]{40,}\b/g,
]

/** Absolute-path patterns stripped from the error summary (POSIX home + Windows). */
const ABS_PATH_PATTERNS: RegExp[] = [
  /(?:\/Users\/|\/home\/|\/root\/|\/var\/folders\/)\S+/g,
  /[A-Za-z]:\\[^\s]+/g,
]

/** Redact secret-shaped substrings from a free-text value. */
export function redactSecrets(s: string): string {
  let out = s
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/** Normalize a short structural field: redact secrets + cap length. */
function normalizeField(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  const redacted = redactSecrets(s).trim()
  return redacted.length > MAX_FIELD_LEN ? redacted.slice(0, MAX_FIELD_LEN) : redacted
}

/**
 * Normalize a failure summary so it never leaks sensitive data: redact tokens,
 * strip absolute paths, collapse whitespace (defuses pasted raw stdout/stderr),
 * and cap length. Returns `undefined` for empty input.
 */
export function normalizeErrorSummary(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  let out = redactSecrets(raw)
  for (const re of ABS_PATH_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(/\s+/g, ' ').trim()
  if (!out) return undefined
  return out.length > MAX_ERROR_SUMMARY_LEN ? `${out.slice(0, MAX_ERROR_SUMMARY_LEN)}…` : out
}

/**
 * Build the safely-normalized {@link PrOperationEvent} from validated args. Every
 * string field is passed through the secret redactor; `errorSummary` additionally
 * has absolute paths stripped and whitespace collapsed. Nested objects are dropped
 * when they hold no surviving field, so the event payload stays compact.
 */
export function normalizePrEvent(args: PublishPrEventArgs): PrOperationEvent {
  const event: PrOperationEvent = {
    operation: args.operation,
    result: args.result,
  }

  if (args.pr) {
    const pr = {
      ...(args.pr.number !== undefined ? { number: args.pr.number } : {}),
      ...(normalizeField(args.pr.id) ? { id: normalizeField(args.pr.id)! } : {}),
      ...(normalizeField(args.pr.url) ? { url: normalizeField(args.pr.url)! } : {}),
      ...(normalizeField(args.pr.title) ? { title: normalizeField(args.pr.title)! } : {}),
      ...(normalizeField(args.pr.state) ? { state: normalizeField(args.pr.state)! } : {}),
    }
    if (Object.keys(pr).length) event.pr = pr
  }

  if (args.repo) {
    const repo = {
      ...(normalizeField(args.repo.provider)
        ? { provider: normalizeField(args.repo.provider)! }
        : {}),
      ...(normalizeField(args.repo.host) ? { host: normalizeField(args.repo.host)! } : {}),
      ...(normalizeField(args.repo.owner) ? { owner: normalizeField(args.repo.owner)! } : {}),
      ...(normalizeField(args.repo.name) ? { name: normalizeField(args.repo.name)! } : {}),
    }
    if (Object.keys(repo).length) event.repo = repo
  }

  if (args.ref) {
    const ref = {
      ...(normalizeField(args.ref.head) ? { head: normalizeField(args.ref.head)! } : {}),
      ...(normalizeField(args.ref.base) ? { base: normalizeField(args.ref.base)! } : {}),
    }
    if (Object.keys(ref).length) event.ref = ref
  }

  if (args.association) {
    const intentId = normalizeField(args.association.intentId)
    if (intentId) event.association = { intentId }
  }

  const errorSummary = normalizeErrorSummary(args.errorSummary)
  if (errorSummary) event.errorSummary = errorSummary

  return event
}

/**
 * Validate + normalize the args and publish the event via the injected
 * `publish` sink (bound to the run's workspace + session at the composition
 * root). Defensive enum re-validation keeps a malformed call from publishing even
 * if a surface ever skips the zod gate; on rejection it returns an `isError`
 * result and publishes NOTHING.
 */
export function runPublishPrEvent(
  args: PublishPrEventArgs,
  publish: (event: PrOperationEvent) => void,
): PrEventToolResult {
  if (!PR_OPERATIONS.includes(args.operation)) {
    return { content: text(`非法 operation:${String(args.operation)}`), isError: true }
  }
  if (!PR_OPERATION_RESULTS.includes(args.result)) {
    return { content: text(`非法 result:${String(args.result)}`), isError: true }
  }
  const event = normalizePrEvent(args)
  try {
    publish(event)
  } catch (err) {
    return { content: text(`PR 事件发布失败:${String(err)}`), isError: true }
  }
  return {
    content: text(`已发布 PR 操作事件:${event.operation}/${event.result}`),
  }
}
