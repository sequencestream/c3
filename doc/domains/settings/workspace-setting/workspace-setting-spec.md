# workspace-setting 工作区设置

`workspace-setting` 域承载 `WorkspaceSetting`(见 [`shared/src/protocol/workspace.ts`](../../../../shared/src/protocol/workspace.ts))——**按工作区**独立的配置旋钮,以唯一 workspace name 作为持久化与协议关联键。缺失或部分条目回退规范化默认值(`normalizeWorkspaceSetting`)。协议消息 `load_workspace_setting` / `save_workspace_setting` / `workspace_setting`。

配置持久化与组级共享上下文见 [settings 组概览](../settings-overview.md)。

## 默认权限模式 `defaultMode`

按 vendor 分组的默认权限模式映射(vendor id → 模式),规范化后三个键齐全:

- `claude`:值为 `ModeToken`,须落在 Claude 目录(`default` / `auto` / `plan` / `acceptEdits` / `bypassPermissions` 等目录声明项),缺省 `default`。
- `codex`:值为 `CodexPolicy`(双策略对象)或 `ModeToken`(字符串旧格式)。字符串须落在 Codex 目录(`read-only` / `auto` / `full-access`),缺省 `auto`;对象路径保留 `sandboxMode`/`approvalPolicy`,不走字符串目录门禁。
- `cursor`:值为 `ModeToken`,须落在 Cursor 目录(`plan` / `agent` / `full-access`),缺省 `agent`。

规范化(`normalizeDefaultMode`)对**每个** vendor 做目录校验:合法 token 原样保留;缺失/空串/对该 vendor 非法的非空字符串一律回退该 vendor 的 `defaultToken`(`DEFAULT_MODE_MAP`)。遗留的单一字符串格式 fan-out 到全部 vendor 键时同样按各目录接受或回退,不得把 Claude 的 `default` 原样写入 `cursor`。某 vendor 不在映射中时,会话启动读该 vendor 的 `defaultToken`。选中已有会话时,若持久化 mode 已不在该会话 vendor 目录内,下发前降级为工作区默认(再不行则 catalog `defaultToken`)并写回纠正值;合法历史 mode 不改写。遗留的全局 `defaultMode`/`consensus`/`devSkill`/`maxRoundsPerStage`/`maxSpeechChars` 由读层一次性迁入按项目配置。

## 共识投票 `consensus`

多智能体对权限提示的共识投票配置(是否启用、一致/多数裁决、投票者集)。缺省关闭。投票编排与裁决机制见 [permission-gateway](../../core/permission-gateway/permission-gateway-overview.md)。

## dev 启动技能 `devSkill`

启动本工作区开发时前缀的斜杠命令(带前导 `/`)。可选;空 ⇒ 无前缀。

## 讨论上限

- **`maxRoundsPerStage`** — 本工作区多智能体讨论每阶段轮次上限,最小 8(向上钳制)。
- **`maxSpeechChars`** — 参与者每轮发言字数引导,最小 300(向上钳制)。

讨论编排见 [discussion](../../core/discussion/discussion-overview.md)。

## Git 分支策略

- **`gitBranchMode`** — `start_development` 的分支策略:`current-branch` 或 `worktree`(缺省)。缺失/非法值读时归一为 `worktree`;显式合法值保持不变,新键缺失时仍兼容旧磁盘键 `gitCommitMode`。
- **`defaultMainBranch`** — `worktree` 模式下新 worktree 的基线/合并目标分支;缺省 ⇒ 从当前 HEAD 分叉。设置面板打开时自动探测(origin/HEAD → 当前 HEAD)。

## 工作区沙箱 `sandbox`

工作区级 arapuca 进程级隔离配置,收敛为 `enabled` + `extraMounts` + `sandboxSessionKinds`。是否进沙箱只由 `enabled` 主开关与该 run 的 `sessionKind` 是否命中 `sandboxSessionKinds` 决定,**与 run 来源(Intent / spec / 普通)、是否使用 worktree、`gitBranchMode` 无关**。配置**独立于分支模式**:`current-branch` 与 `worktree` 下均展示同一编辑区并可保存;归一化只校验 sandbox 内容,切换分支模式不会静默删除已保存的 `enabled` / `extraMounts` / `sandboxSessionKinds`。运行语义(执行根、固定放行、失败硬隔离)见 [sandbox](../../core/sandbox/sandbox-design.md)。

