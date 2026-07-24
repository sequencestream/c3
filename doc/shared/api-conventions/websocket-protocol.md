# WebSocket Protocol

浏览器与服务器之间的唯一线路协议。端点：`ws://<host>/ws`（HTTPS 页面下为 `wss://`）。所有流量均为带 `type` 判别字段的 JSON 信封。

**单一事实来源：** 本文档即是协议契约。浏览器与服务器两端共享同一套消息与数据结构定义，编译期类型一致。

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

请求工作区某一类会话列表。服务器从 `session_metadata` 投影读取 `bound=1`
行并回复 `sessions`；缺省 `sessionKind` 为 `work`。

**字段：** `workspaceId: string`, `sessionKind?: SessionKind`

### `get_session_counts`

请求工作区六类会话的运行中计数。服务器按 `session_metadata.session_kind`
分组并与运行时状态交集，回复 `session_counts`。

**字段：** `workspaceId: string`

### `list_dir`

列出已注册工作区内某个相对目录的直接子项。只读。服务器必须通过 `workspaceId`
解析已注册工作区根,再解释 `rel`；绝不把 wire 上的任意路径当根。服务器回复
`dir_listed` 或 `error`。

**字段：** `workspaceId: string`, `rel: string`

### `read_file`

读取已注册工作区内某个相对文件。文本且未超限时返回内容；二进制或超大文件只返回元信息。
服务器回复 `file_read` 或 `error`。

**字段：** `workspaceId: string`, `rel: string`

### `get_code_git_status`

请求工作区的只读 Git 状态快照,用于装饰文件树。只携带 `workspaceId`,**绝不**携带客户端路径。
服务器基于 `git status --porcelain -z --untracked-files=all` 采集(单仓库工作区查该仓库,否则沿用
子仓库发现规则逐仓库查询并加仓库相对前缀),始终回复 `code_git_status`(不回 `error`);非 Git、
仓库不可读或 Git 不可用时降级为空快照,**不使 `list_dir` 失败**。严格只读,绝不修改索引或工作区。

**字段：** `workspaceId: string`

### `search_codes`

在已注册工作区内搜索代码。`mode: 'filename'` 以查询词作不区分大小写子串,匹配每个条目的基础名(而非相对路径),连字符与扩展名不构成匹配边界,命中的 `match` 为完整基础名；`mode: 'content'`
返回命中文件和行。可选 `pattern` 为文件名 glob 过滤器(如 `*.ts`,逗号/空格分隔取并集),
缩小被搜索的文件范围;目录恒被遍历,空/`*` 表示全部。搜索有结果上限和超时,并排除 `.git`。
服务器回复 `codes_searched` 或 `error`。

**字段：** `workspaceId: string`, `query: string`, `mode: 'filename' | 'content'`, `pattern?: string`

### `create_session`

在工作区中创建新的待处理（pending）会话并激活。可选的 `agentId` 记录为待处理会话的**意图**（ADR-0015）：其首次 run 使用该代理启动并冻结其供应商。缺失/为空 ⇒ **Auto**——不写入意图，run 回退到已配置的 `defaultAgentId`。

**字段：** `workspacePath: string`, `agentId?: string`

### `create_work_session`

`create_session` 的会话页显式入口，语义固定为创建 `session_kind='work'`
的工作会话。服务器回复同 `create_session`。

**字段：** `workspaceId: string`, `agentId?: string`

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

**字段：** `workspacePath: string`

### `save_workspace_setting`

保存工作区设置。

**字段：** `workspacePath: string`, `config: WorkspaceSetting`

### `list_intents`

请求项目的 intent 列表，可按状态过滤。服务器回复 `intents`。如果账本不可用则返回 `error`。

**字段：** `workspacePath: string`, `status?: IntentStatus`

### `open_intent_chat`

进入 intent 视图：打开或切换到通信会话。提供 `sessionId` 时打开该特定会话（并将其设为 `isCurrent`）；不提供时打开项目的 `is_current` 会话（若无则创建一个新的 `pending:` 会话）。回复 `session_selected` 加 `intents` 列表（intent-management RM-R4）。

**字段：** `workspacePath: string`, `sessionId?: string`

### `list_intent_sessions`

列出项目的 intent 通信会话。回复 `intent_sessions`。每个会话携带 `sessionId`、`title`（可为空）和 `updatedAt`。响应还携带活跃 agent run 会话的 `runStates` 快照。

**字段：** `workspacePath: string`

### `rename_intent_session`

重命名 intent 通信会话。成功后服务器广播刷新后的 `intent_sessions` 列表。

**字段：** `workspacePath: string`, `sessionId: string`, `title: string`

### `delete_intent_session`

删除 intent 通信会话：移除数据库行、移除运行时（中止任何活跃 run）、广播刷新后的列表。如果被删除的会话是 `isCurrent`，则最近的剩余会话成为新的默认。会话不存在时返回错误。

**字段：** `workspacePath: string`, `sessionId: string`

### `new_intent_chat`

启动全新的通信会话：将之前 `is_current` 的通信会话重置为 0，创建一个标记为当前的新会话，回复 `session_selected`（空历史记录）加 `intents` 列表。由 intent 标题栏中的 "+" 按钮触发（RM-R4）。

**字段：** `workspacePath: string`

### `refine_intent`

重新启动通信会话，注入一个 intent 的内容作为种子，以进一步细化该 intent（RM-R7）。

**字段：** `workspacePath: string`, `intentId: string`

### `discussion_to_intent`

将已完成的 discussion 的结论桥接到 intent 领域（`refine_intent` 的变体）。服务器从 discussion 解析项目，重启通信会话作为全新会话，注入携带 discussion 标题和结论的首条 prompt，回复 `session_selected`（空历史记录）加 `intents` 列表。如果 discussion 未知、未 `completed` 或没有结论，则拒绝（`error`）。

**字段：** `discussionId: string`

### `start_development`

> 历史 wire type 名称保持 `start_development`；用户可见能力是“开始工作”。

为 `todo` 状态的 intent 启动后台工作会话，使用可配置的开发 skill（系统设置中的 `devSkill`；默认为空 ⇒ 不加 skill 前缀）。将其设为 `in_progress` 并记录 `lastWorkSessionId`（RM-R8）。worktree 模式下会先检查依赖是否已在主线可用；若依赖 intent 已 `done` 但关联 PR/MR 尚未确认合并，启动被拒绝并返回 `intent.dependencyNotMerged`，同时后台对这些依赖 PR/MR 做一次 best-effort 状态同步，完成后重新广播 intents。

**字段：** `workspacePath: string`, `intentId: string`

### `write_spec`

为 intent 撰写 spec 文档（质量闸输出步骤）：在**固定集中**的 spec 根目录(`<c3 home>/doc/<项目路径段>`,按项目隔离、不可配置、不入 Git)下搭建按日期分层的 spec 目录、种子 `spec.md`、立即把**绝对路径**回填到 intent 的 `specPath`,并在配置的 spec agent 上启动写入受限于 spec 目录(即便其位于项目树之外)的撰写会话;非 Claude spec agent 在启动前被拒绝（intent-management RM-R21）。

