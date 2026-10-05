# Codex 适配边界

本页只写 Codex 适配器相对其它厂商的产品边界：c3 如何面对 Codex 宿主 CLI。系统形状见 [architecture.md](architecture.md)；驱动与分发见 [agent-sdk.md](agent-sdk.md)；运行生命周期见 [agent-session](../domains/core/agent-session.md)；中性抽象见 [ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)。对比 Claude 见 [claude-agent-sdk-guide.md](claude-agent-sdk-guide.md)。本文不适用于 Claude、Cursor。自定义 provider 走中立 relay，见 [relay-architecture.md](relay-architecture.md) 与 [ADR-0029](adr/0029-vendor-neutral-relay-and-agent-group-failover.md)。

SDK 升级评估见 [#486](https://github.com/sequencestream/c3/issues/486)。

## 本地子进程

适配器拉起宿主 `codex` 子进程跑一轮；模型调用与工具执行在该子进程里，不是从本进程直连模型 API。c3 以宿主 CLI 的 JSONL（`codex exec`）形态驱动，不以 JS wrapper 为运行时。prompt 送出后 stdin 关闭，事件流只读，没有写回半通道。对照 architecture.md。

## 子进程回收

一轮结束后回收本轮进程树：先登记后代，再自叶向根终止（SIGTERM，超时则 SIGKILL）。头先死则后代被 init 收养，之后无法证明归属。占用者只认进程自身的 `argv[0]` 是 Codex CLI。

`resume` 被 `already has an active writer` 拒绝时，只有占用者能沿本轮已终结登记证明身份（pid 与启动时间一致）才回收并重试一次。进程表不可读、归属不明或占用者仍在跑，只报告 pid 与启动时间，不杀。

## 上游响应流中断

报错里的 "stream" 属于 **Codex CLI ↔ 上游 provider** 的响应流，不属于 c3 ↔ Codex 的通道。后者只有 stdin 送 prompt、stdout 读 JSONL 事件，从不承载模型字节；文案中的 `upstream fetch failed` 出自 CLI 自己的 HTTP 客户端。CLI 内部会重连响应流若干次（报错里的 `1/5` 即该预算），预算耗尽才把整轮判失败——问题不是缺少重试，而是重试耗尽后无人接盘。

CLI 不提供关闭流式的开关（Responses 请求固定带 `stream`，其 provider 配置表里没有 non-stream 键），所以「默认改走非流式」这条路不存在。可用的是 provider 条目上的 `request_max_retries` / `stream_max_retries` / `stream_idle_timeout_ms`：c3 在自建 relay provider 时下发这三个键，加厚 CLI 内部预算。它们只减少发生，不改变终态归属，不能替代整轮恢复。

处置规则：**上游流在完成前断裂是一类可重试失败**，消耗一次整轮重试预算，预算用尽即失败。两类恢复的代价不同：整轮重试意味着同一轮可能被执行两次，断点之后已发生的工具副作用不回滚；Codex 没有逐工具审批点兜底，所以重试只针对「流在完成前断裂」这一类，不放宽任何权限边界。用户停止与墙钟超时优先于一切分类，不消耗也不触发重试。

重试续跑同一 thread（thread id 已知时）以保留已建立的上下文；断在首帧之前没有 id，只能全新启动一次。这与 `resume` 遇写锁的回收重试是两笔独立预算：写锁拒绝只发生在续跑、且须先回收占用者，上游断裂可发生在任意一轮、无需回收。

判定与归因留在 Codex 适配器内，不上升到中立层——措辞是 Codex 专属的。最终失败的消息带上可读归因（说清是哪一侧的流断了、已自动重试几次），并保留子进程结局作为证据；CLI 弃流时退出码是 0，单看它无法解释失败。

对照 Claude 的 socket 自动续跑：那条状态机服务的是 claude 自身的传输，两者失败模型不同，Codex 的重试不接入它。见 [relay-architecture.md](relay-architecture.md) 的上游终止信号与 [agent-session](../domains/core/agent-session.md)。

## 宿主 CLI 必达

适配器只驱动探测到的宿主 `codex`。找不到则 Codex 不可用。该二进制由 c3 分发，见 [ADR-0012](adr/0012-host-binary-probe-first-capability-gate.md)。

## 整轮审批

Codex 不具备逐工具审批。门控落在启动时的整轮策略上，回合内审批桥不触发。Claude 才有逐工具回路，见 [claude-agent-sdk-guide.md](claude-agent-sdk-guide.md) 与 [permission-gateway](../domains/core/permission-gateway.md)。

## 流式输入与 team lead

Codex 没有流式推入，不能成为 agent-team lead。见 agent-session。

## 设置继承

适配器继承用户 `~/.codex` 与项目 `.codex` 的 hook、允许/拒绝规则与 Skill。继承的允许规则可能自动放行浏览器从未见过的工具；未被预先决定的才到网关。c3 是权限网关，不是唯一权威，见 [ADR-0005](adr/0005-inherit-user-project-settings.md)。

## 它如何读取 Skill

Skill 只认单层 `skills/<name>/SKILL.md`，嵌套一层不会被发现（[ADR-0016](adr/0016-external-skill-git-mount.md)）。