- **`enabled`(主开关)** — 缺省关(缺失/`false` 即禁用)。启用后入选 run 的 vendor CLI 经 arapuca wrapper 启动。
- **`extraMounts`(补充放行目录)** — 逐项 `{ path, readonly? }` 同路径放行,默认只读、可逐项声明 rw;不得覆盖执行根 / 源工作区 / specsBase 等保留路径。
- **`sandboxSessionKinds`(会话种类勾选)** — 配置沙箱时列出全部 `SessionKind`(`work` / `intent` / `discussion` / `automation` / `consensus` / `tool` / `spec`),用户勾选哪些种类的 run 进沙箱。**缺省只勾选 `work`**。仅 run 的 `sessionKind` 命中勾选集合时才进沙箱,不再叠加任何 worktree 前置条件;每个勾选的种类都对该种类的全部 run 生效。归一化去重、丢弃未知值,清空后回退 `['work']`。

## 规格驱动开发 `sddEnabled`

- **`sddEnabled`** — 本工作区规格驱动开发(SDD)总开关,缺省开。开启时,SDD 规格质量门与人工批准检查点在开发编码前生效。仅显式布尔 `false` 关闭;缺失/非布尔规范化为 `true`。
- **`specMachineApprovalEnabled`(机器批准,显式 opt-in)** — 仅在 `sddEnabled` 开启时展示的显式授权开关,**缺省关闭**。开启后,审核结论为 `pass` 的规格由队列以机器身份(保留常量 `c3:machine-spec-approver`,不冒充任何登录 subject)自动跨过人工批准检查点;关闭时仍停留在人工批准检查点。规范化严格 opt-in:仅显式布尔 `true` 读作开启并写入该工作区的 `projectConfigs`,缺失 / `false` / 非布尔一律读作关闭且**不落该键**,故既有工作区升级后不会静默获得机器批准。**关闭开关只影响此后的机器批准判断,不撤销任何已批准的规格**(撤销须经批准领域能力的撤销路径)。行为与可撤销语义见 [ADR-0032](../../../architecture/adr/0032-machine-spec-approval-opt-in.md)。
- **Spec 目录(只读、集中、固定)** — SDD 规范文档根目录**不是可配置项**,被**固定**为按项目隔离的集中位置 `<c3 home>/doc/<项目路径段>`(命名范式与 worktree 集中目录同源),由服务端从**归属工作区路径**确定性解析,故同一项目的所有 worktree 共享同一份规范集合。工作区配置**仅只读展示**该解析目录(随工作区设置回复下发),界面与协议均**无法修改**:任何客户端提交的规范目录入参都被忽略,不写入、不改变解析结果(「服务端为准」)。规范文档**不提交 Git**,依赖本机 `<c3 home>`。
  > 边界:不迁移、不读取、不识别历史的工作区内 `.doc` 规范文档(集中目录仅承载启用后的新规范)。

`sddEnabled` 存于按工作区的 `projectConfigs` 映射,由 `normalizeWorkspaceSetting` 回填默认;不存在持久化的规范目录字段。`specMachineApprovalEnabled` 同存于该映射,由 `normalizeWorkspaceSetting` 按「仅 `true` 落键」重建:规范化返回值在开启时携带该键,保存其他工作区字段时原样保留,经「保存—落盘—重新加载」往返仍为 `true`;关闭时省略该键。

## 外部技能仓库 `skillRepos`

配置为技能源的外部 git 仓库。c3 把每个 clone 进共享的 `~/.c3/repo/` 缓存,并把其 skills 软链进每个具备 build-link 能力的 vendor 发现目录。由 `getSkillRepos()` 校验(fail-hard)。缺省/空 ⇒ 本工作区未配置外部技能。另有显式 `install_skill` 安装到 `.claude/skills` 与 `.agents/skills`。