**字段：** `workspaceId: string`, `intentId: string`

### `read_spec`

读取 intent 已撰写的 spec(供意图详情「spec」tab 渲染)。spec 位于工作区之外的集中根目录,工作区受限的 `read_file` 无法触达,故由本消息按 **intentId** 解析该 intent 存储的绝对 `specPath`,并**只在集中 spec 根目录内**读取(失败即拒,落在根目录之外的旧版工作区内 `.doc` 不被识别),回复 `read_file`(其 `file.path` 即该绝对 spec 路径)。

**字段：** `workspaceId: string`, `intentId: string`

### `approve_spec`

人工审批检查点:批准 intent 的 spec，置 `spec_approved=true` 并将批准者(当前登录 subject)记入 `spec_approve_user`，随后重新广播 `intents`。单人确认，无多签/撤销;`specPath` 为空(尚未撰写 spec)时拒绝(`error`)。批准本身不开始工作，只让四态按钮推进到 `Start Work`（intent-management RM-R22）。

**字段：** `workspaceId: string`, `intentId: string`

### `open_spec_session`

打开 intent 的 spec 撰写会话(`specSessionId`)供意图详情的「spec session」tab 查看。服务器解析该 intent 存储的 spec 会话 id;若其写入受限的 `'spec'` 运行时已被回收则按 `specPath` 重建(写入仍受限于 spec 目录、重新绑定 spec agent),回复 `session_selected`(历史 + 状态)。区别于 `open_intent_chat`(打开的是另一类 `'intent'` 运行时的沟通/refine 会话);intent 的沟通会话 tab 仍走 `open_intent_chat`。无 `specSessionId` 时拒绝(`error`)。

**字段：** `workspaceId: string`, `intentId: string`

### `update_intent_status`

手动设置 intent 状态（如 `done` / `cancelled`）；服务器回复 `intents`（RM-R9）。

**字段：** `intentId: string`, `status: IntentStatus`

### `sync_intent_pr_status`

对已完成且 PR/MR 状态仍为 `reviewing` 的 intent 做一次手动状态同步。服务器按 workspace 的 forge 规则查询实时 PR/MR 状态：GitHub 使用 `gh pr view <id> --json state,mergedAt,url`，GitLab 使用 `glab mr view <id> --output json`。仅当 forge 明确返回 merged/closed 时更新 `prStatus`（merged 会解除 worktree 依赖闸门，closed 不会被当作 merged）；无 PR、非 `done`、非 `reviewing`、CLI 缺失/未登录、查询失败均不写入 merged。回复 `sync_intent_pr_status_response`，前端据此展示同步中、成功、不可同步或失败反馈。

**字段：** `workspaceId: string`, `intentId: string`

### `set_intent_automate`

切换 intent 的自动化标记；服务器回复 `intents`（RM-A1）。

**字段：** `intentId: string`, `automate: boolean`

### `start_automation`

启动项目的自动化编排器（已在运行则为空操作）；回复 `automation_status`（RM-A2/A3）。

**字段：** `workspacePath: string`

### `stop_automation`

停止编排器，中止当前开发 run；回复 `automation_status` → `idle`（RM-A7）。

**字段：** `workspacePath: string`

### `list_discussions`

请求项目的 discussion 列表，可按状态过滤。服务器回复 `discussions`。如果 discussion 账本不可用则返回 `error`。

**字段：** `workspacePath: string`, `status?: DiscussionStatus`

### `create_discussion`

从 "+" 表单创建 discussion。`discussionType` 必须是已注册的 discussion 类型；`title` 从 `goal` 派生。服务器持久化为 `draft`，**向创建连接回复 `discussion_detail`**（右侧面板立即打开），推送刷新后的 `discussions` 列表，然后运行只读研究 agent（`discussion-research` 门控）读取项目资料 + 搜索网络以补全 `context`。

研究 run 是**可观察的**——每个回合作为 `research_message` 流式传输，其活跃状态作为 `research_run_status` 广播（`running` 然后完成/失败/进程死亡时 `ended`）——并在结算时再次推送 `discussions`。**研究成功后服务器自动启动编排**（守卫重新检查 `draft` + 无活跃 run；等同于自动 `start_discussion`）；研究失败则保持 `draft` 状态等待手动 **Start**。

**字段：** `workspacePath: string`, `discussionType: string`, `goal: string`, `context?: string`

### `open_discussion`

打开一个 discussion：服务器回复 `discussion_detail`（discussion + 完整消息历史）。如果未知或 store 不可用则返回 `error`。

**字段：** `discussionId: string`

### `start_discussion`

在 `draft` discussion 上启动 organizer 引擎（标题栏 **Start** 按钮，或服务器在 `create_discussion` 研究成功后**自动调用**）。服务器将其切换为 `in_progress` 并在后台运行编排循环：organizer（默认 agent）驱动该类型的工作流，每个回合是一次 one-shot 单次询问；每条消息作为 `discussion_message` 流回；run 结束于写 `conclusion` + `completed`。已在运行则为空操作；非 `draft` / 未知 / store 不可用时返回 `error`。

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

### `create_automation`

在工作区创建 automation；服务器广播 `automations`。

**字段：** `workspacePath: string`, `input: CreateAutomationInput`

### `list_automations`

列出工作区的 automation；服务器回复 `automations`。

**字段：** `workspacePath: string`

### `update_automation`

部分更新 automation；服务器广播 `automations`。

**字段：** `automationId: string`, `input: UpdateAutomationInput`

### `delete_automation`

删除 automation；服务器广播 `automations`。

**字段：** `automationId: string`

### `get_automation_detail`

获取 automation 完整详情及执行日志；服务器回复 `automation_detail`。

**字段：** `automationId: string`

### `get_execution_transcript`

读取一次 `llm` 类型执行的 agent 会话转录记录（只读重放）；服务器回复 `execution_transcript`。

**字段：** `automationId: string`, `executionId: string`

### `automation_run_now`

手动触发：立即执行 automation（在正常 tick 之外）。

**字段：** `automationId: string`

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

### `get_automation_tool_manifest`

请求供应商的工具清单，供 automation 表单中的工具选择使用。服务器回复 `automation_tool_manifest`。

**字段：** `vendor: VendorId`, `workspacePath: string`

### `skill_load_approval_resolve`

解决待处理的启动前 skill 加载门控（挂载层 2/3）。`approve` 允许挂载继续并持久化 `.gitignore` 确认；`cancel` 跳过追加 `.gitignore` 行（skill 不挂载，但会话仍然启动）。通过 `requestId` 与 `SkillLoadApprovalRequest` 关联。

**字段：** `requestId: string`, `decision: 'approve' | 'cancel'`

### `get_skill_link_status`

