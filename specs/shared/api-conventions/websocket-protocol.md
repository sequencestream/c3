# WebSocket Protocol

浏览器与服务器之间的唯一线路协议。端点：`ws://<host>/ws`（HTTPS 页面下为 `wss://`）。所有流量均为带 `type` 判别字段的 JSON 信封。

**单一事实来源：** `shared/src/protocol.ts`。本文档描述该文件，不重新定义数据结构。两端 import 相同类型（`@ccc/shared`）。

## 约定

- 每条消息都是带字符串 `type` 字段的 JSON 对象；消费者按 `type` 收窄类型。
- 服务器忽略无法解析或 `type` 无法识别的客户端消息——不可解析的消息**绝不**视为权限批准。
- 通过 `requestId` 关联：`permission_request` 携带一个；匹配的 `permission_response` 回显它。
- 权限**决策不持久化**。运行时 `buffer` 保存原始 `permission_request` 事件，因此 `select_session` 重放会重新发出过去的请求，且不附带决策——与全新请求在线路上完全相同。区分正在进行的待处理请求与重放历史记录是**客户端**的责任：控制台仅在会话处于 `awaiting_permission` 且是该会话最新的未决策请求时才将权限视为可操作（参见 web-console WC-R16）；已重放/已解决的权限渲染为静态记录。

## Client → Server（`ClientToServer`）

### `user_prompt`

发起**当前查看会话**的新用户回合。对于 `team` 会话，它被推送到活跃的 lead 会话中（不创建新 run；即使 lead 正在回合中也允许——SDK 会排队）。否则，如果回合已在进行中则返回 `error` 拒绝（串行），否则启动新 run。不影响其他会话。

**字段：** `text: string`

### `permission_response`

回复先前的 `permission_request`（按 `requestId` 匹配，无论当前查看哪个会话）。对于 `AskUserQuestion` 类型的请求，`allow` 可携带 `answers`（问题文本 → 选中选项/自定义回复的映射），网关将其注入工具输入。

**字段：** `requestId: string`, `decision: 'allow' | 'deny'`, `answers?: Record<string, string>`

### `set_mode`

更改**当前查看会话**的权限模式（按会话持久化）。`mode` 是供应商原生 token（`ModeToken` 或 `CodexPolicy`），服务器根据会话的供应商目录解析。立即应用于正在进行的 run（如果存在）。

**字段：** `mode: ModeToken | CodexPolicy`

### `set_session_agent`

在会话的冻结供应商内重新指定代理（ADR-0015）：重写 `sessionAgents` 事实，使该会话的下一个回合使用 `agentId` 进行 `resume`。服务器拒绝跨供应商更改（回复 `session_agent_changed { ok: false }`，事实保持不变）。控制台只提供同供应商候选项，因此拒绝仅作为防御性守卫。

**字段：** `sessionId: string`, `agentId: string`

### `add_workspace`

注册一个项目目录为工作区。

**字段：** `path: string`

### `remove_workspace`

从侧边栏取消注册工作区（不删除磁盘上的会话）。

**字段：** `path: string`

### `list_sessions`

请求工作区的会话列表。服务器回复 `sessions`。

**字段：** `workspacePath: string`

### `create_session`

在工作区中创建新的待处理（pending）会话并激活。可选的 `agentId` 记录为待处理会话的**意图**（ADR-0015）：其首次 run 使用该代理启动并冻结其供应商。缺失/为空 ⇒ **Auto**——不写入意图，run 回退到已配置的 `defaultAgentId`。

**字段：** `workspacePath: string`, `agentId?: string`

### `delete_session`

删除会话及其磁盘上的转录记录。

**字段：** `workspacePath: string`, `sessionId: string`

### `select_session`

激活一个会话；服务器回复 `session_selected`（历史记录 + 模式 + 状态）。

**字段：** `workspacePath: string`, `sessionId: string`

### `rename_session`

重命名会话标题。

**字段：** `workspacePath: string`, `sessionId: string`, `title: string`

### `stop_run`

停止**当前查看会话**的正在进行的 run（如果存在）。不影响其他会话。

**字段：** 无

### `rebind_view`

将当前连接视图从待处理 id 重新绑定到真实的 SDK id（ADR-0018 常驻订阅模型）。

**字段：** `from: string`, `to: string`

### `list_commands`

列出活跃会话工作目录下的斜杠命令/skills（回复：`commands`）。

**字段：** 无

### `get_settings`

获取系统配置。服务器回复 `settings`。

**字段：** 无

### `save_settings`

替换系统配置；服务器标准化并回显 `settings`。

**字段：** `settings: SystemSettings`

### `load_workspace_setting`

加载工作区设置。服务器回复 `workspace_setting`。

**字段：** `projectPath: string`

### `save_workspace_setting`

保存工作区设置。

**字段：** `projectPath: string`, `config: WorkspaceSetting`

### `list_intents`

请求项目的 intent 列表，可按状态过滤。服务器回复 `intents`。如果账本不可用则返回 `error`。

**字段：** `projectPath: string`, `status?: IntentStatus`

### `open_intent_chat`

进入 intent 视图：打开或切换到通信会话。提供 `sessionId` 时打开该特定会话（并将其设为 `isCurrent`）；不提供时打开项目的 `is_current` 会话（若无则创建一个新的 `pending:` 会话）。回复 `session_selected` 加 `intents` 列表（intent-management RM-R4）。

**字段：** `projectPath: string`, `sessionId?: string`

### `list_intent_sessions`

列出项目的 intent 通信会话。回复 `intent_sessions`。每个会话携带 `sessionId`、`title`（可为空）和 `updatedAt`。响应还携带活跃 agent run 会话的 `runStates` 快照。

**字段：** `projectPath: string`

### `rename_intent_session`

重命名 intent 通信会话。成功后服务器广播刷新后的 `intent_sessions` 列表。

**字段：** `projectPath: string`, `sessionId: string`, `title: string`

### `delete_intent_session`

删除 intent 通信会话：移除数据库行、移除运行时（中止任何活跃 run）、广播刷新后的列表。如果被删除的会话是 `isCurrent`，则最近的剩余会话成为新的默认。会话不存在时返回错误。

**字段：** `projectPath: string`, `sessionId: string`

### `new_intent_chat`

启动全新的通信会话：将之前 `is_current` 的通信会话重置为 0，创建一个标记为当前的新会话，回复 `session_selected`（空历史记录）加 `intents` 列表。由 intent 标题栏中的 "+" 按钮触发（RM-R4）。

