# DeepSeek Harness 与 c3 接入：可行性边界

本文给出「能否支持、支持到什么程度、如何支持」的上层结论与取舍；证据、版本快照与过程记录见 GitHub Issue [#506](https://github.com/sequencestream/c3/issues/506)。**DeepSeek 聊天/推理 API 与 DeepSeek Harness（DSH）不是同一产品**；前者是模型端点，后者是独立 agent 运行时。

## 结论摘要

- **能否支持**：在**不承诺** DSH 当前 API 稳定的前提下，技术上存在接入路径（以 **DSH SDK 子进程 + JSON-RPC** 为主线）；是否值得做取决于能否接受 **developer preview** 带来的持续适配成本与 Node 运行环境约束。
- **支持到什么程度**：若接入，宜定位为 **与 Claude / Codex / Cursor 并列的新 vendor**，能力由 DSH 协议映射到既有「三件套 + 能力台账」；超出 DSH 暴露能力的部分在 c3 侧**诚实降级**，不作等同承诺。
- **如何支持**：优先评估 **子进程 `dsh --profile sdk`**，由 c3 适配器维护 stdio 上的 JSON-RPC 会话，将事件译为规范消息；备选为进程内嵌入 Cordis（成本高、与 c3 单进程形态冲突大，不做首选）。

## DeepSeek Harness — 官方定位与调研版本（证据来源）

以下条目来自 **上游仓库 README、`package.json`、架构文档、`dsh-sdk-app` 说明**，核验日期见 Issue。

| 项       | 内容                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份     | 官方表述为 DeepSeek AI 开发的**开源 agent harness**（`dsh`），架构为「everything-is-a-plugin」，基于 Cordis。                                           |
| 阶段     | README 标明 **developer preview**，并声明**会有破坏性变更**。                                                                                           |
| 入口     | GitHub 仓库、npm 包（如 `npx @deepseek-ai/dsh web`）、文档站点见 Issue 链接表。                                                                         |
| 集成形态 | 多种 **profile**（如 `web`、`headless`、`sdk`、`acp`）；**SDK profile** 通过 **stdio 换行分隔 JSON-RPC** 与客户端通信（stdout reserved for protocol）。 |
| 运行环境 | 上游根 `package.json` 声明 **Node `>=24.9.0`**（与 c3 当前 Node 基线需单独对照）。                                                                      |
| 版本快照 | 调研时上游根版本号为 **0.2.2-rc.1**；Git 存在 `dsh-v0.2.2-rc.1` 等 tag。具体锁定版本以 Issue 为准。                                                     |

未在官方文档中逐项核实的内容（例如某项 JSON-RPC 方法是否支持 cancel、会话 id 与 c3 `c3SessionId` 的对应策略）在 Issue 中标记为**待验证**，本文不兜底。

## c3 侧：接入面（对照基准）

厂商必须通过**宿主可执行文件或等价入口**进入适配层；上层为 **driver / approval bridge / session-store** 与**能力台账**（[ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)）。**agent-session** 约束会话生命周期、回放、模式、中止与跨连接行为（[agent-session 域](../domains/core/agent-session.md)）。当前已集成宿主为 **Claude、Codex、Cursor**（[厂商 SDK 与宿主 CLI](agent-sdk.md)）。

## 能力对照

下列逐项对应交付要求；**兼容**表示 DSH 文档已明确存在可映射机制或可从「通用子进程 + 协议」合理对接；**需适配**表示要在 c3 实现映射或桥接；**待验证**表示需在固定版本上读协议实现或抓包验证；**不支持**表示与 c3 不变量冲突或 DSH 未承诺等价语义。

**会话启动与恢复**

- **需适配 / 待验证**：DSH 自有 session 日志与 fork/resume 语义；c3 需要稳定的厂商 session id 与转录事实源（[agent-session](../domains/core/agent-session.md)）。需在 **JSON-RPC SDK** 上确认初始化、恢复、会话存储路径与 `DSH_HOME` 等约定后，才能在 adapter 中填报 **session store** 子台账。
- **阻碍（若缺失）**：若无稳定 session id 或无程序化 resume，则 c3 只能降格为「单次 headless 任务」，与「工作台会话」体验不一致。

**消息与工具事件**

- **需适配**：DSH 事件域（session / agent / tools）与 c3 **规范消息 + 线协议**（assistant 文本、tool_use、tool_result）之间的翻译；需处理 DSH 的流式 assistant-stream 与 settle 语义与 c3「块原地修订」模型的差异。
- **待验证**：工具调用是否均能映射到「工具名 + 结构化输入」；MCP 或沙箱策略与 c3 **permission-gateway** 的敏感工具分类是否一致。

**取消执行**

- **待验证**：SDK 侧对「中止当前 step/turn」的 RPC 与信号语义；需与 c3 `stop_run`、租约与 `turn_end` 规则对齐（[agent-session](../domains/core/agent-session.md)）。

**权限审批**

- **需适配**：`dsh-sdk-app` 文档说明默认写盘类工具可能需要 **approval responder**（`approvalRequests`、`approval/request` 等）；需接到 c3 **permission-gateway** 或诚实标为「仅启动时策略」并反映在能力台账。
- **勿混用**：不能与「仅配置 DeepSeek API key」混为一谈；审批链路由 DSH + c3 共同定义。

**工作目录控制**

- **需适配**：DSH 文档称 provider/model 与 **workspace cwd** 经 SDK 初始化传入；须与 **session-registry** 提供的工作目录一致，并符合沙箱与工作区身份不变量（[agent-session](../domains/core/agent-session.md)、[session-registry](../domains/core/session-registry.md)）。

**其他**

- **Team / 多智能体**：c3 对 **agent team** 有专有限制（如仅部分 vendor 可做 lead）；DSH 亦有其 Agent Teams / subagent 模型。**待验证** 二者是否可映射或必须禁用 team 路径。
- **Node 运行时**：DSH 要求 **Node ≥24.9** 时，与 c3 分发/打包的 Node 版本策略冲突则构成**发布面阻碍**，需在 Issue 中单独记录。

## 推荐方案与理由

**首选：JSON-RPC SDK 子进程（`sdk` 或受控 `sdk-minimal` profile）**

- **理由**：与现有「启动外部宿主、消费流式规范消息」形态一致；stdio 协议边界清晰；不强行把 Cordis 嵌进 c3 单进程。
- **功能边界**：以 Issue 中锁定的 DSH 版本能力为准；preview 期间**不承诺**长线稳定。
- **主要风险**：**破坏性变更**、Node 版本、协议体积与调试成本、审批事件与时序差异。
- **工作量量级（数量级估计）**：新增 vendor 描述符 + driver（JSON-RPC 客户端、事件归一化）+ session-store 映射 + 门控桥接 + 探测与台账 + 回归——通常对标「新增一个与 Cursor 复杂度相当或更高」的适配器轮次（精确估算需在 spike 后更新 Issue）。

**备选：仅模型 relay（非 DSH）**

- **适用**：用户需求是「DeepSeek 模型」而非 Harness 工具与插件生态。
- **理由**：c3 已有中立 **relay** 与 provider 模型配置路径；不承担 DSH 插件与工具链。
- **边界**：不提供 DSH 的 harness 语义与插件能力。

**不推荐首选：在 c3 进程内嵌入 Cordis/DSH 核心**

- **理由**：架构耦合高、升级与隔离困难，与当前「宿主外置 + 适配器」边界（[agent-sdk](agent-sdk.md)、[ADR-0011](adr/0011-vendor-neutral-agent-abstraction.md)）不一致。

## 证据边界与后续最小验证

**证据边界**：本文与 Issue 依赖截至核验日期的**上游公开 README/架构/SDK bundle 文档**；未对 DSH 源码做完整走读，**不作**「全部 RPC 方法已核对」的承诺。

**最小验证步骤（建议写入 Issue 执行记录）**

1. 固定 npm 包版本与 git tag，记录于 Issue。
2. 在本机安装并运行 `dsh --profile sdk`，用官方 TypeScript 或 Python SDK 样例完成 **list session → send turn → tool → resume** 全链路，导出 JSON-RPC 方法列表与典型响应序列。
3. 对照 c3 driver 必备契约（abort、session id、规范消息迭代）列出差集，更新能力台账草稿。
4. 确认运行环境：Node 版本、c3 打包是否需要 **随 DSH 捆绑 Node** 或抬升引擎下限。

**通过/否决前提**

- **可继续工程化**：存在稳定 session id、可程序化 resume/cancel、审批事件可映射或可明确降级策略。
- **应暂停或仅限实验**：协议频繁破坏、无法映射 `stop_run` 语义、或 Node/发布链无法在 c3 支持矩阵内满足。

## 相关文档

- [厂商 SDK 与宿主 CLI](agent-sdk.md)
- [agent-session 域](../domains/core/agent-session.md)
- [ADR-0011 厂商中立抽象](adr/0011-vendor-neutral-agent-abstraction.md)
- 过程账本：[GitHub Issue #506](https://github.com/sequencestream/c3/issues/506)