查询某项目下每个已配置 skill repo 的安装链接状态（2026-06-12）。服务器回复 `skill_link_status`：按 `id` 返回 `_c3_<id>` 是否为两个共享公共 skill 目录（`.claude/skills`、`.agents/skills`）下的活跃软链。只读、零网络。外部 skill 已不在启动时挂载，改由设置面板显式安装。

**字段：** `workspacePath: string`

### `install_skill`

显式安装（或更新）某个已配置 skill repo（2026-06-12）：clone/pull 配置 ref 的最新 head，删除旧 `_c3_<id>` 软链/目录后重新建链到两个公共目录。保留一次性 `.gitignore` 追加确认。服务器回复 `skill_install_result`。替代已移除的启动时自动挂载——安装只由用户动作触发。

**字段：** `workspacePath: string`, `skillId: string`

### `list_wait_user_events`

请求工作区的待用户处理事件列表。可选的 `status` 过滤到特定生命周期状态（默认：全部）。列表走服务端时间游标分页：默认 `limit=20`，`cursorTime` 取上一页最后一条的 `createdAt`，`cursorExcludeId` 取上一页最后一条的 `id`；服务端按 `(created_at DESC, id DESC)` 查询严格早于该游标的下一页，因此同毫秒创建的事件不会重复或跳过。服务器回复 `wait_user_events`。`workspaceId` 是不透明工作区 id（与 `currentWorkspace` 一致）；服务端经 `resolveWorkspaceRoot` 解析为绝对路径后查库，未注册 id 降级为空快照——绝不把 id 当路径直接查询。

**字段：** `workspaceId: string`, `status?: WaitUserInvolveStatus`, `cursorTime?: number`, `cursorExcludeId?: string`, `limit?: number`

### `update_wait_user_event`

更新一条待用户处理事件的生命周期状态。当前仅允许从 `todo` 单向改到非 `todo` 状态（WorkCenter 行内“标记完成”发送 `status: 'done'`）；目标不存在、目标不是 `todo`、或请求改回 `todo` 时返回 `waitUserInvolve.invalidStatusTransition`。成功后服务端广播刷新后的 `todo` 列表用于待处理徽章。

**字段：** `id: string`, `status: WaitUserInvolveStatus`

### `ping`

保持连接活跃。

**字段：** 无

## Server → Client（`ServerToClient`）

### `ready`

握手完成；携带工作区列表、最后活跃会话及所有活跃 run 的状态。

**字段：** `workspaces: WorkspaceInfo[]`, `activeSessionId: string | null`, `statuses: SessionRunStatus[]`

### `session_status`

向**所有**连接广播，每 15 秒一次心跳，并在任何运行时状态变化时广播；由服务器端心跳 + 活跃性对账驱动。客户端也可通过 `request_session_status` 按需拉取。侧边栏徽章和等待权限高亮的权威快照。

**字段：** `statuses: SessionRunStatus[]`

### `workspaces`

完整的工作区列表，按最近访问降序排列。

**字段：** `workspaces: WorkspaceInfo[]`

### `sessions`

一个工作区某一 `sessionKind` 的会话列表，按最后修改降序排列。

**字段：** `workspaceId: string`, `sessions: SessionInfo[]`, `sessionKind?: SessionKind`

### `session_counts`

一个工作区六类会话的运行中计数。

**字段：** `workspaceId: string`, `counts: Record<'work' | 'intent' | 'spec' | 'discussion' | 'automation' | 'tool', number>`

### `dir_listed`

回复 `list_dir`。返回某个工作区相对目录的直接子项；每个子项路径仍为工作区相对路径。
不返回 `.git`。

**字段：** `workspaceId: string`, `rel: string`, `entries: CodeDirEntry[]`

### `code_git_status`

回复 `get_code_git_status`。`files` 是「工作区相对路径 → `CodeGitStatus`」的完整映射,只含发生变化的文件。
客户端**权威整体替换**上一份快照(已消失的路径随之丢弃标记),并按文件路径的祖先前缀聚合出目录汇总
(折叠且从未加载的目录也能显示后代变化)。客户端只更新与当前 Codes 工作区匹配的快照,不触碰其他工作区。
空映射表示干净/非 Git/查询失败。删除、重命名、复制、冲突不进入映射。

**字段：** `workspaceId: string`, `files: Record<string, CodeGitStatus>`

### `file_read`

回复 `read_file`。返回文件元信息；当文件是文本且未超过大小上限时携带 `content`。二进制
或超大文件只返回 `path` / `size` / `binary` / `truncated` 元信息。

**字段：** `workspaceId: string`, `file: CodeFileRead`

### `codes_searched`

回复 `search_codes`。返回至多服务器上限数量的命中；`truncated` 表示结果数触顶，
`timedOut` 表示搜索达到运行时间上限。所有命中路径均为工作区相对路径且不包含 `.git`。

**字段：** `workspaceId: string`, `query: string`, `mode: 'filename' | 'content'`, `hits: CodeSearchHit[]`, `truncated: boolean`, `timedOut: boolean`

### `session_selected`

一个会话成为此连接当前查看的会话；携带其模式、重放的磁盘历史记录，以及选中时运行时的权威活跃 `status`。客户端从 `status` 初始化其按会话状态映射，使编辑器立即锁定（无需等待下一次 `session_status` 广播——这是后台运行中会话出现陈旧 "ready" 窗口的来源）。对于后台/进行中的会话，活跃缓冲区尾部在此消息之后作为正常流事件跟随。

**字段：**

- `workspaceId: string`
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

- `hostStatus: VendorHostStatus[]` — 每个供应商的主机 CLI 存在情况 + 已安装二进制的绝对路径 `path`（ADR-0012），驱动新建会话选择器灰显与设置诊断面板的安装位置展示
- `bindingStats: SessionBindingStats` — 会话→代理绑定计数（ADR-0015），用于说明"默认代理更改不回溯"
- `sessionCapabilities: Record<VendorId, SessionCapabilities>` — 每个供应商的会话生命周期能力分级（ADR-0011 附录），UI 按 `vendor` 标签降级会话行操作
- `vendorCapabilities?: Record<VendorId, Record<AdapterCapability, boolean>>` — 每个供应商的二进制能力账本（`interrupt` / `setActionMode` / … / `taskStore`），控制台据此以零 `if (vendor === …)` 的方式门控能力绑定 UI
- `skillSupport?: Record<VendorId, SkillSupportState>` — 每个供应商的外部 skill 挂载支持（ADR-0016/0017，挂载层 2/3）
- `vendorModes?: Record<VendorId, VendorModeCatalog>` — 每个供应商的模式目录（2026-06-07-012），控制台的模式选择器按供应商渲染

**字段：** `settings: SystemSettings`, `hostStatus: VendorHostStatus[]`, `bindingStats: SessionBindingStats`, `sessionCapabilities: Record<VendorId, SessionCapabilities>`, `vendorCapabilities?: Record<VendorId, Record<AdapterCapability, boolean>>`, `skillSupport?: Record<VendorId, SkillSupportState>`, `vendorModes?: Record<VendorId, VendorModeCatalog>`

### `workspace_setting`