**字段：** `projectPath: string`

### `refine_intent`

重新启动通信会话，注入一个 intent 的内容作为种子，以进一步细化该 intent（RM-R7）。

**字段：** `projectPath: string`, `intentId: string`

### `discussion_to_intent`

将已完成的 discussion 的结论桥接到 intent 领域（`refine_intent` 的变体）。服务器从 discussion 解析项目，重启通信会话作为全新会话，注入携带 discussion 标题和结论的首条 prompt，回复 `session_selected`（空历史记录）加 `intents` 列表。如果 discussion 未知、未 `completed` 或没有结论，则拒绝（`error`）。

**字段：** `discussionId: string`

### `start_development`

为 `todo` 状态的 intent 启动后台开发会话，使用可配置的开发 skill（系统设置中的 `devSkill`；默认为空 ⇒ 不加 skill 前缀）。将其设为 `in_progress` 并记录 `lastDevSessionId`（RM-R8）。对未满足的依赖关系仅警告（不阻止）。

**字段：** `projectPath: string`, `intentId: string`

### `update_intent_status`

手动设置 intent 状态（如 `done` / `cancelled`）；服务器回复 `intents`（RM-R9）。

**字段：** `intentId: string`, `status: IntentStatus`

### `set_intent_automate`

切换 intent 的自动化标记；服务器回复 `intents`（RM-A1）。

**字段：** `intentId: string`, `automate: boolean`

### `start_automation`

启动项目的自动化编排器（已在运行则为空操作）；回复 `automation_status`（RM-A2/A3）。

**字段：** `projectPath: string`

### `stop_automation`

停止编排器，中止当前开发 run；回复 `automation_status` → `idle`（RM-A7）。

**字段：** `projectPath: string`

### `list_discussions`

请求项目的 discussion 列表，可按状态过滤。服务器回复 `discussions`。如果 discussion store 不可用（`c3.db`）则返回 `error`。

**字段：** `projectPath: string`, `status?: DiscussionStatus`

### `create_discussion`

从 "+" 表单创建 discussion。`discussionType` 必须是已注册的 discussion 类型（`discussion-types.ts`）；`title` 从 `goal` 派生。服务器持久化为 `draft`，**向创建连接回复 `discussion_detail`**（右侧面板立即打开），推送刷新后的 `discussions` 列表，然后运行只读研究 agent（`discussion-research` 门控）读取项目资料 + 搜索网络以补全 `context`。

研究 run 是**可观察的**——每个回合作为 `research_message` 流式传输，其活跃状态作为 `research_run_status` 广播（`running` 然后完成/失败/进程死亡时 `ended`）——并在结算时再次推送 `discussions`。**研究成功后服务器自动启动编排**（`canAutoStartDiscussion` 守卫重新检查 `draft` + 无活跃 run；等同于自动 `start_discussion`）；研究失败则保持 `draft` 状态等待手动 **Start**。

**字段：** `projectPath: string`, `discussionType: string`, `goal: string`, `context?: string`

### `open_discussion`

打开一个 discussion：服务器回复 `discussion_detail`（discussion + 完整消息历史）。如果未知或 store 不可用则返回 `error`。

**字段：** `discussionId: string`

### `start_discussion`

在 `draft` discussion 上启动 organizer 引擎（标题栏 **Start** 按钮，或服务器在 `create_discussion` 研究成功后**自动调用**）。服务器将其切换为 `in_progress` 并在后台运行编排循环：organizer（默认 agent）驱动该类型的 workfiow，每个回合一个 one-shot `askAgentOnce`；每条消息作为 `discussion_message` 流回；run 结束于写 `conclusion` + `completed`。已在运行则为空操作；非 `draft` / 未知 / store 不可用时返回 `error`。

**字段：** `discussionId: string`

### `pause_discussion`

暂停活跃的 discussion run：引擎在下一轮边界挂起（不会产生新的 organizer 决策/agent 发言；正在进行的 one-shot 回合仍会完成）。没有活跃 run 或已暂停则为空操作。通过 `discussion_run_status: paused` 反映。

**字段：** `discussionId: string`

### `resume_discussion`

恢复已暂停的 discussion run（保留本地阶段/轮次状态）。未暂停则为空操作。通过 `discussion_run_status: running` 反映。

**字段：** `discussionId: string`

### `discussion_speak`

人类插话（"我想发言"）：服务器暂停活跃 run，追加一条 `human` 消息（作为 `discussion_message` 流式传输），然后恢复——organizer 的下一轮可以看到它。没有活跃 run（`in_progress` 但已停止）时则仅追加消息。未知 / store 不可用时返回 `error`；空的 `text` 被忽略。

**字段：** `discussionId: string`, `text: string`

### `continue_discussion`

在 `completed` discussion 上发起新轮次：追加人类的追问作为 `human` 消息，将 `completed → in_progress`，并在完整转录记录上重新运行编排循环以生成新的 `conclusion`。非 `completed` 或已有活跃 run 时返回 `error` 拒绝；空的 `text` 被忽略。

**字段：** `discussionId: string`, `text: string`

### `request_session_status`

拉取权威的会话状态快照（会话层心跳）。客户端在周期性轮询、重连和标签页可见性恢复时拉取。服务器回复 `session_status`。与传输层 ping/pong 区分。

**字段：** 无

### `create_schedule`

在工作区创建 schedule；服务器广播 `schedules`。

**字段：** `workspacePath: string`, `input: CreateScheduleInput`

### `list_schedules`

列出工作区的 schedule；服务器回复 `schedules`。

**字段：** `workspacePath: string`

### `update_schedule`

部分更新 schedule；服务器广播 `schedules`。

**字段：** `scheduleId: string`, `input: UpdateScheduleInput`

### `delete_schedule`

删除 schedule；服务器广播 `schedules`。

**字段：** `scheduleId: string`

### `get_schedule_detail`

获取 schedule 完整详情及执行日志；服务器回复 `schedule_detail`。

**字段：** `scheduleId: string`

### `get_execution_transcript`

读取一次 `llm` 类型执行的 agent 会话转录记录（只读重放）；服务器回复 `execution_transcript`。

**字段：** `scheduleId: string`, `executionId: string`

### `schedule_run_now`

手动触发：立即执行 schedule（在正常 tick 之外）。

