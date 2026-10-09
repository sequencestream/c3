/**
 * 前端的**唯一**「某 provider 有哪些模型」入口。
 *
 * 候选不再由前端自己从随版本发布的厂商目录里算:上游上新/下线模型是常态,而目录更新要等一个
 * 发版周期——用户要么选不到真实存在的模型,要么选到已下线的 id。服务端才是能安全拨号的一方
 * (浏览器跨域、已存 key 也不该为了列清单而到处跑),所以清单由服务端解析(抓取 → 缓存 → 内置
 * 目录兜底)后回包,这里只负责三件事:
 *
 *  1. **按 provider 去问**。在飞的不重复发;一份**新鲜且非空**的答案不再问,`refresh` 是显式重问。
 *     答案**过期**或**为空**时,下一次需要它的组件会再问一轮 —— 空答案意味着上游那一半还没解析
 *     出来(没配 key/URL、或抓取失败),补好 key 之后重开面板就该看到真实清单;过期的那份背后
 *     已经有一次后台刷新在跑,再问一次才读得到它的结果。非管理员一律不问:服务端对这条消息过
 *     `requireAdmin`,发出去只会换来一条用户没触发的报错,外加一个等不到回包的 ↻。
 *  2. **答案到了就换成本地兜底**。服务端还没答、或者压根不认识这条 provider(草稿里新建未保存)
 *     时,清单回落同名 Model Vendor 随版本内置的目录——这正是「离线/无缓存时界面仍有候选」,
 *     先渲染兜底、答案到了再替换,列表不会先空一下。
 *  3. **把 provider 自填的条目合上去**。服务端回的是**上游那一半**(它不知道用户草稿里改了什么,
 *     也不该知道),自填条目仍按既有语义优先生效——合并在前端做,是因为草稿随时在变,而合并规则
 *     与内置目录那一半共用同一个 `mergeProviderModels`。
 *
 * 模块级单例(与 useAuth 同一形态):答案与在飞状态跨组件共享,由 App 绑定发送器,回包在消息
 * 路由里灌回来。没有绑定发送器时(单测直接挂组件)一切照旧——兜底清单本身就够渲染。
 */
import {
  computed,
  ref,
  toValue,
  triggerRef,
  watchEffect,
  type ComputedRef,
  type MaybeRefOrGetter,
} from 'vue'
import type {
  ClientToServer,
  ModelProvider,
  ModelProviderModel,
  ServerToClient,
} from '@ccc/shared/protocol'
import { mergeProviderModels, modelVendorModels } from '@ccc/shared'
import type { ModelVendorId } from '@ccc/shared'
import { useAuth } from '@/composables/useAuth'

/**
 * `provider_models_result` 回包。消息载荷类型是协议分区内部的(不外泄到 `@ccc/shared/protocol`
 * 的公共面),所以从导出的联合里取那一臂 —— 字段跟着协议走,不会各自漂移。
 */
export type ProviderModelsResult = Extract<ServerToClient, { type: 'provider_models_result' }>

/** 一条 provider 的上游清单答案(服务端语义,原样存下)。 */
interface UpstreamAnswer {
  models: ModelProviderModel[]
  fromCache: boolean
  stale: boolean
}

type Sender = (msg: ClientToServer) => void

// ---- 模块级状态(所有调用方共享) ----
//
// 数据本身是**普通值**,旁边挂一个只用来通知渲染的 revision ref。**判断**(某条 provider 还要不要
// 问)一律读普通值:判断发生在面板的 watchEffect 里,而「答复到达」正会改这些普通值 —— 判断若读
// 的是响应式 ref,答复就成了 effect 的依赖,空答案一落地就重跑、重跑又发现它是空、再问一次,
// 死循环。渲染读 revision:数据变了就通知它,读它的 computed / 模板随之重算。
let answers: Record<string, UpstreamAnswer> = {}
const answersRev = ref(0)
const pending = new Set<string>()
const pendingRev = ref(0)

