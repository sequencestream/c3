# 0021 — 系统定义 + 项目选择双层配置

- **Status:** accepted
- **Date:** 2026-06-09
- **Driver:** 管理员定义沙箱模板，项目用户选择并覆盖

## Context

沙箱隔离需要配置以下信息：容器镜像、资源限制（内存/CPU）、网络策略、seccomp 规则、环境变量、只读根文件系统等。

这些配置项存在两种不同的**管理域**：

1. **系统级（system-wide）**：由 c3 管理员（或默认配置文件）定义的沙箱"模板"。包含完整的容器规格——镜像、资源限制、安全策略等。这些定义在整个 c3 安装中共享。
2. **项目级（project-specific）**：由项目开发者选择的沙箱配置。项目不需要重新定义完整的沙箱规格，只需引用系统定义并按需覆盖少量字段（如覆盖镜像版本、增加内存限制）。

此外，沙箱是一个**可选功能**——大多数项目不需要容器隔离，配置应该允许完全不加任何沙箱相关设置地工作。项目可以通过一个简单的 `enabled` 开关来控制是否启用沙箱。

配置文件结构需要满足：

- 系统配置（`~/.c3/settings.json`）包含沙箱定义列表
- 项目配置（项目的 `.c3/config.json`）引用系统定义并可选覆盖
- 系统配置中的沙箱定义可以被多个项目复用
- 空/缺失配置等价于"不使用沙箱"
- 配置合并有明确的优先级规则

## Options Considered

### 1. 单层扁平配置

系统配置和项目配置都包含完整的沙箱规格，不做分层。项目可以定义自己的完整沙箱配置，也可以留空。

_Pro:_ 模型简单——每个项目独立配置。
_Con:_ 重复定义——多个项目使用相同沙箱配置时需要复制粘贴。
_Con:_ 管理负担——安全策略变更需要逐个更新所有项目的配置。
_Con:_ 没有"管理员模板"的概念——不符合职责分离原则。

### 2. 三层配置（系统/项目/运行）

在系统级和项目级之间增加一个组织级（org-level）配置层。

_Pro:_ 大团队场景下更灵活。
_Con:_ c3 目前没有组织/租户概念——这是超前设计。
_Con:_ 增加了配置合并的复杂度（三层优先级规则）。
_Con:_ 未来可以扩展而不破坏现有双层模型。

### 3. 双层配置 (selected)

系统级定义沙箱"模板"，项目级引用并覆盖。

```
System settings (~/.c3/settings.json):
  sandboxes: [
    { name: "default", type: "docker", image: "node:20-alpine", memoryLimit: "512m", ... }
    { name: "python", type: "docker", image: "python:3.12-slim", ... }
  ]

Project config (.c3/config.json):
  sandbox: {
    enabled: true,
    sandbox: "python",          // 引用系统定义
    imageOverride: "python:3.13", // 覆盖镜像版本
    memoryLimitOverride: "1g"
  }
```

_Pro:_ 模板复用——多个项目共享相同系统定义。
_Pro:_ 职责分离——管理员管理系统定义，项目用户选择并覆盖。
_Pro:_ 最小侵入——项目只需指定 `sandbox: "default"` 即可启用沙箱，所有非覆盖字段继承系统默认值。
_Pro:_ 向后兼容——"无沙箱配置"等价于 `enabled: false`，旧配置不受影响。

### 4. 纯引用（无覆盖）

项目只能引用完整系统定义，不能覆盖任何字段。

_Pro:_ 模型最简单——项目只需指定一个 name。
_Con:_ 过于严格——项目开发者无法调整镜像版本或资源限制。
_Con:_ 每个不同的项目需求都要求管理员创建一个新的系统定义——管理开销大。
_Con:_ 与 c3 现有的"项目可覆盖系统设置"的授权模型不一致。

## Decision

**采纳选项 3（双层配置）**，具体方案如下：

### 类型结构

```typescript
// 系统级沙箱定义（管理员管理）
interface SystemSandboxDef {
  name: string // 唯一名称
  type: 'docker' | 'gvisor' | 'kata' | 'firecracker'
  image: string // 容器镜像
  seccomp?: string // seccomp 配置名称
  memoryLimit?: string // 内存限制（如 "512m"）
  cpuLimit?: number // CPU 限制（如 1）
  resourceLimits?: ResourceLimits // 结构化资源限制（优先级高于扁平字段）
  networkDisabled?: boolean // 禁用网络（默认 true）
  networkAllowlist?: string[] // 网络允许列表（Phase 2）
  readonlyRootfs?: boolean // 只读根文件系统（默认 false）
  envVars?: Record<string, string> // 环境变量
  workingDir?: string // 工作目录
  entrypoint?: string[] // 入口点覆盖
  dockerOptions?: Record<string, unknown> // Docker 特定选项
}

// 项目级沙箱配置（项目开发者管理）
interface WorkspaceSandboxConfig {
  enabled: boolean // 主开关
  sandbox?: string // 引用的系统定义名称
  agentIds?: string[] // 容器内可运行的 custom agent id（worktree-only + custom-only）
  imageOverride?: string // 覆盖镜像
  memoryLimitOverride?: string // 覆盖内存限制
  cpuLimitOverride?: number // 覆盖 CPU 限制
  envVarsOverride?: Record<string, string> // 附加环境变量
}
```

