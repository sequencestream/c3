/**
 * 监听地址绑定 —— `--host` 的唯一解析点。
 *
 * `--host` 是启动契约的**增量**扩展:显式传值时它决定 HTTP 服务器绑定到哪个地址,
 * 省略时不产生任何 `hostname` 字段,`@hono/node-server` 保持其默认的全接口绑定。
 * 这条「省略即不变」的规则是硬约束:桌面壳需要回环绑定,但不能借此暗改既有 CLI
 * 部署的网络可达性。
 *
 * 该模块刻意不依赖服务器运行时,只做纯粹的取值归一化,便于单测覆盖两条分支。
 */

/** 传给 `@hono/node-server` `serve()` 的绑定选项子集。 */
export interface ServeBinding {
  port: number
  /** 仅在显式给出 host 时存在;缺席即沿用默认全接口绑定。 */
  hostname?: string
}

/**
 * 归一化 `--host` 原始输入。空串 / 纯空白视同未提供,这样 `--host=` 之类的空值
 * 不会退化成绑定到空字符串。返回 undefined 表示「保持默认绑定」。
 */
export function normalizeHostOption(raw: string | undefined): string | undefined {
  const host = raw?.trim()
  return host ? host : undefined
}

/** 把已解析的 port + 可选 host 折算成 `serve()` 的绑定选项。 */
export function resolveServeBinding(opts: { port: number; host?: string }): ServeBinding {
  const hostname = normalizeHostOption(opts.host)
  return hostname ? { port: opts.port, hostname } : { port: opts.port }
}

/** 桌面壳固定使用的 IPv4 回环地址。壳不读取、也不放宽 `exposure.bindAddress`。 */
export const LOOPBACK_HOST = '127.0.0.1'
