# workspace-setting 工作区设置

`workspace-setting` 域承载 `WorkspaceSetting`(见 [`shared/src/protocol.ts`](../../../../shared/src/protocol.ts))——**按工作区**独立的配置旋钮,存于 `SystemSettings.projectConfigs` 映射(键为解析后的工作区路径)。缺失或部分条目回退规范化默认值(`normalizeWorkspaceSetting`)。协议消息 `load_workspace_setting` / `save_workspace_setting` / `workspace_setting`。

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

- **`gitBranchMode`** — `start_development` 的分支策略:`current-branch`(缺省)或 `worktree`。缺省与旧配置向后兼容,读时规范化。
- **`defaultMainBranch`** — `worktree` 模式下新 worktree 的基线/合并目标分支;缺省 ⇒ 从当前 HEAD 分叉。设置面板打开时自动探测(origin/HEAD → 当前 HEAD)。

## 工作区沙箱引用 `sandbox`

按 name 引用系统级沙箱定义(定义侧见 [system-setting](../system-setting/system-setting-spec.md) 的 `sandboxes`)。未指定 name ⇒ 回退名为 `default` 的系统沙箱定义(用其镜像与模板);若不存在 `default` 定义 ⇒ 未配置沙箱(等同禁用)。启用后 dev run 进容器。运行语义见 [sandbox](../../core/sandbox/sandbox-design.md)。

- **`sandboxSessionKinds`(会话种类勾选)** — 配置沙箱时列出全部 `SessionKind`(`work` / `intent` / `discussion` / `automation` / `consensus` / `tool` / `spec`),用户勾选哪些种类的 run 进沙箱。**缺省只勾选 `work`**。仅 run 的 `sessionKind` 命中勾选集合时才进容器,叠加在「worktree-only + 可解析定义」前置条件之上:从不产生隔离 worktree 的种类即使勾选也不会进沙箱(勾选对其为空操作)。归一化去重、丢弃未知值,清空后回退 `['work']`。
- **`allowExternalNetwork`(外部网络开关)** — 容器是否放通外网访问,**缺省关**。关闭时容器只接入内部 `c3-mcp-net`(能调 c3 MCP、不能上外网);勾选后额外挂 egress 网络,供 DIRECT 模式 CLI 直连 provider API、npm/go 拉依赖等。取代已移除的 `networkDisabled`(deny-by-default;遗留磁盘键自动迁移);RELAY 模式经宿主 relay 代发,无需开此开关。网络拓扑见 [sandbox](../../core/sandbox/sandbox-design.md) §12。

## 规格驱动开发 `sddEnabled`

- **`sddEnabled`** — 本工作区规格驱动开发(SDD)总开关,缺省关。开启时,SDD 规格质量门与人工批准检查点在开发编码前生效。仅显式布尔 `true` 启用;缺失/非布尔规范化为 `false`。
- **Spec 目录(只读、集中、固定)** — SDD 规范文档根目录**不是可配置项**,被**固定**为按项目隔离的集中位置 `<c3 home>/doc/<项目路径段>`(命名范式与 worktree 集中目录同源),由服务端从**归属工作区路径**确定性解析,故同一项目的所有 worktree 共享同一份规范集合。工作区配置**仅只读展示**该解析目录(随工作区设置回复下发),界面与协议均**无法修改**:任何客户端提交的规范目录入参都被忽略,不写入、不改变解析结果(「服务端为准」)。规范文档**不提交 Git**,依赖本机 `<c3 home>`。
  > 边界:不迁移、不读取、不识别历史的工作区内 `.doc` 规范文档(集中目录仅承载启用后的新规范)。

`sddEnabled` 存于按工作区的 `projectConfigs` 映射,由 `normalizeWorkspaceSetting` 回填默认;不存在持久化的规范目录字段。

## 外部技能仓库 `skillRepos`

配置为技能源的外部 git 仓库。c3 把每个 clone 进共享的 `~/.c3/repo/` 缓存,并把其 skills 软链进每个具备 build-link 能力的 vendor 发现目录。由 `getSkillRepos()` 校验(fail-hard)。缺省/空 ⇒ 本工作区未配置外部技能。另有显式 `install_skill` 安装到 `.claude/skills` 与 `.agents/skills`。

## 代码托管平台 `forge`

为本工作区建 PR/MR 时使用的托管平台:`auto`(规范化缺省,从仓库 origin 探测)、`github` 或 `gitlab`(显式纠正自建 GitLab 等探测)。

## 自动化总闸 `automationEnabled`

- **`automationEnabled`** — 本工作区自动化**自动派发**总开关,缺省**开**。关闭时,该工作区下所有 cron 与事件触发的自动化都不会被 tick 循环 / 事件分发器自动派发(在派发前短路);单条自动化各自的 `active` / `paused` 状态不受影响,手动「立即运行」不受影响。触发语义与关闭态的 `nextRunAt` 重算/不补跑规则见 [automations](../../core/automations/automations-spec.md) 的 SCH-R28。
- 规范化仅接受显式布尔 `false` 为关闭;缺失/非布尔/旧的非法值一律归一为 `true`,故现有工作区升级后行为不变(无需数据库迁移,值进入既有 `projectConfigs` 配置 JSON)。`normalizeWorkspaceSetting` 的返回值始终包含规范化后的布尔值,保存其他工作区设置时原样保留该字段。设置读取失败或缺失时按开启处理。
