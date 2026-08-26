# WebSocket Protocol

浏览器与服务器之间的线路协议。端点:`ws://<host>/ws`(HTTPS 下为 `wss://`)。所有流量均为带 `type` 判别字段的 JSON 信封。

**编译期唯一事实来源:** [`shared/src/protocol.ts`](../../../shared/src/protocol.ts)(barrel + `ClientToServer` / `ServerToClient` 联合的唯一装配点)。领域载荷在 [`shared/src/protocol/`](../../../shared/src/protocol/) 按域分区:`<domain>.ts` 为公开模型,`<domain>-messages.ts` 为消息载荷(不经 barrel 再导出)。本文档只记录约定与按域消息目录;字段形状以 TypeScript 为准,不在此复述。

## 约定

- 每条消息是带字符串 `type` 的 JSON 对象;消费者按 `type` 收窄。
- 服务器忽略无法解析或 `type` 无法识别的客户端消息——不可解析的消息**绝不**视为权限批准。
- 通过 `requestId` 关联:`permission_request` 携带一个;匹配的 `permission_response` 回显它。
- 权限**决策不持久化**。运行时 buffer 保存原始 `permission_request`,`select_session` 重放会重新发出且不附带决策。区分待处理与历史重放是客户端责任(见 web-console WC-R16)。
- 工作区身份是不可变的 `workspaceName`;`add_workspace` 携带 `{ workspaceName, path }`,`remove_workspace` 只携带 `{ workspaceName }`。
- 意图自动化队列控制消息为 `start_workflow` / `stop_workflow` / `queue_control`,状态推送为 `workflow_status`(不是历史名 `start_automation` / `automation_status`)。
- 自动化 CRUD 即时生效;写工具权限靠创建/编辑时的 allowlist 冻结,无线上 HITL 写审批消息。

## 域分区与消息目录

下列 `type` 字符串与 `protocol.ts` 联合臂一一对应。新增消息:在所属 `*-messages.ts` 定义载荷 → 在 barrel 联合中加一臂 → 必要时更新本目录一行。

### session

- **C→S:** `user_prompt`, `permission_response`, `set_mode`, `set_session_agent`, `list_sessions`, `get_session_counts`, `create_session`, `create_work_session`, `delete_session`, `select_session`, `rename_session`, `stop_run`, `rebind_view`, `list_commands`, `request_session_status`, `ping`
- **S→C:** `ready`, `session_status`, `sessions`, `session_counts`, `session_selected`, `session_started`, `session_agent_changed`, `mode_changed`, `commands`, `user_text`, `assistant_text`, `notice`, `tool_use`, `tool_result`, `task_list`, `task_created`, `task_updated`, `task_deleted`, `permission_request`, `consensus_auto`, `turn_end`, `team_upgraded`, `agent_failed`, `all_agents_failed`, `error`, `pong`

### workspace

- **C→S:** `add_workspace`, `select_workspace_directory`, `cancel_workspace_directory_selection`, `remove_workspace`, `load_workspace_setting`, `save_workspace_setting`, `get_workspace_mcp_config`, `save_workspace_mcp_config`, `get_timerange_stats`, `get_workspace_dashboard`, `set_workspaces_automation_enabled`, `get_workspace_accessors`
- **S→C:** `workspaces`, `workspace_directory_selection`, `workspace_setting`, `workspace_mcp_config`, `timerange_stats`, `workspace_dashboard`, `workspaces_automation_result`, `workspace_accessors`

### file / log

- **C→S:** `list_dir`, `read_file`, `get_file_git_status`, `search_files`, `read_runtime_log`
- **S→C:** `dir_listed`, `file_read`, `file_git_status`, `files_searched`, `runtime_log`

### settings / skill / tool-manifest

- **C→S:** `get_settings`, `save_settings`, `auto_configure_agents`, `get_personalized_settings`, `save_personalized_settings`, `list_mcp_api_keys`, `create_mcp_api_key`, `update_mcp_api_key`, `revoke_mcp_api_key`, `list_my_mcp_api_keys`, `create_my_mcp_api_key`, `reset_my_mcp_api_key`, `revoke_my_mcp_api_key`, `start_self_update`, `apply_self_update`, `cancel_self_update`, `skill_load_approval_resolve`, `get_skill_link_status`, `install_skill`, `get_tool_manifest`
- **S→C:** `settings`, `auto_configure_agents_result`, `personalized_settings`, `mcp_api_keys`, `my_mcp_api_keys`, `update_status`, `self_update_state`, `skill_load_approval_request`, `skill_link_status`, `skill_install_result`, `tool_manifest`