## 代码托管平台 `forge`

为本工作区建 PR/MR 时使用的托管平台:`auto`(规范化缺省,从仓库 origin 探测)、`github` 或 `gitlab`(显式纠正自建 GitLab 等探测)。

## 自动化总闸 `automationEnabled`

- **`automationEnabled`** — 本工作区自动化**自动派发**总开关,缺省**开**。关闭时,该工作区下所有 cron 与事件触发的自动化都不会被 tick 循环 / 事件分发器自动派发(在派发前短路);单条自动化各自的 `active` / `paused` 状态不受影响,手动「立即运行」不受影响。触发语义与关闭态的 `nextRunAt` 重算/不补跑规则见 [automations](../../core/automations/automations-spec.md) 的 SCH-R28。
- 规范化仅接受显式布尔 `false` 为关闭;缺失/非布尔/旧的非法值一律归一为 `true`,故现有工作区升级后行为不变(无需数据库迁移,值进入既有 `projectConfigs` 配置 JSON)。`normalizeWorkspaceSetting` 的返回值始终包含规范化后的布尔值,保存其他工作区设置时原样保留该字段。设置读取失败或缺失时按开启处理。

## 自动化队列并发意图数 `automationConcurrency`

- **`automationConcurrency`** — 自动化队列**同时进行开发工作会话**的意图数上限,缺省 **2**。它只约束自动化队列自动派发的开发会话:`worktree` 隔离模式下每条意图各占独立目录,队列可并行开发最多 N 条;`current-branch` 共享同一份检出,有效并发**恒为 1**,配置值不覆盖 RM-A12 的共享文件安全。spec 撰写/审核阶段维持串行、**不计入**该上限;人工「开始工作」与 MCP `start_session_for_intent` 不被队列配额拒绝(仍走既有安全门禁)。
- **归一化。** 缺失/非数字/非有限数字回退 `2`;有限数字先取整,小于 1 钳制为 1;合法正整数原值保留。`normalizeWorkspaceSetting` 的返回值始终包含规范化后的数字,保存其他字段时原样保留,无需数据库迁移(存于既有 `projectConfigs` 配置 JSON)。`getAutomationConcurrency(workspacePath)` 是对账内核读取该值的统一访问器,每次 pass 重读,保存后下一 tick 即生效、无需重启队列。
- **队列语义。** 内核按意图 ID 去重统计本轮占用:内核持有的 work run、队列已挂接观察的活跃自动化会话、本轮刚选中的开发意图;占用数达到上限即不再挑选,其余合格意图以 `blocked_concurrency_gate` 与「已达并发上限 N」阻塞。调低上限**不取消/停止/park** 已在途会话(允许暂时超额,持续阻止新派发);调高上限后按每轮一个动作逐步补足。
- **默认 2 是有意收敛。** 早期 `worktree` 模式对并行**无上限**,意图一多会瞬间拉起大量 AI 会话;默认 2 把未配置工作区收敛为最多两个意图并行开发,高吞吐用户可显式调高。
- **界面。** 工作区设置页第五个配置 Tab「自动化」承载 `automationEnabled` 总开关与并发数输入(min 1、步长 1);`automationEnabled` 与自动化页/工作台仪表盘共用同一字段,任一入口保存后经设置回推校准其余入口,不引入镜像字段。

## 本机观测(只读,不属于 `WorkspaceSetting`)

工作区设置页的第六个 Tab「本机观测」展示 park 恢复率,用于判断本批 park 指引是否有效、后续 P1/P2 是否值得投入。

