# 0025 — Sandbox `networkDisabled`/`readonlyRootfs` 下沉为工作区级安全策略

- **Status:** accepted
- **Date:** 2026-06-16
- **Driver:** 网络隔离与只读根文件系统本质是「每个工作区各自的安全策略」，不应由管理员级系统模板承载

## Context

ADR-0021 确立了双层沙箱配置：管理员定义系统级沙箱模板，项目（工作区）通过工作区级沙箱配置引用并覆盖少量字段。当时 `networkDisabled`（禁用网络）和 `readonlyRootfs`（只读根文件系统）都放在系统定义上。

实践中暴露三个问题：

1. **语义错位**：网络是否放通、根文件系统是否可写，取决于具体工作区跑什么活（某些构建/缓存需要可写根、需要拉依赖），属于工作区各自的安全姿态，而非全安装共享的模板属性。放在系统定义里既不灵活，又与「工作区 override」语义重叠让人困惑。
2. **死字段**：合并逻辑当时只读系统定义里的 `networkDisabled`，完全忽略工作区配置上已声明的同名 override —— 协议里有这个配置键，但从未接线，用户在工作区里改它毫无效果。
3. **`readonlyRootfs` 在工作区级毫无入口**：用户根本无法按工作区收紧/放开只读根文件系统。

## Options Considered

### 1. 维持现状（两项留在系统定义）

_Pro:_ 不动代码。
_Con:_ 上述三个问题全部保留；`networkDisabled` override 永远失效；用户无法按工作区调整安全策略。

### 2. 同时放在系统定义与工作区，工作区覆盖系统（标准 override 链）

_Pro:_ 形式上与 `imageOverride`/`memoryLimitOverride` 一致。
_Con:_ 安全策略需要一个**确定的、deny-by-default 的归属点**；让它沿用「缺省继承系统定义」会把默认值的真相分散到两层，难以审计「这个工作区到底放没放网」。
_Con:_ 系统定义里继续保留这两个字段，冗余且易误配。

### 3. 下沉为纯工作区级 deny-by-default 策略 (selected)

`networkDisabled`/`readonlyRootfs` 从系统定义移除，仅在工作区级沙箱配置承载；合并逻辑从工作区配置解析，缺省 `networkDisabled: true`、`readonlyRootfs: true`。

_Pro:_ 归属单一、可审计：安全策略只有一个来源（工作区），缺省即「拒绝」。
_Pro:_ 接通了原本失效的 `networkDisabled` override，并补齐 `readonlyRootfs` 入口。
_Pro:_ 系统定义瘦身，去掉两个易误配的安全字段。
_Con:_ `readonlyRootfs` 默认从 `false` 改为 `true`，是行为变更（见下）。

## Decision

**采纳选项 3。**

1. **协议 / 类型**：系统级沙箱定义删除 `networkDisabled`、`readonlyRootfs`；工作区级沙箱配置保留 `networkDisabled` 并新增 `readonlyRootfs?`。`networkAllowlist` **仍留在系统定义**（管理员管控的 egress SPI，Phase 2 未支持）。
2. **合并**：合并逻辑从工作区配置解析这两项，**deny-by-default**：
   - 缺省 `networkDisabled = true`（`--network none`）。
   - 缺省 `readonlyRootfs = true`（只读根文件系统）。
3. **持久化**：归一化时对这两项持久化显式布尔值（`true` 与 `false` 都保留），使工作区可以**放开**某项策略（例如 `networkDisabled: false` 真正放通网络），而不是只能收紧。
4. **旧值剔除**：系统定义里设过这两项的旧值，在配置校验解析时直接被剥离（首读即丢弃），统一回退新默认，不做迁移。
5. **Web**：系统设置沙箱表单删除两个勾选项；工作区设置沙箱面板补齐（`networkDisabled` 勾选已在、新增 `readonlyRootfs`），并在草稿初始化时按 deny-by-default 预置为已勾选，使 UI 与后端缺省一致。

### 安全基线变更：`readonlyRootfs` 默认 `false → true`

这是一次**安全收紧**：沙箱容器的根文件系统默认变为只读。依赖根可写的构建/缓存（在根目录写临时文件、装全局包等）需用户在工作区里显式把 `readonlyRootfs` 设为 `false`。`/workspace` 挂载点始终可写，不受影响。

## Consequences

### 正面

- 安全策略归属单一、缺省即拒绝，便于审计。
- 失效多时的 `networkDisabled` override 被接通；`readonlyRootfs` 首次有了工作区入口。
- 系统定义去掉两个安全字段，减少误配面。

### 负面 / 风险

- `readonlyRootfs` 默认 `true` 属行为变更，可能让此前隐式依赖可写根的容器构建失败 —— 通过工作区显式置 `false` 解决，文案与 spec（SND-R24）已标注。
- 系统定义里旧的这两项被静默丢弃（无迁移），管理员若曾在系统定义里放过网，升级后该工作区会回退到 deny-by-default，需要在工作区重新放开。

## Compliance

- 合并逻辑须从工作区配置解析 `networkDisabled`/`readonlyRootfs`，缺省 `true`/`true`；schema 与类型的双向钉死仍通过。
- 沙箱注册表测试须覆盖：工作区 override 生效（`false` 放开）、未设置 deny-by-default（`true`）、系统定义旧值被剔除。
- 归一化测试须覆盖：显式 `true`/`false` 双向持久化、未设置时省略（交由 merge 兜底）。
- 文案检查通过：相关文案从系统设置沙箱区迁至工作区设置沙箱区，五语同步。

## References

- [ADR-0021](0021-system-project-two-tier-sandbox-config.md) — 双层配置（本 ADR 修订其字段归属）
- [ADR-0024](0024-sandbox-worktree-only-random-agent-hard-isolation.md) — sandbox 仅 worktree + 硬隔离
- [sandbox domain spec](../../domains/core/sandbox/spec.md) — SND-R5 / SND-R10 / SND-R24