/**
 * 通知渲染层「这份数据变了」。**必须**用 `triggerRef`,不能写成 `rev.value += 1`:自增是一次
 * **读**,而它常发生在 `ensureOne` 的 effect 里 —— 计数器就此成了 effect 的依赖,答复一到就
 * 重跑,又是死循环(只不过绕了一圈)。`triggerRef` 只通知、不登记依赖,值也就不用变。
 */
function markChanged(rev: typeof answersRev): void {
  triggerRef(rev)
}

let sender: Sender | null = null
/** 绑定次数:发送器到位后重跑依赖它的 watchEffect,否则首帧问不出去就再也没人问。 */
const senderReady = ref(0)

/** 管理员判定来自服务端(`ready`);非管理员问了也只有拒答,见 ensureOne。 */
const { isAdmin } = useAuth()

/** App 绑定实时发送器(与 auth.bindSender 同一处)。 */
export function bindProviderModelsSender(fn: Sender): void {
  sender = fn
  // 在飞状态是**连接级**的:上一根 socket 上的请求不会再有回包,留着它只会让 ↻ 永远转下去。
  pending.clear()
  markChanged(pendingRev)
  senderReady.value += 1
}

/** 消息路由把 `provider_models_result` 灌回这里。 */
export function applyProviderModelsResult(msg: ProviderModelsResult): void {
  pending.delete(msg.providerId)
  markChanged(pendingRev)
  answers = {
    ...answers,
    [msg.providerId]: { models: msg.models, fromCache: msg.fromCache, stale: msg.stale },
  }
  markChanged(answersRev)
}

/**
 * 服务端明确不会回包时解掉在飞状态(`auth.adminOnly` 把 `fetch_provider_models` 整条拒了,
 * 没有 result 会回来)。不解掉,`loading` 就恒真、↻ 会在整个会话里禁用。
 */
export function dropPendingProviderModels(): void {
  if (pending.size === 0) return
  pending.clear()
  markChanged(pendingRev)
}

/** 测试钩子:清空共享答案、在飞状态与发送器。 */
export function resetProviderModelsForTests(): void {
  answers = {}
  markChanged(answersRev)
  pending.clear()
  markChanged(pendingRev)
  sender = null
  senderReady.value = 0
}

/** 问一次某 provider 的清单;返回是否真的发了出去(没有发送器就没人能回)。 */
function request(providerId: string): boolean {
  if (!sender || !providerId) return false
  if (pending.has(providerId)) return true
  sender({ type: 'fetch_provider_models', providerId })
  pending.add(providerId)
  markChanged(pendingRev)
  return true
}

/**
 * 该 provider 当下可用的**上游**清单:服务端答案优先,空答案(还不认识它)或还没答时用随版本
 * 内置的厂商目录。空答案不当作「上游就是没有模型」——那会把草稿里新建的 provider 的候选清空。
 */
function upstreamFor(provider: ModelProvider): readonly ModelProviderModel[] {
  // 答复到达时让读它的 computed / 模板重算(这个文件里唯一的响应式入口)。
  void answersRev.value
  const answer = answers[provider.id]
  if (answer && answer.models.length > 0) return answer.models
  return modelVendorModels(provider.vendor)
}

/**
 * 这份答案还值不值得重问:没有答案要问;答案为空(上游那一半没解析出来)或已过期要问;
 * 其余(新鲜且非空)问了也是同一份,不问。
 */
function needsAnswer(answer: UpstreamAnswer | undefined): boolean {
  if (!answer) return true
  return answer.models.length === 0 || answer.stale
}

/**
 * 没有答案、或答案为空/过期时才问——同一 provider 在飞不重复发,新鲜答案不再问。
 *
 * `senderReady`/`isAdmin` 是存心的依赖:发送器到位、或本连接被认成管理员时,effect 要重跑一次,
 * 否则首帧问不出去就再也没人问。答案与在飞状态反而**不能**成为依赖,见上面的状态说明。
 */
function ensureOne(provider: ModelProvider | null | undefined): void {
  if (!provider?.id) return
  // 读一次,让依赖它的 effect 在发送器绑定时重跑。
  void senderReady.value
  // 非管理员发了也是拒答(`requireAdmin` 只回 error 不回 result):徒增一条用户没触发的报错,
  // 外加一个等不到回包的 ↻。与面板里那几个 admin-only 按钮同一道门。
  if (!isAdmin.value) return
  if (!needsAnswer(answers[provider.id])) return
  request(provider.id)
}

