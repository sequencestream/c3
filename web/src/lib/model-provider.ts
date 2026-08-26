/**
 * 模型提供方在前端的共享视图类型。
 *
 * 探测结果不是配置的一部分:它回答的是「此刻这个端点通不通」,随连接断开一起作废,所以既
 * 不进 SystemSettings 草稿、也不落任何本地存储。类型放在 lib 里,是为了让持有它的 state
 * 与渲染它的组件共用一份定义,而组件不必反过来依赖 controls 层。
 */

/** 一条协议 URL 的探测状态;`pending` 与已有结论互斥地渲染。 */
export interface ProviderProbeState {
  /** 请求已发出、还没回包。 */
  pending?: boolean
  /** 端点是否应答。注意 401/403 也算应答 —— URL 是对的,只是 key 没过。 */
  reachable?: boolean
  /** 应答的 HTTP 状态码;传输层失败时没有。 */
  status?: number
  /** Base URL 的结构性问题(压根没发出请求时)。 */
  issue?: string
  /** 传输层错误摘要。 */
  error?: string
  /** 往返耗时(毫秒)。 */
  latencyMs?: number
}

/** 探测状态表的键:一个 provider 的每个 protocol 槽各自独立。 */
export function providerProbeKey(providerId: string, protocolType: string): string {
  return `${providerId}:${protocolType}`
}
