# 会话场景（Session Scenarios）

> 本文是**活文档（current state）**：清点 c3 里**所有构造 prompt 的场景**（prompt construction sites），
> 记录每个场景的会话类型（sessionKind）、构造位置、系统提示路径，以及 Claude / Codex 各自的支持情况与是否存在**缓存/融合问题**。
> 目的：一处集中审视「system instruction 与 user prompt 是否被分离」，为跨厂商的 prompt/cache 优化提供地图。
>
> **状态（2026-07-01 起）**：所有工具会话提示词已完成 system/user 拆分（见「拆分所有工具会话提示词」意图）。
> `driverModelPrompt()` 融合逻辑已删除，改为 `modelUserTurn()`（仅拼 user turn）+ 各厂商的独立 system 通道。
> 唯一保留单字符串的是 `runTaskTool`（按意图 C11 显式决策，收益极低）。

## 心智模型

一次 prompt 的组装可分为两部分：

- **system instruction**：角色、SDD 规格、devSkill、评审规则等**稳定、可缓存**的指令；
- **user prompt / user turn**：本轮用户实际输入，**每轮变化**。

两者**分离**后 system 段可命中缓存。各厂商的 system 通道：

- **Claude**：`appendSystemPrompt`（挂到 `runClaude` 的 preset system append）/ 顾问 one-shot 走裸字符串 custom `systemPrompt`（`askAgentOnce`）或 preset append（`askOneShot`）；
- **Codex**：无独立 system 角色，driver 把 system 文本作为**输入数组首个 text item（position 0）**交付——每轮字节稳定的前缀，即 API prompt cache 的命中键。`DriverStartOptions.systemInstruction` 承载该通道，`run-via-driver.ts` 解析出 `{ systemInstruction, userTurn }` 分别传入 `driver.start`。

**缓存标记图例**：✅ = system 与 user 已分离（Separate），system 段可缓存；⚠️ = 单字符串未拆分（当前仅 `runTaskTool`，按设计保留）。

---

## 一、Claude / Codex 共有的场景

以下场景两个厂商都会走到。Claude 经 `appendSystemPrompt` 分离，Codex 经 driver 的 `systemInstruction` 通道（首个 text item）分离——两侧均已消除融合缺口。

### Dev turn（SDD + devSkill） — work

`dev-prompt.ts` 先做 split，拆出 `systemInstruction`、可见部分（visible）与 devSkill 的 `userTurnPrefix`。

- **Claude** ✅：`systemInstruction` 交给 `appendSystemPrompt`（`run-lifecycle.ts:521-522`），visible + devSkill 前缀经 `modelUserTurn()` 组成 user turn。
- **Codex** ✅：`run-via-driver.ts` 把 `inject.systemInstruction` 经 `DriverStartOptions.systemInstruction` 交给 driver（作为首个 text item），`userTurn`（devSkill 前缀 + visible）单独传入（`run-via-driver.ts:364-368,511-512`）。

### Intent comm create/refine/split — intent

`buildIntentAgentPrompt()` 生成意图沟通 agent 的系统提示（`IntentProfile.appendSystemPrompt`）。

- **Claude** ✅：经 `appendSystemPrompt` 挂到 `runClaude`，user prompt 独立传入。
- **Codex** ✅：`intentProfile.appendSystemPrompt` 经 driver 的 `systemInstruction` 通道交付（`run-via-driver.ts:364-366`），user turn 独立。

### Spec author create/reset — spec

`buildSpecAgentPrompt()` 生成规格作者 agent 的系统提示（`SpecProfile.appendSystemPrompt`）。

- **Claude** ✅：经 `appendSystemPrompt` 挂到 `runClaude`，user prompt 独立。
- **Codex** ✅：`specProfile.appendSystemPrompt` 经 driver 的 `systemInstruction` 通道交付，user turn 独立。

### Discussion research — discussion

- **Claude** ✅：`research.ts` 用 `DISCUSSION_RESEARCH_PROMPT` 经 `appendSystemPrompt`，`buildResearchPrompt()` 生成 prompt，经 `runClaude`。分离（one-shot）。
- **Codex**：N/A —— research 仅 Claude 支持，Codex 侧无此场景。

---

## 二、仅 Claude 的场景

### Work chat（普通用户消息） — work ✅

