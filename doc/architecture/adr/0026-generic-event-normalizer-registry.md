# 0026 — 通用事件契约 + 按 type 注册的归一化器（有意修订「每种事件新增窄工具」）

- **Status:** accepted
- **Date:** 2026-07-13

> **后续演进（2026-07-13）**：本 ADR 当时把「统一模型工具 `publish_event`」记为**后续可复用目标**、明确不在本 ADR 范围（见下方 Scope 表）。该后续目标随后已落地:`publish_pr_event` 被**替换**为单一通用 `publish_event`(入参即 `GenericEvent`),归一化后以 `GenericEventEnvelope` 落到单一 `'event'` 总线 topic,PR 消费者按 `event.type` 判别投影。因此本 ADR 正文中描述 `publish_pr_event` 窄工具与 `pr:operation` 总线 topic 的段落是**决策时的历史语境**;当前状态见 `event-mechanism.md §6`。

> **修订（2026-07-15）——注册表由「封闭」改为「开放 + 默认归一化器兜底」**：本 ADR 原选项 3 把注册表定为**封闭集合**、「未注册 type 一律拒绝」。实践中这与 `<category>:<action>` 命名规范（ADR-0027，type 本就是开放字符串,订阅侧已支持任意 `custom:*` type）冲突,也挡住了用户自定义事件。现修订为:注册表额外接受一个**默认归一化器**(`server/src/features/events/default-normalizer.ts`),已知 type 走其专用归一化器,**其余自定义 type 落到默认归一化器**——它复用同一套 secret 脱敏/绝对路径剥离/截断,但不绑定固定字段形状(递归清洗每个 string 叶子,`type` 不改写)。核心取舍不变:**字段级安全仍在**(默认归一化器同样脱敏/剥路径/截断),放弃的只是「未注册即拒」这条封闭边界——它不再是安全资产,而是无谓的发布限制。下文正文中「封闭注册表 / 未注册即拒」的表述按此修订理解;当前状态见 `event-mechanism.md §6.3 / §9.3`。

## Context

事件总线（ADR-0018）天然多类型、可自由扩 topic。真正被**有意收敛**的是「模型对外发布」这一层：ADR-0018 之后加的 `publish_pr_event` 工具，字段级强类型 + 字段级安全归一化（脱敏、剥绝对路径、折叠空白、截断）+ per-run 信封不可伪造，是这层的核心安全资产。

`event-mechanism.md §9.3` 当时的结论是：出现第 2 种模型可发布事件时，**再新增一个同样聚焦的 `publish_<x>_event` 工具**复用共享核，而**不是**把工具改成带 `type` 的多态 `publish_event`。理由是多态会丢字段级强类型、削弱字段级归一化（一个通用 payload 袋子难做针对性脱敏）。

但「每加一种事件就复制一整套工具 + 字段级归一化」的成本随事件种类线性增长，且极易漂移。缺一个统一的「通用事件」契约与「按 type 注册归一化器」机制，后续的统一发布工具、Automation 通用过滤、以及接入新事件类型都无处落地。

## 选项

### 1. 维持「每种事件新增窄工具」（§9.3 原结论）

每种模型可发布事件都新增 `publish_<x>_event` 工具 + 一套字段级归一化，复用 framing-free 共享核。

_Pro:_ 字段级强类型 + 字段级归一化天然保留；MCP 惯例「窄而清晰 → 模型调用准」。
_Con:_ 每种事件都要复制工具壳 + 归一化实现，成本线性增长且易漂移；没有一处可承接「统一发布/统一过滤」。

### 2. 多态 `publish_event`(`payload: unknown` 或大判别联合)

一个工具吃所有事件。

_Con:_ 要么 `payload: unknown` 放弃校验，要么一个大判别联合让描述变模糊、模型调用正确率下降；字段级安全归一化在通用袋子上很难做针对性处理——正是被 §9.3 否决的形态。

### 3. 通用事件契约 + 按 type 注册归一化器（已选）

一个**供应商中立的通用事件核心**（`type` + `status` + `description` + 扁平 `metadata` + JSON 兼容 `data`），配一个 kernel 层的 `type → normalizer` **封闭注册表**：

- 每种 `type` 注册自己的字段级脱敏 / 截断规则；
- **未注册的 type 一律拒绝发布**——因此通用性不会退化为「任意对象透传」，字段级安全被保住；
- envelope 的 `workspacePath` / `sessionId` 仍由 per-run 绑定闭包在归一化成功后注入，原始事件、`metadata`、`data` 中的同名键不得覆盖信封。

