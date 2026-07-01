# 会话场景（Session Scenarios）

> 本文是**活文档（current state）**：清点 c3 里**所有构造 prompt 的场景**（prompt construction sites），
> 记录每个场景的会话类型（sessionKind）、构造位置、系统提示路径，以及 Claude / Codex 各自的支持情况与是否存在**缓存/融合问题**。
> 目的：一处集中审视「system instruction 与 user prompt 是否被分离」，为跨厂商的 prompt/cache 优化提供地图。

## 心智模型

一次 prompt 的组装可分为两部分：

- **system instruction**：角色、SDD 规格、devSkill、评审规则等**稳定、可缓存**的指令；
- **user prompt / user turn**：本轮用户实际输入，**每轮变化**。

理想情况下两者**分离**（Claude 走 `appendSystemPrompt` + 独立 user turn，system 段可命中缓存）；
Codex 侧目前经 `driverModelPrompt()` 把两部分**融合**进 `effectivePrompt`（`run-via-driver.ts`），导致 system 段无法稳定缓存。

**缓存标记图例**：✅ = system 与 user 已分离（Separate），system 段可缓存；❌ = 已融合（Fused）/ 每轮重复前置，system 段无法缓存；⚠️ = one-shot 或 N 路并行 voter 共享同一角色文本，非缓存关键路径但值得留意。

---

## 一、Claude / Codex 共有的场景

以下场景两个厂商都会走到，Claude 侧普遍已分离，Codex 侧因 `driverModelPrompt()` 融合而无法缓存——这是跨厂商优化的**主要缺口**。

### Dev turn（SDD + devSkill） — work

`dev-prompt.ts` 先做 split，拆出 `systemInstruction` 与可见部分（visible）。

- **Claude** ✅：`systemInstruction` 交给 `appendSystemPrompt`，visible 交给 `launchRun`，两者分离。系统提示路径在 `launchRun.ts:521-522`。
- **Codex** ❌：沿用同一份 split，但 `driverModelPrompt()` 把全部内容折进 `effectivePrompt`（`run-via-driver.ts:359-363`），system 段被融合，无法缓存。

### Intent comm create/refine/split — intent

`buildIntentAgentPrompt()` 生成意图沟通 agent 的系统提示。

- **Claude** ✅：经 `appendSystemPrompt` 挂到 `runClaude`，user prompt 独立传入。系统提示路径在 `server.ts:484`。
- **Codex** ❌：经 `driverModelPrompt()` 折进 `effectivePrompt`（`run-via-driver.ts:361`），融合。

### Spec author create/reset — spec

`buildSpecAgentPrompt()` 生成规格作者 agent 的系统提示。

- **Claude** ✅：经 `appendSystemPrompt` 挂到 `runClaude`，user prompt 独立。系统提示路径在 `server.ts:512`。
- **Codex** ❌：折进 `effectivePrompt`（`run-via-driver.ts:361`），融合。

### Discussion research — discussion

- **Claude** ✅：`research.ts` 用 `DISCUSSION_RESEARCH_PROMPT` 经 `appendSystemPrompt`，`buildResearchPrompt()` 生成 prompt，经 `runClaude`。分离（one-shot）。
- **Codex**：N/A —— research 仅 Claude 支持，Codex 侧无此场景。

---

## 二、仅 Claude 的场景

### Work chat（普通用户消息） — work ✅

普通聊天消息在 `works/index.ts:550` 经 `launchRun(rt, msg.text)` 进入，prompt 只是**单一 user turn**，不带任何 system instruction。天然分离，无缓存问题。

### Dev turn team-lead push（重复） — work ❌

`dev-turn.ts:172` 在**每一轮** push 时都把 `systemInstruction` 前置到 `pushInput()`（`InputStream.push()`）。虽然是 Claude，但每次 push 都重复前置，破坏了缓存前缀。

### Consensus voter（tool allow/deny） — consensus / Claude CLI ⚠️

`consensus-tally.ts:voterPrompt()` 把 role + context 合成一段字符串，经 `askAgentOnce()` 调用。one-shot，但 N 路并行 voter 共享同一角色文本。

### Consensus voter（AskUserQuestion） — consensus / Claude CLI ⚠️

`consensus-tally.ts:askVoterPrompt()` 同样把 role + context 合成一段字符串，经 `askAgentOnce()`。情形同上。

### Consensus decider summarizer — consensus / Claude CLI ⚠️

`consensus-tally.ts:deciderAskPrompt()` + `summarize()` inline 把 role + votes 合成一段字符串，经 `askAgentOnce()`。one-shot。

### Checkpoint consensus voter（continue/wait） — consensus / Claude CLI ⚠️

`checkpoint-consensus.ts:voterPrompt()` 把 role + intent + evidence 合成一段字符串，经 `askAgentOnce()`。N 路并行 voter 共享同一角色文本。

### Checkpoint consensus summarizer — consensus / Claude CLI ⚠️

`summarize()` 内的 inline prompt 把 role + votes 合成一段字符串，经 `askAgentOnce()`。one-shot。

### Intent completion judge — tool / Claude CLI ⚠️

`judge.ts:buildPrompt()` 把 role + intent + messages + evidence 合成一段字符串，经 `askOneShot()`。one-shot。

### askOneShot（general） — tool / Claude CLI ⚠️

单一 prompt 字符串直接 → `query()`，位置在 `kernel/agent/index.ts:311`。one-shot。

### runTaskTool — tool / Claude CLI ⚠️

单一 prompt 字符串直接 → `query()`，位置在 `kernel/agent/index.ts:454`。one-shot。

---

## 观察

- **Claude 侧**多数已通过 `appendSystemPrompt` 把 system 段与 user turn 分离（Work chat、Dev turn、Intent comm、Spec author、Discussion research），system 段具备缓存条件。
- **Codex 侧**的 dev/intent/spec 三类多轮场景经 `driverModelPrompt()` 融合，是 prompt 缓存优化的**主要缺口**。
- **Dev turn team-lead push** 在 Claude 侧也存在问题：每轮 push 都重复前置 `systemInstruction`，破坏缓存前缀。
- **Consensus / judge / one-shot** 场景本质是短命的一次性调用，非缓存关键路径；⚠️ 主要提示 N 路并行 voter 共享角色文本，可考虑抽公共前缀。