**字段：** `scheduleId: string`

### `get_workspace_mcp_config`

获取工作区级 MCP 服务器配置。

**字段：** `workspacePath: string`

### `save_workspace_mcp_config`

保存工作区级 MCP 服务器配置。

**字段：** `workspacePath: string`, `config: WorkspaceMcpConfig`

### `list_pending_write_approvals`

列出工作区的待处理写操作审批。

**字段：** `workspacePath: string`

### `approve_write_approval`

批准或拒绝待处理写操作审批。

**字段：** `approvalId: string`, `decision: 'approve' | 'reject'`

### `get_schedule_tool_manifest`

请求供应商的工具清单，供 schedule 表单中的工具选择使用。服务器回复 `schedule_tool_manifest`。

**字段：** `vendor: VendorId`, `workspacePath: string`

### `skill_load_approval_resolve`

解决待处理的启动前 skill 加载门控（挂载层 2/3）。`approve` 允许挂载继续并持久化 `.gitignore` 确认；`cancel` 跳过追加 `.gitignore` 行（skill 不挂载，但会话仍然启动）。通过 `requestId` 与 `SkillLoadApprovalRequest` 关联。

**字段：** `requestId: string`, `decision: 'approve' | 'cancel'`

### `list_wait_user_events`

请求项目的待用户处理事件列表。可选的 `status` 过滤到特定生命周期状态（默认：全部）。服务器回复 `wait_user_events`。

**字段：** `projectPath: string`, `status?: WaitUserInvolveStatus`

### `ping`

保持连接活跃。

**字段：** 无

## Server → Client（`ServerToClient`）

### `ready`

握手完成；携带工作区列表、最后活跃会话及所有活跃 run 的状态。

**字段：** `workspaces: WorkspaceInfo[]`, `activeSessionId: string | null`, `statuses: SessionRunStatus[]`

### `session_status`

向**所有**连接广播，每 `STATUS_HEARTBEAT_MS`（15s）一次，并在任何运行时状态变化时广播；由服务器端心跳 + 活跃性对账驱动。客户端也可通过 `request_session_status` 按需拉取。侧边栏徽章和等待权限高亮的权威快照。

**字段：** `statuses: SessionRunStatus[]`

### `opencode_status`

受监管的 OpenCode REST 服务器的活跃可达性（2026-06-07-003）——**一级信号**，在每次状态转换（up / down / retrying）时推送，并在连接时作为快照发送（紧随 `ready` 之后）。驱动会话列表的离线警告；同一状态还叠加到 `settings.sessionCapabilities.opencode`（宕机时 list/read/resume 降级为 `'temporarily-unavailable'`），使整个控制台按状态降级而非按供应商降级。

**字段：** `status: OpencodeServerStatus`

### `workspaces`

完整的工作区列表，按最近访问降序排列。

**字段：** `workspaces: WorkspaceInfo[]`

### `sessions`

一个工作区的会话列表，按最后修改降序排列。

**字段：** `workspacePath: string`, `sessions: SessionInfo[]`

### `session_selected`

一个会话成为此连接当前查看的会话；携带其模式、重放的磁盘历史记录，以及选中时运行时的权威活跃 `status`。客户端从 `status` 初始化其按会话状态映射，使编辑器立即锁定（无需等待下一次 `session_status` 广播——这是后台运行中会话出现陈旧 "ready" 窗口的来源）。对于后台/进行中的会话，活跃缓冲区尾部在此消息之后作为正常流事件跟随。

**字段：**

- `workspacePath: string`
- `sessionId: string`
- `title: string`
- `mode: ModeToken` — 供应商原生 token，通过 `vendor` 的目录解析
- `codexPolicy?: CodexPolicy` — Codex 双策略配置（仅 codex 供应商会话存在）
- `history: TranscriptItem[]`
- `status: SessionStatus`
- `vendor?: VendorId` — 会话已解析的 agent 供应商（ADR-0015），用于标题栏供应商色点
- `agentSwitch?: SessionAgentSwitch` — 标题栏同供应商代理切换器数据（ADR-0015 / AS-R22）

### `session_started`

将待处理会话的 `clientId` 绑定到其真实的 SDK `sessionId`。

**字段：** `clientId: string`, `sessionId: string`, `agentSwitch?: SessionAgentSwitch`

### `session_agent_changed`

`set_session_agent` 重新指定代理的结果（ADR-0015）。`ok` 为 `false` 表示被拒绝（跨供应商——供应商不可变），`true` 表示同供应商切换成功。成功后会话的下一个回合使用 `agentId` 进行 `resume`。`vendor` 是会话（未变）的冻结供应商，回显供客户端本地更新使用。

**字段：** `sessionId: string`, `agentId: string`, `vendor: VendorId`, `ok: boolean`

### `mode_changed`

确认当前查看会话的模式更改。`mode` 是供应商原生 token。

**字段：** `mode: ModeToken`, `codexPolicy?: CodexPolicy`

### `commands`

活跃会话的可用斜杠命令/skills（回复 `list_commands`）。

**字段：** `commands: SlashCommandInfo[]`

### `settings`

（标准化后的）系统配置，回复 `get_settings` / `save_settings`。携带三个运行时派生的伴生数据，配置对象本身不包含：

- `hostStatus: VendorHostStatus[]` — 每个供应商的主机 CLI 存在情况（ADR-0012），驱动新建会话选择器灰显
- `bindingStats: SessionBindingStats` — 会话→代理绑定计数（ADR-0015），用于说明"默认代理更改不回溯"
- `sessionCapabilities: Record<VendorId, SessionCapabilities>` — 每个供应商的会话生命周期能力分级（ADR-0011 附录），UI 按 `vendor` 标签降级会话行操作
- `vendorCapabilities?: Record<VendorId, Record<AdapterCapability, boolean>>` — 每个供应商的二进制能力账本（`interrupt` / `setActionMode` / … / `taskStore`），控制台据此以零 `if (vendor === …)` 的方式门控能力绑定 UI
- `skillSupport?: Record<VendorId, SkillSupportState>` — 每个供应商的外部 skill 挂载支持（ADR-0016/0017，挂载层 2/3）
- `vendorModes?: Record<VendorId, VendorModeCatalog>` — 每个供应商的模式目录（2026-06-07-012），控制台的模式选择器按供应商渲染