工作区的标准化设置（回复 `load_workspace_setting` 或 `save_workspace_setting`）。`config` 含两个 git 分支模式字段：`gitBranchMode: 'current-branch' | 'worktree'`（缺省/未知值归一为 `worktree`）与 `defaultMainBranch?: string`（`worktree` 模式下新 worktree 的基准分支），并含 `sddEnabled?: boolean`（缺失/非布尔归一为 `true`，显式 `false` 保持关闭）。`detectedMainBranch?` 是服务端探测到的仓库默认分支（`origin/HEAD` → 当前 HEAD），仅在 `load` 回复时下发，表单用它预填 `defaultMainBranch`（已保存值优先于探测值）。

**字段：** `workspacePath: string`, `config: WorkspaceSetting`, `detectedMainBranch?: string`

### `intents`

项目的 intent 列表，回复 `list_intents` / `open_intent_chat`，或在确认 `save_intents` 后广播（intent-management）。`sddEnabled` 是该 workspace 的 SDD 总开关,随每次列表广播携带,供四态意图操作按钮无需单独拉取设置即可定态（RM-R22）。

### `create_intent` / `create_intent_result`

`create_intent { workspaceId }` 是不经过智能体确认的轻量登记入口。服务端在单个事务中创建一条 `title="new intent"`、空正文、`P2`、`draft`、未开启自动化且无下游资产的意图和 `intent_created` 日志。仅向请求连接回复 `create_intent_result { workspaceId, intent }` 以精确定位服务端 UUID，随后仍广播常规 `intents` 快照；客户端须等待该 ID 出现在当前工作区快照后再选中，不得按标题或排序猜测。

### `start_intent_session`

`start_intent_session { workspaceId, intentId, text, images? }` 为尚无 `intentSessionId` 的指定意图创建 owner 沟通会话并发送首条消息。空文本且无图片不创建；已有绑定返回冲突。成功沿用 `session_selected`、运行事件和 `intents` 快照。owner 会话后续调用 `save_intents` 时，批次必须恰好一项携带 owner intent ID，且在确认和落库前校验；拆分出的其他项省略 ID 并作为 `todo` 新建。

### `delete_intent`

`delete_intent { workspaceId, intentId }` 永久删除意图及其 c3 管理的本地资源。删除前先校验工作区可用且意图归属该工作区（跨工作区 intentId 按 `intent.notFound` 拒绝）；随后停止并删除关联会话、删除确定性的本地 worktree 与已记录的 `intent/` 本地分支，并在事务中清除依赖边、会话关联、生命周期日志和意图记录。远端分支和 PR 不受影响。

**字段：** `workspaceId: string`, `items: Intent[]`, `sddEnabled: boolean`

### `dev_launch_progress`

手动 `start_development` 启动的粗粒度阶段进度，按连接定向（非广播），驱动客户端的工作启动进度遮罩。只承载阶段枚举与目标 `intentId`，**不含路径 / 命令 / 错误细节**（不泄露无关内部信息）。`stage` 取值 `fetching-remote-main`（worktree 模式下尝试拉取远程主分支基底前）、`preparing-worktree`（进入 worktree 创建 / 分支 pull 前）、`launching`（拉起工作 agent 进程前）、`failed`（返回后的异步启动失败——修复此前静默失败的缺口）。**成功终态不在此发**：客户端从常规 `intents` 广播中目标意图翻为 `in_progress` 推断就绪并关闭遮罩。

**字段：** `intentId: string`, `stage: DevLaunchStage`（`'fetching-remote-main' | 'preparing-worktree' | 'launching' | 'failed'`）

### `intent_sessions`

项目的 intent 通信会话列表（回复 `list_intent_sessions` 或在更改后推送）。`runStates` 是哪些列出的会话有活跃 agent run 的实时快照（id → `'running'`）——缺失条目表示没有活跃 run。每次列表发送都携带（首次获取 / 重连重新获取 / 状态变更推送），因此刷新或重连可权威地对账后台会话的 run 状态（与持久化 `status` 解耦）。

**字段：** `workspacePath: string`, `items: IntentSessionInfo[]`, `runStates?: Record<string, 'running'>`

### `automation_status`

项目的自动化编排器状态。在进入 intent 视图时推送，并在每次状态变更（start/stop/progress/error）时推送。驱动列表头部自动化按钮（intent-management RM-A1–A9）。

**字段：** `status: AutomationStatus`

### `discussions`

项目的 discussion 列表（回复 `list_discussions`，或在更改后推送）。`runStates` 是哪些列出的 discussion 有活跃编排 run 的实时快照（id → `running`/`paused`）——仅活跃条目存在。`researchStates` 是只读研究阶段的伴生快照（id → `running`，仅活跃研究 run 的 discussion 存在）。两者每次列表发送都携带，因此刷新或重连可权威地重建右侧面板的研究阶段或编排 run 状态。

**字段：** `workspacePath: string`, `items: Discussion[]`, `runStates?: Record<string, 'running' | 'paused'>`, `researchStates?: Record<string, 'running'>`

### `discussion_detail`

一个 discussion 加上其完整、有序的消息历史，回复 `open_discussion`。驱动 discussion 视图的只读右侧面板。`researchMessages` 是运行时研究转录快照：研究 run 活跃时为目前已广播的可见研究项集合，无研究在途时为空数组——使重连/刷新 mid-research 能恢复已展示的研究流（研究项本身永不持久化；后续 live `research_message` 按 `seq` 追加去重）。

**字段：** `discussion: Discussion`, `messages: DiscussionMessage[]`, `researchMessages: ResearchMessage[]`

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

discussion 的只读研究 run 的流式项，在研究 agent 工作时实时广播。变体镜像 agent 流，使右侧面板渲染与 work/intent 会话一致的标准转录：`text` = 研究员助手回合文本；`tool_use` = 工具调用（携带 `toolUseId`/`toolName`/`input`）；`tool_result` = 同一调用的返回（携带 `toolUseId`/`content`/`isError`，按 `toolUseId` 与工具块关联）。`seq` 在单个 run 内单调递增（从 1 开始），每个可见项各占一个 seq。右侧面板在查看该 discussion 时追加到**研究流**中（工具项渲染为标准可折叠工具块，不再是单行"正在用 X 检索"）。**仅运行时**——研究消息永不持久化到 DB，但服务器保留一份有界的运行时副本并在 `discussion_detail` 快照中重放，使重连 mid-research 恢复已展示项并按 `seq` 去重后续 live 项；活跃性仍从 `discussions` 上的 `researchStates` 快照中对账。

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

工作会话任务列表的完整快照（2026-06-07-009）——**独立的任务线路路径**，使客户端从类型化消息填充其任务面板，而非重新解析 `tool_result.content` 文本。服务器在事件扇出点派生（Claude：从任务工具 `tool_use`/`tool_result` 流）和在冷历史重放时（从基线转录记录，紧随 `session_selected` 之后发送）。主要形式（幂等、重放友好）。`TaskItem` 携带 `order` 供客户端直接消费。

