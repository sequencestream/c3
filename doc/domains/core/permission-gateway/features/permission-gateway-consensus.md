# permission-gateway — Multi-agent Consensus

Implements rule [PG-R9](../permission-gateway-spec.md). An **optional** pre-step in front of the human
permission prompt: instead of asking the user immediately, c3 first asks the
_other_ configured agents whether the tool call should be allowed, and only
falls back to the human when they disagree.

Off by default. Enabled via `SystemSettings.consensus.enabled` (system settings
page). Orchestration spawns advisor queries; the vote parsing / tally / summary is
a pure, SDK-free unit so it can be unit-tested in isolation, mirroring the
permission registry.

### Config source: `workspacePath`, not the worktree `cwd`

The consensus config — the enable switch, the voter roster, and the majority
toggle — is read by **`workspacePath`** (the registered project root), **never** by
the run's effective `cwd`. The two differ in worktree-isolated runs (intent
`start_development` / automation worktree mode), where `cwd` is the detached
worktree (`<c3-home>/worktrees/<project>/intent-<id>/`) while `workspacePath` stays
the project root. `loadWorkspaceSetting` keys on the exact path (no parent-directory
walk, no worktree→root normalization), so reading config off the worktree `cwd`
misses `projectConfigs[root]` entirely — `enabled` falls back to `false` and voting
is silently skipped. The gateway therefore threads both: `GatewaySpec.workspacePath`
(config + WorkCenter audit attribution) and `GatewaySpec.cwd` (the advisor queries'
launch directory, correctly the worktree). `ConsensusParams` mirrors the split —
`isConsensusEnabled` / `getConsensusConfig` / `isConsensusMajorityEnabled` read
`workspacePath`; the one-shot advisor `askAgentOnce` runs in `cwd`. In
current-branch mode the two paths coincide, so behaviour is unchanged. Checkpoint
consensus (automation orchestrator) already reads config off `workspacePath`.

### Majority toggle (config base)

`SystemSettings.consensus.majority` is a second, optional system switch (checkbox
in the settings page next to "Enable multi-agent consensus voting"). Default
`false` ⇒ **unanimous-only**: the current behaviour where a prompt auto-resolves
only when every voter agrees. When `true`, a consensus is allowed to auto-resolve
on a **clear majority** verdict among the voters instead of requiring unanimity;
a **tie or no clear majority** still defers to the human (the fail-safe invariant
is preserved). The flag is normalized strictly: it is true only for an explicit
`true`; missing/invalid ⇒ `false`, so pre-majority configs keep unanimous
behaviour. It is independent of `enabled` and only meaningful when consensus is
also on.

**Allow/deny adjudication.** The vote is tallied with the majority flag in effect:

- `majority = false` (default): the decision is set only when **every** voter cast
  the same `allow`/`deny` verdict (the original unanimous-only rule); any split,
  abstention, or empty set ⇒ no decision ⇒ human.
- `majority = true`: abstentions are **not counted**; a **strict majority** of the
  cast votes decides (`allow > deny` ⇒ allow, `deny > allow` ⇒ deny). A **tie**
  (`2v2`), no clear majority, or no cast vote (all abstained / empty) ⇒ no
  decision ⇒ human, preserving the fail-safe invariant.

The tally always reports **literal** unanimity (every voter agreed, no abstain)
regardless of the toggle, kept separate from the decision so the summary/console
can honestly tell a unanimous verdict (`所有 agent 一致…`) from a majority-carried
one (`多数派裁决…`, emitted by the deterministic fallback summary when a decision
is set while unanimity is false). The gateway auto-resolves whenever a decision is
present — covering both the unanimous and the majority case — and otherwise prompts
the human with the opinions attached.

The same toggle governs the **AskUserQuestion** path, but per-question rather than
as one allow/deny verdict — each question is auto-answered on a clear plurality of
the voters' answers. See [AskUserQuestion — per-question answering](#askuserquestion--per-question-answering).

### Beyond tool permissions: checkpoint consensus

The majority toggle also enables the **automation orchestrator**'s checkpoint consensus
override (RM-A14, see [intent-management spec](../../intent-management/intent-management-spec.md)). When the loop
detects either a `stuck` judge verdict or an unanswered AskUserQuestion (the pending-question
guard), and the majority toggle is ON, the orchestrator spawns a vote among peer agents — who
decide whether the development process should `continue` past the checkpoint or `wait` for
human intervention.

