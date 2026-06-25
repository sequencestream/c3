/*
 * task-model.ts — dev session「当前 task 列表」的纯推断模型(server / web 共用 SoT)。
 *
 * dev session 会调用 SDK 的 TaskCreate / TaskList / TaskUpdate / TaskGet 工具。本模块完全从
 * (toolName, input, result) 事件流推断状态:任意时刻只保留一份最新列表 —— 全量快照(TaskList)整
 * 列表替换,增量(Create/Update/Get)就地改,旧列表不堆叠。
 *
 * 历史上此逻辑只在 web 端(`web/src/lib/task-list.ts`),客户端靠解析 `tool_result.content` 文本推断。
 * 2026-06-07-009 把纯模型逻辑下沉至 shared:服务端在 `emit()` 汇聚点据此派生并下发 `task_*` wire 消息,
 * 客户端转为消费 wire(`TaskItem` 即 wire 携带的任务形态),不再各自解析文本。`taskPanelView`(纯展示)仍留 web。
 *
 * 一切解析都容错:tool_result.content 的 SDK 序列化格式无法确证,字段缺失 / status 非法 / JSON 解析
 * 失败都安全降级(跳过或回退 pending),绝不抛错。
 */

/** 任务状态。与 SDK 的 TaskUpdate 状态机一致(deleted 不纳入展示模型)。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/**
 * 规范化后的单个任务 —— 也是 wire `task_*` 消息携带的任务形态(客户端可直接消费)。
 * 与服务端中性 `TaskData`(`server/.../adapters/types.ts`)字段一致,额外带展示用的 `order`。
 */
export interface TaskItem {
  /** SDK 任务 id(字符串归一)。模型以此去重 / 增量更新。 */
  id: string
  /** 标题(SDK 的 subject;退化时取 title / 截断的 description)。 */
  subject: string
  /** 内容 / 详细描述,可缺失。 */
  description?: string
  status: TaskStatus
  /** 原始顺序:快照取数组下标,增量新增取当前最大序 +1;更新 / upsert 保留既有序。 */
  order: number
  /** SDK 返回的依赖关系,存在才保留。 */
  blockedBy?: string[]
  blocks?: string[]
  /** 任务归属的 agent 名,存在才保留。 */
  owner?: string
}

/** 当前 task 列表模型;`tasks` 已按 `order` 升序,任意时刻仅一份。 */
export interface TaskListModel {
  tasks: TaskItem[]
}

/** result 入参:与 wire 的 tool_result 同形,可缺失(尚未到达 / 未关联)。 */
export interface TaskToolResult {
  content: string
  isError: boolean
}

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

/** SDK 的 task 工具名;接线层据此判定一条 tool_use/tool_result 是否要喂给本模型。 */
export const TASK_TOOL_NAMES = ['TaskCreate', 'TaskList', 'TaskUpdate', 'TaskGet'] as const

export function isTaskTool(name: string): boolean {
  return (TASK_TOOL_NAMES as readonly string[]).includes(name)
}

export function emptyTaskModel(): TaskListModel {
  return { tasks: [] }
}

/** 非空对象判定(数组也是 object,需另行处理)。 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 把 id / status 等可能是 number 的字段归一为非空字符串;无效返回 undefined。 */
function asId(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** status 容错归一:仅接受三个合法值,其余(缺失 / 非法 / deleted)回退 pending。 */
function normalizeStatus(v: unknown): TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v)
    ? (v as TaskStatus)
    : 'pending'
}

/** id 字符串数组的容错抽取;无有效项返回 undefined(以便不写入该字段)。 */
function asIdArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const ids = v.map(asId).filter((x): x is string => x !== undefined)
  return ids.length > 0 ? ids : undefined
}

/**
 * 把一条 task-like 原始记录规范化为 `TaskItem`。无法取到 id 则返回 null(无法去重 / 增量,跳过)。
 * `order` 由调用方决定(快照下标 / 既有序 / 末尾)。
 */
function normalizeTask(raw: unknown, order: number): TaskItem | null {
  if (!isObject(raw)) return null
  const id = asId(raw.id ?? raw.taskId)
  if (id === undefined) return null
  const description = asString(raw.description ?? raw.content)
  const item: TaskItem = {
    id,
    // subject 退化链:subject → title → description(截断)→ 空串。
    subject: asString(raw.subject) ?? asString(raw.title) ?? description?.slice(0, 80) ?? '',
    status: normalizeStatus(raw.status),
    order,
  }
  if (description !== undefined) item.description = description
  const blockedBy = asIdArray(raw.blockedBy)
  if (blockedBy) item.blockedBy = blockedBy
  const blocks = asIdArray(raw.blocks)
  if (blocks) item.blocks = blocks
  const owner = asString(raw.owner)
  if (owner) item.owner = owner
  return item
}

/**
 * 从 tool_result.content 容错抽取 task-like 原始记录数组。兼容多种序列化形状:
 * JSON 数组 / `{ tasks: [...] }` / `{ task: {...} }` / 单对象;解析失败或非任务结构 → 空数组。
 */
function extractRawTasks(result: TaskToolResult | undefined): unknown[] {
  if (!result || result.isError || typeof result.content !== 'string') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(result.content)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed
  if (isObject(parsed)) {
    if (Array.isArray(parsed.tasks)) return parsed.tasks
    if (isObject(parsed.task)) return [parsed.task]
    // 单任务对象(TaskGet / TaskCreate 直接返回任务本体)。
    if ('id' in parsed || 'taskId' in parsed) return [parsed]
  }
  return []
}

/**
 * 文本回退:Claude 的 task 工具 tool_result 是人类可读文本而非 JSON
 * (TaskCreate → "Task #1 created successfully: <subject>")。这里只可靠地抽 id,
 * subject / description 由调用方从 input 取(input 才是权威)。取不到返回 undefined。
 */
