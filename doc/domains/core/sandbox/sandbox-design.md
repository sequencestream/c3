# sandbox — 领域实现设计

## 1. 定位

sandbox 领域为 agent 执行提供**进程级轻量隔离**。c3 不再让 vendor CLI 直接在宿主工作区里裸跑，而是在满足条件的 worktree intent-dev run 中，用 [arapuca](https://github.com/sergio-correia/arapuca) 把 Claude Code / Codex CLI 进程包裹起来：进程仍在宿主同一文件系统内、以当前宿主用户身份、在宿主原路径上运行，由内核 MAC（Linux Landlock / macOS Seatbelt / Windows AppContainer）收窄它能读写哪些目录。不使用容器、镜像、bind mount、独立 rootfs。vendor CLI（claude / codex）由使用方在宿主预装；c3 不下载、不版本化 vendor CLI，也不捆绑分发 arapuca。

本文负责实现细节：配置模型、路径放行解析、arapuca wrapper 生成、run lifecycle 接线、文件系统策略、网络策略、运行期环境卫生、启动前探测。大方向架构（为什么用进程级 arapuca、平台能力面、演进方向）见 `doc/architecture/sandbox-architecture.md`。

sandbox 是内核基础设施领域，属于内层能力（受单向依赖边界约束）。它只提供"把一次 vendor CLI 启动包进受限进程"的能力；是否启用 sandbox、选择哪个 agent、如何接线 provider，由 run lifecycle 与 vendor adapter 决定。

## 2. 范围与边界

范围：

- sandbox 配置类型与默认值。
- workspace sandbox config 的 normalize 规则。
- 路径放行解析：项目原目录 ro、worktree rw、specsBase rw、`extraMounts` 逐项 ro/rw。
- arapuca wrapper 生成与临时目录清理。
- 启动前探测 arapuca 二进制与平台能力。
- run lifecycle 接线：随机选取 sandbox agent、包裹 vendor CLI 启动、run 结束清理。

边界：

- sandbox 领域不决定普通 chat run 是否进入 sandbox。
- sandbox 领域不理解业务 session、intent、automation 的语义。
- sandbox 领域不实现远程 / 云端 sandbox。
- sandbox 领域不下载、不版本化、不验证 vendor CLI；工具由使用方在宿主预装。
- sandbox 领域不捆绑、不分发 arapuca；只探测其存在与平台能力。
- sandbox 领域当前不施加网络约束（网络全开），网络收窄是后续阶段。

## 3. 模块结构

| 模块                          | 职责                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `server/src/kernel/sandbox/`  | sandbox 类型定义：workspace config、resolved 路径集、放行项权限、启动 options。                                     |
| workspace sandbox 配置校验    | 校验并 normalize `WorkspaceSandboxConfig`（`enabled` + `extraMounts` + `sandboxSessionKinds`）。                    |
| `SandboxLauncher`             | run lifecycle 与 sandbox 的集成层：读取 workspace 配置、探测 arapuca、`resolvePaths()`、生成 wrapper、清理 tmpDir。 |
| ProcessSandbox 层（arapuca）  | 把 resolved 路径集映射为 arapuca `run` 参数；把 vendor CLI 包成 `arapuca run … -- <cli> "$@"` 形态的 wrapper。      |
| `kernel/run/sandbox-agent.ts` | sandbox 启用时从 workspace agent pool 随机选一个可沙箱化 agent，其 vendor 决定入口命令。                            |

> 与容器方案的差异：不再有 `DockerDriver`、镜像 / registry、seccomp profile 加载、bind mount、forwarder sidecar、内部网络。原容器 runtime、容器供应链、网络分段相关模块整体移除。既有"沙箱 backend 作为独立内核模块""系统 + 项目双层配置"的抽象概念保留，但不再承载镜像 / 资源 / 网络等容器字段；当前范围内所有隔离参数由 workspace 配置与该 run 的 worktree 直接驱动。具体文件切分由实现阶段确定。

## 4. 配置模型

### 4.1 WorkspaceSandboxConfig

workspace config 是项目级配置，收敛为三项：

```ts
interface WorkspaceSandboxConfig {
  enabled?: boolean
  extraMounts?: readonly {
    path: string // 宿主绝对路径，同路径放行
    readonly?: boolean // 默认 true；缺省即 ro，可逐项显式设为 false 放开 rw
  }[]
  sandboxSessionKinds?: SessionKind[] // 哪些 SessionKind 进沙箱，缺省 ['work']
  // 网络开关留待网络阶段引入；当前网络全开，无对应字段。
}
```

- `enabled` 为真时，满足结构性前提（隔离 worktree）的 run 才有机会进入沙箱。
- `extraMounts` 是补充放行目录，每项按宿主绝对路径同路径放行，默认只读，可逐项声明 rw。用于把额外依赖目录、共享缓存、参考仓库带进放行集。
- `sandboxSessionKinds` 决定哪些 `SessionKind` 的 run 进沙箱，缺省 `['work']`。

移除的容器 / 网络字段（不在当前模型中）：镜像名 / `imageOverride`、`readonlyRootfs`、`networkDisabled`、`allowExternalNetwork`、`memoryLimit` / `cpuLimit` / `resourceLimits`、`envVarsOverride`、`networkAllowlist`、`seccomp`、`sandbox`（system definition 引用名）、`agentIds` 之外的容器专属项等。网络收窄阶段再按需引入网络字段。

同时移除容器供应链协议（`RuntimeVendorConfig`、`VendorInstallManifest`、`FetchPlan` 等），不引入。

### 4.2 normalize 规则

- `sandboxSessionKinds` 缺省 `['work']`；normalize 去重、丢弃合法集合之外的值，归一化后为空则回退 `['work']`。
- `extraMounts` 每项 `readonly` 缺省视为 `true`。
- 遗留磁盘上的容器字段（如旧 `networkDisabled` / `readonlyRootfs` / 镜像相关键）在读取时直接丢弃，不迁移为新字段——当前范围没有对应语义承接。具体的旧键兼容处理由实现阶段确定。

## 5. 业务规则

1. 沙箱后端为 arapuca 进程级隔离，不使用容器 / 镜像 / rootfs 隔离。
2. sandbox 仅对具备隔离 worktree（有效 cwd）且以 worktree 模式创建的 run 生效；在此结构性前提上，再按 `sandboxSessionKinds` 过滤 run 的 `sessionKind`。普通 chat run（无 worktree）与 current-branch dev run 结构性排除。
3. `sandboxSessionKinds` 缺省 `['work']`；勾选某 kind 只对该 kind 且具隔离 worktree 的 run 生效；从不产生 worktree run 的 kind 即使勾选也不会进沙箱。
4. 同路径原则：进程在宿主原路径上运行，宿主绝对路径就是进程看到的绝对路径，不存在任何路径改写；沙箱只给路径打 ro/rw 标签。
5. 固定放行：项目原目录（workspace root）只读，run worktree 读写，workspace specs root 以宿主相同绝对路径读写。其中**工作区可派生**的两项（项目原目录 ro、specs root rw）由单一来源 `sysExtraMounts(workspace)` 产出——**同一函数**既在 sandbox 启动时被 `resolvePaths()` 取用并入放行集，又随工作区设置回复下发前端。run worktree 为**逐 run** 放行（无法仅由工作区路径派生），不在 `sysExtraMounts` 内，由 `resolvePaths()` 单独加入。这三项固定放行在 workspace 设置的「补充放行目录」区域**只读列出（默认嵌入目录列表）**，供用户了解始终生效的放行集：不可修改、不可删除、界面与协议均不接受其入参（worktree 随 run 变化，以描述展示）。
6. 补充放行：workspace 可配置 `extraMounts`，每项同路径放行、默认只读、可逐项声明 rw；补充目录不得覆盖 worktree、项目原目录、specsBase 等保留路径，放行前须 canonicalize 并做 allowlist / denylist 校验，拒绝软链逃逸。
7. deny-by-default 是安全底座：未显式放行的目录（其它项目、`~/.ssh`、`~/.aws` 等 home 内敏感目录）一律不可见，无需额外配置即隔离凭证与无关代码。
8. 无凭证注入：进程即当前宿主用户，沿用宿主侧既有认证（env 变量或 vendor CLI 自身配置目录）；vendor CLI 自身认证所需的最小配置目录由 wrapper 生成逻辑放行，不牵连 home 其它敏感目录。
9. 网络当前全开，不施加网络约束。网络禁用 / 出站白名单 / 代理列为后续阶段。
10. sandbox 启用时，从 normalized custom agent pool 随机选一个 agent 并 pin 到 pending run；被选 agent 的 vendor 决定入口命令（宿主 PATH 中的 CLI）与 provider 接线。
11. 启用即硬隔离：arapuca fail-closed（任一隔离层失效即非零退出），与 deny-by-default 一致；探测缺失 / 平台不支持 / 放行路径非法 / 启动失败时该 run 硬失败，绝不回落宿主裸跑。
12. arapuca 二进制走宿主预装 + 探测：c3 不捆绑；启动前探测二进制存在与平台能力，缺失 / 不支持 hard-fail 并给出明确 `UiCode`。
13. 宿主 spawn wrapper 的 cwd 是宿主 worktree；进程同路径运行，cwd 语义天然一致，无需任何容器内 cwd 设置。
14. 无长驻容器：run 结束只需清理临时 wrapper 文件，不存在 start/stop 容器。

## 6. 启动集成层

`SandboxLauncher` 是 run lifecycle 与 arapuca 之间唯一的集成点，职责：

- 读取并 normalize workspace sandbox config，判断本次 run 是否进沙箱。
- 探测 arapuca 二进制与平台能力，缺失 / 不支持 hard-fail。
- `resolvePaths()`：把固定放行（项目原目录 ro、worktree rw、specsBase rw）与 `extraMounts`（逐项 ro/rw）解析成一个 canonicalize + 校验过的放行路径集。
- `createSandboxWrapper()`：把入口命令、放行路径集、cwd 生成为 arapuca wrapper 脚本。
- run 结束后清理 wrapper 临时目录。

上层不直接依赖 arapuca 的调用细节；`SandboxLauncher` 之下的 ProcessSandbox 层负责把放行路径集翻译为 arapuca `run` 参数。

## 7. arapuca 参数映射

`resolvePaths()` 产出的放行路径集映射为 arapuca `run` 的挂载标志：

| c3 概念                      | arapuca 参数                    |
| ---------------------------- | ------------------------------- |
| 项目原目录（workspace root） | `-v <workspaceRoot>:ro`         |
| run worktree                 | `-v <worktree>:rw`              |
| specsBase                    | `-v <specsBase>:rw`             |
| `extraMounts[i]`（默认 ro）  | `-v <path>:ro`                  |
| `extraMounts[i]`（声明 rw）  | `-v <path>:rw`                  |
| vendor CLI 自身最小配置目录  | `-v <configDir>:ro`（最小放行） |
| 入口命令 + 参数              | `-- <entryCommand> "$@"`        |
| 网络（当前全开）             | 不传网络收窄参数                |

约束：

- 所有放行路径先 canonicalize，再对照 allowlist / denylist；拒绝放行敏感系统目录、拒绝软链逃逸。
- 保留路径（worktree / 项目原目录 / specsBase）不可被 `extraMounts` 覆盖或被其覆盖。
- deny-by-default：未列入放行集的目录一律不可见，无需显式禁止。
- vendor CLI 运行自身所需的最小集（可执行文件、运行库、其自身 home / 配置目录）由 wrapper 生成逻辑纳入放行，最小化暴露，不牵连 home 其它敏感目录。具体放行哪些目录由实现阶段结合各 vendor CLI 的配置布局确定。

## 8. Sandbox 启动流程

```
用户启动 worktree intent-dev run
  → 确认 run 有 effectiveCwd，即隔离 worktree run（否则不进沙箱）
  → 读取 workspace sandbox config；未启用或 sessionKind 不在 sandboxSessionKinds：返回 null，不启动沙箱
  → probe arapuca 二进制 + 平台能力，并检测 macOS 父进程 sandbox：缺失 / 不支持 / 嵌套 Seatbelt → hard-fail run
  → pickSandboxAgent()：从 agent pool 随机选一个，得到 vendor（决定入口命令）
  → resolvePaths()：
       workspace root : ro
       worktree       : rw
       specsBase      : rw
       extraMounts[i] : (ro | rw)
       vendor CLI 最小配置目录 : ro
  → createSandboxWrapper(entryCommand, paths, cwd=worktree, env)
  → vendor SDK / driver spawn wrapper（SDK 以为 spawn 的是本地 CLI）
  → run 完成后清理 wrapper tmpDir（无容器需停止）
```

固定放行（宿主原路径，无改写）：

- 项目原目录（workspace root）：ro，参考基线代码，禁止写回主 checkout。
- worktree：rw，agent 修改代码的唯一主路径。
- specsBase：rw，宿主同绝对路径，支持 specs reverse-sync。

补充放行（可选，来自 `extraMounts`）：同路径放行，默认 ro，可逐项 rw。

不再有容器 label、bind mount、镜像 inspect、内部网络与 sidecar 创建等步骤。

## 9. Wrapper 机制

`createSandboxWrapper()` 在宿主临时目录写一个可执行 wrapper 脚本，把这次 vendor CLI 启动包进 arapuca：

```sh
#!/bin/sh
exec arapuca run \
  -v "<workspaceRoot>":ro \
  -v "<worktree>":rw \
  -v "<specsBase>":rw \
  [ -v "<extraMount>":ro|rw ... ] \
  -- "<entryCommand>" "$@"
```

vendor SDK / driver 仍以为自己在 spawn 一个普通本地 CLI；实际这次 spawn 被 wrapper 包进 arapuca 受限进程。这与容器方案里"wrapper 替换二进制"的 per-run 隔离模型一致，只是包裹形态从 `docker exec … -- <cli> "$@"` 换成 `arapuca run … -- <cli> "$@"`。

关键要求：

- 宿主 spawn cwd 是宿主 worktree；进程同路径运行，cwd 天然一致，无需额外设置容器内 cwd。
- `<entryCommand>` 是宿主 PATH 中的 vendor CLI 名（如 `claude`、`codex`），不是任何容器内安装路径。
- wrapper 需要能在宿主 PATH 中找到 arapuca 可执行文件。
- 无 env-file：进程即当前宿主用户，沿用宿主既有认证；需要额外传递的 per-run 变量随 wrapper 环境或 `"$@"` 参数进入，具体由 vendor adapter 决定。

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

| 路径             | 权限       | 说明                                                  |
| ---------------- | ---------- | ----------------------------------------------------- |
| 项目原目录       | ro         | 参考基线代码，禁止写回主 checkout。                   |
| worktree         | rw         | agent 修改代码的唯一主路径。                          |
| `<specsBase>`    | rw         | 宿主同绝对路径，支持 specs reverse-sync。             |
| `extraMounts[i]` | ro（默认） | 补充依赖 / 缓存 / 参考目录，可按项声明为 rw。         |
| 其它一切目录     | 不可见     | deny-by-default：未放行即不可见，含 home 内敏感目录。 |

项目原目录只读：agent 可读取基线代码，但所有写入只能落在 worktree，避免一次 run 污染用户当前 checkout。敏感目录（其它项目、`~/.ssh`、`~/.aws`、其它工具 token）因不在放行集内而默认不可见，凭证无需传递也不暴露。

## 12. 网络策略

**当前：网络全开。** 沙箱当前不施加网络约束，vendor CLI 与 agent 可正常访问 provider API、拉取依赖等。

c3 MCP 接入天然成立：沙箱内 vendor agent 需要调用 c3 自身的 MCP 工具（`publish_event`、`save_intents`、spec 查询、automation 等），两个 vendor 都通过宿主回环上的 c3 HTTP MCP 端点（`http://127.0.0.1:<port>/internal/...`）访问。agent 是宿主进程，`127.0.0.1` 就是宿主本机，直接够到该端点——不需要内部网络、转发 sidecar 或 URL 改写。回环纵深防御沿用现成的 `isLoopback` + per-run 不透明 token。

后续阶段（非当前范围）可按平台收窄网络：

- Linux：网络命名空间禁直连 + 宿主 CONNECT 代理，配 `--allow-host host:port` 出站白名单（经 unix domain socket，无需 TLS 拦截）。
- macOS：全开 / 代理 / 全断三档，无 per-host 白名单。

收窄时以 workspace 级开关控制，并需保证回环 c3 MCP 端点在收窄后仍在放行集内。这部分留待网络阶段单独设计与决策。

## 13. 运行期环境卫生

进程即当前宿主用户，`127.0.0.1` 就是宿主本机，因此**不再需要过滤指向宿主 loopback 的 proxy env**——容器方案里过滤 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等是因为容器内 `127.0.0.1` 是容器自己；进程级下宿主 loopback proxy 指向仍然正确，无需剥离。

arapuca 自身会对危险前缀环境变量做卫生处理：剥离 `ARAPUCA_*` / `LD_*` / `DYLD_*` 等前缀，保留 `AGENT_*`。c3 在生成 wrapper 环境时应据此确认需要传入进程的变量不落在被剥离前缀下。

## 14. arapuca 探测

启动前探测替代原 Docker 健康检查：

- 探测 arapuca 二进制是否存在于宿主 PATH。
- 探测宿主平台是否支持当前策略所需能力（当前范围为文件系统 ro/rw MAC；三平台均支持）。
- 缺失或平台不支持时返回明确错误，sandbox enabled 的 run hard-fail 并向 UI 暴露原因（明确 `UiCode`，不硬编码英文文案），不静默降级。
- 探测结果可缓存于 host 能力状态，供 UI 展示"沙箱是否可用"。

c3 不捆绑 arapuca；使用方在宿主自行安装（musl 静态二进制或 `cargo install`）。探测是第一道能力关卡，类比宿主二进制探测。

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

| 阶段    | 范围                                                                                                                                                                                            | 状态 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Phase A | 文档与配置类型：`WorkspaceSandboxConfig` 收敛为 `enabled` + `extraMounts` + `sandboxSessionKinds`；移除容器 / 网络字段与供应链协议。                                                            | 当前 |
| Phase B | arapuca wrapper 与路径放行：`resolvePaths()`（项目原目录 ro + worktree rw + specsBase rw + extraMounts）、保留路径校验 + canonicalize + allowlist、生成 `arapuca run … -- <cli> "$@"` wrapper。 | 规划 |
| Phase C | 探测与硬失败：启动前探测 arapuca 二进制 + 平台能力，缺失 / 不支持 hard-fail 并 UI 提示安装；所有失败路径保持 hard-fail，不回落宿主裸跑。                                                        | 规划 |
| Phase D | 网络收窄（后续阶段）：按平台引入网络禁用 / 出站白名单 / 代理与对应 workspace 开关，保证回环 c3 MCP 端点收窄后仍可达。                                                                           | 未来 |