> **改名说明（2026-06-12）**：原 `ProjectSandboxConfig` 统一改名为
> `WorkspaceSandboxConfig`，与 `WorkspaceSetting` 对齐。仅改类型标识符，磁盘键
> （`WorkspaceSetting.sandbox` 及其内部键）不变，无 wire/磁盘迁移。

### 合并规则

0. **worktree-only**：仅当工作区 `gitBranchMode === 'worktree'` 时项目沙箱配置才生效；`current-branch` 模式下容器挂的是主工作区检出，隔离形同虚设，故 normalize 直接丢弃整块配置。
1. **custom-only**：`agentIds` 仅保留 `enabled && configMode === 'custom'` 的 agent id，失效/system/disabled 静默剔除。
2. 如果项目配置缺失、`enabled` 为 `false`、或者未指定 `sandbox` 名称 → **不使用沙箱**。
3. 如果项目配置引用了一个不存在的系统定义名称 → **运行时抛错**（`SandboxRegistry.resolve()` 抛 `Unknown sandbox definition: "name"`）。
4. 合并优先级（从高到低）：项目覆盖 > 系统定义 > 默认值。
5. 环境变量是**合并**（不是替换）的，项目值在冲突时取胜。
6. 结构化 `resourceLimits` 中的 `memory` 和 `cpu` 优先于扁平 `memoryLimit`/`cpuLimit`（同一层级内，不是跨层覆盖）。
7. 未指定的可选字段使用合理默认值：`memoryLimit: "512m"`、`cpuLimit: 1`、`networkDisabled: true`、`readonlyRootfs: false`、`envVars: {}`。

### 验证逻辑

```typescript
export function getProjectSandbox(projectPath: string): WorkspaceSandboxConfig | undefined {
  // loadWorkspaceSetting 已在 normalize 阶段应用 worktree-only + custom-only 不变量。
  return loadWorkspaceSetting(projectPath).sandbox // undefined → 等价于 disabled
}

// 在 launchRun 中使用：
const projectCfg = getProjectSandbox(workspacePath)
if (!projectCfg?.enabled || !projectCfg.sandbox) return null // 不使用沙箱
const resolved = registry.resolve(projectCfg.sandbox, projectCfg) // 合并
```

## Consequences

### 正面

- **职责分离**: 管理员在系统层面管理沙箱模板定义，项目用户只需选择并覆盖少量字段。
- **配置复用**: 一个系统定义可以被多个项目引用。
- **最小侵入**: 无沙箱配置 = 无行为变化。`enabled: false` 显式禁用。只有 `enabled: true + sandbox: "name"` 才激活沙箱。
- **向后兼容**: 所有不包含 `sandbox` 字段的旧项目配置，行为完全不变。
- **清晰的优先级**: 项目覆盖 > 系统定义 > 默认值的三级模型易于理解和调试。

### 负面

- 项目级只能覆盖镜像/内存/CPU/环境变量，不能覆盖网络策略、seccomp 等安全相关字段——这是有意为之（安全策略由管理员管控）。
- 系统定义名称被删除而项目仍引用时，运行时才能发现错误（启动时 fail-fast 已在 `launchRun` 中实现，但因 sandbox 优雅降级，实际上是一个警告）。

### 健壮性保证

1. **启动时验证**: `getProjectSandbox()` 在 session 创建时触发（不是启动时）——因此引用了已删除系统定义的 session 会在 launch 时报错而非静默失败。非 sandbox session 完全不受影响。
2. **空配置安全性**: 整个 `settings.sandboxes` 字段缺失或为空数组时，系统没有任何沙箱定义。项目配置中的 `sandbox` 字段无法引用任何名称。`SandboxRegistry` 为空，`resolve()` 会对任何名称抛错。
3. **降级路径**: 即使 sandbox 启动失败（Docker 不可用、配置错误、镜像拉取失败），非 sandbox 路径完全不受影响。sandbox session 降级为警告并继续。

## Compliance

- `mergeSandboxConfig()` 必须有单元测试覆盖：无项目覆盖、部分覆盖、全覆盖、环境变量合并。
- `SandboxRegistry.resolve()` 必须在引用未知名称时抛错。
- `getProjectSandbox()` 返回 `undefined` 时，`launchSandbox()` 必须返回 `null`（而非抛错）。
- 所有配置模式已在 `SandboxConfig.ts` 中用 Zod schema 定义，`_AssertEqual` 类型 pin 确保 schema 与 TypeScript 接口同步。
- `pnpm test` 必须覆盖 `SandboxConfig` 的合并逻辑和 `SandboxRegistry` 的注册/解析路径。

## References

- [config index](../../server/src/kernel/config/index.ts) — `getSystemSandboxes()` 和 `getProjectSandbox()` 实现
- [SandboxConfig.ts](../../server/src/kernel/sandbox/SandboxConfig.ts) — Zod schema + merge 函数
- [SandboxRegistry.ts](../../server/src/kernel/sandbox/SandboxRegistry.ts) — 注册/解析实现
- [sandbox domain spec](../domains/core/sandbox/spec.md) — 业务规则 SND-R3, SND-R4, SND-R5
- [ADR-0020](0020-sandbox-driver-independent-kernel-module.md) — SandboxDriver 独立 kernel 模块