**字段：** `settings: SystemSettings`, `hostStatus: VendorHostStatus[]`, `bindingStats: SessionBindingStats`, `sessionCapabilities: Record<VendorId, SessionCapabilities>`, `vendorCapabilities?: Record<VendorId, Record<AdapterCapability, boolean>>`, `skillSupport?: Record<VendorId, SkillSupportState>`, `vendorModes?: Record<VendorId, VendorModeCatalog>`

### `workspace_setting`

工作区的标准化设置（回复 `load_workspace_setting` 或 `save_workspace_setting`）。`config` 含两个 git 提交模式字段：`gitCommitMode: 'current-branch' | 'worktree'`（缺省 `current-branch`）与 `defaultMainBranch?: string`（`worktree` 模式下新 worktree 的基准分支）。`detectedMainBranch?` 是服务端探测到的仓库默认分支（`origin/HEAD` → 当前 HEAD），仅在 `load` 回复时下发，表单用它预填 `defaultMainBranch`（已保存值优先于探测值）。

**字段：** `projectPath: string`, `config: WorkspaceSetting`, `detectedMainBranch?: string`

### `intents`

项目的 intent 列表，回复 `list_intents` / `open_intent_chat`，或在确认 `save_intents` 后广播（intent-management）。

**字段：** `projectPath: string`, `items: Intent[]`

### `intent_sessions`

项目的 intent 通信会话列表（回复 `list_intent_sessions` 或在更改后推送）。`runStates` 是哪些列出的会话有活跃 agent run 的实时快照（id → `'running'`）——缺失条目表示没有活跃 run。每次列表发送都携带（首次获取 / 重连重新获取 / 状态变更推送），因此刷新或重连可权威地对账后台会话的 run 状态（与持久化 `status` 解耦）。

**字段：** `projectPath: string`, `items: IntentSessionInfo[]`, `runStates?: Record<string, 'running'>`

### `automation_status`

项目的自动化编排器状态。在进入 intent 视图时推送，并在每次状态变更（start/stop/progress/error）时推送。驱动列表头部自动化按钮（intent-management RM-A1–A9）。

**字段：** `status: AutomationStatus`

### `discussions`

项目的 discussion 列表（回复 `list_discussions`，或在更改后推送）。`runStates` 是哪些列出的 discussion 有活跃编排 run 的实时快照（id → `running`/`paused`）——仅活跃条目存在。`researchStates` 是只读研究阶段的伴生快照（id → `running`，仅活跃研究 run 的 discussion 存在）。两者每次列表发送都携带，因此刷新或重连可权威地重建右侧面板的研究阶段或编排 run 状态。

**字段：** `projectPath: string`, `items: Discussion[]`, `runStates?: Record<string, 'running' | 'paused'>`, `researchStates?: Record<string, 'running'>`

### `discussion_detail`

一个 discussion 加上其完整、有序的消息历史，回复 `open_discussion`。驱动 discussion 视图的只读右侧面板。

**字段：** `discussion: Discussion`, `messages: DiscussionMessage[]`

### `discussion_message`

新追加的 discussion 消息，在 organizer 引擎运行时向所有连接实时广播（客户端在查看该 discussion 时追加）。伴生的状态/结论变更通过刷新后的 `discussions` 列表广播。

**字段：** `discussionId: string`, `message: DiscussionMessage`

### `discussion_run_status`

discussion 后台编排的活跃 run 状态，与持久化的 `DiscussionStatus` 解耦：`running` / `paused` 表示引擎活跃中，`ended` 表示 run 完成或被拆除（前端随后丢弃其 run 状态条目并回退到持久化状态）。仅运行时——不持久化，服务器重启后不恢复。

**字段：** `discussionId: string`, `state: 'running' | 'paused' | 'ended'`

### `discussion_dispatch_status`

organizer 刚在一轮中派发的 agent 的瞬时进行中状态，显示在聊天尾部，使观众在任何内容进入转录记录之前就能看到哪些 agent 正在回复（以及哪些失败）。

- `pending`：`agents` 已被派发并正在回复（`broadcast` 可一次列出多个）。
- `cleared`：`agents` 已完成（回复已追加，或产生空/被跳过的发言，不产生 `discussion_message`）——从进行中集合中移除。
- `failed`：`agents`（单个 agent）回复失败；`error` 是简要原因。Discussion 继续（发言被跳过，轮次不被阻止）。

仅运行时——**永不持久化**，不是 `discussion_messages` 行，且（与 `discussion_run_status` 不同）**不**在 `discussions` 列表中快照：它通过 `cleared`/`failed`/回复消息/run `ended`/discussion 切换自愈，刷新或重连不会留下卡住的 pending。

**字段：** `discussionId: string`, `phase: 'pending' | 'cleared' | 'failed'`, `agents: { id: string; name: string }[]`, `error?: string`

### `research_message`

discussion 的只读研究 run 的流式项，在研究 agent 工作时实时广播。`text` = 助手回合文本；`tool` = 工具调用（`content` 是工具名称）；`seq` 在单个 run 内单调递增（从 1 开始）。右侧面板在查看该 discussion 时追加到**研究流**中。**仅运行时**——研究消息永不持久化，重连时不重放；只有活跃性从 `discussions` 上的 `researchStates` 快照中对账。

**字段：** `discussionId: string`, `message: ResearchMessage`

### `research_run_status`

discussion 的只读研究 run 的活跃状态：研究 agent 工作时为 `running`，完成/失败/底层进程死亡时为 `ended`（run 被 await，因此死亡进程会使 Promise 结算并产生 `ended`）。仅运行时——不持久化。`ended` 时前端丢弃研究阶段；成功时服务器随后自动启动编排（发出 `discussion_run_status: running`），失败时保持 `draft` 等待手动 Start。

**字段：** `discussionId: string`, `state: 'running' | 'ended'`

### `user_text`

用户 prompt 的回显，在回合开始时发送到会话流中，使每个查看者（包括切换到后台会话的查看者）都能看到驱动进行中回合的 prompt，因为它不在回合前捕获的磁盘 `baseline` 中。

**字段：** `text: string`

### `assistant_text`

来自模型的流式文本块。

**字段：** `text: string`

### `notice`

一个回合没有产生可见输出（仅 thinking，`end_turn` 无文本或工具调用）。在回合的 `turn_end` 之前发出，因此查看者看到的是静默行而非空白间隙。像其他事件一样缓冲，因此切换回来的查看者也能重放。

**字段：** `text: string`

