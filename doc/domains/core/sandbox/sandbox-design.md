# sandbox — 领域实现设计

## 1. 定位

sandbox 领域为 agent 执行提供**进程级轻量隔离**。c3 不再让 vendor CLI 直接在宿主工作区里裸跑，而是在**工作区启用且 SessionKind 入选**的 run 中，用 [arapuca](https://github.com/sergio-correia/arapuca) 把 Claude Code / Codex CLI 进程包裹起来：进程仍在宿主同一文件系统内、以当前宿主用户身份、在宿主原路径上运行，由内核 MAC（Linux Landlock / macOS Seatbelt / Windows AppContainer）收窄它能读写哪些目录。不使用容器、镜像、bind mount、独立 rootfs。是否进沙箱只取决于工作区 `enabled` 主开关与该 run 的 `sessionKind` 是否命中 `sandboxSessionKinds`，与 run 来源（Intent / spec / 普通）、是否使用 worktree、`gitBranchMode` 均无关。vendor CLI（claude / codex）由使用方在宿主预装；c3 不下载、不版本化 vendor CLI。arapuca 是例外：c3 关联并自动安装一个经过验证的版本（见 §2、§14）。

本文负责实现细节：配置模型、路径放行解析、arapuca wrapper 生成、run lifecycle 接线、文件系统策略、网络策略、运行期环境卫生、启动前探测。大方向架构（为什么用进程级 arapuca、平台能力面、演进方向）见 `doc/architecture/sandbox-architecture.md`。

sandbox 是内核基础设施领域，属于内层能力（受单向依赖边界约束）。它只提供"把一次 vendor CLI 启动包进受限进程"的能力；是否启用 sandbox、选择哪个 agent、如何接线 provider，由 run lifecycle 与 vendor adapter 决定。

## 2. 范围与边界

范围：

- sandbox 配置类型与默认值。
- workspace sandbox config 的 normalize 规则。
- 路径放行解析：执行根 rw、源工作区 ro（同路径时并入执行根 rw）、specsBase rw、`extraMounts` 逐项 ro/rw。
- arapuca wrapper 生成与临时目录清理。
- arapuca 版本关联与自动安装：下载、SHA-256 校验、落盘、`current` 指向切换。
- 启动前探测 arapuca 二进制与平台能力。
- run lifecycle 接线：随机选取 sandbox agent、包裹 vendor CLI 启动、run 结束清理。

边界：

- sandbox 领域不决定普通 chat run 是否进入 sandbox。
- sandbox 领域不理解业务 session、intent、automation 的语义。
- sandbox 领域不实现远程 / 云端 sandbox。
- sandbox 领域不下载、不版本化、不验证 vendor CLI；工具由使用方在宿主预装。
- arapuca 分发只维护单一「当前版本」指向：不做多版本共存、历史版本、回滚 UI，也不复用 vendor CLI 的多版本选择与远端同步模型。
- 不追踪上游 `latest`、不支持用户配置下载源 / 镜像、不做源码构建；无制品映射的平台一律 `platform-unsupported`。
- sandbox 领域当前不施加网络约束（网络全开），网络收窄是后续阶段。

## 3. 模块结构

| 模块                                  | 职责                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/kernel/sandbox/`          | sandbox 类型定义：workspace config、resolved 路径集、放行项权限、启动 options。                                                         |
| workspace sandbox 配置校验            | 校验并 normalize `WorkspaceSandboxConfig`（`enabled` + `extraMounts` + `sandboxSessionKinds` + `sessionRetentionDays`）。               |
| `SandboxLauncher`                     | run lifecycle 与 sandbox 的集成层：读取 workspace 配置、探测 arapuca、`resolvePaths()`（含持久 codexHome）、生成 wrapper、清理 tmpDir。 |
| `kernel/sandbox/arapuca-dist.ts`      | arapuca 分发管理器：关联版本与各平台制品元数据、下载 + SHA-256 校验 + 解包 + 原子激活、后台 single-flight 安装（见 §14）。              |
| `features/sandbox/rollout-janitor.ts` | 每日定时任务:清理持久 CODEX_HOME 内超过工作区保留天数的 codex rollout(见 §9)。                                                          |
| ProcessSandbox 层（arapuca）          | 把 resolved 路径集映射为 arapuca `run` 参数；把 vendor CLI 包成 `arapuca run … -- <cli> "$@"` 形态的 wrapper。                          |
| `kernel/run/sandbox-agent.ts`         | sandbox 启用时从 workspace agent pool 随机选一个可沙箱化 agent，其 vendor 决定入口命令。                                                |

> 与容器方案的差异：不再有 `DockerDriver`、镜像 / registry、seccomp profile 加载、bind mount、forwarder sidecar、内部网络。原容器 runtime、容器供应链、网络分段相关模块整体移除。既有"沙箱 backend 作为独立内核模块""系统 + 项目双层配置"的抽象概念保留，但不再承载镜像 / 资源 / 网络等容器字段；当前范围内所有隔离参数由 workspace 配置与该 run 的执行根（worktree 或源工作区）直接驱动。具体文件切分由实现阶段确定。

## 4. 配置模型

### 4.1 WorkspaceSandboxConfig

workspace config 是项目级配置，收敛为四项：

```ts
interface WorkspaceSandboxConfig {
  enabled?: boolean
  extraMounts?: readonly {
    path: string // 宿主绝对路径，同路径放行
    readonly?: boolean // 默认 true；缺省即 ro，可逐项显式设为 false 放开 rw
  }[]
  sandboxSessionKinds?: SessionKind[] // 哪些 SessionKind 进沙箱，缺省 ['work']
  sessionRetentionDays?: number // 持久 CODEX_HOME rollout 保留天数，缺省 30、最小 1
  // 网络开关留待网络阶段引入；当前网络全开，无对应字段。
}
```

- `enabled` 为真时，`sessionKind` 命中 `sandboxSessionKinds` 的 run 即进入沙箱，不再要求隔离 worktree 或特定来源。
- `extraMounts` 是补充放行目录，每项按宿主绝对路径同路径放行，默认只读，可逐项声明 rw。用于把额外依赖目录、共享缓存、参考仓库带进放行集。
- `sandboxSessionKinds` 决定哪些 `SessionKind` 的 run 进沙箱，缺省 `['work']`。
- `sessionRetentionDays` 决定持久 CODEX_HOME 内 codex rollout 的保留天数,每日 janitor 据此清理超期文件(见 §9 CODEX_HOME 项)。缺省 30、最小 1。

移除的容器 / 网络字段（不在当前模型中）：镜像名 / `imageOverride`、`readonlyRootfs`、`networkDisabled`、`allowExternalNetwork`、`memoryLimit` / `cpuLimit` / `resourceLimits`、`envVarsOverride`、`networkAllowlist`、`seccomp`、`sandbox`（system definition 引用名）、`agentIds` 之外的容器专属项等。网络收窄阶段再按需引入网络字段。

同时移除容器供应链协议（`RuntimeVendorConfig`、`VendorInstallManifest`、`FetchPlan` 等），不引入。

### 4.2 normalize 规则

- `sandboxSessionKinds` 缺省 `['work']`；normalize 去重、丢弃合法集合之外的值，归一化后为空则回退 `['work']`。
- `extraMounts` 每项 `readonly` 缺省视为 `true`。
- `sessionRetentionDays`:有限正数向下取整并 clamp 到最小 1;非有限 / ≤ 0 / 缺省视为未设(读取回落默认 30)。仅当值 ≠ 默认才落盘。
- 遗留磁盘上的容器字段（如旧 `networkDisabled` / `readonlyRootfs` / 镜像相关键）在读取时直接丢弃，不迁移为新字段——当前范围没有对应语义承接。具体的旧键兼容处理由实现阶段确定。

## 5. 业务规则

1. 沙箱后端为 arapuca 进程级隔离，不使用容器 / 镜像 / rootfs 隔离。
2. sandbox 的适用条件收敛为工作区 `enabled` 与该 run 的 `sessionKind` 是否命中 `sandboxSessionKinds`（叠加主机能力 / 策略门闩），不再以隔离 worktree、run 来源或 `gitBranchMode` 作为结构性前提。普通工作会话、current-branch dev run 只要 kind 命中即进沙箱。
3. `sandboxSessionKinds` 缺省 `['work']`；勾选某 kind 即对该 kind 的所有 run 生效，与其是否使用 worktree、来源无关。
4. 执行根（executionRoot）= `rt.effectiveCwd ?? workspacePath`，代表本次 run 的实际代码执行目录：独立 worktree run 是 worktree；current-branch 与无独立 cwd 的入选 run 是源工作区。路径解析先确定执行根，再解析授权。
5. 同路径原则：进程在宿主原路径上运行，宿主绝对路径就是进程看到的绝对路径，不存在任何路径改写；沙箱只给路径打 ro/rw 标签。
6. 固定放行：执行根始终读写，workspace specs root 以宿主相同绝对路径读写；当执行根**不同于**源工作区时（worktree run），源工作区只读；当执行根**就是**源工作区时（current-branch），二者规范化后同路径，只保留一条读写授权，不产生互相冲突的 ro/rw 挂载。其中**工作区可派生**的两项（项目原目录 ro、specs root rw）由单一来源 `sysExtraMounts(workspace)` 产出——**同一函数**既在 sandbox 启动时被 `resolvePaths()` 取用并入放行集（同路径时把项目原目录 ro 合并入执行根 rw），又随工作区设置回复下发前端。执行根为**逐 run** 放行（无法仅由工作区路径派生），不在 `sysExtraMounts` 内，由 `resolvePaths()` 单独加入。这些固定放行在 workspace 设置的「补充放行目录」区域**只读列出（默认嵌入目录列表）**，供用户了解始终生效的放行集：不可修改、不可删除；逐 run 的执行根按当前分支模式展示为源工作区读写或独立 worktree 读写，界面文案不承诺源工作区恒为只读。
7. 补充放行：workspace 可配置 `extraMounts`，每项同路径放行、默认只读、可逐项声明 rw；补充目录不得覆盖执行根、项目原目录、specsBase 等保留路径，放行前须 canonicalize 并做 allowlist / denylist 校验，拒绝软链逃逸；独立 worktree 的源工作区只读是强制边界，不得通过父子路径重叠把它提升为读写。
8. deny-by-default 是安全底座：未显式放行的目录（其它项目、`~/.ssh`、`~/.aws` 等 home 内敏感目录）一律不可见，无需额外配置即隔离凭证与无关代码。
9. 无凭证注入：进程即当前宿主用户，沿用宿主侧既有认证（env 变量或 vendor CLI 自身配置目录）；vendor CLI 自身认证所需的最小配置目录由 wrapper 生成逻辑放行，不牵连 home 其它敏感目录。
10. 网络当前全开，不施加网络约束。网络禁用 / 出站白名单 / 代理列为后续阶段。
11. sandbox 启用时，从 normalized custom agent pool 随机选一个 agent 并 pin 到 pending run；被选 agent 的 vendor 决定入口命令（宿主 PATH 中的 CLI）与 provider 接线。
12. 启用即硬隔离：arapuca fail-closed（任一隔离层失效即非零退出），与 deny-by-default 一致；探测缺失 / 平台不支持 / 放行路径非法 / 启动失败时该 run 硬失败，绝不回落宿主裸跑。
13. arapuca 二进制解析链为「c3 管理版本 → 宿主 PATH」：管理版本缺失时异步后台安装、当次不阻塞，两者皆无则 hard-fail 并给出明确 `UiCode`（见 §14）。
14. 宿主 spawn wrapper 的 cwd 是执行根（worktree 或源工作区）；进程同路径运行，cwd 语义天然一致，无需任何容器内 cwd 设置。
15. 无长驻容器：run 结束只需清理临时 wrapper 文件，不存在 start/stop 容器。

## 6. 启动集成层

`SandboxLauncher` 是 run lifecycle 与 arapuca 之间唯一的集成点，职责：

- 读取并 normalize workspace sandbox config，判断本次 run 是否进沙箱。
- 探测 arapuca 平台能力与二进制（管理版本优先、PATH 兜底），两者皆无则 hard-fail。
- `resolvePaths()`：把固定放行（执行根 rw、源工作区 ro——同路径时并入执行根 rw、specsBase rw）与 `extraMounts`（逐项 ro/rw）解析成一个 canonicalize + 校验过的放行路径集。
- `createSandboxWrapper()`：把入口命令、放行路径集、cwd 生成为 arapuca wrapper 脚本。
- run 结束后清理 wrapper 临时目录。

上层不直接依赖 arapuca 的调用细节；`SandboxLauncher` 之下的 ProcessSandbox 层负责把放行路径集翻译为 arapuca `run` 参数。

## 7. arapuca 参数映射

`resolvePaths()` 产出的放行路径集映射为 arapuca `run` 的挂载标志：

| c3 概念                         | arapuca 参数                                  |
| ------------------------------- | --------------------------------------------- |
| 执行根（worktree 或源工作区）   | `-v <executionRoot>:rw`                       |
| 源工作区（仅执行根≠源工作区时） | `-v <workspaceRoot>:ro`                       |
| specsBase                       | `-v <specsBase>:rw`                           |
| `extraMounts[i]`（默认 ro）     | `-v <path>:ro`                                |
| `extraMounts[i]`（声明 rw）     | `-v <path>:rw`                                |
| vendor CLI 自身最小配置目录     | `-v <configDir>:ro`（最小放行）               |
| 入口命令 + 参数                 | `-- <entryCommand> "$@"`                      |
| 网络（当前全开）                | `--seccomp baseline`（开网；strict 默认全断） |

约束：

- 所有放行路径先 canonicalize，再对照 allowlist / denylist；拒绝放行敏感系统目录、拒绝软链逃逸。
- 保留路径（执行根 / 源工作区 / specsBase）不可被 `extraMounts` 覆盖或被其覆盖。
- deny-by-default：未列入放行集的目录一律不可见，无需显式禁止。
- vendor CLI 运行自身所需的最小集（可执行文件、运行库、其自身 home / 配置目录）由 wrapper 生成逻辑纳入放行，最小化暴露，不牵连 home 其它敏感目录。具体放行哪些目录由实现阶段结合各 vendor CLI 的配置布局确定。

## 8. Sandbox 启动流程

```
run 启动（任意来源 / 分支模式）
  → 读取 workspace sandbox config；未启用或 sessionKind 不在 sandboxSessionKinds：返回 null，不启动沙箱
  → executionRoot = rt.effectiveCwd ?? workspacePath（worktree 或源工作区）
  → probe arapuca 二进制 + 平台能力，并检测 macOS 父进程 sandbox：缺失 / 不支持 / 嵌套 Seatbelt → hard-fail run
  → 解析入选 run 的 vendor（决定入口命令）
  → resolvePaths()：
       executionRoot  : rw
       workspace root : ro（仅当 ≠ executionRoot；同路径时并入 executionRoot rw）
       specsBase      : rw
       extraMounts[i] : (ro | rw)
       vendor CLI 最小配置目录 : ro
  → createSandboxWrapper(entryCommand, paths, cwd=executionRoot, env)
  → vendor SDK / driver spawn wrapper（SDK 以为 spawn 的是本地 CLI）
  → run 完成后清理 wrapper tmpDir（无容器需停止）
```

固定放行（宿主原路径，无改写）：

- 执行根（executionRoot）：rw，agent 修改代码的唯一主路径——独立 worktree run 是 worktree，current-branch run 是源工作区。
- 源工作区（workspace root）：ro，参考基线代码；仅当执行根为独立 worktree 时作为单独只读放行，current-branch 下与执行根同路径合并为单条 rw。
- specsBase：rw，宿主同绝对路径，支持 specs reverse-sync。

补充放行（可选，来自 `extraMounts`）：同路径放行，默认 ro，可逐项 rw。

不再有容器 label、bind mount、镜像 inspect、内部网络与 sidecar 创建等步骤。

## 9. Wrapper 机制

`createSandboxWrapper()` 在宿主临时目录写一个可执行 wrapper 脚本，把这次 vendor CLI 启动包进 arapuca。脚本 `exec` 探测选中的 arapuca **绝对路径**（管理版本或 PATH 命中，见 §14），不写裸名，避免运行期 PATH 查找到另一个未经校验的二进制：

数据根 env 与挂载**按 vendor 分流**(codex → `CODEX_HOME`,claude → `CLAUDE_CONFIG_DIR`),互不泄漏。codex 分支:

```sh
#!/bin/sh
exec "<arapuca 绝对路径>" run \
  --seccomp baseline \
  --cwd "<executionRoot>" \
  --env "CODEX_HOME=<持久 per-workspace codexHome>" \   # ~/.c3/sandbox-home/<project>/.codex,跨 run 存活
  --env "CODEX_API_KEY=$CODEX_API_KEY" \
  -v "<持久 per-workspace codexHome>":rw \
  -v "<executionRoot>":rw \
  [ -v "<workspaceRoot>":ro ]   # 仅当 workspaceRoot ≠ executionRoot \
  -v "<specsBase>":rw \
  [ -v "<extraMount>":ro|rw ... ] \
  -- "codex" "$@"
```

claude 分支(改设 `CLAUDE_CONFIG_DIR`、挂宿主 claude config dir 与 `/tmp/claude-<uid>` 运行时目录,透传 `ANTHROPIC_*`):

```sh
#!/bin/sh
mkdir -p "/tmp/claude-<uid>" 2>/dev/null || true
exec "<arapuca 绝对路径>" run \
  --seccomp baseline \
  --cwd "<executionRoot>" \
  --env "CLAUDE_CONFIG_DIR=<宿主 claude config dir>" \   # 与 server 读取端同一目录,transcript 天然可读
  --env "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" \
  --env "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  --env "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN" \
  -v "<宿主 claude config dir>":rw \
  -v "<canonical /tmp>/claude-<uid>":rw \
  -v "<executionRoot>":rw \
  [ -v "<workspaceRoot>":ro ]   # 仅当 workspaceRoot ≠ executionRoot \
  -v "<specsBase>":rw \
  [ -v "<extraMount>":ro|rw ... ] \
  -- "claude" "$@"
```

vendor SDK / driver 仍以为自己在 spawn 一个普通本地 CLI；实际这次 spawn 被 wrapper 包进 arapuca 受限进程。这与容器方案里"wrapper 替换二进制"的 per-run 隔离模型一致，只是包裹形态从 `docker exec … -- <cli> "$@"` 换成 `arapuca run … -- <cli> "$@"`。

关键要求：

- `--seccomp baseline` 打开出站网络（当前网络全开）。arapuca 默认 `strict` 全断网络，vendor CLI 的 provider 调用会 `ConnectionRefused`，故必须显式开网。macOS 无 per-host 白名单；Linux 后续可 `--allow-host` 收窄到 provider 域名。
- `--cwd` 显式设为执行根（worktree 或源工作区）；进程同路径运行，cwd 天然一致。
- `<entryCommand>` 是宿主 PATH 中的 vendor CLI 名（如 `claude`、`codex`），不是任何容器内安装路径。
- wrapper 需要能在宿主 PATH 中找到 arapuca 可执行文件（该 arapuca 须含 macOS profile 的 mount-ancestor 遍历与 `/tmp` symlink 放行两处修复，否则 codex `canonicalize(CODEX_HOME)` / claude `mkdir /tmp/claude-<uid>` 会 EPERM）。
- **CODEX_HOME（codex,持久化以支持 resume）**：指向 **per-workspace 持久目录** `~/.c3/sandbox-home/<project>/.codex`（`getSandboxCodexHome(workspace)`），位于执行根**之外**、作为独立 rw volume 传入,满足 macOS profile 对启动期 canonicalize 的授权,并避免 arapuca 默认临时 HOME 被 codex 拒绝创建 PATH helper。**为何持久而非逐 run**:codex 第二轮 `thread/resume` 需要第一轮 `startThread` 写在 `CODEX_HOME/sessions/` 的 rollout;若随 run 清理则下轮空目录 → `no rollout found`。持久目录让同工作区所有 session 共用一个 home、每个 thread 的 rollout(以 thread id 命名)跨 run 存活。**不挂宿主 `~/.codex`**(保持 deny-by-default;rollout 本就不写宿主 home)。逐 run tmpDir 现仅放 wrapper 脚本并随 run 清理;持久 codexHome 不逐 run 删,由每日 janitor 按工作区 `sessionRetentionDays`(默认 30、最小 1)清理超期 rollout(`features/sandbox/rollout-janitor.ts`)。
- **CLAUDE_CONFIG_DIR（claude,持久化以支持 resume + 查看）**：指向**宿主 claude config dir**（`getSandboxClaudeConfigDir(workspace)` = `hostClaudeConfigDir()`，即 `CLAUDE_CONFIG_DIR` 或 `~/.claude`），作为独立 rw volume 传入。**与 codex 的隔离目录策略不同**:claude transcript 由 server 经 SDK `getSessionMessages` 读取,其 projects 根恒取 **server 进程的** `CLAUDE_CONFIG_DIR`(多工作区 server 无法按调用改写);若给 claude 每工作区隔离目录,宿主侧将读不到。故 sandbox 复用宿主 config dir,transcript 落在 server 读取端同一处,**查看零改动即生效**。安全:claude 凭证走 env/keychain,不落在 config dir 内(唯一带凭证的 `~/.claude.json` 是 `~/.claude` 的**兄弟**,不在其内)。
- **claude 运行时目录**：Claude Code 硬编码 `/tmp/claude-<uid>`（shell-snapshot / IPC），不尊重 TMPDIR 且 arapuca 锁定 TMPDIR，故 wrapper 预建该宿主目录并按 canonical 路径放行；逐用户共享（非逐 run），放行但不清理，codex 不使用（仅 claude 分支挂载）。
- **认证经 env 注入，不碰订阅 / keychain**：provider 认证由 driver 通过子进程 env 传入（claude 的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`，codex 的 relay token `CODEX_API_KEY`）；但 arapuca env **deny-by-default**（除自身管理的 `HOME` / `PATH` 外不继承父进程 env，裸名 `--env KEY` 被拒），故 wrapper 须按 vendor 用 `--env "KEY=$KEY"` 显式透传——`$KEY` 由 `/bin/sh` 运行时从 wrapper 进程 env 展开，token 值不落盘;未设变量展开为 `KEY=`,arapuca 视为未设。凭证按 vendor 分离(codex run 不透传 `ANTHROPIC_*`,反之亦然)。deny-by-default 下宿主订阅文件 / keychain 不放行、不可见,作为严格隔离要求。（实测 arapuca 0.2.4 / darwin；早期"arapuca 保留普通 env"表述已更正。）

### 9.1 transcript store 定位:冻结 storeScope + vendor 中立数据根(已实现)

历史 session 展示会话记录一律从 vendor native store 读(c3 不另存):`select_session` → `works/index.ts` `loadHistoryForVendor` → codex 走 `CodexSessionStore.read`、claude 走 `loadHistory`。sandbox 与宿主的 vendor 数据根不同(codex `CODEX_HOME`、claude `CLAUDE_CONFIG_DIR`),故 transcript 物理落在两地之一。以下三层已落地(ADR-0015 / ADR-0030):

**① 读取端两处扫(dual-scan,兜底)**:`CodexSessionStore.list/read` 不再硬编码宿主 `~/.codex`,而按 `storeRoots` 扫描多个 CODEX_HOME 根;缺省即扫**宿主 `~/.codex` + 本工作区 sandbox home 两处**(`codexStoreRoots`),命中即算——按 `session id + cwd` 精确匹配,thread id 唯一不冲突。侧栏冷枚举/回填与存量 session 天然鲁棒。

**② 冻结 `storeScope: 'host' | 'sandbox'`(治本,精确定位)**:session fact 在首次 bind 时冻结 `storeScope`(类比已冻结的 `vendor`),取值由该 run 是否 sandbox(`rt.sandboxPaths`)决定,写入 `SessionAgentFact`(state.json)。读取端 `loadHistoryForVendor` 按冻结 scope 取 `codexStoreRoots(cwd, scope)`——冻结根优先、另一根兜底。续接端(`run-via-driver`):**非 sandbox run 续接一个冻结为 sandbox 的 codex session** 时,把 `CODEX_HOME` 指向 sandbox home,使宿主进程也能找到 rollout(反向——host-frozen 在 sandbox 内续接——保持 wrapper 的 sandbox home,为可接受的取舍)。

**③ vendor 中立"每 vendor sandbox 数据根"**:`resolveVendorStoreDir(vendor, workspace, scope)` 收敛两 vendor 的数据根解析(`workspace-path.ts`)。codex → `host` 用 `~/.codex`、`sandbox` 用隔离的 `getSandboxCodexHome`;claude → 两 scope 均为宿主 `hostClaudeConfigDir()`。`ResolvedSandboxPaths` 增 `claudeConfigDir`,wrapper 按 vendor 挂载对应根(见 §9)。

**为何 claude 不需要按 scope 分支读取**:claude sandbox 复用宿主 config dir(见 §9 CLAUDE_CONFIG_DIR 项),sandbox 写入即落在 server 读取端同一处,查看零改动即成立;故 `storeScope` 的读取分支实际只对 codex 生效,但模型保持 vendor 中立。

## 10. Agent 选择与 provider 接线

sandbox 启用时，`pickSandboxAgent()` 从 workspace 的 normalized agent pool 中随机选一个：

- pool 为空：hard-fail。
- id 已失效或 resolve 回落 default：hard-fail。
- vendor 不支持 sandbox：hard-fail。
- codex 缺少 wire API：hard-fail。

当前支持：

- Claude：以当前宿主用户身份运行，沿用宿主既有 provider 认证（env 或其自身配置目录）；无凭证注入。
- Codex DIRECT：base URL / model 由 SDK 生成 argv，经 wrapper `"$@"` 进入进程；网络全开下直连 provider 天然可用。
- Codex RELAY：agent 是宿主进程，`127.0.0.1` 就是宿主本机，直接回连宿主 loopback relay，无需 host-gateway、内部网络或 sidecar。

hard-fail 是安全要求：sandbox enabled 的 run 不能因为 arapuca 探测或 vendor 接线失败而退回宿主裸跑。

macOS 不支持从已受 Seatbelt 约束的父进程再次应用 arapuca 的 Seatbelt profile。c3 在准备
wrapper 前检查明确的宿主 sandbox 环境标记，命中时以 `nested-sandbox-unsupported` 前置失败，
避免生成无法 bind vendor session 的 pending work run。`arapuca wrapper prepared` 日志只表示
路径与 wrapper 临时目录已经准备完成；vendor session 是否启动以之后的 bind 为准。

## 11. 文件系统策略

运行期文件系统目标（宿主原路径，无改写）：

| 路径                               | 权限       | 说明                                                                |
| ---------------------------------- | ---------- | ------------------------------------------------------------------- |
| 执行根（worktree 或源工作区）      | rw         | agent 修改代码的唯一主路径。                                        |
| 源工作区（仅执行根为 worktree 时） | ro         | 参考基线代码，禁止写回主 checkout；current-branch 下并入执行根 rw。 |
| `<specsBase>`                      | rw         | 宿主同绝对路径，支持 specs reverse-sync。                           |
| `extraMounts[i]`                   | ro（默认） | 补充依赖 / 缓存 / 参考目录，可按项声明为 rw。                       |
| 其它一切目录                       | 不可见     | deny-by-default：未放行即不可见，含 home 内敏感目录。               |

worktree 模式下源工作区只读：agent 可读取基线代码，但所有写入只能落在独立 worktree，避免一次 run 污染用户当前 checkout；current-branch 模式下执行根就是源工作区，写入直接落在源工作区（既有执行语义，非隔离降级）。敏感目录（其它项目、`~/.ssh`、`~/.aws`、其它工具 token）因不在放行集内而默认不可见，凭证无需传递也不暴露。

## 12. 网络策略

**当前：网络全开。** 沙箱当前不施加网络约束，vendor CLI 与 agent 可正常访问 provider API、拉取依赖等。

c3 MCP 接入天然成立：沙箱内 vendor agent 需要调用 c3 自身的 MCP 工具（`publish_event`、`save_intents`、spec 查询、automation 等），两个 vendor 都通过宿主回环上的 c3 HTTP MCP 端点（`http://127.0.0.1:<port>/internal/...`）访问。agent 是宿主进程，`127.0.0.1` 就是宿主本机，直接够到该端点——不需要内部网络、转发 sidecar 或 URL 改写。回环纵深防御沿用现成的 `isLoopback` + per-run 不透明 token。

后续阶段（非当前范围）可按平台收窄网络：

- Linux：网络命名空间禁直连 + 宿主 CONNECT 代理，配 `--allow-host host:port` 出站白名单（经 unix domain socket，无需 TLS 拦截）。
- macOS：全开 / 代理 / 全断三档，无 per-host 白名单。

收窄时以 workspace 级开关控制，并需保证回环 c3 MCP 端点在收窄后仍在放行集内。这部分留待网络阶段单独设计与决策。

## 13. 运行期环境卫生

进程即当前宿主用户，`127.0.0.1` 就是宿主本机，因此**不再需要过滤指向宿主 loopback 的 proxy env**——容器方案里过滤 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等是因为容器内 `127.0.0.1` 是容器自己；进程级下宿主 loopback proxy 指向仍然正确，无需剥离。

arapuca 环境变量为 **deny-by-default**:除自身管理的 `HOME` / `PATH` 外**不继承父进程 env**,只有显式 `--env KEY=VALUE` 传入的才进沙箱(裸名 `--env KEY` 被拒:`invalid --env, expected KEY=VALUE`)。因此 c3 wrapper 必须把 codex/claude 所需的每个变量(CODEX*HOME、provider 凭证等)逐个 `--env` 显式透传,不能依赖继承。（早期文档误称"arapuca 保留普通 env、仅剥 `LD*\_`/`DYLD\_\_`/`ARAPUCA\_\*`",与实测 0.2.4/darwin 不符,已更正。）

## 14. arapuca 版本关联与探测

探测是第一道能力关卡，替代原 Docker 健康检查。顺序固定：先平台门禁，再二进制解析。

### 14.1 平台门禁

- 未知平台 → `platform-unsupported`。
- macOS 嵌套 Seatbelt（`CODEX_SANDBOX` / `APP_SANDBOX_CONTAINER_ID` 存在）→ `nested-sandbox-unsupported`；此时 arapuca 二进制探测即便成功，`sandbox-exec` 子进程也必然 EPERM。
- 当前策略只需文件系统 ro/rw MAC，三平台均支持。

### 14.2 二进制解析链

1. **c3 管理版本**：`~/.c3/sandbox/arapuca/current` 指向的版本目录内的可执行文件。
2. **宿主 PATH**：使用方自己安装的 arapuca，版本不受 c3 控制。

两者皆无 → `arapuca-missing`。sandbox enabled 的 run 一律 hard-fail 并向 UI 暴露 `UiCode`（不硬编码英文文案），绝不静默降级为宿主裸跑。

探测结果携带选中的**绝对路径**与来源（`managed` / `host-path`）。该绝对路径随本次 launch 结果传给 wrapper，wrapper `exec` 它而非裸名 `arapuca`——运行期 PATH 查找可能命中另一个未经校验的二进制。

### 14.3 管理版本

c3 版本显式关联一个经过验证的 arapuca 版本，以及各受支持平台的制品元数据（下载地址、SHA-256、归档内可执行文件路径）。关联版本必须满足 c3 依赖的能力门槛（macOS 挂载点祖先目录遍历、`/tmp` symlink 解析）；升级关联版本要重跑 `e2e-arapuca-capability-test.mjs` 并同步校验值。

目录布局：

```
~/.c3/sandbox/arapuca/
  <version>/arapuca-<version>/arapuca   # 完整制品
  current -> <version>                  # 全部校验通过后才切换
```

`current` 仅在下载、SHA-256 校验、解包、可执行性检查**全部成功**后原子切换（同目录临时 symlink + `rename`）。下载与解包在同根临时目录内进行，失败即清理临时产物，既不激活也不触碰既有 `current`。

信任规则——仅凭名称存在不算数，以下一律视为「管理版本不可用」，走异步修复 + PATH 兜底：

- `current` 断链、指向管理根之外、指向非关联版本。
- 目标可执行文件缺失或无执行权限。

SHA-256 不匹配时禁止解包，因此不完整或被篡改的目录永远不可能被探测命中。切换失败时保留上一条有效关联。

### 14.4 异步安装

管理版本缺失或无效时，探测启动后台安装任务并**立即继续** PATH 探测：

- 进程内 single-flight——启动探测、设置页探测与多个 run 复用同一任务，一个版本每进程最多下载一次。
- 本次 run 的时序与判定完全不受影响：已选 PATH 就用该绝对路径；PATH 也缺失则立即 `arapuca-missing`，不等待下载。
- 后台失败只记可诊断日志，不改写本次探测结果，不产生未处理的 Promise rejection；同进程后续探测可重试。
- 安装成功切换 `current` 后使探测缓存失效，后续探测/run 升级到管理版本；已启动的 run 保持原选择。
- 自动安装由组合根（server 启动）显式开启，内核被单独引用时不会隐式联网。

设置页的 sandbox host status 表达「当前实际可用性」，不额外呈现下载进度或版本管理 UI。

## 15. 写操作预审 / checkpoint

worktree 直接位于宿主同路径，agent 的写入实时落在宿主 worktree 上，因此预审无需任何"从容器拷回"步骤：预审逻辑可直接检查宿主 worktree。当前是 MVP 级 top-level 文件检查；后续可扩展为 git diff、文件白名单、大小限制、敏感文件扫描。写操作审批队列的具体接线（触发时机、审批粒度）沿用既有非容器部分，细节由实现阶段确定。

## 16. 与架构文档的分工

本文是实现设计，回答：

- 当前 sandbox 具体怎么启动？
- 放行路径怎么解析、arapuca 参数怎么映射？
- wrapper 怎么工作？
- worktree、specs、extraMounts、网络的规则是什么？
- run lifecycle 如何接入？

`doc/architecture/sandbox-architecture.md` 是大方向架构，回答：

- c3 sandbox 为什么从容器整体切换为进程级 arapuca？
- arapuca 的平台能力面（文件系统 / 网络 / 系统调用 / 资源）与跨平台差异是什么？
- 目录如何同路径放行、凭证为何默认不可见？
- 进程内 agent 如何天然直连 c3 MCP？
- 网络收窄等后续阶段如何演进？

## 17. Phase plan

| 阶段    | 范围                                                                                                                                                                                                          | 状态 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Phase A | 文档与配置类型：`WorkspaceSandboxConfig` 收敛为 `enabled` + `extraMounts` + `sandboxSessionKinds`；移除容器 / 网络字段与供应链协议。                                                                          | 完成 |
| Phase B | arapuca wrapper 与路径放行：`resolvePaths()`（执行根 rw + 源工作区 ro[同路径并入执行根] + specsBase rw + extraMounts）、保留路径校验 + canonicalize + allowlist、生成 `arapuca run … -- <cli> "$@"` wrapper。 | 完成 |
| Phase C | 探测、自动安装与硬失败：平台能力门禁 + 「管理版本 → PATH」二进制解析链 + 异步安装关联版本；所有失败路径保持 hard-fail，不回落宿主裸跑。                                                                       | 完成 |
| Phase D | 网络收窄（后续阶段）：按平台引入网络禁用 / 出站白名单 / 代理与对应 workspace 开关，保证回环 c3 MCP 端点收窄后仍可达。                                                                                         | 未来 |
