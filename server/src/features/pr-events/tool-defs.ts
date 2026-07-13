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
 * The model uses its OWN tools to create / review / merge / close / comment on
 * a PR — or update it (modify + re-submit / re-open) — and then calls this tool
 * to publish ONE event; a automation may subscribe and trigger its follow-up
 * action. An `update/success` event additionally lets the intent domain reset a
 * rejected/failed/closed PR back to `reviewing`. The server-side PR creation paths
 * (dev-cleanup / automation / manual create_pr) also publish a `create` event
 * after successfully creating a PR on the model's behalf.
 */
import { z } from 'zod'
import {
  PR_OPERATIONS,
  PR_OPERATION_RESULTS,
  type GenericEvent,
  type JsonObject,
  type PrBranchRef,
  type PrEventAssociation,
  type PrOperation,
  type PrOperationEvent,
  type PrOperationResult,
  type PrRef,
  type PrRepo,
} from '@ccc/shared/protocol'
import type { EventNormalizer, NormalizeResult } from '../../kernel/events/generic-event.js'

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
    .describe(
      'PR 操作类型:create(创建)/review(评审)/merge(合并)/close(关闭)/comment(评论)/' +
        'update(已有 PR 被修改后重新提交/重新打开,非创建新 PR)。',
    ),
  result: z
    .enum(PR_OPERATION_RESULTS)
    .describe('操作结果:success(成功)/failure(失败)/error(异常,如 CI 挂了/工具异常)。'),
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
      intentTitle: z
        .string()
        .optional()
        .describe('意图名称(自解释),经安全归一后再发布,勿放敏感信息'),
    })
    .optional()
    .describe('关联信息。review 场景请填写 intentId + intentTitle，让事件在通知阶段即可自解释'),
  errorSummary: z
    .string()
    .optional()
    .describe(
      '仅 result=failure 或 result=error 时有意义:简短的失败原因摘要(自然语言)。' +
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
  'PR 的创建/评审/合并/关闭/评论/修改重提(update),操作完成或失败后调用本工具发布对应事件;' +
  'c3 本身不执行任何 PR 操作。事件包含 operation、result、pr、repo、ref、association,' +
  '供订阅了 pr:operation 的 Automation 匹配并触发后续动作。' +
  'result 是三态:success(成功)/failure(评审判定未通过)/error(执行异常,如 CI 挂了)。' +
  'review 场景请务必填写 pr.id + association.intentTitle(意图名称),让事件自解释。' +
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
    const intentTitle = normalizeField(args.association.intentTitle)
    if (intentId || intentTitle) {
      event.association = {}
      if (intentId) event.association.intentId = intentId
      if (intentTitle) event.association.intentTitle = intentTitle
    }
  }

  const errorSummary = normalizeErrorSummary(args.errorSummary)
  if (errorSummary) event.errorSummary = errorSummary

  return event
}

// ---- PR ⇄ generic-event mapping (the `pr:operation` registry entry) ----------
//
// The PR event is the first registered generic-event `type`. Its normalizer
// (`normalizePrGenericEvent`) is the SINGLE field-level normalization used by
// both the model publish path and the three server-side PR-create paths — the
// old `normalizePrEvent` bypass no longer runs standalone. `prArgsToGenericEvent`
// encodes tool args into the untrusted core; `genericEventToPrOperation` is the
// deterministic reverse adapter the compat bridge uses to recover the current
// {@link PrOperationEvent} for the `pr:operation` bus topic — it does NOT
// re-clean (normalization already happened).

/** The stable discriminant the PR normalizer registers against. */
export const PR_EVENT_TYPE = 'pr:operation'

const readStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const readNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Read the known {@link PrRef} fields from an untrusted `data.pr`; `undefined` if empty. */
function readPr(v: unknown): PrRef | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const pr: PrRef = {}
  if (readNum(o.number) !== undefined) pr.number = readNum(o.number)
  if (readStr(o.id) !== undefined) pr.id = readStr(o.id)
  if (readStr(o.url) !== undefined) pr.url = readStr(o.url)
  if (readStr(o.title) !== undefined) pr.title = readStr(o.title)
  if (readStr(o.state) !== undefined) pr.state = readStr(o.state)
  return Object.keys(pr).length ? pr : undefined
}