### `tool_use`

模型正在调用工具（此事件发出时已授权）。

**字段：** `toolUseId: string`, `toolName: string`, `input: unknown`, `preApproved?: boolean`, `isUserInteraction?: boolean`

- `preApproved`：审计提示（2026-06-06-004）——此工具调用由供应商自身的权限规则引擎自动允许，未经 c3/人类决策。
- `isUserInteraction`：此工具是用户交互工具（如 `AskUserQuestion`、`ExitPlanMode`）——模型发起的需要用户注意才能继续的 prompt。

### `tool_result`

工具完成；`content` 是扁平化的显示字符串。

**字段：** `toolUseId: string`, `content: string`, `isError: boolean`, `isUserInteraction?: boolean`

### `task_list`

开发会话任务列表的完整快照（2026-06-07-009）——**独立的任务线路路径**，使客户端从类型化消息填充其任务面板，而非重新解析 `tool_result.content` 文本。服务器在 `emit()` 扇出点派生（Claude：从任务工具 `tool_use`/`tool_result` 流）和在冷历史重放时（从基线转录记录，紧随 `session_selected` 之后发送）。主要形式（幂等、重放友好）。`TaskItem` 携带 `order` 供客户端直接消费。

**字段：** `tasks: TaskItem[]`

### `task_created` / `task_updated`

单个任务 upsert（创建或状态/字段更改）。适用于原生推送单任务更新的供应商（Codex/OpenCode `onUpdate`，按 ADR-0011 修订 / 2026-06-07-008 §6 稍后接入）和未来的增量使用。客户端按 `id` upsert，保留已有条目的 `order`。

**字段：** `task: TaskItem`（`task_created`），`task: TaskItem`（`task_updated`）

### `task_deleted`

按 id 从模型中移除一个任务。

**字段：** `taskId: string`

### `permission_request`

**阻塞点**——run 无限等待直到 `permission_response` 到达（或 run 被中止，视为拒绝）。`consensus` 在多方代理共识运行但代理意见分歧时附加。对于 `AskUserQuestion`，`isUserInteraction` 为 true 时 `consensus` 是逐问题的汇总（`AskConsensusOutcome`）。

**字段：** `requestId: string`, `toolName: string`, `input: unknown`, `consensus?: AnyConsensusOutcome`, `isUserInteraction?: boolean`

### `consensus_auto`

多方代理共识自行解决的权限请求（所有投票者一致同意）——信息性，无需人类决策。携带裁决 + 理由 + 决策者摘要。

**字段：** `toolName: string`, `input: unknown`, `outcome: AnyConsensusOutcome`

### `turn_end`

一个 prompt→结果回合结束。`complete` = run 正常结束；`error` = 失败。这**绝不**意味着会话结束——会话保持活跃等待下一个 prompt。会话仅在用户清除时才真正结束。对于 `team` 会话，每次 lead 回合触发一次；lead 进程保持运行。

Socket 断连自动 resume 遥测（AS-R18，全部可选/正常回合不出现）：

- `reconnect_attempted`：此回合经历了 socket 断连后的单次自动 `resume`
- `retry_count`：消耗了多少次 resume 尝试（0 或 1，有界）
- `original_error`：触发 resume 路径的 socket 断连消息
- `side_effect_pending`：副作用门控拒绝了自动 resume，因为在 socket 断开时有未完成的写类 `tool_use`（AS-R19）

**字段：** `reason: 'complete' | 'error'`, `error?: string`, `reconnect_attempted?: boolean`, `retry_count?: number`, `original_error?: string`, `side_effect_pending?: boolean`

### `team_upgraded`

会话升级为持久化 agent team：run 检测到使用了 team 工具，lead 进程现在在回合之间保持活跃以协调队友。客户端保持编辑器启用（消息路由到活跃 lead）并显示 team 徽章。一次性发出，写入会话缓冲区，因此重连的查看者也能看到。

**字段：** 无

### `agent_failed`

降级链中的一个 agent 失败（频率限制 / 认证 / 连接错误）。在原始 `user_text` 和下一次尝试的第一个事件之间发送到会话缓冲区，使查看者了解第一个 agent 为何被跳过。后跟下一个 agent 的输出或 `all_agents_failed`。

**字段：** `agentId: string`, `agentName: string`, `error: string`

### `all_agents_failed`

降级链中所有 agent 都已耗尽——没有一个能完成当前回合。会话随后发出 `turn_end { reason: 'error' }` 及组合消息。当前回合的最终失败横幅（会话保持活跃等待手动重试）。

`crossVendorSkipped` 是在链构建时因与当前 agent 不同供应商而被跳过的降级链条目。跨供应商降级无法携带上下文（Claude 会话不能 `resume` 到 Codex——SDK 报错；ADR-0011 / 008），因此链是**同供应商**的：跨供应商条目被丢弃而非以错误供应商启动。在此展示使控制台诚实注明跳过的候选项。

**字段：** `agents: Array<{ agentId: string; agentName: string; error: string }>`, `message: string`, `crossVendorSkipped?: Array<{ agentId: string; agentName: string; vendor: VendorId }>`

### `error`

请求的操作失败（路径错误、会话缺失等）。携带机器可读的 `{ code, params }`（参见 `ui-codes.ts`）——永不为翻译文本；web 通过其 i18n 目录渲染。服务器不持有任何 UI 文案。

**字段：** `error: UiError`

### `schedules`

工作区的 schedule 列表（回复 `list_schedules` 或在创建/更新/删除后广播）。

**字段：** `workspacePath: string`, `items: Schedule[]`

### `schedule_detail`

schedule 完整详情及执行日志（回复 `get_schedule_detail`）。

**字段：** `schedule: Schedule`, `logs: ScheduleExecutionLog[]`

### `execution_transcript`

一次执行的 agent 会话转录记录（回复 `get_execution_transcript`）。`items` 对 `command` 类型或无会话的执行为空；`sessionId` 此时为 `null`。

**字段：** `executionId: string`, `sessionId: string | null`, `items: TranscriptItem[]`

### `schedule_execution_logs`

schedule 的执行日志。

**字段：** `scheduleId: string`, `items: ScheduleExecutionLog[]`

### `workspace_mcp_config`

工作区级 MCP 服务器配置（回复 `get_workspace_mcp_config`）。

**字段：** `workspacePath: string`, `config: WorkspaceMcpConfig`