### auth / memory

- **C→S:** `login`, `logout`, `set_admin_password`, `remove_account`, `set_admin_account`, `get_user_workspace_access`, `save_user_workspace_access`, `list_workspace_memories`, `delete_workspace_memory`
- **S→C:** `login_result`, `admin_password_result`, `account_op_result`, `unauthenticated`, `user_workspace_access`, `workspace_memories`, `workspace_memory_deleted`

### intent(含工作区自动化队列)

- **C→S:** `list_intents`, `create_intent`, `start_intent_session`, `open_intent_session`, `list_intent_sessions`, `list_intent_logs`, `rename_intent_session`, `delete_intent_session`, `delete_intent`, `new_intent_session`, `refine_intent`, `discussion_to_intent`, `start_development`, `repair_intent_worktree`, `write_spec`, `approve_spec`, `revoke_spec_approval`, `open_spec_session`, `open_spec_review_session`, `reset_intent_session`, `reset_spec_session`, `read_spec`, `update_spec_content`, `update_intent_content`, `update_intent_status`, `set_intent_automate`, `set_intent_spec_mode`, `update_intent_deps`, `set_intent_git_info`, `start_workflow`, `stop_workflow`, `get_queue_detail`, `get_park_recovery_stats`, `queue_control`, `create_pr`, `sync_intent_pr_status`
- **S→C:** `intents`, `create_intent_result`, `dev_launch_progress`, `spec_launch_progress`, `intent_worktree_repair_result`, `intent_worktree_baseline_notice`, `intent_sessions`, `intent_logs_list`, `workflow_status`, `queue_detail`, `park_recovery_stats`, `create_pr_response`, `create_pr_progress`, `sync_intent_pr_status_response`

### delivery / discussion / automation

- **delivery C→S:** `list_deliveries`, `create_delivery`, `list_delivery_logs`, `get_delivery_detail`, `update_delivery`, `cancel_delivery`, `transition_delivery`, `init_delivery_branch`, `cleanup_delivery_branch`, `link_intent_to_delivery`, `unlink_intent_from_delivery`, `sync_delivery_mainline`, `create_delivery_pr`, `sync_delivery_pr`
- **delivery S→C:** `deliveries`, `create_delivery_result`, `delivery_detail`, `delivery_transition_failed`, `delivery_branch_init_progress`, `delivery_branch_init_result`, `delivery_logs_list`, `delivery_sync_mainline_progress`, `delivery_sync_mainline_result`
- **discussion C→S:** `list_discussions`, `create_discussion`, `open_discussion`, `start_discussion`, `pause_discussion`, `resume_discussion`, `cancel_discussion`, `discussion_speak`, `continue_discussion`
- **discussion S→C:** `discussions`, `discussion_detail`, `discussion_message`, `discussion_run_status`, `discussion_dispatch_status`, `research_message`, `research_run_status`
- **automation C→S:** `create_automation`, `list_automations`, `update_automation`, `delete_automation`, `get_automation_detail`, `get_execution_transcript`, `automation_run_now`, `list_wait_user_events`, `update_wait_user_event`
- **automation S→C:** `automations`, `automation_detail`, `execution_transcript`, `automation_execution_logs`, `wait_user_events`

### robot(IM)

- **C→S:** `list_robots`, `create_robot`, `update_robot`, `delete_robot`, `acknowledge_robot_outbound`, `set_robot_enabled`, `list_robot_turns`, `acknowledge_robot_write_capability`, `set_robot_write_grant_enabled`, `get_my_im_identity`, `create_im_identity_challenge`, `cancel_im_identity_challenge`, `revoke_my_im_identity`, `admin_revoke_im_identity`, `list_im_identity_bindings`, `list_im_group_workspace_scopes`, `set_im_group_workspace_scopes`, `start_app_registration`, `cancel_app_registration`
- **S→C:** `robots`, `robot_turns`, `my_im_identity`, `im_identity_challenge_created`, `im_identity_bindings`, `im_group_workspace_scopes`, `app_registration_progress`, `app_registration_result`

## 维护

消息形状变更只改 `shared/src/protocol/` 与 barrel 联合;同步更新本目录中对应域的一行。领域行为规格引用 `type` 名,不复制字段表。
