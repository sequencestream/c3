# 0020 — SandboxDriver 作为独立 kernel 模块

- **Status:** accepted
- **Date:** 2026-06-09
- **Driver:** 沙箱隔离需求 → 容器生命周期管理 → 独立于 agent 抽象

## Context

c3 需要在容器中运行 agent 的 vendor CLI 进程，以实现文件系统、网络和资源的隔离。这引入了一个新的基础设施关注点：**容器生命周期管理**——创建、启动、停止、删除容器，以及在容器内执行命令。

在沙箱功能设计初期，有三种可能的归属方案：

1. 将容器操作内嵌到 `AgentAdapter`（每个 vendor 的 driver 自行管理容器）。
2. 放在 `wiring/` 层作为胶水代码。
3. 创建一个独立的 kernel 模块。

三个候选各有trade-off。此外，未来可能需要支持多种容器后端（Docker、gVisor、Kata、Firecracker），接口需要足够通用以容纳不同的运行时。

已有架构约束（ADR-0009）要求 kernel 模块不得反向依赖 features/transport，且 kernel 内部模块之间也应有清晰的单向边界。

## Options Considered

### 1. 嵌入 AgentAdapter

_Pro:_ adapter 可以精确控制容器的生命周期，与 vendor 进程的 fork 时机完美对齐。
_Con:_ 每个 adapter 都要实现（或复制）相同的容器管理代码——违反 DRY。
_Con:_ 新的 vendor 接入时必须理解容器管理逻辑，增大了接入成本。
_Con:_ 容器后端的选择不应该与 vendor 绑定（一个项目应该能用同一个沙箱配置运行任意 vendor）。
_Con:_ 违反单一职责——adapter 的职责是桥接 vendor API，不是管理容器。

### 2. Wiring 层胶水代码

在 `server/src/wiring/` 中将容器管理作为 `launchRun` 的前置/后置步骤。

_Pro:_ 不需要新模块，改动最小。
_Con:_ 容器生命周期逻辑游离在分层架构之外，没有明确的归属。
_Con:_ 难以测试——wiring 是 composition root，不应包含业务逻辑。
_Con:_ 新的容器后端支持需要修改 composition root，违反开闭原则。

### 3. 独立 kernel 模块 (selected)

在 `server/src/kernel/sandbox/` 下创建专用的沙箱模块，对外暴露 `SandboxDriver` 接口。

_Pro:_ 职责清晰——容器生命周期属于 kernel 基础设施层。
_Pro:_ 可替换后端——接口抽象化后，Docker/gVisor/Kata/Firecracker 可互换。
_Pro:_ 遵循 ADR-0009——kernel 模块之间只能单向依赖，sandbox 不依赖 agent 或 transport。
_Pro:_ 可测试——接口 mock 化后，依赖 sandbox 的上层可以独立测试。
_Con:_ 增加了模块数量（新增 6 个文件 + 测试）。

### 4. 事件驱动（通过 EventBus 管理容器）

将容器的启动/停止作为 EventBus 事件，由独立的 subscriber 处理。

_Pro:_ 完全解耦——run 生命周期发布事件，sandbox subscriber 响应。
_Con:_ 容器的生命周期需要与 run 生命周期严格同步（先启动容器再 fork vendor 进程），事件模型的异步性引入竞态。
_Con:_ 过度设计——对于启动 + 停止两个同步操作，事件总线增加了不必要的复杂度。
_Con:_ ADR-0022 已确定容器生命周期通过 `SessionRuntime.sandboxStop` 闭包同步管理，无需事件。

## Decision

**采纳选项 3**：`SandboxDriver` 是 `server/src/kernel/sandbox/` 下的一个独立 kernel 模块，通过明确的接口与 run 生命周期集成。

### 接口契约

`SandboxDriver` 定义 7 个方法：

| 方法                                        | 用途                       | 同步/异步               |
| ------------------------------------------- | -------------------------- | ----------------------- |
| `start(config, opts?)`                      | 创建并启动容器             | async → `SandboxHandle` |
| `stop(handle, opts?)`                       | 停止并可选删除容器         | async → `void`          |
| `exec(handle, cmd)`                         | 在容器内执行命令并收集输出 | async → `ExecResult`    |
| `spawnStream(handle, cmd)`                  | 在容器内执行命令并流式输出 | async → `Readable`      |
| `snapshot(handle, tag)`                     | 将容器提交为新镜像         | async → image ID        |
| `copyFrom(handle, containerPath, hostPath)` | 从容器复制文件到宿主机     | async → `void`          |
| `healthCheck(handle)`                       | 检查容器健康状态           | async → `HealthStatus`  |