### `schedule_write_approval_pending`

创建了新的待处理写操作审批条目。

**字段：** `approval: PendingWriteApproval`

### `schedule_write_approval_resolved`

待处理写操作审批已解决（批准/拒绝/过期）。

**字段：** `approvalId: string`, `status: 'approved' | 'rejected' | 'expired'`, `scheduleId: string`

### `pending_write_approvals`

工作区的待处理写操作审批列表（回复 `list_pending_write_approvals`）。

**字段：** `workspacePath: string`, `items: PendingWriteApproval[]`

### `schedule_tool_manifest`

供应商的工具清单（回复 `get_schedule_tool_manifest`）。

**字段：** `vendor: VendorId`, `tools: ToolManifestEntry[]`

### `wait_user_events`

项目的待用户处理事件列表（回复 `list_wait_user_events`）。作为完整快照推送——客户端替换而非合并其本地状态。

**字段：** `items: WaitUserInvolveEvent[]`

### `skill_load_approval_request`

启动前 skill 加载门控等待人类决策（挂载层 2/3；模态框由 3/3 渲染）。后端在项目中首次挂载外部 skill 之前发出，此时一次性 `.gitignore` 写入需要确认，然后阻塞该挂载等待匹配的 `skill_load_approval_resolve`。`detail` 是人类可读的即将发生操作的摘要（要追加的 `.gitignore` 行）。

**字段：** `requestId: string`, `kind: SkillApprovalKind`, `id: string`（SkillRepoConfig.id）, `vendor: VendorId`, `repo: string`, `ref: string`, `detail: string`

### `pong`

回复 `ping`。

**字段：** 无

## 工作区和会话类型

- **`WorkspaceInfo`** — `{ path, name, lastAccessed }`。已注册的项目目录。
- **`SessionInfo`** — `{ sessionId, title, lastModified, mode, isToolSession, vendor, state? }`。工作区中的一个会话。`sessionId` 是供应商**原生** id（而非不透明的 c3 id）；`vendor` 是拥有供应商的标签，来自跨供应商 `SessionAccessor` 列表（ADR-0013）——显示维度（侧边栏颜色点 / 过滤 / 同供应商代理切换候选项）。`mode` 是供应商原生 `ModeToken`，根据此行的 `vendor` 通过该供应商的 `VendorModeCatalog` 解释。`state` 是支持此线路条目的投影行的生命周期状态（ADR-0013 修订——`work_session_metadata` 投影），驱动侧边栏新鲜度 UX：`born`/`alive` 为正常列表项；`stale` 显示 "Unvalidated" 标签；`orphaned` 灰显该行（原生 store 已清除会话）；`ghost` 显示 "Retry" 操作（原生 store 错误，不知该行是否真实）。
- **`SessionStatus`** — `'idle' | 'running' | 'awaiting_permission' | 'team' | 'reconnecting'`。会话的活跃 run 状态。`team` 是持久化 agent-team 会话：lead 进程在回合之间保持活跃，因此即使没有回合产生输出，run 仍在进行中（非 `idle`）；仅当用户显式停止时才结束。`reconnecting` 是瞬态保持：正常会话的回合遇到 socket 断连，在单次自动 `resume` 同一 run 之前进行退避（AS-R18）。
- **`SessionRunStatus`** — `{ sessionId, status: SessionStatus }`。一个会话的状态，携带于 `ready.statuses` 和 `session_status` 中。
- **`TranscriptItem`** — 重放的历史项：`user` / `assistant` / `tool_use` / `tool_result` / `notice`，镜像活跃渲染种类。
- **`IntentSessionInfo`** — `{ sessionId, title: string | null, updatedAt }`。intent 通信会话列表响应中的一个会话。`title` 可为空——客户端在为空时回退到 `'New Intent'` 或首条 prompt / 时间戳派生。
- **待处理会话 id** — `PENDING_SESSION_PREFIX`（`pending:`）前缀在未启动会话的 id 上，直到 `session_started` 将其绑定到真实 SDK id。

参见 [session-registry 规范](../../domains/core/session-registry/spec.md)。

## 系统配置类型

- **`AgentConfig`** — 供应商**可区分联合类型**：供应商无关的公共外壳 `AgentConfigBase = { id, vendor, configMode, displayName, enabled?, icon? }` 与供应商特定的 `config` 子对象相交。当前分支：`{ vendor: 'claude'; config: ClaudeAgentConfig }`、`{ vendor: 'opencode'; config: OpencodeAgentConfig }`、`{ vendor: 'codex'; config: CodexAgentConfig }`。`configMode` 为 `'system'` 表示使用供应商 CLI 自身的系统配置/登录（`config` 的 provider 字段被忽略）；为 `'custom'` 表示应用 `config` 的 provider 字段作为启动覆盖。内置 agent id `=== SYSTEM_AGENT_ID`（`'system'`）仅作为迁移哨兵和合成回退存在。
- **`SystemSettings`** — `{ agents, defaultAgentId, voiceLang?, uiLang?, timezone?, showToolSessions?, degradationChain?, socketAutoResume?, sandboxes?, projectConfigs? }`。持久化在 `~/.c3/settings.json`。曾有的顶级 `defaultMode`、`consensus`、`devSkill`、`maxRoundsPerStage`、`maxSpeechChars`、`skillRepos` 字段已**废弃**（2026-06-07），移至 `WorkspaceSetting`。
- **`WorkspaceSetting`** — `{ defaultMode?, consensus?, devSkill?, maxRoundsPerStage?, maxSpeechChars?, skillRepos?, gitCommitMode?, defaultMainBranch?, sandbox? }`。工作区级设置，键控于 `SystemSettings.projectConfigs`（on-disk 键名仍为 `projectConfigs`，兼容旧数据）。`defaultMode` 是 `Record<VendorId, ModeToken | CodexPolicy>`（每个供应商独立的默认权限模式）。`gitCommitMode: 'current-branch' | 'worktree'`（缺省 `current-branch`，normalize 对缺省/未知值回退 `current-branch`）决定启动开发时的 git 提交策略；`defaultMainBranch?` 为 `worktree` 模式下新 worktree 的基准分支（缺省则从当前 HEAD 切）。
- **`ConsensusConfig`** — `{ enabled, majority? }`。多方代理共识投票配置。`majority` 可选；`false`/缺失 ⇒ 仅一致同意才自动解决；`true` ⇒ 多数裁决。
- **`ConsensusOutcome`** — `{ kind: 'tool', votes, summary, unanimous, decision, vendorScope?, crossVendorExcluded? }`。`kind` 区分 `'tool'`（allow/deny 投票）和 `'ask'`（`AskUserQuestion` 回答）。`vendorScope` 是投票限定于的供应商（共识是供应商同质的）。`crossVendorExcluded` 是因跨供应商范围而被排除的 voter 数量。
- **`AskConsensusOutcome`** — `{ kind: 'ask', perQuestion, fullyUnanimous, agreedAnswers, summary, vendorScope?, crossVendorExcluded? }`。`AskUserQuestion` 上共识的逐问题汇总。`agreedAnswers` 是问题文本 → 同意答案的预构建映射。
- **`VendorModeCatalog`** — `{ vendor, modes: VendorModeDescriptor[], defaultToken }`。供应商的模式目录（2026-06-07-012），定义该供应商可选的原生模式 token 的有序列表及其中立网格映射。
- **`VendorModeDescriptor`** — `{ token, labelCode, actionMode, toolGate }`。目录中一个可选择的模式：其原生 `token`、web i18n 叶子键 `labelCode`，以及它映射到的中立 `ActionMode × ToolGate` 网格单元。
- **`ModeToken`** — `string`。供应商原生权限模式 token。`PermissionMode`（`'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'`）现在是 Claude 独有的 token 集合。
- **`CodexPolicy`** — `{ sandboxMode: CodexSandboxMode, approvalPolicy: CodexApprovalPolicy }`。Codex 双策略配置（2026-06-08），替换 `codex` 供应商的单一 `ModeToken`。

