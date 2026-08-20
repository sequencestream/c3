# 领域: memory

- **分组:** core
- **一句话:** 工作区级的长期记事本——把用户口头表达过的偏好、验证过一次的项目约束、稳定事实与踩过的坑,以结构化、有界、可撤销的形式留给以后的 work session,使 agent 不必让用户把同一件事再说一遍。
- **负责人:** maintainer
- **状态:** 活跃
- **依赖:** 位于 `~/.c3/c3.db` 的本地 SQLite 存储(`workspace_memories` 单表);`session-registry` 的工作区身份解析(`workspaceNameFor`,把 run 绑定的路径换成不可变的 `workspace_name`);既有的 work session 回环 MCP 路由 `POST /internal/event-mcp/v1`(不新增路由);`agent-session` 的 run 生命周期(由 `sessionKind === 'work'` 正向选中工具面)。
- **被依赖方:** `permission-gateway`(把两个记忆工具列入免确认集);`agent-session` 的 work session 工具面;`web-console` 的工作区设置页(记忆 Tab,只读列表 + 删除)。
- **exposes-api:** true —— 四条 WebSocket 消息(`list_workspace_memories` / `workspace_memories` / `delete_workspace_memory` / `workspace_memory_deleted`),供工作区设置页查看与软删;无独立 HTTP 路由,不进外部 MCP 工具目录。对**模型**的全部暴露面仍只是 work session 上的两个 MCP 工具 `memory_search` / `memory_write`,经既有 event MCP 回环传输提供;协议面服务的是人,且只能读摘要与删,不能写。
- **ADRs:** [0045](../../../architecture/adr/0045-workspace-memory-as-allowed-local-persistence.md)

## 它解决什么

仓库能自证的事实属于仓库文档:目录约定、代码结构、已写进 `CLAUDE.md` 的规则,任何工具都能重新推导。
但用户在会话里说出来的东西不属于那里——「提交信息用中文」「PR 合进交付分支而不是 main」「沙箱内 vitest
要单线程跑」这类共识,写进仓库会污染代码库并跨人泄漏,不写又会在每个新会话丢失一次。

memory 域就是这批知识的落点。它是**结论**的存储,不是转录的存储。

## 边界

- **工作区级,不是账号级**,也不跨工作区。`subject` 只做分组,不扩大可见范围。
- **只有 `work` session 能读写。**`intent` / `spec` / `spec_review` / `discussion`(含调研会话与编排的
  逐 agent 会话)一概拿不到这两个工具——它们产出的是合成观点,不是用户共识。
- **不自动读、不启动注入。**记忆是 agent 主动检索的对象。
- **写入路径唯一。**只有 work session 里的 agent 能写。设置页的记忆 Tab 只做「看 + 删」,不提供新建与编辑——第二个写入口会让同一张表长出第二套各自漂移的语义。
- **不是密钥库。**写入路径拒绝常见凭据形状,但形状检测挡不住任意散文;不要把秘密托付给它。
- **不做语义。**没有 LLM 压缩、FTS5、向量检索与矛盾检测;检索是字面子串匹配。
- **不派生。**不从意图/交付台账、仓库文件或厂商会话库回填任何历史记忆。

## 索引

- [memory-spec.md](memory-spec.md) —— 两个工具的行为契约、设置页的看与删、会话与权限规则、用户场景、业务规则(身份、容量、拒绝规则、清理规则)
- [memory-design.md](memory-design.md) —— SQLite 层与 schema 收敛、store、工具接线、janitor、组合根装配
- [memory-models.md](memory-models.md) —— WorkspaceMemory / WorkspaceMemoryListItem / MemoryType / MemoryStatus / MemoryScope 等实体与判据
