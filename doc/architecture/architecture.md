# 架构概览

## 系统形态

c3 是一个单一本地进程：浏览器经 `/ws` 连入，进程内经厂商中性适配器驱动宿主 CLI。

```
┌────────────┐      /ws        ┌──────────────────────────────────────────────────┐
│  Browser   │ ──────────────► │  本地服务器（本进程）                             │
│  (web SPA) │ ◄─── ws ──────  │                                                  │
│            │                 │  web-console ↔ agent-session                     │
│ prompt     │                 │              ↕                                   │
│ activity   │                 │       permission-gateway                         │
│ Allow/Deny │                 │              ↕                                   │
│ mode       │                 │  vendor 中性适配器层（ADR-0011）                 │
│            │                 │  ┌──────────┬──────────┬──────────────┐          │
│            │                 │  │  adapter │  adapter │  adapter     │          │
│            │                 │  └────┬─────┴────┬─────┴──────┬───────┘          │
│            │                 │       │          │            │                  │
│            │                 │     Claude     Codex        Cursor               │
│            │                 │     vendor     vendor       vendor               │
│            │                 │       │          │            │                  │
└────────────┘                 └───────┼──────────┼────────────┼──────────────────┘
                                       │          │            │
                                       ▼          ▼            ▼
                                   claude      codex     cursor-agent
                                    CLI         CLI          CLI
```

三个厂商都落在宿主 CLI 上，产品能力不同。驱动与分发见 [`agent-sdk.md`](agent-sdk.md)；Claude 适配边界见 [`claude-agent-sdk-guide.md`](claude-agent-sdk-guide.md)；中性抽象见 [ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)；custom provider 走中立 relay（[ADR-0029](adr/0029-vendor-neutral-relay-and-agent-group-failover.md)）；Cursor 为非托管宿主 CLI（[ADR-0040](adr/0040-cursor-as-host-cli-vendor.md)）。

| Vendor | 进程模型       | 工具级审批 |
| ------ | -------------- | ---------- |
| Claude | 本地常驻子进程 | 逐工具     |
| Codex  | 本地子进程     | 仅整轮     |
| Cursor | 每轮一个子进程 | 仅整轮     |

- **web-console** — 人的视图：侧边栏、活动流、权限与模式。一条连接只保存当前在看哪个会话。见 [web-console](../domains/core/web-console.md)。
- **本地进程** — 升级 `/ws`，单二进制交付中内嵌前端。运行活在进程级 session-runtime，不活在 socket 上（[ADR-0006](adr/0006-decouple-runs-from-connections.md)）。默认只监听本机回环；暴露到网络是显式选择。
- **agent-session** — 驱动适配器走完生命周期，把规范消息映到线协议，并暴露模式切换与中断。运行循环不接触厂商 SDK 类型。见 [agent-session](../domains/core/agent-session.md)。
- **permission-gateway** — 把尚未被策略决定的敏感工具交给浏览器，阻塞直到人作答。见 [permission-gateway](../domains/core/permission-gateway.md)。
- **session-registry** — 工作区与会话目录；转录以厂商原生存储为事实来源。见 [session-registry](../domains/core/session-registry.md)。
- **宿主 CLI** — 硬性运行时依赖。Claude 与 Codex 由 c3 分发，Cursor 不由 c3 分发。解析不到则该厂商不可用——这是产品约定（[ADR-0012](adr/0012-host-binary-probe-first-capability-gate.md)）。

## 模块地图

业务域职责见 [core](../domains/core/core.md) 与 [settings](../domains/settings/settings.md)。下面只列构成运行时形状的层。

- **交付** — 单一自包含二进制（[ADR-0003](adr/0003-single-binary-via-bun-compile.md)）。可选桌面壳把该二进制当 sidecar，WebView 加载其自带前端；壳内无业务逻辑（[ADR-0033](adr/0033-tauri-desktop-shell-sidecar.md)）。
- **线协议** — 两端共用一份消息联合。见 [websocket-protocol](../shared/api-conventions/websocket-protocol.md)。
- **session-runtime** — 进程级注册表：运行句柄、回放缓冲、观看者；跨连接共享。
- **活动状态注册表** — 进程内当前活动事实：generation / sequence 围栏、pending 绑定、只读快照；可从 Runtime 与在途自动化执行重建。与事件总线正交（[ADR-0050](adr/0050-activity-registry-as-current-state.md)）。
- **角标投影** — 从注册表成员集合增量维护 Workspace / 种类 / owner 索引，并从权限、待办、交付权威源维护三类 attention 集合；revision 仅在摘要变化时增加，可全量重建。经 WebSocket 以 snapshot / delta 推送给前端（[ADR-0051](adr/0051-badge-projection-from-activity-sets.md)、[ADR-0052](adr/0052-attention-sets-in-badge-projection.md)、[ADR-0053](adr/0053-activity-snapshot-delta-protocol.md)）。
- **Host-CLI launcher** — 厂商无关的宿主探测与健康检查，第一道能力关卡（ADR-0012）。
- **事件总线** — 进程内发布/订阅。见 [`event-mechanism.md`](event-mechanism.md)（[ADR-0018](adr/0018-event-bus-kernel-layer.md)）。事件表达已发生的事实；当前活动不由总线保存。
- **relay** — 进程内 provider 枢纽，真钥不离开本进程。见 [`relay-architecture.md`](relay-architecture.md)。
- **sandbox** — 入选 run 进进程级隔离；驱动不可用则失败、不裸跑。见 [sandbox](../domains/core/sandbox.md) 与 [沙箱架构](sandbox-architecture.md)。
- **prompt 缓存** — system 与 user turn 分离，稳定前缀才能命中厂商 cache。见 [跨厂商 prompt 缓存](session-scenarios.md)。
- **MCP** — 公开 `POST /mcp` 与内部 loopback MCP 并列、互不放宽。见 [external-mcp](../domains/core/external-mcp.md)。
- **IM 出入口** — 部署级办公 IM。见 [im-robot](../domains/core/im-robot.md)。

## 依赖方向

```
web-console ──/ws──► session-registry ──工作目录 / 模式──► agent-session ──► permission-gateway
                                              │
                                         适配器层 ──► 宿主 CLI
```

控制台是视图，不拥有运行。注册表给运行提供上下文。运行时依赖网关门工具。适配器隔离厂商，SDK 类型不向上泄漏（[ADR-0009](adr/0009-unidirectional-boundaries.md)）。意图、自动化、IM 等复用同一运行时，不反向依赖控制台。域级依赖见 [core](../domains/core/core.md)。

## 横切不变量

- **权限单向。** 只有网关能给出决策；没有决策则敏感工具不得继续。决策不持久化，待决跟 run 走。
- **运行与连接解耦。** 切换观看或关闭 socket 只改订阅；运行继续直到结束或被显式停止。会话之间并发、无固定上限；同一会话串行。
- **配置在实例库。** 设置与会话绑定存在 `c3.db`；实例身份跟随该文件（[ADR-0042](adr/0042-configuration-in-database.md)）。转录仍在厂商原生存储（[ADR-0004](adr/0004-persist-workspace-session-registry.md)）。见 [persistence](../shared/data-conventions/persistence.md)。
- **意图同库、软失败。** 库不可用时意图降级，其余会话仍可服务（[ADR-0007](adr/0007-read-only-intent-agent.md)）。见 [intent-management](../domains/core/intent-management.md)。
- **厂商中性。** 上层经同一界面驱动，按探测到的能力行事，不按厂商身份分支。厂商策略补偿只发生在适配器内（ADR-0011）。

决策目录见 [adr.md](adr/adr.md)。
