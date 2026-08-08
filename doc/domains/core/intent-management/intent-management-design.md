# intent-management — 设计

实现 [spec](intent-management-spec.md)。该能力由一个 SQLite 账本层、其上的 store、只读沟通运行变体
加保存工具、启动开发接线,以及自动化编排器(状态机 + 完成判定器 + git 助手)构成,并挂钩到智能体
运行循环(一个运行变体)、运行时注册表(一个运行 `kind` + 共享启动器)、WS 分发层(新的消息分支)、
以及会话列表(隐藏集过滤)。前端新增一个意图视图。

**复用基线。** 几乎所有部分都建立在既有机制之上:运行时注册表、emit/viewer 扇出、以及后台运行;
聊天流与 `user_prompt`;权限网关;`select_session` 用于开发回链。真正全新的部分是:
**SQLite 层**、**只读沟通运行变体 + `save_intents` 工具**、**意图前端**,以及叠加在同一套
运行时/启动器/viewer 机制之上的**自动化编排器**(状态机 + 完成判定器 + git 助手)。

## 职责

| 关注点               | 说明                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| SQLite 驱动适配器    | 跨运行时共享适配器(Node 与 Bun 内置 SQLite);最小化同步 API(讨论 store 也使用它)                   |
| 账本操作             | Intent CRUD、依赖聚合、沟通会话映射                                                               |
| 沟通系统提示词       | 只读分析师提示词,作为追加系统提示词注入                                                           |
| `c3` MCP 工具        | 暴露 `save_intents`(对话确认后落库)+ 只读的 `find_intents` / `view_intent`(RM-R19)                |
| 运行变体             | 运行循环新增追加系统提示词 / 禁用工具 / MCP 服务器 / 网关等选项;为判定器提供一个无工具的 one-shot |
| 运行时 kind + 启动器 | 运行时上新增运行 kind(`session` 或 `intent`);一个共享启动器                                       |
| WS 分支 + 编排       | 八个新消息分支;沟通会话的 viewer 管理;开发轮助手 + 自动化广播                                     |
| 隐藏集列表过滤       | 会话列表排除该项目的隐藏集                                                                        |
| 自动化编排器         | 按项目的状态机:挑选下一项、续跑循环、判定 + 提交;注入式钩子                                       |
| 完成判定器           | 构建提示词、运行无工具 one-shot、解析 `done`/`in_progress`/`stuck`                                |
| Reconcile            | 在进入列表时对死进程的 `in_progress` 意图做调和(注入式依赖)                                       |
| Git 助手             | Diff-stat + 近期日志 + commit-and-push(按仓库限定作用域,支持多仓库);从不拒绝,只返回代码/错误      |

## SQLite 层

- **位置:** `~/.c3/c3.db` — 与 c3 设置主目录 `~/.c3/` 对齐,**而非**注册表的
  `~/.claude/c3/`。
- **跨运行时驱动(ADR 0007)。** 该层暴露一个最小化的**同步**接口
  (exec / run / all / get),按运行时选择驱动:Bun 二进制使用 Bun 内置的
  SQLite,Node 使用 Node 内置的同步 SQLite。二者绝不交叉使用。两者都是同步的,因此
  单一同步适配器与 c3 既有的同步持久化风格相匹配。
- **适配器约束(两套 API 确实存在差异):** 只使用位置占位符
  (命名参数的绑定方式不同);只按字段读取行(一个驱动返回 null 原型对象,
  另一个返回普通对象)。两个驱动在 prepare/query 及多语句 API 上也有差异,由
  适配器统一处理。
- **构建(强制):** 服务端打包必须把两个内置 SQLite 模块都标记为 external。仅靠
  动态 import **是不够的**——没有 external 标记,打包器仍无法解析 Bun 模块。
- **创建时的 PRAGMA:** WAL 日志模式 + 忙等超时,在多个 c3 进程指向同一个
  db 时低成本地减少锁冲突(跨进程并非 v1 目标,但该设置是零成本的)。
- **软失败(按每个入口点):** open/create 失败时,将 db 标记为不可用,
  在不影响 c3 启动的前提下禁用意图功能(RM-R12)——与
  「即使配置损坏也要能启动」这条规则保持一致。

## Schema(`PRAGMA user_version` 迁移)

- `intents` — 账本(`id`、`workspace_path`、`title`、`content`、`priority`、`status`、
  `module`、`last_work_session_id`、`automate`、`created_at`、`updated_at`、`completed_at`,
  以及 spec 相关列 `spec_path`/`spec_status`/`spec_approved`/`spec_approve_user`/
  `spec_session_id`/`spec_review_*`/`spec_mode`),按 `(workspace_path, status)` 建索引。
  `module` 为 `TEXT NOT NULL DEFAULT ''`;`automate` 为 `INTEGER NOT NULL DEFAULT 0`;
  `spec_mode` 可空三态(`NULL`=继承工作区 / `'sdd'` / `'fast'`,RM-R43)。
- `intent_deps` — `(intent_id, depends_on_id)` 边。
- `intent_fast_turns` — fast 模式每 turn 反向补轨的结算记录(`session_id` 主键、`intent_id`、
  `workspace_path`、`baseline` JSON、`settled_at`/`outcome`/`spec_path`、`created_at` +
  `idx_intent_fast_turn_intent`);`settled_at` 在落定处理前为 NULL,同时充当「启动 → 落定」
  握手,防重复 settled 事件或重启重复生成规格。resume 复用同一 session 重建 baseline 时,
  冲突分支一并清除 `settled_at`/`outcome`/`spec_path`,为同一会话的每个 turn 各自开启新的
  可结算周期,使第二个及后续 resume turn 同样能 claim 落定(RM-R43)。
- `intent_chats` — 一张表身兼**按工作区的沟通会话集合**与**隐藏集**两职:`session_id`
  (主键,可能是 `pending:` id)、`workspace_path`、
  `title`(可空,客户端回退为「New Intent」或由首个提示词推导)、
  `is_current`(0/1,每个项目最多一条——默认打开指针)、
  `updated_at`。一个项目全部行的集合即为隐藏集;`is_current=1` 的那一行
  是未指定具体 `sessionId` 进入意图视图时重新加载的会话。

**Schema 版本(当前:v19)。** Schema 版本为 `19`。每次升级都在旧字段重命名之后、
应用 schema 之前追加一个幂等迁移:v2 `module`,v3
`completed_at`(可空),v4 `automate`(`INTEGER NOT NULL DEFAULT 0`),v6 旧的 `requirement*`
→ `intent*` 重命名,v7 `intent_chats.title`(`TEXT`),v8 git 追踪字段,v9 `intent_deps`
(`dep_type` 与 `created_at`),v10 一张审计表,**v11 在 `intents` + `intent_chats` 上
将工作区键列 `project_path` → `workspace_path` 原地重命名**(复合索引重建为
`idx_intent_workspace_status`;chat 的单列索引保留原名,其列引用
随重命名自动更新)。v11 **有意与** settings.json 中保持向后兼容的 `projectConfigs`
键**分道而行**,后者沿用旧名(参见 2026-06-14 的 workspace-path 迁移记录)。该重命名
在 schema 应用之前执行(新的复合索引引用了
重命名后的列);幂等,从不删表。与下文相同的「按列是否存在来判断」模式。
v12–v18 依次为 `short_en_title`、spec 质量闸/会话字段、`pr_url`、`last_work_session_id`
改名、`intent_logs` 审计表、spec 审核事实字段、`spec_status`(完整迁移历史见
`database/tables.md`)。**v18→v19** 新增可空的 `intents.spec_mode`(三态)与
`intent_fast_turns` 结算表;存量 `spec_mode` 不回填,继续按工作区 `sddEnabled` 派生
(详见迁移记录 `migrate/2026/08/06/030`)。**v19→v20** 把 PR 事实提升为关系表
`intent_prs` 并从冻结的旧三列一次性回填;回填与其标记写在同一事务内,以跨域标记表
`schema_migrations` 判定幂等——列存在性检查回答不了「表已建、回填做完没有」
(裁决见 [ADR-0035](../../../architecture/adr/0035-intent-pr-table-split-and-migration-markers.md);
详见迁移记录 `migrate/2026/08/06/031`)。

**Schema 版本与迁移(v1 → v2)。** 新建时的 schema
已声明 `intents.module`。对于已存在的 db(v1,无 `module` 列),open 路径
会在应用 schema 之后、写入 schema 版本之前运行一个**幂等的列迁移**:检查表结构信息,
仅在该列缺失时才添加 `module` 列(`TEXT NOT NULL DEFAULT ''`)。这依据的是实际的列是否存在
(而非精确的版本历史),因此在新库和旧库上都是安全的,且可跨次运行幂等执行;
添加一列是轻量的仅元数据操作,历史行取 `''`
默认值(不做回填)。两种内置 SQLite 驱动都通过共享适配器支持表结构信息检查与
加列操作(RM-R14)。

## Store