function parseCreatedId(result: TaskToolResult | undefined): string | undefined {
  if (!result || result.isError || typeof result.content !== 'string') return undefined
  const m =
    /task\s+#?([A-Za-z0-9][\w-]*)\s+created/i.exec(result.content) ??
    /created\s+task[:\s#]+([A-Za-z0-9][\w-]*)/i.exec(result.content) ??
    /\btask[\s#]+([A-Za-z0-9][\w-]*)/i.exec(result.content)
  return m ? m[1] : undefined
}

/**
 * 文本回退:TaskList → 每行 "#<id> [<status>] <subject>" 的全量快照。只接受带合法
 * status tag 的行(其余行视为非任务文本跳过),返回 task-like 原始记录数组。
 */
function parseListText(result: TaskToolResult | undefined): unknown[] {
  if (!result || result.isError || typeof result.content !== 'string') return []
  const out: unknown[] = []
  for (const line of result.content.split('\n')) {
    const m = /^\s*#?([A-Za-z0-9][\w-]*)\s*\[\s*([A-Za-z_ ]+?)\s*\]\s*(.*)$/.exec(line)
    if (!m) continue
    const status = m[2].replace(/\s+/g, '_').toLowerCase()
    if (!(TASK_STATUSES as readonly string[]).includes(status)) continue
    out.push({ id: m[1], status, subject: m[3].trim() })
  }
  return out
}

function nextOrder(tasks: TaskItem[]): number {
  return tasks.reduce((max, t) => Math.max(max, t.order), -1) + 1
}

/** 整列表按 `order` 升序排序(返回新数组)。 */
function sorted(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => a.order - b.order)
}

/** upsert 单个任务:存在则就地合并(保留既有 order),否则按下一序追加。 */
function upsert(tasks: TaskItem[], incoming: TaskItem): TaskItem[] {
  const idx = tasks.findIndex((t) => t.id === incoming.id)
  if (idx === -1) return [...tasks, { ...incoming, order: nextOrder(tasks) }]
  const next = [...tasks]
  next[idx] = { ...next[idx], ...incoming, order: next[idx].order }
  return next
}

/** 把 TaskUpdate 的 input 字段(无 result 时)应用到既有任务;无该任务则忽略。 */
function applyUpdateInput(tasks: TaskItem[], input: Record<string, unknown>): TaskItem[] {
  const id = asId(input.taskId ?? input.id)
  if (id === undefined) return tasks
  const idx = tasks.findIndex((t) => t.id === id)
  if (idx === -1) return tasks
  const next = [...tasks]
  const patch: Partial<TaskItem> = {}
  if (typeof input.status === 'string') patch.status = normalizeStatus(input.status)
  const subject = asString(input.subject)
  if (subject) patch.subject = subject
  const description = asString(input.description)
  if (description) patch.description = description
  const owner = asString(input.owner)
  if (owner) patch.owner = owner
  next[idx] = { ...next[idx], ...patch }
  return next
}

/**
 * 归并一次 task 工具调用到模型,返回新模型(纯函数,不改入参)。
 *
 * - `TaskList` → 全量快照,整列表替换(旧列表不堆叠)。
 * - `TaskGet`  → 单任务快照,upsert。
 * - `TaskCreate` → 从 result 取新任务(含 id)后新增;取不到则容错跳过。
 * - `TaskUpdate` → 有 result 以 result 为准 upsert;否则按 input.taskId 增量改。
 * - 其它 toolName → 原样返回。
 */
export function applyTaskTool(
  model: TaskListModel,
  toolName: string,
  input: unknown,
  result?: TaskToolResult,
): TaskListModel {
  const tasks = model.tasks
  switch (toolName) {
    case 'TaskList': {
      // 先试 JSON,失败回退解析 "#N [status] subject" 文本快照。
      const raw = extractRawTasks(result)
      const rows = raw.length > 0 ? raw : parseListText(result)
      // 无法解析快照时保持现状,避免把列表误清空。
      if (rows.length === 0) return model
      const next = rows.map((r, i) => normalizeTask(r, i)).filter((t): t is TaskItem => t !== null)
      return { tasks: next }
    }
    case 'TaskGet': {
      const raw = extractRawTasks(result)
      let next = tasks
      for (const r of raw) {
        const item = normalizeTask(r, nextOrder(next))
        if (item) next = upsert(next, item)
      }
      return next === tasks ? model : { tasks: sorted(next) }
    }
    case 'TaskCreate': {
      let raw = extractRawTasks(result)
      // 文本回退:result 形如 "Task #1 created successfully" 只携带 id,
      // subject / description 从 input 取(SDK result 不回显完整字段)。
      if (raw.length === 0) {
        const id = parseCreatedId(result)
        if (id !== undefined && isObject(input)) {
          raw = [{ id, status: 'pending', subject: input.subject, description: input.description }]
        }
      }
      let next = tasks
      for (const r of raw) {
        const item = normalizeTask(r, nextOrder(next))
        if (item) next = upsert(next, item)
      }
      return next === tasks ? model : { tasks: sorted(next) }
    }
    case 'TaskUpdate': {
      const raw = extractRawTasks(result)
      if (raw.length > 0) {
        let next = tasks
        for (const r of raw) {
          const item = normalizeTask(r, nextOrder(next))
          if (item) next = upsert(next, item)
        }
        return next === tasks ? model : { tasks: sorted(next) }
      }
      // result 不可解析时退回按 input 增量改。
      if (!isObject(input)) return model
      const next = applyUpdateInput(tasks, input)
      return next === tasks ? model : { tasks: sorted(next) }
    }
    default:
      return model
  }
}