参见 [system-config 规范](../../domains/system-config/agent-config/spec.md)。

## 规范代理消息模型（供应商中立）——ADR-0013

线路上的供应商中立信封的单一事实来源（`shared/src/protocol.ts`，不含 SDK）。该模型最初在 `kernel/agent/adapters/types.ts` 中编写（ADR-0011），并由 ADR-0013 提升至此，因此线路仅增加一个 `vendor` **维度**——绝不启动每个供应商的第二个模式。

- **`VendorId`** — `'claude' | 'codex' | 'opencode'`。每个信封上携带的供应商标签。
- **`ActionMode`** — `'plan' | 'build'`。run 被允许执行的**操作**维度。Claude 的 `plan` 模式、Codex 的只读 `sandboxMode`、OpenCode 的 Plan agent 都转换为此维度。
- **`ToolGate`** — `'always-ask' | 'on-sensitive' | 'trusted-prefix' | 'never-ask'`。工具门控的**激进程度**维度，与 `ActionMode` 正交。替换 Claude 的五向 `PermissionMode` 作为内部权限真相。
- **`NeutralMode`** — `{ actionMode: ActionMode, toolGate: ToolGate }`。一个模式 token 解析到的中立权限网格单元。
- **`AdapterCapability`** — 六个二进制能力：`'interrupt' | 'setActionMode' | 'streamingPush' | 'inProcessMcp' | 'forkSession' | 'perToolApproval' | 'taskStore'`。内核的 `AdapterCapabilities` 布尔账本以此精确键名。
- **`SessionCapability`** — 五个会话生命周期操作：`'list' | 'read' | 'resume' | 'rename' | 'delete'`。每个供应商通过 `SessionCapabilities` 按 `CapabilityState`（`'none' | 'partial' | 'full' | 'temporarily-unavailable'`）分级自我报告。
- **`CapabilityState`** — `'none' | 'partial' | 'full' | 'temporarily-unavailable'`。一个可降级能力的分级状态，比 `boolean` 更丰富。用于会话生命周期操作（`SessionCapability`）和 OpenCode 服务器可达性（`OpencodeServerStatus`）。
- **`CanonicalRole`** — `'user' | 'assistant'`。模型承诺的唯一角色。Codex 从项类型合成。
- **`CanonicalBlock`** — 三供应商公共块联合类型：`text` / `thinking` / `tool_use`。**没有独立的 `tool_result` 块**（ADR-0011 D3 裁决）：工具的返回通过 id-upsert 折叠到 `tool_use.result` 中。供应商独有类型（Codex `reasoning`、OpenCode `diff`）在 `vendorExtra` 中携带。块 `id` 用于 upsert 关联，而非跨供应商身份。
- **`CanonicalMessage`** — `{ vendor, sessionId, turnId?, role, blocks: CanonicalBlock[], ts, preApproved?, vendorExtra? }`。`vendor`/`sessionId` 是无条件的；`role`/`blocks`/`ts`/`turnId?` 携带折扣（合成/upsert/c3 时间戳/可丢弃）。无法在所有三种供应商中存活的任何内容落在 `vendorExtra` 中，永不放在顶层。
- **`OpencodeServerStatus`** — `{ reachability: CapabilityState, retrying: boolean, url? }`。受监管 OpenCode REST 服务器的活跃可达性。`reachability` 复用 `CapabilityState`，使 UI 按状态降级而非按供应商。

**双形式 upsert。**两种供应商消息形式折叠为一种规则——块按 `(sessionId, block.id)` 键控并 **upsert**，而非仅追加：Claude 发出完整消息（完整块集，幂等重新发出），Codex 发出增量 `ItemUpdated` 帧原地修订较早的块。工具结果单调回填其 `tool_use`（后续仅输入的修订永不擦除已到达的结果）。

**审批是独立流。**审批/权限事件**不是** `CanonicalMessage`——它们走 `ApprovalBridge`（目前作为 `permission_request` / `permission_response` 呈现），因此信封不会变成上帝类型。

**会话命名空间（c3 内部化）。**外部世界（URL、存储键）只看到不透明的 `C3SessionId`（`"c3s_" + sha256(vendor \0 vendorSessionId)[:32]`，确定性、不含供应商信息）；`{ vendor, vendorSessionId }` 引用保留在内核内。`SessionAccessor` 是可用供应商 `SessionStore` 上的**只读**联合类型。

## Intent 类型