- **路径归一化(RM-R10):** 每个 `workspacePath` 参数在读写前都会被解析为绝对路径,
  以匹配工作区键 / 运行时工作目录 / 智能体工作目录。
  否则查询会落空,隐藏过滤也会失效。
- Intents:list(带 `dependsOn` 聚合)、insert(事务性批量、uuid、状态 `todo`;
  将 `module` 持久化为 `it.module ?? ''`,`automate` 默认为 `0`)、upsert
  (`save_intents` 的写入路径——按每项 `id` 插入或原地更新,RM-R20;详见下文)、
  update-status、set-last-dev-session、set-automate、update-intent、get-intent。
  内部行水合携带 `module` + `automate`(映射为布尔值),因此每条读路径都会返回
  它们;普通 update 不会修补 `module`(而是由 upsert 直接写入 `module`)。
- **Upsert 写入路径(RM-R20)。** upsert 是 `save_intents` 的后端实现(取代
  了旧的直接 insert 调用)。它会预先为每一项解析出一个稳定 id——更新用传入的
  `id`,插入用新生成的 uuid——这样无论被引用的同批成员是新增还是被更新,
  `dependsOnIndexes`(RM-R17)都能针对完整批次解析。**所有校验都在
  事务开启前完成**(原子性拒绝,不写入任何半成品):每个更新 `id` 都会被取出,
  并校验其属于解析出的工作区(未知 / 跨项目 ⇒ 拒绝),同时检查其当前
  状态——`in_progress`/`done` 因不可变而拒绝,`cancelled` 被标记为待重新激活。
  在同一个事务内,更新会写入 `title`/`content`/`priority`,仅当提供了 `module` 时才写入
  (否则保留原值),对被重新激活的 `cancelled` 将状态置为 `todo`(否则不变)并
  清空 `completed_at`,并且仅当提供了 `dependsOn`/`dependsOnIndexes` 时才重写依赖边;
  插入的行为与普通插入完全一致(状态 `todo`,创建时间按索引偏移)。
  `save_intents` 的 handler 会把任何拒绝转换为一个错误结果,让智能体知道没有任何写入发生。
  - **单意图会话回链(`intentSessionId`)。** 当且仅当批次中**恰好一项**携带了
    `intentSessionId` 时,upsert 才会把它写入该行的
    `intent_session_id`(insert 和原地更新两条子路径都适用;更新使用
    `COALESCE(?, intent_session_id)`,因此缺省值会保留任何既有链接)。批次中若有超过一项,
    则不论传入什么都强制将该列置空——批次没有单一来源会话的概念。这是一道**双重防护**:
    schema 描述告诉智能体「仅限单项」,而 store 独立地强制执行这一约束。`insertIntents`
    (仅供自动化使用的 `save_intent_directly` 路径)从不读取该字段——草稿没有沟通会话语义。
    这个显式字段写入,弥补了下文 refine 的 `run:bound` 回填无法触达的空缺:
    一个沟通会话**创建全新**意图时,没有 pending→intent 链接可回填,所以
    这个一次性字段就是该新意图链回其源头对话的方式。
- **只读智能体查询(RM-R19):** find 操作是智能体 `find_intents` 工具的后端——
  各过滤条件以 `AND` 组合,均为可选:`keyword`
  是对 `title` 或 `content` 的子串匹配(关键词中的通配字符会被转义,以免字面量
  `%` 被当作通配符),`module`/`status` 为精确匹配;
  与 list 相同的 resolve + 工作区限定作用域,以及 `priority ASC, updated_at DESC`
  排序;db 不可用时返回空。`view_intent` 工具复用了仅按 id 的
  get,并由**工具 handler** 守卫该意图归属于绑定的项目,
  因此另一个项目的 id 读到的是「未找到」(不会跨项目泄漏)。
- **批内依赖(RM-R17)。** insert 会预先铸造**所有**行 id,
  这样一个批次可以在任何行拥有 id 之前引用自己的同批成员。随后一个纯函数式的
  批内依赖解析器逐项校验
  `dependsOnIndexes`(每个都必须是范围内、非自身的索引),运行三色环检测
  来拒绝任何批内环,并返回合并且去重后的
  依赖 id 列表(既有 id 的 `dependsOn` ∪ 解析为同批成员 id 的索引)。它运行在
  事务开启**之前**,因此一个非法批次会被拒绝且不会写入任何内容;
  `save_intents` 的 handler 会把该拒绝转换为一个错误结果。由于其是纯函数(输入 items + ids,
  输出 id 列表),可以在没有 db 的情况下做单元测试。每一行都会被打上按索引偏移的创建时间戳,
  这样同优先级、无依赖的项在编排器「最早优先」的平局裁决(RM-A3)中能保持
  确定性的提交顺序名次,而不是单一共享时间戳产生的任意顺序。
- 沟通会话(集合表):获取当前会话
  (`is_current=1`——默认打开指针);设置当前会话(先清除该项目的 `is_current`,
  再把新行 upsert 为 `is_current=1`,同时纳入隐藏集);
  列出全部行(按 `updated_at` 降序);
  重命名(更新 `title` 并推进 `updated_at`);
  删除(物理删除该行;若被删除的行原是
  `is_current`,则按 `updated_at` 把剩余最新的一行提升为 `is_current=1`);
  隐藏集查询;
  重绑定(在首次绑定时把 pending 行改写为真实 id,
  保留 `is_current` 与隐藏集归属)。

## 运行变体

- 运行时新增一个运行 `kind`(默认 `session`;此前是二值的 `normal | intent`,
  `normal → session` ——见术语表 / ADR-0018);`user_prompt`
  根据运行时的 kind 分派到运行循环的标准变体或意图变体。
- 从 `user_prompt` 中抽取出一个共享启动器。**边界:**
  它只触碰模块级的 emit / 状态广播 / 注册表;与连接相关的
  回复作为可选回调留给调用方——因此
  `start_development`(无连接的后台运行)与 `refine_intent`(带种子首条提示词)复用
  同一个启动器。
- 运行循环新增可选的追加系统提示词、禁用工具、MCP 服务器,以及一个
  网关选择器(`standard` | `intent`),不破坏既有调用方。沟通智能体的
  MCP 服务器是在 `user_prompt` 分支中**服务端**构造的(闭包捕获
  已解析的工作区),使运行循环不依赖 store。

## 只读沟通会话(ADR 0007)

- **强制 `default` 模式(RM-R3,辅助性)。** 沟通运行时以
  `default` 权限模式启动,且**不**继承系统默认模式;`set_mode` 对
  intent kind 无效,视图也不渲染模式选择器。这如今是一道*辅助性*
  约束:它**并不**独立承担静默保存的防御职责。厂商的允许规则可以
  预先批准 `save_intents` 并跳过权限网关(即便处于 `default` 模式下),因此保存
  保存的人工授权是对话中的文字确认(见下文「对话确认即保存」)。
- **双重锁定的只读性(RM-R2)。** 硬禁用工具列表拦截
  Write / Edit / MultiEdit / NotebookEdit / Bash / BashOutput / KillShell / Task / SlashCommand。
  Task 与 SlashCommand 是必须拦截的:被派生的子智能体的工具调用会绕过父级
  权限网关,而斜杠命令可能触发写入类技能。在此之上,
  intent 网关**默认拒绝**,由一个纯函数、可导出的工具分类器路由
  → `allow` | `ask` | `deny`(已做单元测试,因为实际闭包否则
  只能靠端到端测试覆盖):读类工具
  (Read / Grep / Glob / LS / NotebookRead / WebFetch / WebSearch / TaskCreate / TaskList / TaskUpdate / TaskGet)**以及**
  两个只读的 c3 查询工具(`find_intents` / `view_intent`,RM-R19)→ `allow`(自动允许,
  不弹窗——它们只读取智能体自己项目的账本);`save_intents` → `allow`**一路放行到
  其 handler**(用户已在对话中确认——见「对话确认即保存」;网关再弹窗就是重复确认);
  `AskUserQuestion` → `ask`。`AskUserQuestion` 是一个**交互性
  (仅用于澄清)工具,而非写入工具**——它没有文件/执行副作用,所以只读
  智能体可以使用它。因此它被**排除在硬禁用列表之外**,并**被允许,但经由
  用户答案注入路由**——发送一个 `permission_request`,等待用户决定,允许时返回
  答案(SDK 仅在答案被预填时才会回显它们),
  取消时拒绝。它在**无共识**下运行(单一智能体,无投票方)。一道防护会
  过滤空/无效问题,这些问题会落入默认的
  拒绝分支。其余所有情况一律拒绝(即使 SDK 新增写入工具也有双重保险)。
  SDK 层面的硬禁用列表
  (Write / Edit / MultiEdit / NotebookEdit / Bash / BashOutput / KillShell / Task / SlashCommand)不变,且
  **不包含 `AskUserQuestion`**。