- **不是配置。** 派生统计**不进** `SystemSettings` / `WorkspaceSetting`,也不进任何保存负载;该 Tab 的字段白名单为空,因此永不脏、不参与切换确认、无 Save 按钮,`buildPayload` 对它返回 `null` 使程序化保存也发不出东西。避免设置保存把观测数据回写成配置。
- **专用只读协议。** `get_park_recovery_stats`(workspaceName)→ `park_recovery_stats`(workspaceName + `{ windowMs, eligible, recovered, pending, rate }` 或结构化 `error`)。服务端沿用既有工作区解析与访问边界,无法解析的工作区一律拒绝;响应不暴露单条事件、intent id、原因码或任意文本。回包按 `workspaceName` 对齐当前工作区,切换后到达的迟到回包被丢弃而非改标。
- **打开页面或切换工作区时**请求对应工作区统计;切换工作区与重连时清空已有数字,避免一个工作区的数据挂在另一个名下。
- **呈现。** park 后 24h 恢复率(`rate` 为 `null` 时显示「暂无足够样本」,**不显示 0%**)、`recovered / eligible` 样本数、`pending` 未满窗数;**数据库不可用或查询失败**显示「本机统计暂不可用」并提供重试,失败态**优先于**任何仍在手上的旧数字。「暂无足够样本」只用于真正读到了空样本的情形,数据库打不开**不得**退化成它。
- **文案必须写明**数据只在本机、滚动保留 90 天、不含自由文本、不外传,以及决策口径:恢复率达 60% 为正向信号、达 70% 为强信号;上线 2–4 周复查,若相对上线初期未见提升,则停止并作废基于本批指引规划的全部 P1/P2 后续投入。
- **无控件**开启遥测、导出、上传、修改保留期或清空数据。趋势图、按原因拆分报表、自动执行 P1/P2 决策均为非目标。

采集侧(`funnel_event` 表、写入边界、统计口径与保留)见 [intent-management](../../core/intent-management/intent-management-spec.md) 的 RM-A23。

## 外部 MCP 接入(非配置,独立即时指令)

第七个 Tab「外部 MCP 接入」管理 c3 未拉起的 agent 如何通过 MCP 访问本部署。域语义见 [external-mcp](../../core/external-mcp/external-mcp-spec.md);key 存储、归属与哈希见 [system-setting](../system-setting/system-setting-spec.md#外部-mcp-api-key-存储-mcp_api_keys)。

- **非配置。** 本 Tab 不在 `WorkspaceSetting` 里,空字段白名单:永不脏、无 Save 按钮、不出现在任何保存载荷里。每个操作(生成/改工具范围/吊销)都是即时服务端指令,不进入页面草稿。
- **生命周期在此,但授权不在这里。** key 在这里生成、列示、改工具范围、吊销;本页只是它的**管理页**,不授予本工作区的访问权。key 能到达哪些工作区,由它的归属账号(创建时取连接已验证的 subject)的管理员范围决定。生成后的一次性揭示区给出明文 key、不含凭据的端点地址与一行式 `claude mcp add` 命令,各配复制按钮;关闭即不可恢复。命令以环境变量间接引用 key,不把明文再拼进一条会进 shell 历史的命令。列表只含元数据(名称、短前缀、创建/最后使用、工具范围、不可用态),绝不回传明文。
- **默认只读。** 新 key 一律只授予五个只读工具(`find_intents` / `view_intent` / `find_discussions` / `view_discussion` / `publish_event`),不含任何写工具;创建时服务端忽略客户端伪造的默认值。
- **逐 key 工具范围。** 编辑区从服务端目录渲染只读/写两组工具,前端不另存清单。写工具会真实改动 c3 状态(落库意图、提交 spec 审核、拉起会话),保存含写工具的范围前必须过一次危险确认;保存后服务端立即切断该 key 已建立的活动会话,下一次调用即按新范围。
- **管理员门。** 生成/改范围/吊销仅管理员可操作;非管理员只读查看不含秘密的元数据(列表本身不过滤,避免功能显得「不存在」)。
- **不可用态。** 归属账号已不被本部署承认的 key(账号被移除,或无认证时期创建的 `local` 归属在配置 basic 认证之后)被标为不可用、只留吊销;不披露宿主路径。
- **缺失态。** `baseUrl` 未配置时明说「未配置」并给出跳转系统设置的入口(地址拼不出来,key 仍可生成),**不猜浏览器 Host** 当作永久配置。
- 页面持续提示写工具风险与无 TLS 时明文 bearer 可被嗅探的风险。