/** Read the known {@link PrRepo} fields from an untrusted `data.repo`; `undefined` if empty. */
function readRepo(v: unknown): PrRepo | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const repo: PrRepo = {}
  if (readStr(o.provider) !== undefined) repo.provider = readStr(o.provider)
  if (readStr(o.host) !== undefined) repo.host = readStr(o.host)
  if (readStr(o.owner) !== undefined) repo.owner = readStr(o.owner)
  if (readStr(o.name) !== undefined) repo.name = readStr(o.name)
  return Object.keys(repo).length ? repo : undefined
}

/** Read the known {@link PrBranchRef} fields from an untrusted `data.ref`; `undefined` if empty. */
function readRef(v: unknown): PrBranchRef | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const ref: PrBranchRef = {}
  if (readStr(o.head) !== undefined) ref.head = readStr(o.head)
  if (readStr(o.base) !== undefined) ref.base = readStr(o.base)
  return Object.keys(ref).length ? ref : undefined
}

/** Read the known {@link PrEventAssociation} fields from an untrusted `data.association`. */
function readAssociation(v: unknown): PrEventAssociation | undefined {
  const o = asObject(v)
  if (!o) return undefined
  const assoc: PrEventAssociation = {}
  if (readStr(o.intentId) !== undefined) assoc.intentId = readStr(o.intentId)
  if (readStr(o.intentTitle) !== undefined) assoc.intentTitle = readStr(o.intentTitle)
  return Object.keys(assoc).length ? assoc : undefined
}

/** Drop `undefined`-valued keys so the resulting object is a valid JSON object. */
function compact(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out
}

/**
 * Encode PR tool args into an (un-normalized) {@link GenericEvent} core:
 * `status = result`, `metadata.operation = operation`, `description = errorSummary`,
 * `data` carries `pr` / `repo` / `ref` / `association`. Empty structural objects
 * are omitted so the core stays a valid JSON object (no `undefined` values).
 */
export function prArgsToGenericEvent(args: PublishPrEventArgs): GenericEvent {
  const data: Record<string, unknown> = {}
  if (args.pr) {
    const pr = compact(args.pr)
    if (Object.keys(pr).length) data.pr = pr
  }
  if (args.repo) {
    const repo = compact(args.repo)
    if (Object.keys(repo).length) data.repo = repo
  }
  if (args.ref) {
    const ref = compact(args.ref)
    if (Object.keys(ref).length) data.ref = ref
  }
  if (args.association) {
    const assoc = compact(args.association)
    if (Object.keys(assoc).length) data.association = assoc
  }
  const core: GenericEvent = {
    type: PR_EVENT_TYPE,
    status: args.result,
    metadata: { operation: args.operation },
  }
  if (args.errorSummary !== undefined) core.description = args.errorSummary
  if (Object.keys(data).length) core.data = data as JsonObject
  return core
}

/** Encode a normalized {@link PrOperationEvent} back into a normalized generic event. */
function prOperationToGenericEvent(event: PrOperationEvent): GenericEvent {
  const data: Record<string, unknown> = {}
  if (event.pr) data.pr = { ...event.pr }
  if (event.repo) data.repo = { ...event.repo }
  if (event.ref) data.ref = { ...event.ref }
  if (event.association) data.association = { ...event.association }
  const core: GenericEvent = {
    type: PR_EVENT_TYPE,
    status: event.result,
    metadata: { operation: event.operation },
  }
  if (event.errorSummary !== undefined) core.description = event.errorSummary
  if (Object.keys(data).length) core.data = data as JsonObject
  return core
}

/**
 * The registered normalizer for `type: 'pr:operation'`. Validates the operation +
 * result enums (throws on an unknown value so the generic layer rejects the
 * publish), reconstructs the tool args from the untrusted core (ignoring any
 * unknown `data` keys), runs the field-level {@link normalizePrEvent} redaction,
 * and re-encodes the clean event as a generic event.
 */