**字段：** `tasks: TaskItem[]`

### `task_created` / `task_updated`

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

请求的操作失败（路径错误、会话缺失等）。携带机器可读的 `{ code, params }`——永不为翻译文本；web 通过其 i18n 目录渲染。服务器不持有任何 UI 文案。

**字段：** `error: UiError`

### `automations`

工作区的 automation 列表（回复 `list_automations` 或在创建/更新/删除后广播）。

**字段：** `workspacePath: string`, `items: Automation[]`

### `automation_detail`

automation 完整详情及执行日志（回复 `get_automation_detail`）。

**字段：** `automation: Automation`, `logs: AutomationExecutionLog[]`

### `execution_transcript`

一次执行的 agent 会话转录记录（回复 `get_execution_transcript`）。`items` 对 `command` 类型或无会话的执行为空；`sessionId` 此时为 `null`。

**字段：** `executionId: string`, `sessionId: string | null`, `items: TranscriptItem[]`

### `automation_execution_logs`

automation 的执行日志。

**字段：** `automationId: string`, `items: AutomationExecutionLog[]`

### `workspace_mcp_config`

工作区级 MCP 服务器配置（回复 `get_workspace_mcp_config`）。

**字段：** `workspacePath: string`, `config: WorkspaceMcpConfig`

### `automation_write_approval_pending`

创建了新的待处理写操作审批条目。

**字段：** `approval: PendingWriteApproval`

### `automation_write_approval_resolved`

待处理写操作审批已解决（批准/拒绝/过期）。

**字段：** `approvalId: string`, `status: 'approved' | 'rejected' | 'expired'`, `automationId: string`

### `pending_write_approvals`

工作区的待处理写操作审批列表（回复 `list_pending_write_approvals`）。

**字段：** `workspacePath: string`, `items: PendingWriteApproval[]`

### `automation_tool_manifest`

供应商的工具清单（回复 `get_automation_tool_manifest`）。

**字段：** `vendor: VendorId`, `tools: ToolManifestEntry[]`

### `wait_user_events`

项目的待用户处理事件列表（回复 `list_wait_user_events`）。分页回复携带 `hasMore`，客户端据此显示“加载更多”；实时广播路径不携带 `hasMore`，语义为刷新 `todo` 待处理集合，客户端不应把它当作历史分页页替换已加载窗口。

**字段：** `items: WaitUserInvolveEvent[]`, `hasMore?: boolean`

每条 `WaitUserInvolveEvent` 的溯源跳转契约（WorkCenter 据此跳回来源）：

- `workspaceId`：不透明工作区 id（不是路径）。store 持久化绝对 `workspace_path`，读出时经 `pathToId` 映射为 id，因此与 `currentWorkspace` 及各跳转入口（`select_session` / `open_intent_chat` / `open_spec_session` / 讨论 / 计划）期望的 id 一致。工作区已注销的行在读出时被丢弃，绝不下发破损 id。
- `sessionKind`：产生事件的运行的完整 `SessionKind`（`work | intent | discussion | automation | consensus | tool | spec`），由调用方原样写入（不再折叠为可跳转子集）；driver 路径取运行的 `sessionKind`、agent 网控路径取 gate 派生。协议层类型为 `string`，前端 `jumpToSource` 据此 switch 路由，未识别取值兜底进控制台。
- `sessionId`：产生事件的真实会话 id（work/intent/spec 会话 id、discussion id、automation id），溯源跳转直接据 `sessionKind + sessionId` 路由。为 `null` 时降级到对应列表页且不选中。历史行可能携带意图对象 id（非会话 id），这类行反查不到意图、跳转降级，不回填。
- `intentId` / `intentTitle`：**读时派生、不落库**。服务端按 `sessionId` 反查所属意图（`intent_sessions` 绑定 + `intents.intent_session_id` comm 会话 + `intents.last_work_session_id`)，命中则填意图 id 与当前标题（意图改名即时反映），无归属或反查不到为 `null`。`createEvent` 不接受这两个字段。

### `skill_load_approval_request`

启动前 skill 加载门控等待人类决策（挂载层 2/3；模态框由 3/3 渲染）。后端在项目中首次挂载外部 skill 之前发出，此时一次性 `.gitignore` 写入需要确认，然后阻塞该挂载等待匹配的 `skill_load_approval_resolve`。`detail` 是人类可读的即将发生操作的摘要（要追加的 `.gitignore` 行）。

**字段：** `requestId: string`, `kind: SkillApprovalKind`, `id: string`（SkillRepoConfig.id）, `vendor: VendorId`, `repo: string`, `ref: string`, `detail: string`

> 安装动作仍复用此门控做一次性 `.gitignore` 确认（2026-06-12）；安装由 `install_skill` 触发，而非启动时挂载。

### `skill_link_status`

回复 `get_skill_link_status`（2026-06-12）：每个已配置 skill repo 一条 `SkillLinkStatus`，报告 `_c3_<id>` 在两个共享公共目录下的软链存在性。

**字段：** `workspacePath: string`, `statuses: SkillLinkStatus[]`（`SkillLinkStatus = { id, claudeSkills, agentsSkills }`）

### `skill_install_result`

回复 `install_skill`（2026-06-12）。`ok` 表示该 skill 已 clone/pull 到 ref 最新 head 并重新链入两个公共目录。失败时 `reason` 为机器标记（`not-configured` / `repo-error` / `gitignore-cancelled`，UI 映射文案），`detail` 为英文调试文本（非 UI 文案）。

**字段：** `workspacePath: string`, `skillId: string`, `ok: boolean`, `reason?: string`, `detail?: string`

### `pong`

回复 `ping`。

**字段：** 无

## 工作区和会话类型