Checkpoint consensus reuses the same one-shot advisor infrastructure, the same
shared (cross-vendor) participant selector, and the same fail-safe invariant (a tie → stop).
The continue/wait prompt is already vendor-neutral (natural language), so it does **not** go
through the tool-risk normalizer. It differs from
the tool-permission and ask-question consensus in that it is owned by the automation
orchestrator, not the permission gateway, and that it decides _automation flow_ (`continue`
vs `wait`) rather than answering a tool-use or AskUserQuestion. The outcome is broadcast on
the automation status so the UI/events can render the process.

**Merged gate.** When the majority toggle is OFF, checkpoint consensus is never triggered —
the orchestrator follows the existing stop path for both the stuck and pending-question cases.
When it IS on, the same agents vote on both tool-permission and checkpoint questions; no
separate agent pool or configuration field exists.

## Roles

| Role    | Who                                                                                                                                        | Job                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Voters  | Every enabled agent **except** the session's own (resolved), **regardless of vendor**, optionally narrowed by the `custom` voter allowlist | Judge the normalized request from recent context; `allow`/`deny`  |
| Decider | The session's own agent                                                                                                                    | Summarize the voters' opinions in one sentence (Display language) |

If there are no voters (only the session's own agent, or the `custom` allowlist is empty /
all-stale), consensus is skipped and the human is prompted as usual.

### Cross-vendor voting + risk normalization (2026-07-09)

Consensus voting is **vendor-neutral**: every enabled non-self agent votes regardless of
vendor (a shared participant selector, `selectConsensusVoters`, reused by tool voting,
`AskUserQuestion` voting, and the automation checkpoint vote). This supersedes the earlier
vendor-homogeneous rule (2026-06-06-006), which limited voting to the session's own vendor
because a native tool name + its risk meaning are not comparable across vendors.

A cross-vendor voter is made possible for **tool** permission requests by a server-side
**risk normalizer** that runs BEFORE fan-out. It deterministically maps
`(requesting vendor, native tool name, input)` to a vendor-neutral payload:

- `operationIntent` — a stable neutral operation category + short description;
- `resourceScope` — a neutral `kind` (`file` / `command` / `url` / `search` / …) plus the
  structurally-extracted targets (paths, command target, remote host/URL). Never the raw
  native input verbatim;
- `risks` — explicit `read` / `write` / `execute` / `network` booleans (plus optional
  non-vendor tags);
- `normalizationVersion` — so prompts, protocol, and audit stay interpretable.

Voters see **only** this payload — never the native tool name or raw input — so a Codex
advisor can judge a Claude session's `Bash`/`Write` request (and vice-versa). A successful
normalization enters the existing tally unchanged: a `write`/`execute`/`network` axis is
descriptive, not a hard deny.

**Fail-closed normalization.** The normalizer is deterministic and never throws. An unknown
tool, a missing critical target, an invalid input shape, or any internal error returns a
**stable reason code**; the round then records every selected voter as an `abstain` (no
advisor call is made) ⇒ empty verdict ⇒ the human is prompted. A normalization failure
**never** auto-allows and never low-risk-defaults a value it could not derive. Adding a new
native tool means adding a normalizer rule first — until then it safely degrades to abstain +
human approval.

The `AskUserQuestion` and checkpoint continue/wait votes are already vendor-neutral
(natural-language prompts) and skip normalization entirely.

**Honest audit.** The outcome carries the normalized payload (or the failure reason code) and
each voter's `vendor`; the console / permission panel / WorkCenter render the participating
agents + vendors, the risk axes, any abstentions, and the final verdict. The old "共识限
\<vendor\> 内" scope marker (and `vendorScope`/`crossVendorExcluded` fields) are gone; old
audit records without the new fields still read, they just no longer show the scope note.

### Custom voter selection (2026-06-15, cross-vendor since 2026-07-09)

The consensus `mode` config key chooses **who** votes, filtering by id only (never by vendor):

- `mode: 'all'` (default / absent) — every enabled non-self agent votes, across vendors.
  The `agentIds` allowlist is ignored and not persisted.
- `mode: 'custom'` — voters are the **intersection** of the `agentIds` allowlist with the
  enabled non-self set. This lets the user exclude irrelevant read-only agents or restrict
  voting to high-trust ones. It narrows by id and may include agents of any vendor. An empty
  (or all-stale) allowlist ⇒ zero voters ⇒ consensus is skipped and the human is prompted.