普通聊天消息在 `works/index.ts` 经 `launchRun(rt, msg.text)` 进入，prompt 只是**单一 user turn**，不带任何 system instruction。天然分离，无缓存问题。

### Dev turn team-lead push — work ✅

team-lead 进程在**启动时**已一次性设置 `systemInstruction`（`runClaude` 的 `appendSystemPrompt`）。后续 push（`dev-turn.ts`）只推**纯 user turn**（`input.prompt`），不再每轮重复前置 system/devSkill——缓存前缀保持稳定。

### Consensus voter（tool allow/deny） — consensus / Claude CLI ✅

`consensus-tally.ts:voterPrompt()` 返回 `{ system, user }`：system = 顾问角色 + 判定指令 + JSON 形状（不含 tool/context），user = 本轮 tool + input + context。经 `askAgentOnce(agent, user, …, system)` 交付。N 路并行 voter 共享**同一份可缓存 system 前缀**。

### Consensus voter（AskUserQuestion） — consensus / Claude CLI ✅

`consensus-tally.ts:askVoterPrompt()` 返回 `{ system, user }`：system = 顾问角色 + 选项作答规则 + JSON 形状，user = context + 问题列表。经 `askAgentOnce` 分通道交付。

### Consensus decider / summarizer — consensus / Claude CLI ✅

`consensus-tally.ts:deciderAskPrompt()` 返回 `{ system, user }`（system = 裁决规则 + 汇总语言 + JSON 形状，user = 每问的投票记录 + 分歧问题选项）；`consensus.ts` 内联 tool 投票 `summarize()` 同样拆出稳定 system 角色。均经 `askAgentOnce` 分通道交付。

### Checkpoint consensus voter（continue/wait） — consensus / Claude CLI ✅

`checkpoint-consensus.ts:voterPrompt()` 返回 `{ system, user }`：system = 顾问角色 + 决策指令 + 考量清单 + JSON 形状，user = intent + last message + checkpoint signal + evidence。N 路并行 voter 共享可缓存 system 前缀。

### Checkpoint consensus summarizer — consensus / Claude CLI ✅

`summarize()` 内联 prompt 拆为 system（汇总角色 + 输出指令）+ user（投票列表），经 `askAgentOnce`。

### Intent completion judge — tool / Claude CLI ✅

`judge.ts:buildPrompt()` 返回 `{ system, user }`：system = 评审角色 + verdict 规则 + JSON 形状，user = intent + messages + evidence。经 `askOneShot({ prompt: user, systemInstruction: system })`，system 走 preset append。

### askOneShot（general） — tool / Claude CLI ✅（可分离）

`kernel/agent/index.ts:299` 的 `askOneShot` 新增可选 `systemInstruction`，经 preset `append` 交付；调用方（judge）传入稳定角色即分离。未传时退化为裸 preset（旧行为）。

### runTaskTool — tool / Claude CLI ⚠️（按设计保留单字符串）

`kernel/agent/index.ts:444`。任务执行器是每次一次性的机械单回合，切分出的 system 极小（preset + 单工具描述），缓存收益可忽略，且当前 prompt 需被模型端到端读取以消歧强制的工具调用——按意图 C11 显式保留单字符串，不拆分。

---

## 观察

- **2026-07-01 拆分后**：dev / intent / spec 三类多轮场景在 **Claude 与 Codex 两侧均已分离**（Codex 经 driver 的 `systemInstruction` 首 text-item 通道），此前经 `driverModelPrompt()` 融合的主要缺口已消除。
- **Dev turn team-lead push** 不再每轮重复前置 system，缓存前缀稳定。
- **Consensus / checkpoint / judge** 顾问 one-shot 均拆为 `{ system, user }`：N 路并行 voter 现共享同一份可缓存 system 角色前缀（`askAgentOnce` 用裸字符串 custom systemPrompt 保持轻量，`askOneShot` 用 preset append）。
- **runTaskTool** 是唯一按设计保留的单字符串场景（收益极低、避免回归）。
- 说明：Codex CLI（`codex exec`）经 stdin 送出整段 prompt，首个 text item 作为字节稳定前缀落在请求体的用户消息前段，即 API prompt cache 的命中键；因此「首 text item」等价于稳定可缓存前缀。