export const normalizePrGenericEvent: EventNormalizer = (core) => {
  const operation = core.metadata?.operation
  const result = core.status
  if (operation === undefined || !PR_OPERATIONS.includes(operation as PrOperation)) {
    throw new Error('unknown pr operation')
  }
  if (result === undefined || !PR_OPERATION_RESULTS.includes(result as PrOperationResult)) {
    throw new Error('unknown pr result')
  }
  const data = core.data ?? {}
  const args: PublishPrEventArgs = {
    operation: operation as PrOperation,
    result: result as PrOperationResult,
    pr: readPr(data.pr),
    repo: readRepo(data.repo),
    ref: readRef(data.ref),
    association: readAssociation(data.association),
    errorSummary: core.description,
  }
  return prOperationToGenericEvent(normalizePrEvent(args))
}

/**
 * Deterministic reverse adapter: recover a {@link PrOperationEvent} from a
 * NORMALIZED generic PR event. Used by the compat bridge to publish onto the
 * existing `pr:operation` bus topic. It does NOT re-clean — normalization already
 * happened — and preserves the empty-drop + optional-field semantics.
 */
export function genericEventToPrOperation(event: GenericEvent): PrOperationEvent {
  const data = event.data ?? {}
  const out: PrOperationEvent = {
    operation: event.metadata?.operation as PrOperation,
    result: event.status as PrOperationResult,
  }
  const pr = readPr(data.pr)
  if (pr) out.pr = pr
  const repo = readRepo(data.repo)
  if (repo) out.repo = repo
  const ref = readRef(data.ref)
  if (ref) out.ref = ref
  const assoc = readAssociation(data.association)
  if (assoc) out.association = assoc
  if (event.description !== undefined) out.errorSummary = event.description
  return out
}

// ---- Server-side PR create event builder (shared by dev-cleanup / automation / create_pr) ----

/** Inputs for building a server-side `pr:operation create` event. */
export interface ServerSidePrCreateInput {
  prId: string
  prUrl: string | null
  headBranch: string | undefined
  baseBranch: string | undefined
  intentId: string
}

/**
 * Publish a `pr:operation create/success` event for the server-side PR creation
 * paths (dev-cleanup, automation, manual create_pr). The three call-sites share
 * this single entry so their mapping never drifts, and — like the model path —
 * they route through the SAME generic pipeline: `normalize` runs the registered
 * PR normalizer (a missing registration is a publish failure, NOT a bypass), and
 * `publish` receives the recovered {@link PrOperationEvent} to wrap with the
 * bus envelope. Returns the {@link NormalizeResult} for optional logging.
 */
export function runServerSidePrCreate(
  input: ServerSidePrCreateInput,
  normalize: (core: GenericEvent) => NormalizeResult,
  publish: (event: PrOperationEvent) => void,
): NormalizeResult {
  const args: PublishPrEventArgs = {
    operation: 'create',
    result: 'success',
    pr: { url: input.prUrl ?? undefined },
    ref: { head: input.headBranch, base: input.baseBranch },
    association: { intentId: input.intentId },
  }
  const res = normalize(prArgsToGenericEvent(args))
  if (res.ok) publish(genericEventToPrOperation(res.event))
  return res
}

/**
 * Validate + normalize the args through the generic pipeline and publish the
 * recovered event via the injected `publish` sink (bound to the run's workspace +
 * session at the composition root). `normalize` runs the registered PR normalizer:
 * an unknown type / registration gap / normalizer rejection returns an `isError`
 * result and publishes NOTHING. Defensive enum re-validation keeps a malformed
 * call from even reaching the registry if a surface ever skips the zod gate.
 */
export function runPublishPrEvent(
  args: PublishPrEventArgs,
  normalize: (core: GenericEvent) => NormalizeResult,
  publish: (event: PrOperationEvent) => void,
): PrEventToolResult {
  if (!PR_OPERATIONS.includes(args.operation)) {
    return { content: text(`非法 operation:${String(args.operation)}`), isError: true }
  }
  if (!PR_OPERATION_RESULTS.includes(args.result)) {
    return { content: text(`非法 result:${String(args.result)}`), isError: true }
  }
  const res = normalize(prArgsToGenericEvent(args))
  if (!res.ok) {
    return { content: text(`PR 事件发布失败:${res.reason}`), isError: true }
  }
  try {
    publish(genericEventToPrOperation(res.event))
  } catch (err) {
    return { content: text(`PR 事件发布失败:${String(err)}`), isError: true }
  }
  return { content: text(`已发布 PR 操作事件:${args.operation}/${args.result}`) }
}
