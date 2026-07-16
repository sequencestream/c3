# 0030 — 冻结的会话 store scope + vendor 中立 sandbox 数据根

- **Status:** accepted
- **Date:** 2026-07-17

## Context

ADR-0028 把 sandbox 落为进程级 arapuca 隔离,ADR-0015 把"会话的 vendor"冻结为首次绑定时的不可变
不变量——因为一个会话的 transcript **只**存在于它所属 vendor 的原生 store 里,c3 从不另存会话内容。

sandbox 落地后出现第二维不变量的缺口:同一 vendor 的数据根在**宿主 run** 与 **sandbox run** 下并不相同
(codex `CODEX_HOME`:宿主 `~/.codex` vs 持久 `~/.c3/sandbox-home/<project>/.codex`;claude
`CLAUDE_CONFIG_DIR`:宿主 `~/.claude` vs 若隔离则另一处)。于是一个会话的 transcript 物理落在两地之一。
而读取端(`CodexSessionStore` 曾把 sessions 根硬编码为宿主 `~/.codex`)不看这个区别,导致:

1. **sandbox 里产生的 codex session 历史前端读不到**(读取端恒读宿主 home,而 rollout 写在 sandbox home)。
2. **切换 sandbox 开关后续接错位**:sandbox 冻结的 session 在宿主续接 → `no rollout found`。

问题 **vendor 中立**:claude 有同构变量 `CLAUDE_CONFIG_DIR`,真跑通 claude 沙箱化后同样成立。

## Decision

引入**第二个冻结不变量 `storeScope: 'host' | 'sandbox'`**,并把两 vendor 的 sandbox 数据根抽象为一个
vendor 中立解析函数。三层协同:

- **存储层(内核 config,对 vendor/scope 无感知)**:`SessionAgentFact` 增可选 `storeScope`,与 `vendor`
  并列在首次绑定时冻结(`bindSessionAgent` 增参;`changeSessionAgentFact` 保留不可变,agent 切换从不
  relocate store)。缺省(遗留 fact / 无 fact)读作 `'host'`——每个前 sandbox 时代的会话都在宿主。
- **解析层(内核 agent-config)**:`freezeSessionAgent` 增 `storeScope` 参数并透传给存储层与 `onBind`
  投影钩子;新增 `resolveSessionStoreScope`(`resolveSessionVendor` 的姊妹)。
- **绑定时机**:与 vendor 冻结同一时刻,在首个真实 session id 上,两条 run 路径(claude 路径
  `run-lifecycle`、driver 路径 `run-via-driver`)都从 `rt.sandboxPaths` 是否存在推导 scope。
- **读取端两处扫(dual-scan)**:`CodexSessionStore` 按 `storeRoots` 扫多根;缺省即扫宿主 + 本工作区
  sandbox home 两处,对存量/切换鲁棒(按 `session id + cwd` 精确匹配,thread id 唯一不冲突)。
  冻结 scope 已知时按"冻结根优先、另一根兜底"排序精确定位。
- **vendor 中立数据根**:`resolveVendorStoreDir(vendor, workspace, scope)` 收敛解析;`ResolvedSandboxPaths`
  增 `claudeConfigDir`,wrapper 按 vendor 挂载/导出对应根。**claude 的 sandbox 数据根故意复用宿主
  config dir**——因为 claude transcript 由 SDK 按 **server 进程的** `CLAUDE_CONFIG_DIR` 定位,多工作区
  server 无法按调用改写;复用宿主目录使 sandbox 写入即被宿主读到(claude 凭证不在 config dir 内,安全)。
- **续接**:非 sandbox run 续接冻结为 sandbox 的 codex session 时,把 `CODEX_HOME` 指向 sandbox home,
  使宿主进程也能找到 rollout。反向(host 冻结在 sandbox 内续接)保持 wrapper 的 sandbox home,为可接受
  的取舍(宿主 `~/.codex` 挂进 sandbox 会破坏 deny-by-default)。

## Consequences

- transcript 随冻结 scope 定位,"在哪写就在哪回",与工作区 sandbox 开关后续变化解耦。
- 存量会话无迁移成本(缺省 host + dual-scan 兜底)。
- claude 与 codex 采不同数据根策略(claude 复用宿主 / codex 隔离持久),但经 `resolveVendorStoreDir`
  收敛为一个 vendor 中立接缝,claude 沙箱化真跑通时无需再抄一遍读取逻辑。
- 有意接受的边界:host 冻结的 codex session 在 sandbox 内续接不强行挂宿主 home,可能起新 rollout。