**Double static filtering of disabled agents.** A disabled agent never votes by
two independent guards: (1) workspace-setting normalization cleans the `agentIds`
allowlist, dropping ids that no longer exist or are disabled (deduped); (2) the runtime
voter set is built from the enabled-only agents, so even a stale id that slipped through
cannot resurrect a voter. Both are **static** snapshots — there is no mid-run add/remove of
voters; the config snapshot at vote time governs.

The selection is configured per workspace in the Workspace Setting consensus
section (an `All / Custom` radio; custom reveals an enabled-agent checklist). The
server reads it per workspace and applies it at every voting site (tool permission,
AskUserQuestion, and the automation checkpoint).

## Flow

```mermaid
sequenceDiagram
    participant GW as sensitive-tool callback
    participant CO as consensus vote
    participant V as voter agents (one-shot, tools denied)
    participant D as decider agent
    participant WS as WebSocket

    GW->>CO: currentAgentId, toolName, input, context, cancellation signal
    alt disabled OR no voters
        CO-->>GW: no outcome
        GW->>WS: permission_request (plain) → wait for human
    else
        CO->>CO: normalize(requesting vendor, toolName, input)
        alt normalization failed (unknown tool / missing target / invalid / error)
            Note over CO: every voter abstains — no advisor call
            CO-->>GW: outcome {abstains, normalizationFailure, decision:null}
        else normalized OK
            CO->>V: voter prompt (neutral risk payload + context)  (parallel)
            V-->>CO: decision + reason | abstain (on error / unparseable)
            CO->>D: summarize votes  (code fallback on failure)
            D-->>CO: one-line summary
            CO-->>GW: outcome {votes+vendor, summary, unanimous, decision, normalized}
        end
        alt decision set (unanimous, or majority when the toggle is on)
            GW->>WS: consensus_auto{toolName, input, outcome}
            GW->>GW: onConsensusResolved → 记录 status:'auto' 的 WaitUserInvolveEvent(携带 outcome)
            Note over GW: auto allow/deny — no human needed; 非阻塞审计记录入 WorkCenter
        else split / tie / abstention
            GW->>WS: permission_request{..., consensus: outcome}
            Note over GW: human decides, sees opinions
        end
    end
```

## Advisor query

Each voter (and the decider) runs as a single non-interactive one-shot turn under
that agent's launch overrides, with **all tools denied** so it reasons only from the
provided context. No setting sources are loaded, keeping the call light (no CLAUDE.md /
hooks / Skills). The run's cancellation signal interrupts every in-flight advisor query
when the session switches or a new prompt starts.

The recent-context buffer is the user prompt plus streamed assistant text,
capped at ~4000 chars.

## Contracts

| Capability           | Contract                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run a consensus vote | No outcome ⇒ disabled or no voters (caller does the plain human prompt). Otherwise a full outcome.                                                                                                                                                       |
| Normalize a tool req | Deterministic map `(vendor, toolName, input)` → neutral payload; never throws. Failure ⇒ a stable reason code, every voter abstains (no advisor call), outcome carries `normalizationFailure` and `decision: null` (defers to human, never auto-allows). |
| Parse a vote         | Strict-JSON first, then a keyword scan; ambiguous/empty ⇒ the caller records an **abstain**.                                                                                                                                                             |
| Tally                | `unanimous` = literal all-agree (no abstain), independent of the majority toggle. The decision: unanimous-only when majority is off; a strict majority of cast votes (abstain excluded) when on — tie / no clear majority / no cast vote ⇒ no decision.  |
| Summarize            | The decider agent produces one sentence in the Display language; a deterministic tally summary is used on error/abort.                                                                                                                                   |

## Invariants

- **Human override preserved.** Consensus never removes the human prompt for a
  split decision; it only short-circuits the unanimous case.
- **Fail-safe to human.** Any voter error/timeout/unparseable answer is an
  abstain, which is non-unanimous, so the human decides (PG-R9). On the ask path
  the decider may rescue a split/abstained question into consensus, but only with a
  re-validated exact-label answer; a decider error/abort/parse-failure or invalid
  answer emits no upgrade, so the question stays split and defers to the human.