- **`WorkspaceInfo`** — `{ id, name, path, lastAccessed }`。已注册的项目目录；`id` 是服务器分配的不透明工作区身份，所有 workspace-scoped 操作只认 `id`。`path` 是解析后的绝对路径，仅供 WorkspaceSwitcher 下拉展示以区分同名工作区，不作身份、服务端也不接受它回流作 id。
- **`SessionInfo`** — `{ sessionId, title, lastModified, mode, isToolSession, vendor, state?, sessionKind?, ownerKind?, ownerId?, bound? }`。工作区中的一个会话。`sessionId` 是线路上的会话句柄；`vendor` 是拥有供应商的标签，来自 `session_metadata` 投影/跨供应商 accessor（ADR-0013）——显示维度（侧边栏颜色点 / 过滤 / 同供应商代理切换候选项）。`mode` 是供应商原生 `ModeToken`，根据此行的 `vendor` 通过该供应商的 `VendorModeCatalog` 解释。`sessionKind` 是业务分类(work/intent/spec/discussion/automation/tool)，`ownerKind`/`ownerId` 是可空逻辑归属，供前端纯跳回规则使用；owner 为空表示不可跳回。`state` 是支持此线路条目的投影行生命周期状态（`session_metadata` 投影），驱动侧边栏新鲜度 UX：`born`/`alive` 为正常列表项；`stale` 显示 "Unvalidated" 标签；`orphaned` 灰显该行（原生 store 已清除会话）；`ghost` 显示 "Retry" 操作（原生 store 错误，不知该行是否真实）。
- **`CodeDirEntry`** — `{ name, path, type, gitStatus? }`。`path` 为工作区相对路径；`type` 为 `file` 或 `directory`。`gitStatus` 可选,客户端由 `code_git_status` 快照合并填充,缺失等价于无 Git 状态(兼容非 Git 工作区及旧数据)。
- **`CodeGitStatus`** — `{ modified, untracked, staged }`。文件工作树状态的**可组合标志**(非互斥枚举):`MM`/`AM` 同时为 `staged` 且 `modified`,`untracked` 不与另外两项组合。来自只读 `git status --porcelain`;删除、重命名、复制、冲突不产生此结构。
- **`CodeFileRead`** — `{ path, size, binary, truncated, content? }`。`content` 只在文本且未超限时出现。
- **`CodeSearchHit`** — `{ path, type, line?, lineText?, match? }`。内容搜索命中带行号和行文本；文件名搜索命中可只带路径与匹配片段。
- **`SessionStatus`** — `'idle' | 'running' | 'awaiting_permission' | 'team' | 'reconnecting'`。会话的活跃 run 状态。`team` 是持久化 agent-team 会话：lead 进程在回合之间保持活跃，因此即使没有回合产生输出，run 仍在进行中（非 `idle`）；仅当用户显式停止时才结束。`reconnecting` 是瞬态保持：正常会话的回合遇到 socket 断连，在单次自动 `resume` 同一 run 之前进行退避（AS-R18）。
- **`SessionRunStatus`** — `{ sessionId, status: SessionStatus }`。一个会话的状态，携带于 `ready.statuses` 和 `session_status` 中。
- **`TranscriptItem`** — 重放的历史项：`user` / `assistant` / `tool_use` / `tool_result` / `notice`，镜像活跃渲染种类。
- **`IntentSessionInfo`** — `{ sessionId, title: string | null, updatedAt }`。intent 通信会话列表响应中的一个会话。`title` 可为空——客户端在为空时回退到 `'New Intent'` 或首条 prompt / 时间戳派生。
- **待处理会话 id** — 未启动会话的 id 带 `pending:` 前缀，直到 `session_started` 将其绑定到真实 SDK id。

参见 [session-registry 规范](../../domains/core/session-registry/session-registry-spec.md)。

## 系统配置类型

- **`SystemSettings`** — `{ agents, defaultAgentId, voiceLang?, uiLang?, timezone?, showToolSessions?, degradationChain?, socketAutoResume?, sandboxes?, projectConfigs? }`。持久化为系统级配置。曾有的顶级 `defaultMode`、`consensus`、`devSkill`、`maxRoundsPerStage`、`maxSpeechChars`、`skillRepos` 字段已**废弃**（2026-06-07），移至 `WorkspaceSetting`。`settings` 回包另带只读运行时伴随数据 `hostStatus` 与 `sandboxStatus?`；后者为 `{ present, binary:'arapuca', path, error? }`，供系统设置展示 sandbox 驱动状态及解析后的绝对路径，不写入配置。
- **`WorkspaceSetting`** — `{ defaultMode?, consensus?, devSkill?, maxRoundsPerStage?, maxSpeechChars?, skillRepos?, gitBranchMode?, defaultMainBranch?, sandbox?, sddEnabled? }`。工作区级设置，键控于 `SystemSettings.projectConfigs`（on-disk 键名仍为 `projectConfigs`，兼容旧数据）。`defaultMode` 是 `Record<VendorId, ModeToken | CodexPolicy>`（每个供应商独立的默认权限模式）。`gitBranchMode: 'current-branch' | 'worktree'`（缺省/未知值归一为 `worktree`，并兼容回读旧磁盘键 `gitCommitMode`）决定开始工作时的 git 分支策略；`defaultMainBranch?` 为 `worktree` 模式下新 worktree 的基准分支（缺省则从当前 HEAD 切）。`sddEnabled` 缺失或非布尔时归一为 `true`，显式 `false` 保持关闭。
- **`ConsensusConfig`** — `{ enabled, majority?, mode?, agentIds? }`。多方代理共识投票配置。`majority` 可选；`false`/缺失 ⇒ 仅一致同意才自动解决；`true` ⇒ 多数裁决。`mode: 'all' | 'custom'`（缺省视作 `all`）选择投票者集合，**vendor 中立**（不按 vendor 分组）：`all` ⇒ 全部「已启用非自身」agent（跨 vendor）；`custom` ⇒ 该集合与 `agentIds` 白名单的交集（白名单只按 id 收窄，可含任意 vendor）。`agentIds?: string[]` 仅 `custom` 模式有意义；normalize 清洗掉不存在/已禁用的 id，运行时再次过滤已禁用项（双重静默过滤），空集 ⇒ 无投票者 ⇒ 退回人工。
- **`NormalizedToolRisk`** — `{ operationIntent, resourceScope: { kind, targets }, risks: { read, write, execute, network, tags? }, normalizationVersion }`。工具权限请求经服务端确定性归一化后的 vendor 中立载荷（投票前生成），跨 vendor 投票者只看到它，不接触原生工具名/输入。`operationIntent` 稳定的中立操作类别+简述；`resourceScope` 结构化提取的资源种类与目标（路径/命令目标/远端 host 或 URL）；`risks` 四类基础风险布尔+可选标签；`normalizationVersion` 归一化规则版本。
- **`ConsensusOutcome`** — `{ kind: 'tool', votes, summary, unanimous, decision, normalized?, normalizationFailure? }`。`kind` 区分 `'tool'`（allow/deny 投票）和 `'ask'`（`AskUserQuestion` 回答）。`votes[]` 每票含投票 agent 的 `vendor?`。`normalized` 是归一化成功时投票者所判的载荷；`normalizationFailure` 是归一化失败的稳定原因码（此时全员弃权、`decision` 为 null、转人工，绝不自动允许）。旧的 `vendorScope`/`crossVendorExcluded` 字段已移除；旧审计记录缺这些新字段仍可读。
- **`AskConsensusOutcome`** — `{ kind: 'ask', perQuestion, fullyUnanimous, agreedAnswers, summary }`。`AskUserQuestion` 上共识的逐问题汇总（问题为自然语言、天然 vendor 中立，不走风险归一化）。`agreedAnswers` 是问题文本 → 同意答案的预构建映射；`perQuestion[].answers[]` 每条含 `vendor?`。
- **`VendorModeCatalog`** — `{ vendor, modes: VendorModeDescriptor[], defaultToken }`。供应商的模式目录（2026-06-07-012），定义该供应商可选的原生模式 token 的有序列表及其中立网格映射。
- **`VendorModeDescriptor`** — `{ token, labelCode, actionMode, toolGate }`。目录中一个可选择的模式：其原生 `token`、web i18n 叶子键 `labelCode`，以及它映射到的中立 `ActionMode × ToolGate` 网格单元。
- **`ModeToken`** — `string`。供应商原生权限模式 token。`PermissionMode`（`'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'`）现在是 Claude 独有的 token 集合。
- **`CodexPolicy`** — `{ sandboxMode: CodexSandboxMode, approvalPolicy: CodexApprovalPolicy }`。Codex 双策略配置（2026-06-08），替换 `codex` 供应商的单一 `ModeToken`。

