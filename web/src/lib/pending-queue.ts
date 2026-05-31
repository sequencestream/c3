/*
 * pending-queue.ts — 普通会话运行中的「待发送队列」纯逻辑。
 *
 * 普通(非团队)会话运行中,服务端会拒绝 user_prompt(单回合),所以运行中发送的
 * 消息先进入按 sessionId 归集的客户端内存队列;当前查看的会话回到就绪且队列非空时,
 * 把队列按顺序合并为一条 prompt 经现有 user_prompt 路径发出。此处只承载与队列相关的
 * 纯函数,便于在 Node 环境下单测(web 测试不含 DOM)。
 */

export interface PendingItem {
  id: number
  text: string
}

/** flush 时条目之间的分隔:空行(双换行),合并为一条 prompt。 */
const FLUSH_SEPARATOR = '\n\n'

/** 把队列条目按顺序、用空行连接合并为一条 prompt。 */
export function mergeQueue(items: PendingItem[]): string {
  return items.map((i) => i.text).join(FLUSH_SEPARATOR)
}

/**
 * 是否应该把队列 flush 成下一回合。队列只在 running 时被填充,故「就绪(非 running)
 * 且非团队且队列非空」等价于「running→idle 转换且队列非空」。团队会话实时 pushInput,
 * 从不入队,自然不触发。
 */
export function shouldFlush(running: boolean, teamActive: boolean, queueLength: number): boolean {
  return !running && !teamActive && queueLength > 0
}

/**
 * composer 的 Send 行为:普通会话运行中=入队(服务端会拒绝即时 user_prompt);
 * 否则(就绪、或团队会话实时投喂 lead)=立即发送。
 */
export function composerAction(running: boolean, teamActive: boolean): 'enqueue' | 'send' {
  return running && !teamActive ? 'enqueue' : 'send'
}

/** 追加一条(调用方提供去空白后的文本与递增 id),返回新数组。 */
export function appendItem(items: PendingItem[], text: string, id: number): PendingItem[] {
  return [...items, { id, text }]
}

/** 移除指定 id 的条目,返回新数组。 */
export function removeItem(items: PendingItem[], id: number): PendingItem[] {
  return items.filter((i) => i.id !== id)
}

/**
 * 「修改」回填:把队列条目文本并入输入框现有草稿。草稿非空时以**单换行**追加
 * (避免丢失已写内容),否则取条目文本本身。区别于 flush 的空行合并。
 */
export function mergeIntoDraft(draft: string, text: string): string {
  return draft.trim() ? `${draft.replace(/\s*$/, '')}\n${text}` : text
}