- **De-bias is presentation-only.** Two de-bias passes (ask path only — see
  below) touch only the text shown to the advisors, never the option set, the
  tally, or SDK answer injection:
  1. _Recommendation stripping_ removes the asker's trailing marker from presented
     labels. A marker-free echo is restored to its original exact label by the
     option matcher's stripped-exact pass; stripping a marker-less label is a no-op.
  2. _Order shuffling_ presents each voter an **independently** randomized option
     order (and the decider one shuffled order) to dilute the LLM's positional
     ("first option") bias.
     Both are transparent downstream: option matching resolves a choice by label
     **content, never by option index**, and the answer key sorts labels before
     comparing, so the parse passes the **original** questions and the tally,
     decider upgrade (`decidedByAgent`), agreed answers, and answer injection (matches
     by original label) all key off the canonical labels regardless of presentation.
- **No input mutation.** Auto-allow returns the original input unchanged (PG-R6).
  The sole exception is `AskUserQuestion` (see below), where the chosen answers
  are deliberately injected into the input — the only headless channel to answer.
- **No leak on abort.** Advisor queries attach to the run's cancellation signal and
  are interrupted on teardown, like the human prompt (PG-R4).
- **Consensus window never drops a live prompt.** The ask-consensus pass spawns one
  advisor query per voter plus a decider — a multi-second window in which the
  `AskUserQuestion` tool-use is pending and the request is not yet visible to the
  human. The pass is fully contained: an advisor error/abort/slowness can never throw
  into or abort the main run; the worst case is "no opinions, ask the human".
  Crucially, while a run is **alive** and a prompt has been emitted but not yet
  answered, a stray `turn_end` must NOT settle the session to `idle` — the runtime
  holds it at `awaiting_permission` (backed by the set of pending request ids) so the
  answer panel stays actionable instead of downgrading to a static "曾请求…" history
  line. The guard releases per-request when the human answers and wholesale on
  teardown; once the run is genuinely gone, `idle` is correct (the prompt can no longer
  be answered). A teardown deny that beats the human answer is logged so the precise
  trigger can be confirmed in a live multi-agent setup.
- **No unanswerable residue.** If the run signal is already aborted when the
  consensus pass returns (the run was torn down _inside_ the window, before the
  request was ever shown), the gateway does **not** emit the `permission_request`
  at all — it denies immediately. Emitting it would leave a phantom prompt in the
  buffer that renders as a dead static "曾请求…" line nobody can answer. Both the
  `AskUserQuestion` and the allow/deny consensus branches apply this guard.

## AskUserQuestion — per-question answering

`AskUserQuestion` is **not** an allow/deny tool: it carries `questions`, each
with `options` (and a `multiSelect` flag), and needs an _answer per question_,
not a verdict. So the gateway routes it to a separate branch (guarded by detecting
the questions array) that **always** runs — rendering the answer panel and injecting
the chosen answers is the base mechanism that makes `AskUserQuestion` answerable at
all in c3's headless (no-TTY) setup. The consensus _voting_ within that branch,
however, only happens when consensus is **enabled**: the ask-consensus pass yields no
outcome when disabled (or with no voters / no questions), so there is no auto-answer
and the human fills the panel unaided.

| Role    | Job (ask path)                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------- |
| Voters  | Answer **every** question — pick option label(s) or write a custom reply, with reason                            |
| Decider | Summarize the per-question answers (Display language) **and** adjudicate split questions for effective consensus |

- Each voter gets a per-question voter prompt and returns structured per-question
  choices; the parse resolves each choice to an option label via tolerant matching
  and marks any missing/garbled question an **abstain** (ignored in that question's
  tally).
- **Recommendation de-bias.** The `AskUserQuestion` convention lets the asker flag
  its preferred choice by appending a trailing marker (`方案A (推荐)`,
  `Use X (Recommended)`). Feeding that to the advisors would anchor them to the
  asker's leaning and defeat independent judgement, so the voter prompt and the
  decider prompt (both its option list **and** the echoed advisor answers) present
  labels with the marker stripped. Stripping is **end-anchored and bracketed only**
  (`()（）[]【】` × 推荐/建议/默认/recommended/recommend/default), so a label that
  merely ends in such a word without brackets (`使用系统默认`) is untouched.
- **Order de-bias.** Beyond the textual marker, the **fixed order** of the options
  is itself an anchor — an LLM tends to favour whatever comes first. So each voter is
  presented an **independently** shuffled option order (Fisher–Yates), and the
  decider's split-question option list is shuffled once. Per-voter diversity dilutes
  the positional bias across the N votes at no extra cost (still one advisor query per
  voter). Shuffling is **presentation-only and index-agnostic**: it reorders only the
  array passed into the prompt builder; the parse is handed the **original** questions,
  and option matching resolves by label content (not position), so
  tally/upgrade/injection are unaffected (an earlier scope rejected reordering in
  favour of marker-stripping only — that decision is now superseded). Ask path
  only — the allow/deny path has no candidate list to reorder.
