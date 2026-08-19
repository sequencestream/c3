/**
 * Framing-free definitions for the two workspace-memory MCP tools — the zod input
 * shapes, the descriptions advertised to the model, and the core handlers. The
 * MCP framing (registration + the per-run binding closure that supplies the
 * workspace and live session id) lives in `transport/event-mcp`, so Claude, Codex
 * and Cursor all run these exact behaviors from one definition.
 *
 * The scope is server-derived. A caller cannot name a workspace or a session: both
 * come from the run binding, which is what makes "workspace A cannot read workspace
 * B" a structural property rather than an argument the model is trusted to get
 * right.
 *
 * Every successful call acknowledges the title actually saved or deleted, and
 * every failure returns `isError` with a reason that is safe to show — a write is
 * never dropped quietly and a refusal never echoes the material that caused it.
 */
import { z } from 'zod'
import {
  MEMORY_MAX_CHARS,
  MEMORY_TYPES,
  MemoryStoreError,
  createMemory,
  deleteMemory,
  listActiveMemories,
  searchMemories,
  updateMemory,
  type MemoryType,
  type WorkspaceMemory,
} from './store.js'

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface MemoryToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** The run-derived scope both tools close over. Never supplied by the caller. */
export interface MemoryScope {
  workspaceName: string
  /** The live work-session id recorded as the source of a write. */
  sessionId: string
}

const text = (s: string): MemoryToolResult['content'] => [{ type: 'text' as const, text: s }]
const ok = (payload: unknown): MemoryToolResult => ({ content: text(JSON.stringify(payload)) })
const fail = (reason: string): MemoryToolResult => ({ content: text(reason), isError: true })

function refusal(err: unknown): MemoryToolResult {
  if (err instanceof MemoryStoreError) return fail(err.message)
  return fail(`记忆操作失败:${String(err)}`)
}

// ---- memory_search ----

export const memorySearchSchema = {
  query: z
    .string()
    .optional()
    .describe(
      '检索词(可选)。省略或留空时返回本工作区全部记忆的目录(只含 title 与 type,按 type 分组),' +
        '用于先看清有哪些记忆;给出检索词时按字面子串(不区分大小写)匹配 title / subject / content 并返回完整详情。' +
        '检索是字面匹配,不做同义词或语义扩展——没命中就先列目录再换一个更短的词。',
    ),
}

export type MemorySearchArgs = { query?: string }

export const memorySearchDesc =
  '检索当前工作区的长期记忆(用户偏好、已验证约束、事实、教训)。' +
  '在开始一项工作、或需要知道用户在这个工作区的既有约定时先调用一次:' +
  '不传 query 会返回按 type 分组的完整目录(title + type),传 query 则返回命中条目的完整内容。' +
  '记忆只属于当前工作区,看不到其它工作区的内容。'

/** The fixed group order of the directory listing. */
const DIRECTORY_ORDER: readonly MemoryType[] = MEMORY_TYPES

function detail(m: WorkspaceMemory): Record<string, unknown> {
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    subject: m.subject,
    content: m.content,
    sourceSessionId: m.sourceSessionId,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }
}

/**
 * Two modes. No query lists the complete active directory grouped by type in a
 * fixed order (empty groups omitted) — cheap enough to read whole, which is how a
 * caller recovers from a literal search that found nothing. A query returns full
 * details for the matches, and an explicit empty result when there are none.
 */
export function runMemorySearch(scope: MemoryScope, args: MemorySearchArgs): MemoryToolResult {
  const query = (args.query ?? '').trim()
  if (!query) {
    const grouped: Record<string, Array<{ title: string; type: MemoryType }>> = {}
    for (const m of listActiveMemories(scope.workspaceName)) {
      ;(grouped[m.type] ??= []).push({ title: m.title, type: m.type })
    }
    const directory: Record<string, Array<{ title: string; type: MemoryType }>> = {}
    for (const t of DIRECTORY_ORDER) if (grouped[t]) directory[t] = grouped[t]
    const total = Object.values(directory).reduce((n, list) => n + list.length, 0)
    return ok({ mode: 'directory', total, directory })
  }
  const matches = searchMemories(scope.workspaceName, query)
  return ok({ mode: 'match', query, total: matches.length, memories: matches.map(detail) })
}

