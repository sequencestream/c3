# workspace-setting 工作区设置

`workspace-setting` 域承载 `WorkspaceSetting`(见 [`shared/src/protocol/workspace.ts`](../../../../shared/src/protocol/workspace.ts))——**按工作区**独立的配置旋钮,存于 `SystemSettings.projectConfigs` 映射(键为解析后的工作区路径)。缺失或部分条目回退规范化默认值(`normalizeWorkspaceSetting`)。协议消息 `load_workspace_setting` / `save_workspace_setting` / `workspace_setting`。

配置持久化与组级共享上下文见 [settings 组概览](../settings-overview.md)。

## 默认权限模式 `defaultMode`

按 vendor 分组的默认权限模式映射(vendor id → 模式):

- `claude`:值为 `ModeToken`,保存时按该 vendor 的 `VendorModeCatalog` 校验。
- `codex`:值为 `CodexPolicy`(双策略新格式)或 `ModeToken`(旧格式,读时经 `gateToCodexPolicy` 迁移)。

某 vendor 不在映射中时,启动回退该 vendor 的 `defaultToken`。旧的单一 `ModeToken` 格式在工作区设置规范化时检测,并原值分发到每个 vendor 键(每 vendor 的目录校验发生在按 vendor 保存处)。遗留的全局 `defaultMode`/`consensus`/`devSkill`/`maxRoundsPerStage`/`maxSpeechChars` 由读层一次性迁入按项目配置。

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

## 本机观测(只读,不属于 `WorkspaceSetting`)

工作区设置页的第五个 Tab「本机观测」展示 park 恢复率,用于判断本批 park 指引是否有效、后续 P1/P2 是否值得投入。

- **不是配置。** 派生统计**不进** `SystemSettings` / `WorkspaceSetting`,也不进任何保存负载;该 Tab 的字段白名单为空,因此永不脏、不参与切换确认、无 Save 按钮,`buildPayload` 对它返回 `null` 使程序化保存也发不出东西。避免设置保存把观测数据回写成配置。
- **专用只读协议。** `get_park_recovery_stats`(workspaceId)→ `park_recovery_stats`(workspaceId + `{ windowMs, eligible, recovered, pending, rate }` 或结构化 `error`)。服务端沿用既有工作区解析与访问边界,无法解析的工作区一律拒绝;响应不暴露单条事件、intent id、原因码或任意文本。回包按 `workspaceId` 对齐当前工作区,切换后到达的迟到回包被丢弃而非改标。
- **打开页面或切换工作区时**请求对应工作区统计;切换工作区与重连时清空已有数字,避免一个工作区的数据挂在另一个名下。
- **呈现。** park 后 24h 恢复率(`rate` 为 `null` 时显示「暂无足够样本」,**不显示 0%**)、`recovered / eligible` 样本数、`pending` 未满窗数;**数据库不可用或查询失败**显示「本机统计暂不可用」并提供重试,失败态**优先于**任何仍在手上的旧数字。「暂无足够样本」只用于真正读到了空样本的情形,数据库打不开**不得**退化成它。
- **文案必须写明**数据只在本机、滚动保留 90 天、不含自由文本、不外传,以及决策口径:恢复率达 60% 为正向信号、达 70% 为强信号;上线 2–4 周复查,若相对上线初期未见提升,则停止并作废基于本批指引规划的全部 P1/P2 后续投入。
- **无控件**开启遥测、导出、上传、修改保留期或清空数据。趋势图、按原因拆分报表、自动执行 P1/P2 决策均为非目标。

采集侧(`funnel_event` 表、写入边界、统计口径与保留)见 [intent-management](../../core/intent-management/intent-management-spec.md) 的 RM-A23。

## 外部 MCP 接入(只读,不属于 `WorkspaceSetting`)

第六个 Tab「外部 MCP 接入」展示 c3 未拉起的 agent 如何通过 MCP 访问**本工作区**。域语义见 [external-mcp](../../core/external-mcp/external-mcp-spec.md);key 的生成与吊销见 [system-setting](../system-setting/system-setting-spec.md#外部-mcp-api-key-mcpapikeys)。

- **不是配置。** 地址由系统级 `baseUrl`、固定路由 `/mcp/v1` 与本工作区路径拼出;长期 key 属系统设置,不纳入工作区配置。与「本机观测」同样是空字段白名单的 Tab:永不脏、无 Save 按钮、不出现在任何保存载荷里。
- **展示内容。** 可复制的接入 URL 与一行式 `claude mcp add` 命令,各配复制按钮;并列出已授权本工作区的 key 名称供辨认(仅元数据,服务端绝不回传旧 key 明文)。
- **明文处理。** 常态 URL/命令以 `<KEY>` 占位。用户可临时粘贴自己保管的明文以生成可直接复制的值——该输入**只存在于当前组件的内存**,不上传、不写入浏览器存储,离开页面即清除;输入框为密码型,避免旁人读到。
- **缺失态。** `baseUrl` 未配置时明说「未配置」并给出跳转系统设置的入口,**不猜浏览器 Host** 当作永久配置;没有覆盖本工作区的 key 时,给出前往系统设置生成的入口。
- 页面同时提示外部 key 的能力边界(只读 + 投递事件,永不写入)与查询串/HTTPS 风险。