- **`IntentPriority`** — `'P0' | 'P1' | 'P2' | 'P3'`（P0 最高）。
- **`IntentStatus`** — `'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'`。
- **`Intent`** — `{ id, projectPath, title, content, priority, module, status, dependsOn, lastDevSessionId, automate, createdAt, updatedAt, completedAt, runStatus }`。项目范围账本条。`module`（模块名称）是 agent 推断的所属模块，未识别时为 `''`。`runStatus: IntentRunStatus`（`'running' | 'dangling' | 'idle'`）是在列表时派生的运行状态。
- **`ProposedIntent`** — `{ id?, title, content, priority, module?, dependsOn?, dependsOnIndexes? }`。`save_intents` 调用中的一个项。有 `id` 时 upsert（更新同项目已存在的 intent）；无 `id` 时插入新 `Intent`（状态 `todo`）。
- **`AutomationState`** — `'idle' | 'running' | 'awaiting_gate' | 'developing' | 'fixing' | 'done' | 'error'`。
- **`AutomationStatus`** — `{ projectPath, state, currentIntentId, currentSessionId, awaitingPermission, error, completedIds, startedAt }`。每个项目的自动化编排器状态；仅内存，不持久化。

通信 agent 的保存确认复用 `permission_request` / `permission_response`，其中 `toolName === 'mcp__c3__save_intents'`，`input.intents: ProposedIntent[]`。

参见 [intent-management 规范](../../domains/core/intent-management/spec.md)。

## Discussion 类型

- **`DiscussionStatus`** — `'draft' | 'in_progress' | 'completed' | 'cancelled'`。
- **`DiscussionSpeakerKind`** — `'organizer' | 'agent' | 'human'`。消息作者类别。
- **`Discussion`** — `{ id, projectPath, title, type, goal, context, researchResult, status, agenda, agendaIndex, conclusion, createdAt, updatedAt, completedAt }`。项目范围 discussion。`context` 是用户的原始输入，永不覆写。`researchResult` 是只读研究 agent 的完成输出，独立于 `context`。`agenda` 是 organizer 的有序子主题（`[]` 表示未设置）；`agendaIndex` 是当前子主题的 0 基索引。
- **`DiscussionMessage`** — `{ id, discussionId, seq, speakerKind, speakerAgentId, speakerName, content, createdAt }`。一条消息，按每个 discussion 单调递增的 `seq`（从 1 开始）排序。
- **`ResearchMessage`** — `{ discussionId, seq, kind, content, createdAt }`。研究 run 的流式项。仅运行时——不持久化。

`open_discussion` 一次性返回完整有序历史（`discussion_detail`）；`create_discussion` 向创建连接发送相同回复，因此新 discussion 无需点击即可打开。右侧面板为**两阶段**：当 discussion 的研究 run 活跃时面板显示**研究流**；研究结束且编排自动启动后切换到**discussion 流**。Organizer 引擎将每条新消息作为 `discussion_message` 流式传输。当一轮被派发时，聊天尾部通过瞬时 `discussion_dispatch_status` 显示谁在回复。对话由 agent 驱动但人类可操控：标题栏提供暂停/恢复，编辑器允许人类在运行中插话（`discussion_speak`）或在完成后发起新轮次（`continue_discussion`）。

参见 [discussion 规范](../../domains/core/discussion/discussion-overview.md)。

## Schedule 类型

- **`ScheduleType`** — `'command' | 'llm'`。
- **`ScheduleTriggerType`** — `'cron' | 'event'`。触发方式：基于时间或基于运行生命周期事件。
- **`RunLifecycleTopic`** — `'run:started' | 'run:settled'`。事件触发 schedule 可订阅的运行生命周期主题。
- **`RunEndReason`** — `'complete' | 'error' | 'aborted'`。运行结束的终端原因。
- **`RunKind`** — `'session' | 'intent' | 'discussion' | 'schedule' | 'consensus' | 'tool'`。运行/agent 调用的来源分类（2026-06-08），替代旧的 `SessionKind`。
- **`ScheduleStatus`** — `'active' | 'paused' | 'error'`。
- **`McpMode`** — `'read-only' | 'sandboxed' | 'full-access'`。
- **`Schedule`** — `{ id, type, config, workspacePath, vendor, triggerType, cronExpression, nextRunAt, eventTopic, eventReasonFilter, status, mode, toolAllowlist, toolDenylist, createdAt, updatedAt }`。`mode` 是 `ModeToken | CodexPolicy`。
- **`ScheduleExecutionLog`** — `{ id, scheduleId, startedAt, finishedAt, exitCode, output, error, status, sessionId }`。
- **`PendingWriteApproval`** — `{ id, scheduleId, workspacePath, toolName, toolInput, diffPreview, createdAt, expiresAt, status, resolvedBy, resolvedAt }`。沙箱化 schedule 执行的待处理写操作审批。
- **`ToolManifestEntry`** — `{ name, isWrite }`。供应商工具清单中的条目。

## 等待用户处理事件

- **`WaitUserInvolveSource`** — `'session' | 'intent' | 'discussion' | 'schedule'`。事件的来源类别。
- **`WaitUserInvolveStatus`** — `'todo' | 'done' | 'canceled'`。
- **`WaitUserInvolveEvent`** — `{ id, projectPath, source, sourceId, title, requestId, toolName, toolInput, status, createdAt, updatedAt }`。需要人类关注的事件——网控在人类决策（`permission_response`）前门控的工具调用的服务器端记录。在门控时创建，人类决策时解决。Web 侧边栏的"待处理"徽章按项目统计 `todo` 条目。

## UI 错误码（`UiError`）

- **`UiError`** — `{ code: UiErrorCode, params?: Record<string, string | number> }`。浏览器中显示的任何错误的无语言负载。`code` 是机器可读标识符（如 `intent.notFound`）；`params` 携带目标消息占位符的值。
- **单一事实来源** — `shared/src/ui-codes.ts` 定义 `UI_ERROR_CODES`（`code → { key, params? }`，全部英文常量）和 `UiErrorCode` 联合类型。Web import 它并渲染 `t(UI_ERROR_CODES[code].key, params)`；**翻译仅在 web locale 目录中存在一次**——服务器永不持有它们。

## 备注

- `user_prompt` 回显为 `user_text`（因此所有查看者和切换回放都能看到）；run 的 `assistant_text` / `tool_use` / `permission_request` 随后，`turn_end` 是可观察的回合结束。
- 浏览器对 `set_mode` 发送乐观 UI 更新，在 `mode_changed` 上确认；提交时也乐观地将查看的会话标记为运行中，通过 `session_status` 对账。
- Run 不与连接绑定：切换查看的会话或关闭 socket 不会停止 run（ADR-0006）。重连时，`select_session` 重放完整记录。