// ---- memory_write ----

export const memoryWriteSchema = {
  op: z
    .enum(['create', 'update', 'delete'])
    .describe(
      'create=保存一条新记忆(title 归一化后同名则原地覆盖该条);update=按 id 修改已有记忆;delete=按 id 软删除(30 天内可由重新写入同名条目恢复)。',
    ),
  id: z.string().optional().describe('update / delete 必填:目标记忆的 id(由 memory_search 得到)。'),
  type: z
    .enum(MEMORY_TYPES)
    .optional()
    .describe(
      'create 必填:preference=用户偏好/习惯;constraint=已验证的项目约束;fact=稳定事实;lesson=踩过的坑与教训。',
    ),
  title: z
    .string()
    .optional()
    .describe(
      'create 必填:一句话标题,同时是这条记忆的身份——归一化(去首尾空白、折叠空白、转小写)后相同即视为同一条并覆盖。' +
        '两条真正互相矛盾的记忆必须用不同 title,并在 content 里写清各自成立的条件。',
    ),
  content: z
    .string()
    .optional()
    .describe(
      `create 必填:记忆正文,最长 ${MEMORY_MAX_CHARS} 字符。只写一句可复述的结论(用户说过什么、验证过什么、教训是什么),` +
        '不要放代码、命令、提示词、工具输入输出或对话原文——这类内容会被直接拒绝。',
    ),
  subject: z
    .string()
    .optional()
    .describe('可选:归类标签,用于把相关记忆聚到一起。它不参与身份判定,也不改变可见范围。'),
}

export interface MemoryWriteArgs {
  op: 'create' | 'update' | 'delete'
  id?: string
  type?: MemoryType
  title?: string
  content?: string
  subject?: string
}

export const memoryWriteDesc =
  '维护当前工作区的长期记忆。用于把「用户明确表达过的偏好」「已验证的项目约束」「稳定事实」「踩过的坑」' +
  '留给以后的会话,避免用户重复说同一件事。仓库自己能证明的东西(代码结构、目录约定、已写进 CLAUDE.md 的规则)不要写进来。' +
  'op=create 保存(title 归一化后同名即原地覆盖)、op=update 按 id 修改、op=delete 按 id 软删除。' +
  `单条 content 上限 ${MEMORY_MAX_CHARS} 字符,单工作区上限 500 条;超限会明确报错而不是悄悄丢弃或淘汰旧条目。` +
  '禁止写入凭据、代码块、工具调用/返回与对话转录,这类内容会被拒绝。'

function saved(verb: string, m: WorkspaceMemory): MemoryToolResult {
  return ok({ ok: true, op: verb, id: m.id, title: m.title, type: m.type, status: m.status })
}

/**
 * One mutation per call. Missing required arguments, a foreign or absent id, a
 * rejected field, and a full workspace all return `isError` and change nothing.
 */
export function runMemoryWrite(scope: MemoryScope, args: MemoryWriteArgs): MemoryToolResult {
  try {
    switch (args.op) {
      case 'create': {
        if (!args.type || !args.title || !args.content) {
          return fail('create 需要 type、title、content 三个参数,未写入任何内容。')
        }
        return saved(
          'create',
          createMemory({
            workspaceName: scope.workspaceName,
            sourceSessionId: scope.sessionId,
            type: args.type,
            title: args.title,
            content: args.content,
            subject: args.subject ?? null,
          }),
        )
      }
      case 'update': {
        if (!args.id) return fail('update 需要 id 参数,未做任何修改。')
        return saved(
          'update',
          updateMemory({
            workspaceName: scope.workspaceName,
            id: args.id,
            sourceSessionId: scope.sessionId,
            ...(args.type === undefined ? {} : { type: args.type }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.content === undefined ? {} : { content: args.content }),
            ...(args.subject === undefined ? {} : { subject: args.subject }),
          }),
        )
      }
      case 'delete': {
        if (!args.id) return fail('delete 需要 id 参数,未做任何修改。')
        return saved('delete', deleteMemory(scope.workspaceName, args.id))
      }
      default:
        return fail('op 必须是 create / update / delete 之一,未做任何修改。')
    }
  } catch (err) {
    return refusal(err)
  }
}