这是对 §9.3「不要多态 publish_event」的**有意修订**——用「type 判别 + 按 type 注册归一化器」的中间路线，同时拿到通用性（一条发布链路）与字段级安全（封闭注册表 + 逐 type 归一化器）。

_Pro:_ 通用性与字段级安全兼得；新增事件类型 = 一个归一化器 + 一处组合根注册，不再复制工具壳。
_Pro:_ 归一化器是纯函数，可脱离总线/传输单测；未注册 type 拒绝是可断言的封闭边界。
_Con:_ 通用 `data` 放弃「全字段先验强类型」，安全边界改由 `type` + 注册归一化器兜底（可接受的取舍）。

## 决策

采用**选项 3**。落地边界：

| 关注点           | 决策                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 通用契约         | `GenericEvent`（`type` 必填非空判别值 + `status`/`description` + 扁平 `metadata` + JSON `data`）与 `GenericEventEnvelope` 定义在 `shared/src/event-model.ts`；`server/src/kernel/events/generic-event-validate.ts` 的 `validateGenericEvent` 拒绝空 type、嵌套 metadata、非 JSON `data`。                                |
| 注册表位置       | `EventNormalizerRegistry`（`server/src/kernel/events/generic-event.ts`）在 kernel 事件边界，不 import features/transport（ADR-0009 R1）；具体 type 的归一化器由 feature 提供，在**组合根显式注册**。                                                                                                                     |
| 拒绝语义         | 查无注册、核心非法、归一化器抛错、或归一化结果非法/改写了 `type`，均同步返回 `{ ok: false }` 且**不调用 `EventBus.publish`**；错误文本不回显原始敏感值。发布前失败**不属于**订阅者错误隔离范围（ADR-0018）。                                                                                                             |
| 重复注册         | 启动期配置错误（`register` 抛错）。                                                                                                                                                                                                                                                                                      |
| PR 作为首个 type | 注册 `type: 'pr:operation'`：`status = result`，`metadata.operation = operation`，`description = errorSummary`，`data` 承载 `pr`/`repo`/`ref`/`association`。现有 PR 字段级脱敏/剥路径/折叠空白/截断规则**迁入该归一化器**，成为模型发布与三条服务端建 PR 路径的**唯一归一化实现**（不再走旧 `normalizePrEvent` 旁路）。 |
| 保留类型化 topic | 本 ADR **不**迁移 `run:*`、`intent:lifecycle` 等已有专属消费者的内部 topic。PR 经**兼容桥**（确定性形状转换，不再次清洗）在归一化后的 envelope 上发布既有 `pr:operation` bus payload，使 Automation 与意图 PR 状态复位消费者契约不变。总线仍保持 ADR-0018 的同步、按注册序、订阅者错误隔离语义。                         |
| 未纳入本 ADR     | 不替换 `publish_pr_event` 工具、不改 Automation 事件过滤/数据库字段/匹配逻辑、不新增 `publish_event` MCP 工具、不改权限策略与分发时序。统一模型工具 `publish_event` 仅作为**后续可复用目标**记录。                                                                                                                       |

## 后果

- **§9.3 结论被修订**：模型可发布事件的安全原则从「每种事件新增窄工具」改为「**type 判别 + 封闭归一化器注册**」。`event-mechanism.md §9.3` 同步改写。
- **扩展更便宜**：加一种模型可发布事件 = 写一个归一化器（字段级脱敏规则）+ 在组合根注册一行；无需复制工具壳与信封/绑定逻辑。
- **安全边界更清晰**：只有已注册 type 能发布，未注册即拒；per-run 信封注入与「同名 data 不可覆盖」由通用链路统一保证。
- **渐进收敛**：`pr:operation` 通过适配桥承接旧订阅面，其余内部 topic 暂不动；后续可按需将统一发布工具与 Automation 通用过滤接到本机制上。

## References

- [ADR 0018](0018-event-bus-kernel-layer.md) — 进程内事件总线；本 ADR 在其「模型对外发布」层之上引入通用契约 + 归一化器注册表。
- [ADR 0009](0009-unidirectional-boundaries.md) — kernel 不得 import features/transport；注册表在 kernel，归一化器由组合根注册。
- [事件机制](../event-mechanism.md) — 活文档，§9.3 记录本决策的落地形态。