参见 [settings 规范](../../domains/settings/agent-config/agent-config-spec.md)。

## 规范代理消息模型（供应商中立）——ADR-0013

线路上的供应商中立信封的契约（不含 SDK）。该模型最初为内核适配层的内部抽象（ADR-0011），并由 ADR-0013 提升为线协议契约，因此线路仅增加一个 `vendor` **维度**——绝不启动每个供应商的第二个模式。

- **`ToolGate`** — `'always-ask' | 'on-sensitive' | 'trusted-prefix' | 'never-ask'`。工具门控的**激进程度**维度，与 `ActionMode` 正交。替换 Claude 的五向 `PermissionMode` 作为内部权限真相。
- **`NeutralMode`** — `{ actionMode: ActionMode, toolGate: ToolGate }`。一个模式 token 解析到的中立权限网格单元。
- **`AdapterCapability`** — 八个二进制能力：`'interrupt' | 'setActionMode' | 'streamingPush' | 'inProcessMcp' | 'forkSession' | 'perToolApproval' | 'taskStore' | 'nativeUserInput'`。内核的 `AdapterCapabilities` 布尔账本以此精确键名。其中 `nativeUserInput` = 供应商能否在回合中暂停向用户提问并以其回答续跑（Claude 经阻塞式 `canUseTool` 写回 = `true`；Codex 因 `codex exec` 派发后即关 stdin 无反向通道 = `false`）。`false` 时用户输入类意图（如 `save_intents`）改走 c3 受控的 HTTP-MCP 网关，抬升为常规 `permission_request` 进入 WorkCenter（可见的降级路径）。
- **`SessionCapability`** — 五个会话生命周期操作：`'list' | 'read' | 'resume' | 'rename' | 'delete'`。每个供应商通过 `SessionCapabilities` 按 `CapabilityState`（`'none' | 'partial' | 'full' | 'temporarily-unavailable'`）分级自我报告。
- **`CanonicalRole`** — `'user' | 'assistant'`。模型承诺的唯一角色。Codex 从项类型合成。
- **`CanonicalMessage`** — `{ vendor, sessionId, turnId?, role, blocks: CanonicalBlock[], ts, preApproved?, vendorExtra? }`。`vendor`/`sessionId` 是无条件的；`role`/`blocks`/`ts`/`turnId?` 携带折扣（合成/upsert/c3 时间戳/可丢弃）。无法在所有三种供应商中存活的任何内容落在 `vendorExtra` 中，永不放在顶层。

**双形式 upsert。**两种供应商消息形式折叠为一种规则——块按 `(sessionId, block.id)` 键控并 **upsert**，而非仅追加：Claude 发出完整消息（完整块集，幂等重新发出），Codex 发出增量更新帧原地修订较早的块。工具结果单调回填其 `tool_use`（后续仅输入的修订永不擦除已到达的结果）。

**审批是独立流。**审批/权限事件**不是**规范消息——它们走独立的审批桥（目前作为 `permission_request` / `permission_response` 呈现），因此信封不会变成上帝类型。

**会话命名空间（c3 内部化）。**外部世界（URL、存储键）只看到不透明的会话句柄（`"c3s_" + sha256(vendor \0 vendorSessionId)[:32]`，确定性、不含供应商信息）；`{ vendor, vendorSessionId }` 引用保留在内核内。对可用供应商原生会话存储的访问是**只读**的联合视图。

## Intent 类型

- **`IntentPriority`** — `'P0' | 'P1' | 'P2' | 'P3'`（P0 最高）。
- **`IntentStatus`** — `'draft' | 'todo' | 'in_progress' | 'done' | 'cancelled'`。
- **`Intent`** — `{ id, workspacePath, title, content, priority, module, status, dependsOn, lastWorkSessionId, automate, createdAt, updatedAt, completedAt, runStatus, sessionActive, intentSessionId, specSessionId }`。项目范围账本条。`module`（模块名称）是 agent 推断的所属模块，未识别时为 `''`。`runStatus: IntentRunStatus`（`'running' | 'dangling' | 'idle'`）是在列表时派生的运行状态，仅描述 `in_progress` 工作会话。`sessionActive: boolean` 是发送时派生的瞬时活跃信号：`intentSessionId`、`specSessionId`、`lastWorkSessionId` 三者任一非空且被运行注册表 `isRunning` 判活即为 `true`，覆盖三类会话、不受意图 `status` 限制，可与 `runStatus='idle'/'dangling'` 共存；每次发送从注册表重新派生，不落库不缓存。`intentSessionId` 是 refine/沟通会话，`specSessionId` 是撰写/精炼 spec 会话，`lastWorkSessionId` 是最近一次由 intent 启动的工作会话回链，三者语义不同。
- **`ProposedIntent`** — `{ id?, title, shortEnTitle, content, priority, module?, dependsOn?, dependsOnIndexes?, intentSessionId? }`。`save_intents` 调用中的一个项。`shortEnTitle` 是必填的简短英文 ASCII 标题，用作后续分支/worktree 命名的稳定来源。有 `id` 时 upsert（更新同项目已存在的 intent）；无 `id` 时插入新 `Intent`（状态 `todo`）。`intentSessionId` 是把本条意图回链到产出它的沟通会话的可选字段，**仅当本批只保存 1 条意图时才生效**（批量 >1 条时落库核心一律忽略，不写入任何行）；模型填入提示中注入的当前会话 id，保存处理器再将其归一化为 bind 后的真实会话 id（`open_intent_chat` 可解析）。`save_intent_directly`（automation 路径）的 schema 不含该字段。
- **`AutomationState`** — `'idle' | 'running' | 'awaiting_gate' | 'developing' | 'fixing' | 'done' | 'error'`。
- **`AutomationStatus`** — `{ workspacePath, state, currentIntentId, currentSessionId, awaitingPermission, error, completedIds, startedAt }`。每个项目的自动化编排器状态；仅内存，不持久化。

通信 agent 的保存确认复用 `permission_request` / `permission_response`，其中 `toolName === 'mcp__c3__save_intents'`，`input.intents: ProposedIntent[]`。

参见 [intent-management 规范](../../domains/core/intent-management/intent-management-spec.md)。

## Discussion 类型