- **Tolerant label matching.** Advisors often echo a label with reasoning appended
  (`"方案A：扩展协议: <why>"`) or embed it in a sentence. Match order is: exact
  (case-insensitive) → **stripped-exact** (de-biased label compared to de-biased
  options, see below) → longest label that prefixes / is prefixed by the choice →
  longest label contained in / containing it. Longest-first keeps a specific label
  from losing to a shorter sibling. Without this, a clear pick is mis-recorded as an
  abstain, wrongly splitting the question. The stripped-exact pass is what **restores**
  an advisor's marker-free echo (it only ever saw the de-biased label) to the
  **original exact label** the SDK must be answered with.
- The tally makes a question literally **unanimous** only when every voter produced a
  parseable answer (≥1, none abstained) and they all normalize identically (the answer
  key: option labels sorted + comma-joined, else the custom text). Unanimity is the gate
  the gateway auto-answers on; the two `decidedBy*` flags below mark the _non-literal_
  ways a question reached that gate.
- **Majority pre-step.** When the majority toggle (the same switch as the allow/deny
  path) is on and the literal vote is **not** unanimous, the tally resolves the question
  to its **plurality** answer: abstentions are excluded, the cast answers are grouped by
  answer key, and the **single** most-voted answer wins — the question is marked agreed
  and `decidedByMajority`. A **tie** for the top count, **no unique leader**, or **no
  cast vote** (all abstained / empty) keeps it split ⇒ defer to the human. With the
  toggle **off** the original unanimous-only rule stands. Multi-select and custom answers
  tally on the same normalized answer key, so the same pair-in-different-order or
  identical custom text counts as one answer.
- **Decider escalation.** In ONE decider call (which also writes the summary), every
  question **still split after the majority pre-step** is put to the session's own agent,
  which sees each advisor's actual answer + reason. Where the advisors are in _effective_
  consensus (a mis-parsed reply, or differently-worded answers that mean the same option)
  the decider returns the agreed answer using an exact option label; the parse re-validates
  it via tolerant matching and, on success, **upgrades** that question to unanimous with
  `decidedByAgent`. The decider only ever upgrades a split question — string-unanimous
  **and** majority-resolved ones are never re-judged (already at the gate), and it can never
  downgrade one.
- **Adjudication priority — at most one ruling per question.** literal unanimous →
  majority pre-step → decider rescue. Each later stage only acts on what the earlier ones
  left split, so `decidedByMajority` and `decidedByAgent` are **mutually exclusive** and no
  question is adjudicated twice (the toggle and the decider coexist without overlap).
- Fully unanimous ⇒ every question agreed (by literal vote **or** decider ruling). Then the
  gateway **auto-answers**: `consensus_auto` with an `ask`-kind outcome and `allow` with the
  answers injected.
- Otherwise the human gets the **answer panel** (`permission_request` with an `ask`-kind
  consensus): agreed questions pre-filled, split ones highlighted with each agent's pick.
  The human's `permission_response` answers are injected.

**Answer injection (verified).** The SDK's `AskUserQuestion` reads a pre-supplied
`answers` map (keyed by question text; multi-select comma-separated) from the tool input
and echoes it as the tool result. So both paths resolve via an `allow` that carries the
original input plus the chosen `answers`. This is the documented PG-R6 exception,
`AskUserQuestion`-only.

| Capability               | Contract                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run ask-path consensus   | No outcome ⇒ disabled, no voters, or input has no questions (caller still shows the panel).                                                                                                                                                   |
| Extract questions        | Extracts/validates the questions array; nothing for non-ask input.                                                                                                                                                                            |
| Strip recommendation     | Removes an end-anchored, bracketed recommendation marker (推荐/建议/默认/recommended/…); idempotent; no-op when absent. Used only for prompt presentation.                                                                                    |
| Shuffle options          | Copies the questions with each options array Fisher–Yates–shuffled (labels untouched). Presentation-only; the randomness source is injectable for tests. Applied per-voter and once for the decider; parse still uses the original questions. |
| Match an option          | Resolves a free-form choice to a canonical option label (exact → stripped-exact → prefix → substring); nothing if none fit. Stripped-exact restores a de-biased echo to the original label.                                                   |
| Parse a voter answer     | One answer per question; choice resolved via option matching, unmatched / missing entry ⇒ `abstain`.                                                                                                                                          |
| Tally a question         | Unanimous/agreed on a literal all-answer agreement. With majority on, a still-split question resolves to its strict-plurality answer (abstain excluded; tie / no leader / no cast vote ⇒ split), flagged `decidedByMajority`.                 |
| Build the decider prompt | Builds the combined judge+summary prompt; lists option labels only for the split questions. The Display-language name (default English) sets the summary sentence's language.                                                                 |
| Parse the decider reply  | Yields a summary plus overrides; an override is emitted only for consensus rulings whose answer re-validates to a label/custom — else dropped (stays split).                                                                                  |

