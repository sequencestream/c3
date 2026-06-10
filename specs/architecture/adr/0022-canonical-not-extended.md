# 0022 — CanonicalMessage 不扩展（沙箱/Checkpoint 通过事件总线）

- **Status:** accepted
- **Date:** 2026-06-09

## Context

沙箱集成（sandbox 容器内运行 agent）引入了两个新的跨层关注点：

1. **容器生命周期** — 启动/停止容器的信号需要从 run 生命周期到达内核沙箱层。
2. **Pre-approve checkpoint** — 在自动批准工具调用前，需要检查沙箱工作区的文件变更。

这两个关注点都需要跨层通信。一个直观的方案是扩展 `CanonicalMessage` 协议，让 sandbox 相关的状态（容器 ID、checkpoint 结果等）作为新字段或新 block 类型承载在 canonical 消息流中。

但扩展 `CanonicalMessage` 有代价：它增加了 wire 协议的复杂度，将服务器内部的状态管理与前端数据结构耦合，并为后续无法预见的上层功能打开了"再扩一个字段"的先例。

## 选项

### 1. 扩展 CanonicalMessage

给 `CanonicalMessage` 新增可选字段（如 `sandboxContainerId`、`checkpoint`），让沙箱状态随消息流传递到前端。

_Pro:_ 前端可以通过 `CanonicalMessage.sandboxContainerId` 直接知道容器 ID，无需额外查询。
_Con:_ 污染了 canonical envelope 的通用性——`CanonicalMessage` 的核心职责是承载 vendor 无关的 agent 会话内容（文本、工具调用、结果），不是服务器内部基础设施状态。
_Con:_ 前端不需要知道容器 ID、checkpoint 结果——这些是服务器内部决策信号。
_Con:_ 开了一个先例：后续任何跨层关注点（资源监控、网络状态、缓存命中率）都会要求扩 `CanonicalMessage`，导致协议膨胀。

### 2. 使用进程内事件总线 (selected)

沙箱状态通过已在运行的 `EventBus`（ADR-0018）在内核层传递，不扩展 `CanonicalMessage`。

- **容器生命周期**：`launchRun` 在 vendor fork 前启动 sandbox，通过 `SessionRuntime.sandboxHandle`/`sandboxStop` 持有引用。sandbox 的生命周期绑定到 `SessionRuntime` 的生命周期，而不是消息流。`finalizeRun`/`removeRuntime` 通过闭包回调停止容器。
- **Checkpoint**：`ApprovalBridge.preApproveCheckpoint` 是一个可选的方法，直接通过 `SandboxDriver.copyFrom()` 操作 Docker，结果通过内存返回（`CheckpointResult`），不进消息流。
- **错误通知**：如果 sandbox 启动失败，通过 `console.warn` 记录（非致命，run 继续执行），或者未来通过 `EventBus` 发布一个 `sandbox:error` 事件。

_Pro:_ CanonicalMessage 不扩展——它保持纯粹的会话内容承载职责。
_Pro:_ 前端完全无感知（前端不需要知道 sandbox 存在）。
_Pro:_ 与现有架构完全一致——`SessionRuntime` 已经是进程级 registry，`EventBus` 已是跨层通信通道。
_Con:_ 前端无法在 UI 中显示 sandbox 状态——这是一个 feature，不是 bug。sandbox 是一个透明的基础设施层。

### 3. 新增专用 wire frame

新增一个 `ServerToClient` union 变体（如 `{ type: 'sandbox_status', containerId: string }`），通过现有 WebSocket 通道下发 sandbox 状态。

_Pro:_ 前端可以获得 sandbox 状态（如果将来需要显示）。
_Con:_ 前端目前不需要；这会增加协议复杂度。
_Con:_ 为未来可能不需要的功能增加 wire 协议。
_Con:_ 与 ADR-0006（run 与连接解耦）的精神不一致——sandbox 是服务器端资源，不是连接级状态。

## 决策

**不扩展 `CanonicalMessage`**。新引入的沙箱关注点通过以下已有机制承载：

| 关注点                 | 机制                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| 容器生命周期           | `SessionRuntime.sandboxHandle` + `sandboxStop` 闭包                       |
| 容器清理               | `finalizeRun` / `removeRuntime` 调用 `sandboxStop()`                      |
| Pre-approve checkpoint | `ApprovalBridge.preApproveCheckpoint()` 可选方法，返回 `CheckpointResult` |
| Checkpoint 文件检查    | `DockerDriver.copyFrom()`（`docker cp`）+ 内存文件列表                    |
| Docker 不可用          | `console.warn` 降级（run 继续执行），未来可选 `EventBus` 事件             |
| 前端感知               | 无——sandbox 是透明基础设施                                                |

## 后果

- CanonicalMessage 不承担 sandbox 状态职责。
- 前端无 sandbox 相关变更。
- 后续 Phase 2（断点续传、checkpoint-restore）需要序列化容器状态到磁盘时，将引入新的持久化机制（而非扩展 wire 协议）。
- 如果将来需要在前端显示 sandbox 状态，应新增专用 `ServerToClient` wire frame 而非扩展 `CanonicalMessage`。