- **`DiscussionStatus`** — `'draft' | 'in_progress' | 'completed' | 'cancelled'`。
- **`DiscussionSpeakerKind`** — `'organizer' | 'agent' | 'human'`。消息作者类别。
- **`Discussion`** — `{ id, workspacePath, title, type, goal, context, researchResult, status, agenda, agendaIndex, conclusion, createdAt, updatedAt, completedAt }`。项目范围 discussion。`context` 是用户的原始输入，永不覆写。`researchResult` 是只读研究 agent 的完成输出，独立于 `context`。`agenda` 是 organizer 的有序子主题（`[]` 表示未设置）；`agendaIndex` 是当前子主题的 0 基索引。
- **`DiscussionMessage`** — `{ id, discussionId, seq, speakerKind, speakerAgentId, speakerName, content, createdAt }`。一条消息，按每个 discussion 单调递增的 `seq`（从 1 开始）排序。
- **`ResearchMessage`** — `{ discussionId, seq, createdAt } & ({ kind: 'text', text } | { kind: 'tool_use', toolUseId, toolName, input } | { kind: 'tool_result', toolUseId, content, isError })`。研究 run 的流式项,变体镜像 agent 流以渲染标准转录(文本气泡 + 可折叠工具块)。仅运行时——不持久化到 DB,但服务器保留有界运行时副本经 `discussion_detail` 重放。

`open_discussion` 一次性返回完整有序历史（`discussion_detail`）；`create_discussion` 向创建连接发送相同回复，因此新 discussion 无需点击即可打开。右侧面板为**两阶段**：当 discussion 的研究 run 活跃时面板显示**研究流**；研究结束且编排自动启动后切换到**discussion 流**。Organizer 引擎将每条新消息作为 `discussion_message` 流式传输。当一轮被派发时，聊天尾部通过瞬时 `discussion_dispatch_status` 显示谁在回复。对话由 agent 驱动但人类可操控：标题栏提供暂停/恢复，编辑器允许人类在运行中插话（`discussion_speak`）或在完成后发起新轮次（`continue_discussion`）。

参见 [discussion 规范](../../domains/core/discussion/discussion-overview.md)。

## Automation 类型

- **`AutomationType`** — `'command' | 'llm'`。
- **`ScheduleTriggerType`** — `'cron' | 'event'`。触发方式：基于时间或基于运行生命周期事件。
- **`RunLifecycleTopic`** — `'run:started' | 'run:settled'`。事件触发 automation 可订阅的运行生命周期主题。
- **`RunEndReason`** — `'complete' | 'error' | 'aborted'`。运行结束的终端原因。
- **`SessionKind`** — `'work' | 'intent' | 'discussion' | 'automation' | 'consensus' | 'tool' | 'spec'`。运行/agent 调用的**业务场景**分类（业务来源判断走它）。2026-06-26 从旧 `RunKind` 拆出，7 个业务值整体迁入（`'session' → 'work'`）。未被任何线协议消息引用，仅服务端内存态使用。
- **`RunKind`** — `'interactive' | 'background' | 'headless' | 'internal'`。运行的**执行形态**分类（执行机制判断走它），与 `SessionKind` 正交。2026-06-26 收窄而来，目前仅作记录/审计字段。未被任何线协议消息引用。
- **`AutomationStatus`** — `'active' | 'paused' | 'error'`。
- **`McpMode`** — `'read-only' | 'sandboxed' | 'full-access'`。
- **`Automation`** — `{ id, type, config, maxWallClockMs, workspacePath, vendor, triggerType, cronExpression, nextRunAt, eventFilter, eventSessionKindFilter, runningSessionId, status, mode, toolAllowlist, toolDenylist, createdAt, updatedAt }`。`maxWallClockMs` 为单次执行的最大墙钟时间（毫秒）；null 使用任务类型默认值。`mode` 是 `ModeToken | CodexPolicy`。`runningSessionId` 是服务端派生、客户端只读的字段（不落库，读时关联 `automation_execution_logs` 计算）：仅当 `type='llm'` 且存在 `status='running'` 且 `session_id` 非空的执行日志时为该会话 id，否则为 `null`；多条候选时取 `started_at` 最新的一条（同刻按日志 id 定序）。command 执行、尚未绑定真实会话 id 的 LLM 执行以及终态日志均为 `null`；不推断进程存活性。
- **`AutomationExecutionLog`** — `{ id, automationId, startedAt, finishedAt, exitCode, output, error, status, sessionId }`。
- **`PendingWriteApproval`** — `{ id, automationId, workspacePath, toolName, toolInput, diffPreview, createdAt, expiresAt, status, resolvedBy, resolvedAt }`。沙箱化 automation 执行的待处理写操作审批。
- **`ToolManifestEntry`** — `{ name, isWrite }`。供应商工具清单中的条目。

## 等待用户处理事件

- **`WaitUserInvolveStatus`** — `'todo' | 'done' | 'canceled' | 'auto'`。`'auto'` = 多 Agent 共识自动决议、无人类参与的非阻塞审计记录（永不计入"待处理"徽章），其 `outcome` 携带做出该决议的共识结果，使自动决策可追溯。
- **`WaitUserInvolveEvent`** — `{ id, workspaceId, sessionKind, sessionId, intentId?, intentTitle?, title, requestId, toolName, toolInput, status, outcome?, createdAt, updatedAt }`。需要人类关注的事件——网控在人类决策（`permission_response`）前门控的工具调用的服务器端记录。在门控时创建，人类决策时解决。`sessionKind`（`string`，产生运行的完整 `SessionKind`）/ `sessionId`（真实会话 id）是溯源跳转键；`intentId` / `intentTitle` 为读时按 `sessionId` 反查所属意图派生（不落库，无归属为 null）。Web 侧边栏的"待处理"徽章按项目统计 `todo` 条目。`outcome?: AnyConsensusOutcome | null` 仅在 `status: 'auto'` 记录上出现（网控的 `consensus_auto` 结果——投票、裁决、摘要），人类决策的事件上缺省/为 null。`done` / `canceled` / `auto` 事件按 `createdAt` 保留 7 天；服务端启动时清理一次，之后每 6 小时硬删除一次，`todo` 不参与保留期清理。

## UI 错误码（`UiError`）

- **`UiError`** — `{ code: UiErrorCode, params?: Record<string, string | number> }`。浏览器中显示的任何错误的无语言负载。`code` 是机器可读标识符（如 `intent.notFound`）；`params` 携带目标消息占位符的值。
- **单一事实来源** — 错误码目录将每个 `code` 映射到一个翻译 key 加可选 params（全部英文常量），由共享契约统一声明。Web 据此把 `code` 渲染为本地化文本；**翻译仅在 web locale 目录中存在一次**——服务器永不持有它们。

## 备注

- `user_prompt` 回显为 `user_text`（因此所有查看者和切换回放都能看到）；run 的 `assistant_text` / `tool_use` / `permission_request` 随后，`turn_end` 是可观察的回合结束。
- 浏览器对 `set_mode` 发送乐观 UI 更新，在 `mode_changed` 上确认；提交时也乐观地将查看的会话标记为运行中，通过 `session_status` 对账。
- Run 不与连接绑定：切换查看的会话或关闭 socket 不会停止 run（ADR-0006）。重连时，`select_session` 重放完整记录。