- **Codex 驱动的权限形态。** 当默认/绑定的沟通智能体是 Codex 时,
  驱动路径仍运行 intent profile 并注入本地 HTTP MCP 服务器,但使用
  Codex 的 `plan + never-ask` 网格(映射为 `read-only + never`)而非 `plan + always-ask`。
  Codex 没有实时批准通道,因此 `always-ask` 可能阻塞 MCP 的使用;文件系统仍保持
  只读,而 `save_intents` 的人工授权与 claude 一致,来自对话中的文字确认。
- **Codex 意图会话关闭 code execution 与 web search。** 意图 profile 的 codex 运行显式下发
  `features.js_repl=false`、`tools.web_search=false` 与旧式 `web_search="disabled"`,使
  `mcp__c3` 工具一律走标准 MCP tool-call 路径,而不是被包进 code_mode 沙箱的一次代码执行里
  (沙箱有执行时限,承载不了工具往返)。识别的依据是某个 MCP server 的 `enabledTools` 含
  `save_intents`(意图 profile 独有),因此只读的 spec / work profile 不受影响。意图智能体的
  职责是对话澄清 + 读本项目材料 + 查台账,不检索外部网页,关闭 web search 没有能力损失;
  未知配置键在旧版 codex 上被静默忽略,故新旧两种写法可同时下发。
- **独立的 viewer 编排。** `open_intent_chat` / `new_intent_chat` /
  `refine_intent` 自行管理
  viewer 切换(移除旧 viewer → 设置被查看的会话 → 添加新 viewer),并且
  **不**复用 `select_session` 的内部逻辑(后者会无条件设置活动会话)。
  沟通会话的 session-id 绑定会重绑定真实 id,但**从不**写入持久化的
  活动会话提示——隐藏会话绝不能污染它。
- **打开/恢复(`open_intent_chat`):** db 不可用 → `error`。接受一个可选的
  `sessionId`——若提供,校验该会话存在于本项目并打开它(同时
  将其标记为 `isCurrent`,这样后续无 sessionId 的打开会回到这里);若缺省,则使用
  当前(`is_current=1`)会话,若不存在则创建一个新的 `pending:` 会话。
  然后切换 viewer,回复 `session_selected`(历史记录),并**立即**回复一个 `intents`
  列表(运行状态的 reconcile 之后在后台运行——见 Reconcile)。这个分支同样是
  首次进入、WS 重连、以及整页刷新时重新加载项目当前沟通会话的
  路径(RM-R4)。
- **新会话(`new_intent_chat`):** 未知工作区 / db 不可用 → `error`;否则
  无条件启动一个全新的 `pending:` intent 运行时(`default` 模式)并将其设为当前
  会话——这会先清除该项目此前的当前行,再把新行标记为当前。
  切换 viewer,回复 `session_selected`(空历史)与一个 `intents` 列表。不会
  注入首条提示词(与 refine 不同):对话框以空白状态打开,开始新一轮沟通。
  由于新会话现在是当前会话,之后的 `open_intent_chat`(刷新/重连)会
  恢复**这个**会话,而非被放弃的那个。由标题栏的「+」触发(RM-R4)。
- **精炼(`refine_intent`):** 切出旧的沟通视图,启动一个新的
  `pending:` intent 运行时(`default` 模式),将其设为当前,回复 `session_selected`
  (空),随后启动器注入一条等同于用户消息的首条 `user_prompt`(RM-R7)。种子
  提示词携带**原意图 id 及其当前状态**,并指示智能体在
  定稿时以该 id 调用 `save_intents`,以原地更新原条目(upsert,RM-R20)
  ——而非产生重复项——若该意图已是
  `in_progress`/`done`,则告知用户无法修改。(「开始完善已存在意图 <id>(当前状态:…) …, 定稿后调用 save_intents 并回填
  id 以原地更新原意图」)Refine 还会在启动前注册一条 **pending→intent 链接**,以便
  常驻的 `run:bound` 订阅在首次绑定时,用真实的沟通会话 id 回填源意图的
  `intentSessionId`——与回填 `specSessionId` 的 spec-session 链接机制相同——
  使该 refine 对话之后可以从意图详情的
  「intent session」标签页重新打开(用该 id 调用 `open_intent_chat`)。一个绑定前出错的边界情况
  由 `run:settled`(kind=intent)安全网清理。
- **来自讨论(`discussion_to_intent`):** 与**增加意图**共用创建原语和绑定序列,而非一个
  游离的种子会话;差别只在载荷 —— 它落的是空白正文、无显式基准选择。
  服务端加载该讨论,除非其为 `completed` 且 `conclusion` 非空,
  否则拒绝(拒绝发生在建意图**之前**,不留任何空意图);从讨论的工作区解析出项目
  后:① 用与 `create_intent` 同一个 `createEmptyIntent` 落一条空白 `draft` 意图
  (标题 `new intent`、`P2`、空正文,写 `intent_created` 生命周期日志),并以
  `create_intent_result` 回给发起连接;② 以**该意图为 owner** 走与
  `start_intent_session` 同一段绑定序列(`pending:` intent-runtime → 绑定 intent
  agent → 持久化会话 → 带 `ownerId` 的会话投影 → `setIntentSessionId` →
  注册 pending→intent 链接 → `session_selected` → 刷新 intents → 启动首轮)。
  首轮提示词由**共享构造器** `buildIntentSessionFirstPrompt` 产出:意图
  id/状态/标题/内容前言 + 用户输入块(此处为讨论标题 + 结论)+ 原地更新护栏
  (`save_intents` 批次必须恰好一项携带该 id,拆分出的其他项不得复用)——
  与 `start_intent_session` 共用同一处措辞,不会分叉。会话标题仍用讨论标题
  (仅显示用)。启动失败按同一段 unwind 回收会话但**保留意图**。由讨论视图的
  **转为 Intent** 按钮触发(RM-R7),转换后控制台落在该意图的意图会话标签页。
- **重置意图会话(`reset_intent_session`):** 用于意图变更后、
  refine 对话上下文腐化时的逃生舱(RM-R24)。意图详情头部的「我要修改」打开
  受控输入对话框;intent-session 标签页本身没有重置按钮。与
  **Refine** 机制完全相同,但种子提示词会把用户的**新引导输入**前置于意图
  当前的标题 + 内容之前,然后指示智能体原地 upsert 原 id
  (「继续完善已存在意图 <id>… 我的新输入:… 当前意图内容:…」)。它注册相同的 pending→intent 链接,因此
  常驻的 `run:bound` 订阅会在首次绑定时**替换**意图的 `intentSessionId` 为新的
  沟通会话 id。之前的会话仍可在 Works(运行中心)下查询,但
  不再是该意图的关联会话;不做批量重置。
- **重置 spec 会话(`reset_spec_session`):** spec 文档标签页的「我要修改」操作,镜像
  **编写 spec**,但复用**既有的** spec 目录/路径(不做脚手架搭建)。spec-session
  标签页本身没有重置按钮。当从未写过 spec 时被拒绝(`error`
  `intent.specNotWritten`)。Claude 与 Codex 都可以运行该会话,
  但二者使用不同的硬边界:Claude 保持 cwd 位于项目,并用 spec
  权限网关把写入限制在 spec 目录内;Codex 将 cwd 移到集中式 specs
  根目录,强制 `workspace-write` + `approval_policy=never`,并把 specs 根目录作为
  `--add-dir` 传入,从而使项目、账本 DB 及其他非 specs-root 路径都留在可写根目录之外。
  服务端启动一个新的、写入受限的 `'spec'` 会话,种子为用户的**新输入** +
  一个指向当前 `spec_path` 的指针(仅路径——智能体自己读取 spec 文件;
  提示词不再内联 spec 正文),回复 `session_selected`(以便详情页的「spec
  session」标签页切换过去),并注册 pending→intent 链接,使 `run:bound` 在首次绑定时
  替换意图的 `specSessionId`。绑定路径还会把统一的
  `session_metadata` 投影 upsert 为 `session_kind='spec'`、`owner_kind='intent'`
  加该意图 id,并在意图被重置到新的 spec 会话时清除前一个 spec 会话的 owner。投影写入
  失败只会使该行在 Sessions 页面隐藏,不会阻塞
  spec 的启动。服务端不再预读 spec 文件,因此其
  可读性不是启动的前置条件;缺失/不可读的 spec 会成为智能体读取该路径时
  面对的一个普通文件错误。

## 沟通系统提示词