### 与 Run 生命周期的集成

由 ADR-0022 确定，通过 `SessionRuntime` 的三个字段承载：

```typescript
interface SessionRuntime {
  sandboxHandle?: SandboxHandle // 运行中的容器句柄
  sandboxTmpDir?: string // wrapper 脚本临时目录
  sandboxStop?: () => Promise<void> // 清理闭包
}
```

- `launchRun` 在 fork vendor 进程前调用 `launchSandbox()`，将结果写入 runtime
- `finalizeRun` / `removeRuntime` 调用 `sandboxStop()` 清理容器
- 容器启动失败是**非致命的**——降级为 console.warn，run 继续在宿主机执行

### 可插拔后端

```typescript
export interface SandboxDriver {
  start(config: ResolvedSandboxConfig, options?: StartOptions): Promise<SandboxHandle>
  stop(handle: SandboxHandle, options?: StopOptions): Promise<void>
  exec(handle: SandboxHandle, command: readonly string[]): Promise<ExecResult>
  spawnStream(handle: SandboxHandle, command: readonly string[]): Promise<SandboxStream>
  snapshot(handle: SandboxHandle, tag: string): Promise<string>
  copyFrom(handle: SandboxHandle, containerPath: string, hostPath: string): Promise<void>
  healthCheck(handle: SandboxHandle): Promise<HealthStatus>
}
```

Phase 1 只有 `DockerDriver` 实现。Phase 2 计划加入 gVisor、Kata、Firecracker 实现。

## Consequences

### 正面

- **职责清晰**: 容器生命周期管理有明确归属，与 agent 抽象层完全解耦。
- **可替换后端**: 新增容器运行时只需实现 `SandboxDriver` 接口，无需修改上层代码。
- **遵循 ADR-0009**: `kernel/sandbox/` 不依赖 `features/` 或 `transport/`，不引入 WebSocket / HTTP 语义。
- **可测试**: `DockerDriver` 接受可注入的 `dockerode` 实例，`SandboxRegistry` 是纯内存操作，`SandboxLauncher` 接受 mock driver。所有核心逻辑都有单元测试覆盖。
- **优雅降级**: 容器启动失败不阻断 run 执行——`launchRun` 捕获错误并降级到宿主机路径。

### 负面

- 新增模块的初始化成本：composition root 需要创建 `DockerDriver` + `SandboxRegistry` 并注入 `AppContext`。
- Phase 1 仅支持 Docker 后端。gVisor/Kata/Firecracker 需要额外的适配工作和安全配置。

### 迁移

- 现有的 `run-lifecycle.ts` 已经集成了 sandbox 路径（git HEAD 的状态）。
- 新增后端时不需要修改现有的 `run-lifecycle.ts` 或 `run-via-driver.ts`，只需新增 `server/src/kernel/sandbox/<backend>/` 目录下的实现。

## Compliance

- `server/src/kernel/sandbox/` 不得导入 `features/` 或 `transport/` 模块（ADR-0009 R1，eslint `no-restricted-imports`）。
- `pnpm typecheck` 必须在所有沙箱类型改动后保持绿色。
- `pnpm test` 必须覆盖 `SandboxRegistry.test.ts`、`SandboxLauncher.test.ts`、`DockerDriver.test.ts`。
- `SandboxConfig.ts` 中的 `_AssertEqual` 类型 pin 必须保持绿色（Zod schema 与 TypeScript 接口同步）。

## References

- [ADR-0009](0009-unidirectional-boundaries.md) — 单向边界规则
- [ADR-0022](0022-canonical-not-extended.md) — CanonicalMessage 不扩展，沙箱通过事件总线
- [sandbox domain spec](../domains/core/sandbox/spec.md) — 模块结构、接口定义、业务规则
- [SandboxDriver.tsの実装](../../server/src/kernel/sandbox/SandboxDriver.ts) — 接口源码