/** 显式重问:丢掉旧答案(含过期的),再问一次。非管理员同上,不白问。 */
function refreshProvider(providerId: string): void {
  if (!providerId || !isAdmin.value) return
  const { [providerId]: _dropped, ...rest } = answers
  answers = rest
  markChanged(answersRev)
  pending.delete(providerId)
  markChanged(pendingRev)
  request(providerId)
}

function isLoading(providerId: string): boolean {
  void pendingRev.value
  return pending.has(providerId)
}

function isStale(providerId: string): boolean {
  void answersRev.value
  // 还没答的 provider 不算「过期」——那只是兜底清单,标出来会让每一行都顶着同一个提示。
  return answers[providerId]?.stale ?? false
}

/** 单条 provider 的视图:`models` 是有效清单,`upstream` 是上游那一半。 */
export interface ProviderModelsHandle {
  /** 有效清单:上游那一半 + 这条 provider 的自有条目(同名以自有为准)。 */
  models: ComputedRef<ModelProviderModel[]>
  /** 只读上游那一半,不含自有条目——提供方面板把两者分区展示。 */
  upstream: ComputedRef<ModelProviderModel[]>
  /** 该 provider 的清单正在向服务端索取。 */
  loading: ComputedRef<boolean>
  /** 服务端说这份清单已过期(后台正在刷新)。 */
  stale: ComputedRef<boolean>
  /** 显式重问(用户点「重新抓取」)。 */
  refresh: () => void
}

/**
 * 一条 provider 的模型清单(响应式)。`provider` 可以是 ref/getter,草稿里的对象改了立刻生效
 * ——自有条目的合并在前端做,正因如此。
 */
export function useProviderModels(
  provider: MaybeRefOrGetter<ModelProvider | null | undefined>,
): ProviderModelsHandle {
  watchEffect(() => ensureOne(toValue(provider)))
  return {
    upstream: computed(() => {
      const p = toValue(provider)
      return p ? [...upstreamFor(p)] : []
    }),
    models: computed(() => {
      const p = toValue(provider)
      return p ? mergeProviderModels(upstreamFor(p), p.models) : []
    }),
    loading: computed(() => {
      const p = toValue(provider)
      return p ? isLoading(p.id) : false
    }),
    stale: computed(() => {
      const p = toValue(provider)
      return p ? isStale(p.id) : false
    }),
    refresh: () => refreshProvider(toValue(provider)?.id ?? ''),
  }
}

/**
 * 一次覆盖多条 provider / 一个 vendor 的目录视图——agent 表单的候选来自整个候选池,而
 * composable 不能在循环里调用,所以这里是函数式入口;两者共用同一份缓存与同一个发送器。
 */
export interface ProviderModelCatalog {
  /** 上游那一半(不含自有条目)。 */
  upstream: (provider: ModelProvider) => readonly ModelProviderModel[]
  /** 有效清单(自有条目优先生效)。 */
  effective: (provider: ModelProvider) => ModelProviderModel[]
  /** 某 vendor 随版本内置的目录:接不了 provider 的 vendor(cursor)只有这一份候选。 */
  shipped: (vendor: ModelVendorId | undefined) => readonly ModelProviderModel[]
  loading: (providerId: string) => boolean
  stale: (providerId: string) => boolean
  /** 确保这些 provider 的清单已在索取(幂等)。 */
  ensure: (providers: readonly ModelProvider[]) => void
  /** 显式重问某条 provider。 */
  refresh: (providerId: string) => void
}

/** 目录视图(函数式,给模板里逐行渲染用)。 */
export function useProviderModelCatalog(): ProviderModelCatalog {
  return {
    upstream: (provider) => upstreamFor(provider),
    effective: (provider) => mergeProviderModels(upstreamFor(provider), provider.models),
    shipped: (vendor) => modelVendorModels(vendor),
    loading: isLoading,
    stale: isStale,
    ensure: (providers) => {
      for (const provider of providers) ensureOne(provider)
    },
    refresh: refreshProvider,
  }
}