以追加系统提示词的形式注入 `claude_code` preset,按运行时构建,携带展示
语言。**提示词骨架为英文**;只有结尾的
「用此语言回复」指令跟随**展示语言**——
在运行开始时读取,使分析师用用户控制台的语言交流,
而非写死某一种语言。简述:你是一名意图分析师;只读取
项目资料,绝不编辑/写入/运行变更命令/派生子智能体/运行斜杠命令;
你可以通过 `find_intents` / `view_intent` 只读查询**本**项目既有的账本,
并应在拆分新条目或设置 `dependsOn` **之前**这样做(复用相关条目,避免
重复,引用正确的既有 id——RM-R19);
与用户交流,把需求拆分为离散、可验证、大小适中的条目(每项都带
title/content/priority P0–P3/可选依赖/**推断出的 module 名**);先与用户
把本轮全部条目的完整内容列出并等待用户明确的文字确认(异议后修改需重新列全再确认);
确认后立即调用 `save_intents`,调用即落库;绝不假装保存已发生。依赖指引是
明确的:对已存在的意图用 `dependsOn`(按 id),对
**同一批次内的同批成员**用 `dependsOnIndexes`(按从 0 开始的数组索引),并且当条目间
存在先后关系时**必须**声明该批次的顺序——把前置条件放在数组更靠前的位置,
并让依赖项的 `dependsOnIndexes` 指向它——以便编排器正确排序
(RM-R17)。提示词要求智能体从标题/内容中推断
每一项的**module 名**(如 auth、session、intent-management),
不确定时留空,并把 `module` 随每一项传给 `save_intents`。这是方案
**a**(从标题/内容推断);未来的扩展可能改为根据项目实际的模块
结构做更精确的分类(RM-R14)。

提示词还携带一条**refine-upsert 规则(RM-R20):** 当精炼一个已经
存在的意图时(种子提示词把其 id 交给智能体),智能体**必须**在
`save_intents` 上设置该项的 `id`,以便原地更新原条目——绝不能省略而产生重复项;
`cancelled` 的原条目会被重新激活为 `todo`,而 `in_progress`/`done` 的原条目不可变
(智能体应告知用户无法修改,而非尝试保存)。一个批次可以混合
更新(带 id)与全新条目(不带 id)。

提示词会**注入本次运行的会话 id**,使智能体能把单个已保存意图回链到
该对话:当一轮恰好保存**一个**意图时,智能体把注入的 id 复制到
该项的 `intentSessionId`(提示词禁止在多条目批次上这样做——批次没有单一
源会话)。在提示词构建时注入的 id 是一个 `pending:` id(SDK 尚未绑定),
因此**保存 handler 会将其归一化**为绑定后的沟通会话 id 再持久化——与
`open_intent_chat` 解析所依据的以及 refine 的 `run:bound` 回填所写入的是同一个 id,
使两条链接来源落在同一 id 空间。模型只决定**是否**设置该字段;
**值**由服务端权威决定。

提示词还携带一条**拆分规则(一个目标从不拆开)**:当一个目标
同时涉及**代码、其测试、及/或其配套文档**(spec / README / 注释)时,分析师
把测试与文档同步的工作并入**同一个**意图的内容与验收要点中,
而不是另外生成一个单独的「更新测试」/「文档更新」条目——代码、其测试与其文档是同一次
变更,保留在同一张票据上,避免其中一半被单独排期或遗漏,从而导致测试/文档
与代码不同步(RM-R15)。

## `c3` MCP 工具

c3 自己的 MCP 服务器名为 `c3`,携带 `save_intents`、`find_intents` 与
`view_intent`,对**三个厂商**都经由**同一条回环 streamable-HTTP MCP 路由**暴露
(三个厂商都消费它;Claude 边界把中立的远程 MCP 描述符转译成 Claude SDK 的
HTTP MCP 配置 `{ type: 'http', url, alwaysLoad: true }`)。每个工具都被标记为
**常驻于第一轮提示词**(HTTP MCP 配置的 `alwaysLoad: true`),而不是
延迟在 harness 的工具搜索之后——因此 `save_intents` 无需智能体在保存前
先搜索其 schema 就可用(turn-1 即驻留,无需 ToolSearch 往返)。作用范围仅限于意图
智能体——该服务器只在 intent kind / intent 网关启动路径上构建(ADR 0007)。
每个意图元素
都包含一个可选的 `id`(用于原地更新的既有意图 id
——upsert,RM-R20;省略则表示插入)与一个可选的 `module`
(推断出的模块名,可留空);两者都会流经 upsert
(RM-R14/RM-R20)。它还携带 `dependsOn`(既有意图的 id)与
`dependsOnIndexes`(同一批次内从 0 开始的索引,
用于填写条目间存在先后关系时的批内依赖);两者都会流经
upsert,由其针对完整批次解析索引(RM-R17)。该工具顶层的
描述告诉智能体:用 `id` 做原地精炼,用 `dependsOnIndexes` 表达批内
顺序,以便编排器正确排序。handler 先校验当前意图批次约束(会话归属某条意图时,批次必须
恰好包含它一次)、归一化单条意图的会话回链,再通过 store 的 upsert 写入(按每项 id 插入
或原地更新),并广播一次 `intents` 刷新,返回一段说明插入/更新拆分情况的文本结果
(或在 db 不可用/失败时——包括不可变状态或未知/跨项目的更新 id 会拒绝整个批次——返回一段
错误文本,让智能体知道自己没有保存成功)。handler 的绑定——项目路径、**实时**的 run-id
getter、以及 abort signal——是按每次运行提供的(run-id getter 与 signal 在查询时构造,
若存在的话;项目路径闭包捕获自运行时已解析的工作区),因此该工具绝不会跨项目,并把会话
回链解析到绑定的会话。

**对话确认即保存。** 沟通智能体在每次保存前都把本轮全部意图的完整内容(标题、正文、
优先级、模块、依赖)列在对话里等待用户明确确认;用户提出异议后必须重新列全并再次等待
确认。这条文字确认就是保存的唯一人工授权,因此 handler 收到调用即持久化:不发
`permission_request`、不等待权限决定、不登记等待人工介入事件,浏览器端不出现任何确认
弹框。代价是服务端不再有独立于模型行为的第二道拦截——「未确认不得调用」由提示词约束,
由单测与端到端观察验证。落库归因没有审批人,`intent_logs.actor` 落为 `system`。

这三个工具的形状、描述与核心逻辑都存在于同一份源代码中,被三个厂商共用同一条
回环 HTTP MCP 路由(见下文),因此三者绝不会产生分歧。

**只读查询工具(RM-R19)。** 同一个服务器还携带 `find_intents`
(`{ keyword?, module?, status? }`,均为可选;`status` 被约束为五个
状态值之一)→ store 的 find → 一份**精简**的 JSON 列表
(`id`/`title`/`module`/`priority`/`status`/`dependsOn`;`content` 被特意省略以保持
列表紧凑)或一条「未找到」消息;以及 `view_intent`(`{ id }`)→ store 的 get →
单个意图的**完整** JSON,并守卫该意图归属于绑定的项目,使
未知/其他项目的 id 返回一条友好的「未找到」文本(而非错误)。两者都闭包捕获同一个
工作区(无跨项目读取),保持常驻,并被网关自动允许。智能体
被提示在拆分条目或设置 `dependsOn` 之前先查询账本。

## 跨厂商的意图工具:通过 localhost HTTP MCP(2026-06-12-005)

上文的 `c3` 服务器就是这一条**本地 streamable-HTTP MCP 路由**:同样的三个工具被
暴露在这条路由上(挂载在 c3 自己的服务器上,位于 SPA 兜底路由之前,与 codex relay
类似),**三个厂商都消费它**——这样意图面板与厂商无关。Claude 边界把中立的远程 MCP
描述符转译成 Claude SDK 的 HTTP MCP 配置(`{ type: 'http', url, alwaysLoad: true }`);
codex driver 转译成其原生的 streamable-HTTP 服务器条目;cursor 边界把描述符作为 `mcpServers` 选项直接传给 `Agent.create`。

- **按运行绑定 + 隔离。** intent profile 通过中立的 `bindMcp` 绑定一个按运行区分的
  MCP 服务器(对三个厂商一致):一个不透明 token 映射到一个私有 MCP 服务器,其工具
  handler 闭包捕获该次运行的项目。token 随 URL query 传递;项目绑定存在于闭包中,
  因此智能体既不能读也不能写另一个项目的账本。该绑定在运行结束时(`finally`)被驱逐。
- **仅限回环。** intent MCP 路由自身只监听本地回环:一道纵深防御守卫拒绝非回环对端(403);
  未知/过期的 token 返回 404(默认拒绝原则)。三个厂商的子进程环境都以回环 `NO_PROXY`
  旁路收尾,否则宿主代理会吞掉这一跳并让三个工具静默缺席(见
  [agent-session design § 远程 MCP](../agent-session/agent-session-design.md))。
- **保存路径(三个厂商共享)。** 三个厂商通过这条回环 HTTP MCP 路由调用同一个保存
  handler,确认语义不因厂商而分叉:用户在对话中确认后调用即落库。
  `find_intents`/`view_intent` 同样自动允许(只读)。
- **厂商转译。** 中立的远程 MCP 描述符(type、url、可选的 bearer-token 环境变量)
  被 Claude 边界转译为 Claude SDK 的 HTTP MCP 配置,被 codex 驱动转译为其写入的
  streamable-HTTP MCP 形式,cursor 边界把描述符作为 `Agent.create` 的 `mcpServers` 选项直接传入;三者指向同一条回环路由。

## 启动开发(`start_development`)

1. 解析项目,并在创建 worktree 或启动之前,同步地在该特性私有的内存
   启动集合中占用该意图 id。若已被占用,回复
   一个「开发启动进行中」错误并停止。一旦 pending dev 链接在绑定时被消费,
   即释放该占用;在每一条启动前/启动失败路径(包括 worktree 创建失败
   和启动被拒绝)上也会释放。
2. 校验该意图存在且为 `todo`,或为 `in_progress` 但 `lastWorkSessionId`
   悬空(已删除)(允许重新启动;其他状态 → `error`)(RM-R8)。
3. 未满足依赖检查:任何 `dependsOn` 未 `done` → 仍然允许,但前端
   会在手动路径发送前二次确认(RM-R11)。
4. **启动前拉取最新代码**(2026-06-20),使工作会话构建在最新代码之上:
   - `worktree` 模式:从远程 `git fetch` 基础分支,并把 worktree 的根设为
     `<remote>/<base>`(通过 `git worktree add --no-track`),在没有远程/拉取失败
     时回退到本地基础分支。同步执行——保持自动化控制器的
     微任务时序约定。fetch 从不做 merge,因此该分支从不阻塞。
   - `current-branch` 模式:在项目检出上执行 `git pull --ff-only`。无远程/无上游/
     离线 ⇒ 尽力而为地跳过;**发生分叉**的分支(非快进)⇒ 硬性停止并返回一个
     拉取失败的错误(手动路径:发送错误 + 释放占用;自动化:呈现为一个
     自动化失败)。从不自动合并/自动变基。
5. 通过共享的开发提示词构建器启动一个**后台普通运行时**(`pending:`)。
   可见的提示词为 `title + content + 依赖摘要`,若启用了 SDD 且存在 spec 路径,
   再加上已批准的 spec 路径提示。内部提示词通道与
   可见回显是分离的:若配置了 `devSkill`,由其主导模型用户轮;而当未配置
   `devSkill` 时,SDD 的工作会话提示词使用系统指令通道。手动启动与
   自动化使用相同的提示词构建方式,且不改变分支/worktree/会话流程。
   在会话绑定时,设置 last-dev-session + 状态 `in_progress` + 广播 `intents` + 广播
   状态。
6. 该运行是后台化的,断开连接也能存活;工作会话是一个**普通**
   会话,会出现在侧边栏中;`lastWorkSessionId` 驱动回链。

## 自动化编排器

一个按项目、内存中的状态机,完全由消息 handler 与一个内部 viewer 驱动
——无轮询,无 cron。每个项目一个控制器,存活在一个模块级 map 中;其自动化状态
是唯一真相来源,在每次变化时广播。

- **接线分支。** `set_intent_automate` → 设置 automate 标志 + 广播
  `intents`(`set_intent_spec_mode` 同形:写 `spec_mode` + 广播,
  广播时重算 `effectiveSpecMode`)。`start_automation` → 启动编排器(若已在运行则为
  no-op),然后广播状态。`stop_automation` → 停止编排器(中止正在进行的
  运行)。进入意图视图(`open_intent_chat`)也会推送当前的
  `automation_status`,以便一个新连接恢复按钮状态。
- **依赖注入。** 编排器直接 import store/judge/git,但通过注入式钩子
  获取服务端接线:一个开发轮运行器(绑定到 WS-server 闭包)、
  一个 intents 广播器、一个状态 emitter、一个会话是否存在的磁盘检查(与手动启动
  使用的是同一个——被注入,以便 resume/dangling 分支
  能用假实现做单元测试),以及一个是否正在运行的即时检查(被注入,以便
  attach 分支——RM-A10——能用假实现做单元测试)。这使得该状态机可单元测试。
- **开发轮运行器(服务端闭包)。** 为该意图确保一个普通运行时(全新的
  `pending:` id,或为续跑复用一个既有 id),在其上注册一个**内部
  viewer**,并通过共享启动器启动/恢复。它通过一个回调**尽早**呈现 SDK
  会话绑定(远早于该轮结束时触发)。viewer 捕获最后一条
  assistant 消息,并在以下情形结束该轮:`turn_end`
  → `complete`/`error`;控制器的 abort → blocked(aborted)。`permission_request`
  **不会**结束该轮——自动化**镜像手动路径**(RM-A9):运行保持存活,等待
  正在观看的人在浏览器中作答,viewer 只翻转「等待权限」标志(在
  作答的 tool-result 上,或在 `turn_end` 时清除),使控制器能在状态上
  翻转 `awaitingPermission`(「等待授权」提示)。一个存活的 team lead(对开发技能而言罕见)
  由推送喂给,而非重新启动。
  - **Attach 模式(RM-A10)。** 当控制器传入 attach 模式时,闭包
    只注册 viewer——它**从不**启动或推送。它从运行时**缓冲区**的最后一条
    assistant 消息中获取种子文本(进行中那一轮的最新消息可能在 viewer
    附加之前就已发出,否则判定器会读到空)。若运行已在控制器的
    is-running 检查与 viewer 注册之间的竞态中结束,它会立即从缓冲区
    尾部的 `turn_end`(`complete`/`error`)解析,而不是挂起。在
    这条回放路径上,它还会从缓冲区计算 pending-question 标志,使一个
    以未作答的 `AskUserQuestion` 结束的已结束轮被标记给人工决策防护
    (RM-A11)使用——否则它会被读作普通的 `complete`,冒着盲目续跑的风险。
- **并发闸门(RM-A12)。** 在挑选下一个意图**之前**,闸门扫描**所有** `in_progress` 意图
  (无论 `automate` 标志如何),查找**真正在运行**的工作会话(`lastWorkSessionId` 非空且该运行存活)。
  它要挡的是并发工作会话在同一份检出上因文件修改产生的冲突,因此作用范围随 Git 分支模式:
  - `current-branch`:所有意图共用一份检出,发现任一运行中会话即本轮不再挑选新意图 ——
    对该进行中的一轮附加一个内部 viewer(attach 模式)并等待其结束,记录结果但**从不**评判或
    干预该意图的生命周期(手动意图不在编排器的职责范围内);该轮结束后重新检查闸门,闸门清空才继续挑选。
  - `worktree`:每条意图在各自的目录里开发,运行中的会话只代表它自己 —— 照常附加观察,
    但不阻止本轮再挑选另一个合格意图;每轮仍最多发起一个新的工作动作,并行度逐轮提升。
    并行开发总数受工作区 `automationConcurrency`(默认 2)约束:内核按意图 ID 去重统计
    本轮占用(内核 in-flight run + 队列挂接观察的活跃自动化会话 + 本轮新选中),达到上限即
    不再挑选,其余合格意图以 `blocked_concurrency_gate`「已达并发上限 N」阻塞;该上限只约束
    自动化队列自动派发的开发会话,spec 撰写/审核不计入,人工/MCP 启动不被配额拒绝,调低
    上限不取消在途会话。`current-branch` 的有效上限恒为 1,配置值不覆盖共享检出文件安全。

  悬空会话(存在于磁盘上但未运行)两种模式下都立即通过。这与每意图的 attach 逻辑(RM-A10)
  相互独立,后者处理**被选中**意图自身的运行会话。同一条规则也由共享的 `launchWorkSession`
  (RM-A21)在发起或恢复任何新 turn 之前求值,被挡时返回 `intent.concurrencyGate`。
  两处不是两套门禁——循环这一份决定「本轮选不选」,启动器那一份决定「这次启动准不准」,
  规则与事实来源相同。

  **队列位次(RM-A19)。** 被闸门挡住时,「在等」和「卡死」在页面上长得一样,因此对账在收尾处
  给本轮的决策补一个从 1 起的位次。编号的依据就是挑选用的那份**已排好序的合格候选表**
  (先优先级再最早创建),没有第二套排序;只有**通过全部闸门却没拿到本轮工作动作**的候选进入
  编号,所以位次 1 恒等于下一个名额的归属,被其它闸门挡住、park、跳过、正在运行、以及只是在等
  规格阶段串行名额的意图都不占位(后者虽然同样报 `blocked_concurrency_gate`,但那是另一条队)。
  位次随决策一起返回,`queue-projection.ts` 只照搬本轮的值——它是这份读模型里**唯一不回落
  决策日志**的字段:陈旧的原因仍然为真,陈旧的名次不再为真。落库的决策日志也不含该列,
  下一轮从新事实重算。

  **规格阶段占用(RM-R35)。** 一个意图的规格撰写/审核会话从**发起那一刻**起就占用其
  `spec_session_id` / `spec_review_session_id`:launcher 在脚手架/建 runtime 之前就把
  `pending:` 占位 id 条件写入该字段,占用判据**不依赖 `run:bound` 写回**。队列内核通过
  `probeSpecRunFacts` 把「有效 pending 占用 + 已 bind 的活跃会话」统一投影为规格阶段运行中,
  因此 vendor 冷启动、relay 排队或凭证握手超过一个 tick(冷却 5s < tick 10s)也不会在
  冷却过后重复发起撰写/审核会话。占用可释放且 owner-safe:启动失败、未 bind 即 settle,
  或进程重启后 pending 投影行超过有界宽限期,都按「字段仍属于本次 pending id」的条件清理,
  旧 run 不释放新 run 的占用;已 bind 的真实会话 id 保留供恢复/历史定位。

  占用登记受两条不变量约束,保证它永远是一个**有界**事实而非永久锁:
  (a) **投影行先行**——ledger 里的 `pending:` 值必须有对应的 pending 投影行来计时。
  claim 先写投影行、成功后才写 ledger 字段;投影行写入失败时**不写** ledger 字段、
  不返回成功,调用方报失败,队列在后续 tick 重试,绝不留下没有时间戳的 `pending:` 占用;
  (b) **缺失行可恢复**——投影行缺失的 `pending:` 值(投影写失败遗留,或 bind 已删除
  投影行但 ledger 字段未及替换时进程重启)视为**已过期**,队列可以重新发起,而不是
  永久判为占用把意图锁死在规格阶段。

- **挑选下一个**选出最佳的合格意图
  (RM-A3:`automate` ∧ status∈{todo,in_progress} ∧ 依赖已完成;按 P0→P3 再按 `createdAt` 排序)。对
  每一个,develop 步骤先按优先级挑选其**起始**动作:(1)若 `lastWorkSessionId`
  **已在运行**,则**附加**(RM-A10)——attach 模式,起始 id =
  `lastWorkSessionId`,且 in-progress 标记在开发轮**之前**就已应用(不启动 ⇒ 无早期
  绑定,因此状态必须预先指向被跟踪的会话);否则 (2) 一个 `in_progress`
  意图,其 `lastWorkSessionId` 通过会话是否存在的检查,则**恢复**它(真实 id ⇒ 开发轮
  延续该上下文,首个提示词为 continue);否则 (3) 一个 `todo` 或悬空的意图开始一次全新
  启动——与手动启动相同的悬空规则。attach 标志只对
  **第一**轮生效;第一轮之后即被清除,因此任何续跑都走
  普通的恢复路径(已附加的那一轮已经结束了该运行)。随后 develop 步骤循环:运行一个开发轮 → **一旦工作会话绑定**
  (尽早——镜像手动启动)in-progress 标记就执行 set-last-dev-session +
  状态 `in_progress` + 广播 + emit,使 UI 立即翻转为 `in_progress`,而不是
  等到该轮结束(若早期绑定从未触发,有一个兜底会重新标记);→ 在 `complete` 时,收集
  diff-stat 并运行完成判定器;`done` → 提交(带 lint 自愈)然后标记 `done` + 把 id 推入
  已完成集合;`in_progress` → 恢复续跑(上限 10 次续跑,RM-A8);`stuck`/`error`/push 失败
  (以及一个被拆除的待处理问题,RM-A11)→ 带原因失败并停止整个循环(RM-A6)。一个存活的
  权限弹窗**不会**停止循环——它等待正在观看的人(RM-A9),
  等待权限标志会在暂停期间翻转状态提示。没有合格条目
  → 状态 `done`(RM-A7)。运行中途中止(blocked/aborted)→ 状态 `idle`。
  - **人工决策防护(RM-A11)。** 在 `done`/`in_progress`/`stuck` 分支之前,develop 步骤
    检查该轮的 pending-question 标志:当该轮以一个**未作答的 `AskUserQuestion`** 结束时,它
    立即失败——**即便判定器给出了 `in_progress`**——这样一个误判的结论
    绝不会覆盖真实的用户选择而驱动盲目续跑。该标志由一个纯函数
    检测器计算(已导出、已做单元测试):一个 `AskUserQuestion`
    的工具调用若没有匹配的 tool-result(按 tool-use id),即意味着该问题从未被作答。
    一个**存活的** AskUserQuestion 不再造成阻塞——开发轮运行器会让运行保持存活,等待观看的
    人来作答(RM-A9);该标志专门覆盖**被拆除/attach 缓冲区回放**路径,在该路径上一个
    携带待处理问题的已结束运行原本会呈现为 `complete`。
  - **自动提交的 lint 自愈(RM-A13)。** `done` 分支通过一个
    commit-with-lint-heal 助手来提交,而非裸提交。它先提交;
    成功则返回已提交。一个**不是**提交钩子失败的失败(push 被拒、无上游、无仓库……)
    会原样返回 → 硬性停止(RM-A6),**绝不**重试。一个
    提交钩子失败(一个 pre-commit lint 钩子)会通过**单次开发智能体尝试**来自愈——
    lint 工具链因项目而异,因此没有可移植的修复*命令*:它恢复**同一个**
    工作会话(相同 id,不 attach),用一条嵌入 lint 错误摘要的针对性提示词,
    让智能体去修复,然后**仅重试一次**提交(重新暂存
    所有文件)。重试成功即结束自愈;重试失败且非提交钩子问题则原样呈现;
    重试仍是 lint 失败则返回 `lint 自动修复失败(修复 agent 介入后仍未通过)…`
    → 失败(RM-A6,意图不为 `done`)。abort signal 在每次 await 前后都会被检查
    (中止时返回无错误的失败,以便调用方保持安静);智能体修复轮的权限暂停会按 RM-A9
    翻转等待标志。每个阶段都记录一条轨迹。
- **完成判定器。** 判定器构建一条英文提示词(意图 + 最后一条
  消息 + **证据**:未提交工作用 `git diff HEAD --stat`,近期提交用 `git log --oneline -5`
  ——开发技能常常自行提交,留下干净的工作树,因此空 diff **绝不能**
  被读作未完成;任一来源都算数),要求严格的 `{"verdict","reason"}` JSON。
  裁定规则按 **stuck → done → in_progress** 排序,优先级固定在提示词中:
  (1) **stuck 优先**——任何需要人工介入的信号(询问用户/`AskUserQuestion`、
  给出选项或寻求偏好/方向/范围/取舍;等待权限;因缺乏上下文而受阻;
  出错/放弃;或声称已完成但没有一致的证据);
  (2) 仅当不是 stuck 且变更证据一致时才判 **done**(仅凭智能体自己的说法
  不够);(3) **in_progress** 作为纯开发技能检查点或
  自驱动剩余步骤的**兜底**。旧的「偏向 done / continue」措辞已被**移除**——
  `in_progress` 不再是默认值。它通过无工具的 one-shot 查询运行(默认智能体
  环境/模型),记录该裁定,并容错地解析第一个
  JSON 对象;一个无法解析/超出范围的答案会被视为 `stuck`(故障安全——绝不静默地判为
  `in_progress`,RM-A4)。判定器是人工决策防线的**第一**道;
  编排器的 pending-question 防护(RM-A11)是第二道。
- **Git 助手。** Diff-stat、近期日志与 commit-and-push 通过 git CLI 在限定的
  目录范围内执行,且从不拒绝(它们返回退出码/stderr)。
  Commit-and-push 是**多仓库感知**的:
  - 若项目根目录有 `.git` 标记,则视为单一仓库——经典行为:
    暂存所有文件,**仅当有变更时**提交 `feat: <title>`,然后**始终**推送(空
    工作树意味着开发技能已经自行提交——我们仍然推送,以便那些提交到达远程)。
  - 否则它会在根目录下发现 git 仓库(递归、有界深度,
    跳过 `node_modules`/`dist` 等,在每个仓库边界处停止),并独立地为每个**受影响**的
    仓库提交。暂存按仓库限定作用域,因此变更文件按位置归属到
    其所属仓库。当一个仓库的工作树是脏的**或**它领先于上游时(覆盖开发技能自行提交的
    子仓库场景),即视为受影响;未变更的仓库不予处理。若找**不到**任何仓库,
    则为一个错误(`工作区内未找到 git 仓库,无法提交`)。
  - 任何非零的步骤都会返回一个失败(失败子仓库的相对路径会
    在消息中给出),这会成为编排器的停止原因(RM-A5/A6)。失败
    种类会分类**原因**:一个失败的 `git commit`,若其输出携带
    lint/pre-commit-hook 特征(`eslint`/`prettier`/`lint-staged`/`husky`/`pre-commit`/`✖`,
    通过一个纯函数、已做单元测试的分类器判定),则为提交钩子失败(可自愈,RM-A13);
    其他所有失败(`git add`/`status`/`push`、无仓库)都是硬性停止。多仓库运行会
    传播子仓库的失败种类,因此一个子仓库的 lint 失败仍会触发自愈
    (RM-A13)。**没有** lint 修复*命令*助手——自愈是单次开发智能体修复,因为
    lint 工具链在各项目间不可移植。

## Reconcile

一个独立(注入式)的 reconcile 函数由服务端的
`open_intent_chat` handler 调用,**在后台、在**意图
列表已经发送给客户端**之后**运行(性能考量:面板基于
缓存/派生的 `runStatus` 立即渲染,而一次 intents 刷新广播会在 reconcile 结束后
推送刷新后的列表——判断一个死会话是一次 LLM 调用,绝不能
阻塞首次绘制)。它为一个项目处理每一个 `in_progress` 意图:

1. **存活检查:** 若 `lastWorkSessionId` 非空且该运行存活,
   说明开发进程仍然活着——得出 `runStatus: 'running'`。
2. **死进程路径:** 否则,从磁盘加载该会话最后 3 条 assistant
   消息并运行完成
   判定器(由于进程已消失,**不带 git 证据**)。
3. **判定为 `done`:** 提交并推送 + 标记 `done`——得出
   `runStatus: 'idle'`(自动完成)。
4. **判定为 `in_progress` / `stuck` 或无会话:** 得出 `runStatus: 'dangling'`
   (保持 `in_progress`,但标记为已中断)。

所有有副作用的访问(运行时注册表、磁盘上的记录、AI 判定器、git、
store)都是被注入的,因此该逻辑是纯函数式的、可
单元测试的。reconcile 的自动 `done` 是针对进程死亡对 RM-R9 的一个显式的、
有文档记录的例外,覆盖手动启动与自动化启动的运行
(RM-R18)。完成后,服务端缓存每个派生出的 `runStatus`(在
后续广播中被使用),并推送一次 intents 刷新,让每个
连接都能看到刷新后的运行状态及任何自动完成。

**死会话去重(性能考量)。** 该 handler 维护一个已判定会话 map
(意图 id → 上次在死亡状态下被判定的 `lastWorkSessionId`),并过滤
reconcile 的输入:一个意图若其**当前的死会话**已被记录过,
则被跳过——在每次进入/刷新/WS 重连时都重新判定会得出相同的
裁定,却要多付出一次 LLM 调用的代价。一个存活的进程(廉价地重新推导)以及
一个全新的会话 id(与记录不同)仍会被
(重新)判定。当该意图离开 `in_progress` 时,该记录条目会被清除。

## 模型 `update` 事件触发的 PR 状态重置(RM-R29)

`features/intents/pr-update-consumer.ts` 承载一个纯函数 `handlePrUpdateEvent(payload, deps)`——
意图领域对模型发布的 `pr:operation` `update`/`success` 事件的响应。它在
`wiring/run-domain-subscriptions.ts` 中注册为一个**常驻订阅**,与运行生命周期
订阅并列,且**独立于** `scheduler-startup.ts` 中的 Automation 事件桥接。它被特意排除在
`dispatchEventTriggers` 之外:PR 状态是账本状态机的一部分,因此即便未配置任何
自动化、Automation store 不可用、或某个进行中的闸门跳过了自动化,该重置也必须触发。
Automation 分发与该 consumer 是**同一个**总线事件的两个独立副作用;二者互不阻塞
(`EventBus` 隔离了各 handler 的错误,该 consumer 还额外对自己的 store 访问做了 try/catch)。

该 handler 会在非 `operation === 'update' && result === 'success'` 或
`association.intentId` 不存在时短路返回。之后它会 `getIntent(intentId)`,校验
`intent.workspaceId === pathToId(payload.workspacePath)`(阻止跨工作区的 `intentId`),再定位
事件所指的 PR 行:携带 `data.pr.number` 即精确定位,不带则回退到该意图唯一的未合并行——有多条
时无从判断是哪一条被重提,忽略并 warn,绝不批量复位。仅当该行状态 ∈ {rejected, failed, closed}
时,调用 `upsertIntentPr(…, 'reviewing')`、`safeInsertIntentLog(id, 'pr_updated', …, 'automation')`,
以及 `broadcastIntents(workspacePath)`。`merged` 是终态,会被跳过;其他状态、无法定位的 PR、
一个缺失/未知/跨工作区的意图,或一个非 `update`/非 `success` 的事件,都是静默的空操作
(发布本身已经成功,因此不会有错误)。
一个重复的事件是幂等的:首次重置之后该状态不再可重置,因此后续
事件都是空操作——不会重复记录日志或广播。所有 store/广播能力都是被注入的,因此该
handler 用假实现做单元测试(无需实时 DB 或总线)。

## 列出 / 重命名 / 删除沟通会话

意图本体的永久删除由 `delete_intent` 编排为“读取快照 → 停止运行时并删除关联会话 → 清理本地
Git 资源 → 数据库事务 → 广播”。Git 清理只接受确定性 worktree 路径与已记录的 `intent/`
本地分支,不执行 fetch、push 或 forge 操作。外部步骤失败时主记录保留,已完成步骤可在重试时
幂等跳过；事务删除双向依赖、全部工作会话审计、生命周期日志、PR 行、交付关联边与主记录。
远端 PR **不动** —— 与本流程其余清理一致:清本地台账/Git/会话,从不代用户在 forge 上做
不可逆的事。

会话清理按每个会话的**真实供应商**分派:transcript 删除只交给会话能力账本里
`sessions.delete` 非 `none` 的供应商(当前只有 claude,由其 SDK 删除
`~/.claude/projects/` 下的 transcript);codex 自报 `none`,其
`~/.codex/sessions/` 下的 JSONL 保留在磁盘上,c3 只回收自己持有的引用。把 codex 的会话 id
交给 claude SDK 会抛出 “Session not found”,正是这类异常曾中断整轮删除。
清理的异常边界落在**每一步**上,而非每个会话:供应商解析、运行时移除、transcript 删除、沟通会话行
删除、会话投影删除各自独立,任一步失败只记录告警,既不跳过其后的步骤,也不阻断其余会话以及随后的
Git 资源与数据库记录清理。这样意图记录不会被一个清不掉的会话永久卡住;而由于意图主记录是无条件
删除的,会话自身的 c3 侧行也必须尽最大努力删除,否则会留下指向已删意图的孤儿记录。供应商解析失败时
无法判定投影行的 vendor 键,则按全部已知供应商各删一次。

三个新的 WS handler 补齐了会话集合的 CRUD:

- **`list_intent_sessions`**:读取会话列表,派生一份运行状态快照
  (拥有存活智能体运行的会话为 running,缺席则为 idle),并在同一连接上回复
  `intent_sessions`。
- **`rename_intent_session`**:重命名该会话,然后向所有连接广播
  `intent_sessions`。
- **`delete_intent_session`**:移除运行时(中止 + 丢弃内存中的
  运行时),然后删除该会话行(带 `is_current` 兜底)。
  若被删除的会话正被观看,则清除该连接被查看的会话,然后向所有连接广播
  `intent_sessions` 与 `session_status`。

三者都先检查 store 是否可用,在 db 不可用时返回 `error`。

第四、第五个只读的打开器服务于意图详情的「spec session」与「评审」标签页:

- **`open_spec_session`**:解析该意图存储的 `specSessionId`;若该 `'spec'` 运行时
  已被丢弃(进程重启/GC),则从记录重建,并把写入重新限定在
  spec 目录内(意图**绝对**的集中式 `specPath` 的父目录),重新钉住 spec
  智能体,然后回复
  `session_selected` 并注册 viewer。意图自身的沟通/refine 会话
  (`intentSessionId`)则由既有的 `open_intent_chat` 打开——两种会话是
  不同的运行时 kind。当该意图没有 `specSessionId` 时被拒绝(`error`)。
  统一的 Sessions 页面从不通过原始会话 id 打开一个 spec 行;它使用投影出的
  `owner_kind='intent'` / `owner_id` 组合导航到所属意图的「spec session」标签页,
  再用该意图 id 调用此打开器。

- **`open_spec_review_session`**:与上一个镜像,但恢复的是 `'spec_review'` 运行时,
  且**不**授予任何目录写权;它重新注入被审意图 id 与结论所绑定的内容指纹
  (尚无结论时用 spec 现内容的指纹),回复的 `session_selected` 另外显式携带
  `sessionKind='spec_review'` 与 intent owner,使详情页(无列表行可读)也能据此
  进入只读呈现并解析溯源。它是**唯一**的评审恢复入口:详情页「评审」标签页与
  Sessions 页面「规范」列表里的评审行都调用它,并且都只传意图 id ——
  行携带的会话 id 只用于选择与响应对齐,不能绕过服务端按意图的解析。
  意图不存在或该意图没有 `specReviewSessionId` 时拒绝(`error`),
  调用方不得回退到通用的 `select_session`(其冷恢复会建成可写的 `work` 运行时)。
  恢复只让过程可回放:任何人工续跑仍由 `user_prompt` 的 `sessionKind` 门禁挡下
  (RM-R36)。

## 广播

意图会话的广播遵循与讨论广播相同的模式:
它读取会话列表,附加一份从即时检查派生出的运行状态快照,
并把 `{ type: 'intent_sessions', workspacePath, items, runStates }` 扇出到
每个连接。它被接入共享的内核上下文,以便意图会话 handler
和任何后台变更都能推送刷新后的列表。

- `list_intents` / `update_intent_status` 读写 store 并回复 `intents`。
  `update_intent_status` 是 `async` 的:取消一个持有活跃 PR 的意图会逐条通过
  `closeForgePr`(`gh pr close` / `glab mr close`)关闭远程 PR/MR。任一关闭失败即发送
  `intent.prCloseFailed`(detail 标明失败编号),并在任何状态变化**之前**返回;全部成功才翻转
  状态。每关掉一条即经 `upsertIntentPr` 落 `closed` 并追加一条 `pr_closed` 生命周期日志——
  关闭是幂等的,已关掉的行不会拖累重试。没有 PR 的意图保留原有的同步路径。
- 开发回链:前端发送带 `lastWorkSessionId` 的 `select_session`;若该会话不再
  存在,既有的 `error` 路径会返回,前端会提供一个友好的
  重启/取消退出选项(RM-R13)。

## 隐藏集过滤

工作区会话列表会过滤掉该项目的隐藏集,使沟通
会话**及意图的 spec 会话**永远不会进入普通列表(RM-R4)——二者在构建列表时
被收集进同一个隐藏集,使用解析后的路径以匹配存储的
工作区路径。该过滤在分页**之前**运行,因此分页窗口与 `hasMore` 是基于
已过滤后的列表计算的。若 store 不可用,则**不**做过滤(降级,
而非破坏列表)(RM-R12)。

## 前端

- **入口按钮:** 会话侧边栏在「＋ new session」左侧新增一个 idea(💡)按钮,
  会发出一个带工作区路径的 open-intents 事件。
- **视图切换:** app 新增一个视图模式(`console` | `intents`)+ intents 项目。
  打开时发送 `open_intent_chat`(其响应携带列表);选中任何普通
  会话都会重置回 `console`。intent 视图不渲染模式选择器(RM-R3)。
- **标题栏(RM-R3):** 对话列复用会话标题栏,但隐藏模式选择器。
  console 标签页仍显示模式选择器。标题展示活动标题或「New Intent」。
- **新建意图按钮:** 「+」按钮位于意图列表头部,状态过滤器的
  右侧。它发出一个 new-intent 事件 → app 发送
  `new_intent_chat`;随之而来的 `session_selected`(空历史)会清空对话框,
  开始新的一轮。
- **重连/刷新恢复:** 每个项目当前的沟通会话被持久化在
  chat 表的 current 标志中,因此进入意图视图会自动重新加载它。在 WS 重开时,
  若视图模式为 intents,重新发送 `open_intent_chat`;视图模式与 intents 项目
  也会被镜像到本地存储中,以在强制刷新后存活。无需新的服务端消息——
  既有的恢复分支已经足够。
- **布局:** 左侧意图列表(默认完整宽度 960px,窄屏 `min(960px,68vw)`;可在标题栏
  通过折叠按钮在展开/收缩两态间切换,折叠态是组件本地 UI 状态,收缩态宽度减半至 480px 并**不渲染**
  模块标签与操作区,展开态恢复;折叠态文案/可见性由一个纯函数决定)
  (头部:标题 + 一个**自动化**按钮[▶ / ■ 停止,
  运行中高亮,出错时变红]+ 状态过滤器,下方一行状态线显示
  当前条目或停止原因;
  **列表排序(纯客户端展示排序,服务端 `priority ASC, updated_at DESC`
  不变):**「全部」视图未完成项保持服务端原序置顶、已完成(`done`)项置底;置底段与「已完成」筛选整列均
  **按完成时间倒序、再优先级排序**——一个纯比较函数:`completedAt` 降序为
  主键(缺失时回退 `createdAt`),同完成时刻按 `priority` 升序 P0→P3;其它单状态筛选原样不重排;
  每行一个 `MM/DD` 日期前缀
  ——已完成项用 `completedAt`,否则用 `createdAt`,均补零——一个可选的**模块标签**
  (胶囊标签,渲染于 date 与 title 之间;`module===''` 时不渲染,无占位不破版)
  位于标题/优先级徽标/状态之前(彩色 pill 徽标,按
  draft 灰 / todo 主色 / in_progress 橙 / done 绿 / cancelled 红映射语义色,风格同优先级徽标,
  收缩态不隐藏;标签文案来自一个纯函数)
  以及一个依赖提示;
  **展开详情(手风琴,至多一项展开):** 详情区复用安全 Markdown 渲染,
  把 `content` 全文以 Markdown 安全渲染——
  详情显式走 Markdown 管线(markdown-it `html:false` → DOMPurify 清洗 → 注入),与聊天消息
  一致的 XSS 防护与外链加固(`target=_blank rel=noopener noreferrer`,剔除 `javascript:`/`data:`);
  套用同一排版样式,聊天既有行为不回归。
  下方元信息区显示次要元信息(小字号、灰色):
  创建时间(完整格式 `YYYY-MM-DD HH:mm`)、
  完成时间(仅 `completedAt` 非空时显示,同完整格式)、
  依赖列表(无依赖时不显示;已完成依赖灰色、未完成依赖橙色并加 ⚠ 标记);
  时间与依赖格式化由纯函数完成;
  再下方仅当存在未完成依赖时显示简短警告;
  按状态提供操作:`todo` 为精炼 + 启动开发,已启动的为开发详情,
  任意状态可标记完成/取消),然后是一个**尾部的自动化切换图标**
  (渲染于操作按钮排末尾、所有操作按钮之后;`automate` → ⏳ 提示「in auto queue」,
  否则 ✋ 提示「manual trigger mode」;因属于操作区,收缩态随操作区一并隐藏);
  右侧**复用**聊天消息 + 会话状态栏 +
  消息输入框,作用于已被查看的沟通会话。自动化图标发出
  一个 set-automate 事件(切换该标志);按钮发出 start/stop-automation。
- **意图数据:** app 保存按工作区路径为键的 intents,
  由 `intents` 消息刷新;以及按工作区路径为键的自动化状态,
  由 `automation_status` 消息刷新;意图列表以 prop 形式接收当前项目的
  状态。
- **工程进度:** 意图详情头部按意图字段派生只读进度。意图、规范、工作依次展示,
  SDD 关闭时省略规范；仅 worktree 工作区在末尾展示 PR。工作是否完成只取决于
  `intent.status === 'done'`,与 PR 独立。PR 段读**聚合态**(`deriveIntentPrAggregate`,与服务端
  闸门同一份规则):无 PR 行为未开始;聚合 `merged` 为已完成,`rejected`/`failed`/`closed` 为
  已关闭/失败,其余(有行且聚合 `reviewing`)为进行中。进度条在窄屏横向滚动。
  分支模式来自工作区配置的异步回复,因此意图页的**每个**入口(常规进入与刷新后的
  视图恢复)都会为所选工作区发送一次 `load_workspace_setting`;配置到达前先按无 PR
  渲染,回复把模式更新为 `worktree` 后进度在原挂载实例上重算并追加 PR 阶段,
  不依赖重挂载或切换顶层 Tab。

## 依赖

- **SQLite** — Node 内置的 SQLite(Node)/ Bun 内置的 SQLite(Bun 单二进制);两者都
  在服务端打包中标记为 external。
- **agent-session** — intent kind 运行时以及共享启动器。
- **permission-gateway** — 意图网关放行 `save_intents` 与只读查询工具,默认拒绝其余工具。
- **session-registry** — 其列表过滤消费本领域的隐藏集。
- **git(本地 CLI)** — 编排器在验证 `done` 后的提交/推送。
- **agent-session(one-shot)** — 完成判定器运行一次无工具的 one-shot SDK 查询。
- **Claude Agent SDK** — 追加系统提示词 preset、禁用工具;c3 自己的工具现经回环 HTTP MCP 路由接入(不再走进程内 MCP)。

# 创建与首次会话

意图列表标题栏的「+」打开新增弹窗(`CreateIntentDialog`),不再直接登记空白 draft,也不提供独立的「增加意图」文字按钮或从该处新建独立意图会话。弹窗收互斥的基准来源与必填内容,提交一条 `create_intent`;服务端在同一个 handler 里落库并启动 owner 会话(规则见 spec RM-R45,基准取值见 RM-R44)。

创建结果中的服务端 ID 只负责精确 UI 落点,账本状态仍以 `intents` 快照为准。结果和快照允许任意顺序到达,工作区切换、失败或目标消失时必须丢弃落点;创建落点选中新意图后打开「意图会话」tab。创建被拒时弹窗保持打开、草稿留存,在途守卫必须释放,否则提交按钮会一直卡在禁用态。

内容为空的创建(讨论转意图、旧客户端)只登记意图、不预建空会话。此时详情的「意图会话」tab 在无绑定时提供首条输入,提交 `start_intent_session` 后由服务端为该 intent 建立唯一 owner 会话、绑定 agent 并启动 refine 运行。

三条路径(新增弹窗、`discussion_to_intent`、`start_intent_session`)共用同一个创建原语、同一段绑定序列与同一处首轮提示词构造(含批次恰好一项携带该 ID 的护栏),措辞不会分叉;运行上下文注入当前 ID、状态、标题和正文,owner 会话保存时必须在同一批次恰好一次更新当前 ID,其余拆分项新建且不继承来源会话。

draft 可沿用正文编辑与取消状态迁移。物理删除仅允许无会话、spec、工作、git 或 PR 资产的 draft,并在同一事务删除依赖边和日志。