## 审计留痕（自动决策可追溯）

每次共识自动决议（`consensus_auto`，无人类参与）除发出 wire 帧外，网控还经 `onConsensusResolved`
回调记录一条 `status: 'auto'` 的 `WaitUserInvolveEvent`，其 `outcome` 携带做出决议的共识结果
（投票及各投票者 `vendor`、裁决、摘要，工具路径还含归一化风险载荷 `normalized` 或失败原因
`normalizationFailure`）。该记录是**非阻塞、仅审计**的：永不计入"待处理"徽章，也不阻塞续跑；
它使自动决策在 WorkCenter 的"自动"筛选下可追溯。这覆盖 allow/deny 工具共识与 `AskUserQuestion`
全一致自动作答两条自动路径。人类参与的 `permission_request` 走另一条回调
（`onPermissionRequest` → `status: 'todo'`），二者互斥。持久化失败（如库不可用）被吞并记日志，
绝不打断刚被共识放行的实时运行。

> 注：automation 编排的 checkpoint 共识（continue/wait）不镜像进 WorkCenter，仍仅经
> `AutomationStatus.checkpointConsensus` 广播（有意决策，避免重复留痕）。

### 来源契约与溯源跳转（WorkCenter）

每条 `WaitUserInvolveEvent` 携带产生运行的完整 `SessionKind`（`sessionKind`，
`work | intent | discussion | automation | consensus | tool | spec`），由调用方原样写入：
driver 路径取运行的 `sessionKind`，claude 网控路径取 gate 派生（`intent`→intent、
`spec`→spec、`discussion-research`→discussion、`standard`→work）。`consensus` / `tool`
不产生人工门控事件，前端 switch 兜底进控制台。不再折叠为可跳转子集，旧 `WaitUserInvolveSource`
类型与 `sessionKindToWaitUserSource` 映射已移除。

`workspaceId` 为不透明工作区 id：store 持久化绝对路径，读出时经 `pathToId` 映射为 id，
工作区已注销的行被丢弃而非下发破损 id；`list_wait_user_events` 读取端先经
`resolveWorkspaceRoot` 把 id 解析回路径再查库（未注册 id 降级为空快照），避免把 id 当
路径直接查询导致历史 / auto 标签 re-fetch 恒空。`sessionId`（真实会话 id）的含义与缺失
降级、以及读时按 `sessionId` 反查派生 `intentId`/`intentTitle` 的契约见
`websocket-protocol.md` 的 `wait_user_events` 条目。`intent` 来源的 `sessionId` 通常是
真实 comm 会话 id（save-gate 写入），但 Start-Dev 收尾事件无真实会话、写意图对象 id；
前端按「先意图、再 comm 会话、再降级」消解，不为消歧给协议加判别字段。

## Wire protocol

- `permission_request.consensus` is the consensus outcome — the allow/deny outcome
  (`kind: 'tool'`) **or** the per-question outcome (`kind: 'ask'`).
- `consensus_auto.outcome` is likewise either consensus-outcome kind.
- `permission_response` gains optional `answers` (question text → label(s)/custom)
  for the `AskUserQuestion` panel; the gateway injects them into the tool input.
- A per-question `decidedByAgent` flag marks a question whose literal vote was split
  but the decider ruled an effective consensus — so the console can label an
  AI-adjudicated agreement honestly rather than implying a unanimous vote.
- A per-question `decidedByMajority` flag marks a question whose literal vote was not
  unanimous but the majority toggle carried it on a strict plurality — distinguishing a
  majority-carried answer from a literal unanimous vote and from a decider ruling
  (`decidedByAgent`); the two `decidedBy*` flags are mutually exclusive.
- The console renders the allow/deny verdicts (tool kind) or the per-question
  answer panel / auto-answer roll-up (ask kind).
