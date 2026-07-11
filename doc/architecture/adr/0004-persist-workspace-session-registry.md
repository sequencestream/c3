# 0004 — c3 持久化工作区与会话注册表

- **Status:** accepted
- **Date:** 2026-05-29

## Context

c3 最初绑定到单个项目目录，所有状态按 WebSocket 连接保存在内存中——“关闭 socket 即丢弃状
态”。多工作区/多会话特性要求侧边栏能扛过重启：用户添加过的工作区集合、其最近访问顺序、每
个会话的权限模式、以及最后活动的是哪个会话。

Agent SDK 本身已经持久化了会话数据(存放在 SDK 按项目划分的 transcript 存储下的会话记
录)，并暴露了会话列表、消息读取、重命名与删除接口。SDK **不**追踪的是 c3 特有的元数
据：工作区注册表、每会话的权限模式、以及最近访问排序。

## Options considered

- **一切都保存在内存中(不持久化)。** 优点：保留原有不变式；代码更少。缺点：侧边栏、最
  近访问顺序、每会话模式在重启后消失——该特性无法跨会话使用。
- **把 c3 的元数据存进 SDK 的 transcript 存储(例如用 tag)。** 优点：单一存储。缺点：滥
  用 tag；无法表示空工作区(尚无会话)或工作区排序；使 c3 状态与 SDK transcript 内部结构
  耦合。
- **持久化一个小型 c3 专属 JSON 文件；SDK 仍是会话的权威来源。** 优点：清晰的职责划
  分——SDK 拥有会话/历史/标题，c3 只拥有 SDK 无法覆盖的部分；空工作区与排序可以表示。缺
  点：引入了持久化(打破原有的纯内存不变式)；多了一个需要保持一致的存储。

## Decision

在 `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/` 下持久化一个 c3 专属注册表，保存：工作区列表
(路径、名称、最后访问时间戳)、以 SDK 会话 id 为键的每会话权限模式、以及最后活动的会话
id。SDK 仍是会话是否存在、历史与标题的权威来源。该文件以原子方式写入(临时文件 +
rename)，任何读取/解析错误都回退到空状态，使 c3 仍能启动。

## Consequences

- **Easier:** 侧边栏、最近访问顺序、每会话模式能挺过重启；SDK 不被重复实现。
- **Harder:** 现在有了两个存储；c3 必须容忍持久化注册表中出现磁盘上已不存在的会话
  id(过期的模式条目是无害的，会被惰性忽略)。
- 架构中“状态是按连接的、纯内存的；不持久化”的规则被修订：**权限决策仍保持纯内存、按
  连接**(不变，ADR 0001/0002)，但**工作区/会话注册表被持久化**(本 ADR)。
- `settingSources`(现在继承 user + project，ADR 0005)不受影响——transcript 存储与
  会话接口照常工作(见 [`claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md) §4)。

## Compliance

- 持久化注册表与会话读取保持分离；不持久化任何权限状态。
- 评审者应拒绝任何持久化权限决策或批准结果的行为。

## References

- `doc/domains/core/session-registry/session-registry-spec.md`
- `doc/architecture/architecture.md` § cross-cutting conventions
- [ADR 0001](deprecated/0001-c3-sole-permission-authority.md), [ADR 0003](0003-single-binary-via-bun-compile.md)
