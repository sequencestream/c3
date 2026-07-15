# sandbox — 领域实现设计

## 1. 定位

sandbox 领域为 agent 执行提供容器级隔离。c3 不再让 vendor CLI 直接在宿主工作区里运行，而是在满足条件的 worktree intent-dev run 中启动一个轻量容器，把 run 的 worktree 与项目原目录按宿主绝对路径同路径映射进容器，再通过宿主 wrapper 把 Claude Code / Codex CLI 进程转发到容器内执行。工具（claude、codex、npm 等）随使用方自建镜像分发，c3 不下载、不版本化 vendor CLI。

本文负责实现细节：配置模型、配置合并、sandbox driver contract、Docker runtime、run lifecycle 接线、wrapper、目录映射、网络与文件系统策略、运行期环境卫生。大方向架构、目录映射与镜像分发模型见 `doc/architecture/sandbox-architecture.md`。

sandbox 是 kernel infrastructure domain，属于 ADR-0009 的内层能力。它只提供可启动、可停止、可 exec、可 stream、可 snapshot、可 health check 的 runtime 能力；是否启用 sandbox、选择哪个 agent、provider 凭据如何进入容器，由 run lifecycle 与 vendor adapter 决定。

## 2. 范围与边界

范围：

- sandbox 配置类型与默认值。
- system sandbox definition 与 workspace sandbox config 的合并规则。
- named-definition registry。
- sandbox driver contract。
- Docker-backed runtime。
- seccomp profile 加载与合并。
- `SandboxLauncher` 启动容器、创建 wrapper、清理临时目录。
- worktree/specs bind mount 与 container label。
- codex relay 的 container→host hop。

边界：

- sandbox 领域不决定普通 chat run 是否进入 sandbox。
- sandbox 领域不理解业务 session、intent、automation 的语义。
- sandbox 领域不实现 Kubernetes、Swarm、远程 Docker host。
- sandbox 领域不下载、不版本化、不验证 vendor CLI；工具由使用方预装进镜像，见 `doc/architecture/sandbox-architecture.md`。
- sandbox 领域不构建镜像；镜像名由 workspace 配置，c3 视其为不透明工具环境。

## 3. 模块结构

| 模块                                 | 职责                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/kernel/sandbox/types.ts` | sandbox 类型定义：runtime type、system def、workspace config、resolved config、handle、exec result、health status、start/stop options。 |
| `SandboxConfig.ts`                   | 校验 system/workspace 配置，并合并为 `ResolvedSandboxConfig`。                                                                          |
| `SandboxRegistry.ts`                 | 注册 system sandbox definition，按 name 解析 workspace override。                                                                       |
| `SandboxDriver.ts`                   | runtime backend contract。                                                                                                              |
| `docker/DockerDriver.ts`             | Docker backend，实现 start/stop/exec/stream/snapshot/health/copy。                                                                      |
| `seccomp/profiles.ts`                | 加载默认 seccomp profile 和用户指定 profile。                                                                                           |
| `SandboxLauncher.ts`                 | run lifecycle 与 sandbox driver 的集成层：读取 workspace sandbox 配置、启动容器、创建 wrapper、停止容器、清理 tmpDir。                  |
| `kernel/run/sandbox-agent.ts`        | sandbox 启用时从 workspace agent pool 随机选择一个可容器化 agent。                                                                      |

## 4. 配置模型

### 4.1 SystemSandboxDef

system definition 是管理员配置的 sandbox 模板，保存于 system settings 的 `sandboxes`：

```ts
interface SystemSandboxDef {
  name: string
  type: 'docker' | 'gvisor' | 'kata' | 'firecracker'
  image: string
  seccomp?: string
  memoryLimit?: string
  cpuLimit?: number
  resourceLimits?: ResourceLimits
  envVars?: Record<string, string>
  networkAllowlist?: readonly string[]
  workingDir?: string
  entrypoint?: readonly string[]
  dockerOptions?: Record<string, unknown>
}
```

注意：`networkDisabled` 和 `readonlyRootfs` 不在 system definition 上。它们是 workspace 级安全策略。

### 4.2 WorkspaceSandboxConfig

workspace config 是项目级配置：

```ts
interface WorkspaceSandboxConfig {
  enabled?: boolean
  sandbox?: string
  agentIds?: readonly string[]
  allowExternalNetwork?: boolean
  readonlyRootfs?: boolean
  imageOverride?: string
  memoryLimitOverride?: string
  cpuLimitOverride?: number
  envVarsOverride?: Record<string, string>
  extraMounts?: readonly { path: string; readonly?: boolean }[]
  sandboxSessionKinds?: SessionKind[]
}
```

`enabled` 为真且能解析到沙箱定义（`sandbox` 显式指定，或未指定时回退名为 `default` 的 system 定义）时，才有机会启动 sandbox。`agentIds` 来自 normalize 后的 custom agent pool；sandbox 只从这个 pool 随机选一个 agent。`image`（或 `imageOverride`）指向使用方自建、预装 vendor CLI 的镜像；未 override 时用所解析 system 定义的 `image`。`extraMounts` 是补充映射目录，每项按宿主绝对路径同路径映射进容器，默认只读。`sandboxSessionKinds` 决定哪些 `SessionKind` 的 run 进沙箱，缺省 `['work']`。

### 4.3 ResolvedSandboxConfig

合并后得到 driver 可直接使用的 resolved config：

```ts
interface ResolvedSandboxConfig {
  type: SandboxType
  image: string
  seccomp?: string
  memoryLimit: string
  cpuLimit: number
  resourceLimits?: ResourceLimits
  networkDisabled: boolean
  networkAllowlist?: readonly string[]
  readonlyRootfs: boolean
  envVars: Record<string, string>
  workingDir?: string
  entrypoint?: readonly string[]
  dockerOptions?: Record<string, unknown>
}
```

默认值：

- `memoryLimit = "512m"`。
- `cpuLimit = 1`。
- `networkDisabled = true`。
- `readonlyRootfs = true`。
- `envVars = {}`。

## 5. 业务规则

| ID       | 规则                                                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SND-R1   | Phase 1 仅支持 Docker runtime。`gvisor`、`kata`、`firecracker` 是后续 backend。                                                                                                                                                                                                                                 |
| SND-R2   | 每个 system sandbox definition 通过唯一 `name` 标识。重复注册时 registry 覆盖旧值。                                                                                                                                                                                                                             |
| SND-R3   | workspace config 通过 `sandbox` 字段引用 system definition；解析时把 system base 与 workspace override 合并。                                                                                                                                                                                                   |
| SND-R3b  | workspace 未指定 `sandbox` 名时，回退到名为 `default` 的 system 沙箱定义（用其镜像与模板）；若不存在 `default` 定义，则视为未配置沙箱（等同禁用）。                                                                                                                                                             |
| SND-R4   | workspace override 优先级高于 system definition。同名 env var 由 workspace 覆盖，env map 是 merge 不是 replace。                                                                                                                                                                                                |
| SND-R5   | 缺省值 deny-by-default：512 MB、1 CPU、禁网、只读 rootfs、空 env。                                                                                                                                                                                                                                              |
| SND-R6   | Docker runtime 只连接本地 Docker daemon；不支持远程 Docker host。                                                                                                                                                                                                                                               |
| SND-R7   | stop 是幂等操作；容器已停止或已删除时吞掉错误。                                                                                                                                                                                                                                                                 |
| SND-R8   | health check 不抛运行态错误；inspect 失败返回 `running: false` 与错误信息。                                                                                                                                                                                                                                     |
| SND-R9   | 当前默认 seccomp profile 是 MVP permissive；后续阶段收紧。                                                                                                                                                                                                                                                      |
| SND-R10  | sandbox 启用时容器始终接入内部网络 `c3-mcp-net`（`docker network --internal`，无外网路由），供访问宿主 c3 MCP；外网由 `allowExternalNetwork` 控制（缺省 false ⇒ 不挂 egress bridge）。旧 `networkDisabled` 已移除，normalize 时把遗留磁盘键迁移为 `allowExternalNetwork = !networkDisabled`。                   |
| SND-R10b | 宿主 c3 MCP（及 codex relay）经 forwarder sidecar 暴露到 `c3-mcp-net`；sidecar 双网卡（内部网 + 可达宿主 bridge），仅做端口转发，digest pin、cap-drop、只读根、非 root。                                                                                                                                        |
| SND-R10c | MCP 传输统一为 loopback HTTP：两个 vendor 都走 c3 HTTP MCP 端点，Claude 改用 HTTP、移除进程内绑定。sandbox 下两 vendor 的 MCP server URL（及 codex relay base URL）改写为 sidecar 网络别名；回环纵深防御由 `isLoopback` 调整为「`c3-mcp-net` 可达 + per-run token」。大方向见 `sandbox-architecture.md` §12.5。 |
| SND-R11  | `networkAllowlist` 是 Phase 2 extension point；当前非空时拒绝启动。                                                                                                                                                                                                                                             |
| SND-R12  | `resourceLimits` 优先于 flat `memoryLimit` / `cpuLimit`；stop timeout 只能通过 `resourceLimits.stopTimeoutMs` 表达。                                                                                                                                                                                            |
| SND-R13  | sandbox 仅对具备隔离 worktree（`effectiveCwd`）且 `gitBranchMode === 'worktree'` 的 run 生效；在此结构性前提上，再按 `sandboxSessionKinds` 过滤 run 的 `sessionKind`。普通 chat run（无 worktree）与 current-branch dev run 结构性排除。                                                                        |
| SND-R13b | `sandboxSessionKinds` 缺省 `['work']`；normalize 去重、丢弃 `SESSION_KINDS` 之外的值，归一化后为空则回退 `['work']`。勾选某 kind 只对该 kind 且具隔离 worktree 的 run 生效；从不产生 worktree run 的 kind 即使勾选也不会进沙箱。                                                                                |
| SND-R14  | sandbox 采用同路径映射：宿主绝对路径 = 容器绝对路径。项目原目录（workspace root）只读挂载，run worktree 读写挂载，workspace specs root 以宿主相同绝对路径读写挂载。                                                                                                                                             |
| SND-R14b | workspace 可配置 `extraMounts` 补充映射目录，每项同路径映射、默认只读；补充目录不得覆盖 worktree、项目原目录、specsBase 等保留路径，映射前须 canonicalize 并做 allowlist 校验。                                                                                                                                 |
| SND-R15  | sandbox 启用时，从 normalized custom agent pool 随机选择一个 agent 并 pin 到 pending run；被选 agent 的 vendor 决定容器内入口命令（镜像 PATH 中的 CLI）与 provider 接线。                                                                                                                                       |
| SND-R16  | 工具随镜像分发：镜像名由 workspace 配置，预装 claude/codex/npm 等；c3 不下载、不版本化 vendor CLI，启动前 `docker image inspect` 确认镜像存在与 arch，缺失/不符 hard-fail。                                                                                                                                     |
| SND-R17  | codex RELAY 在 sandbox 下经 forwarder sidecar（`c3-mcp-net`）回连宿主 loopback relay，不再依赖 `host.docker.internal:host-gateway` 直连，也不要求 `allowExternalNetwork`；relay 监听面不扩大。                                                                                                                  |
| SND-R18  | composition root 必须实例化 Docker runtime 与 SandboxRegistry，并注入 run launch 依赖；否则 sandbox gate 永远不会触发。                                                                                                                                                                                         |
| SND-R19  | Docker daemon socket 解析顺序为 `DOCKER_HOST`、`/var/run/docker.sock`、`~/.docker/run/docker.sock`、`~/.colima/default/docker.sock`、`~/.rd/docker.sock`、dockerode 默认值。                                                                                                                                    |
| SND-R20  | 宿主 spawn wrapper 的 cwd 必须是宿主 worktree；容器内 cwd 由 wrapper 的 `docker exec -w <worktree 宿主同路径>` 设置，与宿主 worktree 绝对路径一致。                                                                                                                                                             |
| SND-R21  | wrapper env-file 会过滤指向宿主 loopback 的 proxy env，避免容器内访问 `127.0.0.1` 时误连自己。                                                                                                                                                                                                                  |
| SND-R22  | Claude sandbox wrapper 注入 `IS_SANDBOX=1`，允许 root 容器内使用 skip-permissions 模式。                                                                                                                                                                                                                        |
| SND-R23  | 同路径映射的所有目录（项目原目录、worktree、specsBase、extraMounts）必须位于 Docker Desktop file sharing 范围内，否则 macOS 下会空挂载；worktree 仍要求位于 c3 home 下。                                                                                                                                        |
| SND-R24  | `allowExternalNetwork`（缺省 false，deny-by-default）/ `readonlyRootfs`（缺省 true）是 workspace 级安全策略，不属于 system definition；遗留磁盘键 `networkDisabled` 在 normalize 时迁移为 `allowExternalNetwork`。                                                                                              |

## 6. Driver contract

每个 runtime backend 必须实现同一组能力：

| 操作          | 输入                                         | 输出            | Docker 实现                                |
| ------------- | -------------------------------------------- | --------------- | ------------------------------------------ |
| `start`       | `ResolvedSandboxConfig` + `StartOptions`     | `SandboxHandle` | create container，然后 start。             |
| `stop`        | `SandboxHandle` + `StopOptions`              | void            | stop container，可选 remove。              |
| `exec`        | `SandboxHandle` + argv                       | `ExecResult`    | Docker exec，收集 stdout/stderr/exitCode。 |
| `spawnStream` | `SandboxHandle` + argv                       | readable stream | Docker exec stream。                       |
| `snapshot`    | `SandboxHandle` + tag                        | image id        | Docker commit。                            |
| `healthCheck` | `SandboxHandle`                              | `HealthStatus`  | Docker inspect。                           |
| `copyFrom`    | `SandboxHandle` + container path + host path | void            | Docker archive copy，用于 checkpoint。     |

上层只依赖 `SandboxDriver`，不直接依赖 dockerode。

## 7. Docker runtime 实现

`DockerDriver.start()` 把 resolved config 映射为 Docker create options：

| c3 字段                                 | Docker 字段                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `memoryLimit` / `resourceLimits.memory` | `HostConfig.Memory`                                                                               |
| `cpuLimit` / `resourceLimits.cpu`       | `HostConfig.CpuPeriod` + `HostConfig.CpuQuota`                                                    |
| `readonlyRootfs`                        | `HostConfig.ReadonlyRootfs`                                                                       |
| sandbox 启用（始终）                    | 容器接入内部网络 `c3-mcp-net`（`NetworkMode`/`EndpointsConfig` 指向该网），并起 forwarder sidecar |
| `allowExternalNetwork = true`           | 额外挂一张可 egress 的 bridge（多网络 attach）                                                    |
| `allowExternalNetwork = false`（默认）  | 只在 `c3-mcp-net` 上，无 egress bridge                                                            |
| `resourceLimits.stopTimeoutMs`          | `HostConfig.StopTimeout`                                                                          |
| `seccomp`                               | `HostConfig.SecurityOpt`                                                                          |
| start `binds`                           | `HostConfig.Binds`                                                                                |
| `envVars`                               | `Env`                                                                                             |
| `workingDir`                            | `WorkingDir`                                                                                      |
| `entrypoint`                            | `Cmd`                                                                                             |

`dockerOptions.HostConfig` 会 deep merge 到 `HostConfig`，用于专家级扩展。使用者要避免通过 `dockerOptions` 绕开 deny-by-default 安全策略；需要新增安全能力时优先扩展显式字段。

## 8. Sandbox 启动流程

当前启动流程：

```
run lifecycle
  → 确认 run 有 effectiveCwd，即 worktree run
  → 读取 workspace sandbox config
  → sandbox 未启用或 system def 不存在：返回 null，不启动 sandbox
  → registry.resolve(systemName, workspaceConfig)
  → docker image inspect <image>：缺失或 arch 不符 hard-fail
  → resolveMounts()：项目原目录 ro + worktree rw + specsBase rw + extraMounts
  → ensure c3-mcp-net + forwarder sidecar（转发宿主 MCP/relay）
  → driver.start(resolvedConfig, binds + labels + 内部网 [+ egress bridge if allowExternalNetwork])
  → 创建 tmpDir
  → createSandboxWrapper(handle, tmpDir, entryCommand, envVars)
  → codex：MCP/relay URL 改写为 sidecar 网络别名
  → vendor SDK/driver spawn wrapper
  → run 完成后 stop container + 清理 sidecar/网络（按复用策略）+ 删除 tmpDir
```

启动时固定 mount（宿主绝对路径 = 容器绝对路径）：

- `<workspace root>:<workspace root>:ro`（项目原目录，参考基线代码，禁止写回）。
- `<worktree>:<worktree>`（run 的唯一代码改动面，读写）。
- `<specsBase>:<specsBase>`（读写，支持 specs reverse-sync）。

启动时固定 label：

- `c3.sandbox=true`。
- `c3.project=<workspace path escaped>`。
- `c3.worktree=<worktree path escaped>`。

补充 mount（可选，来自 `extraMounts`）：

- `<path>:<path>[:ro]`，默认只读，同路径映射。

工具不再通过 mount 注入：claude/codex/npm 由镜像预装，wrapper 直接调用镜像 PATH 中的入口命令，无 `/opt/vendor` 只读挂载。

## 9. Wrapper 机制

`createSandboxWrapper()` 在宿主 tmpDir 写两个文件：

- `env.txt`：传给 `docker exec --env-file`。
- `wrapper.sh`：宿主可执行脚本。

wrapper 形态：

```sh
#!/bin/sh
exec docker exec --env-file "<envFile>" -i -w "<worktreeHostPath>" "<containerId>" "<entryCommand>" "$@"
```

vendor SDK/driver 仍以为自己在 spawn 一个普通本地 CLI；实际进程被 wrapper 转发到容器内。

关键要求：

- 宿主 spawn cwd 必须是宿主 worktree。
- 容器内 cwd 与宿主 worktree 绝对路径一致（同路径映射）。
- `<entryCommand>` 是镜像 PATH 中的 vendor CLI 名（如 `claude`、`codex`），不是 `/opt/vendor` 路径。
- wrapper 需要能找到宿主 `docker` executable。
- env-file 在 `docker exec` 时读取，允许 codex RELAY 在 wrapper 创建后追加 per-run token。

## 10. Agent 选择与 provider 接线

sandbox 启用时，`pickSandboxAgent()` 从 workspace 的 normalized `agentIds` 中随机选一个：

- pool 为空：hard-fail。
- id 已失效或 resolve 回落 default：hard-fail。
- vendor 不支持 sandbox：hard-fail。
- codex 缺少 wire API：hard-fail。

当前支持：

- Claude：provider env 通过 wrapper env-file 进入容器，注入 `IS_SANDBOX=1`。
- Codex DIRECT：base URL/model 由 SDK 生成 argv，经 wrapper `"$@"` 进入容器；`CODEX_API_KEY` 写入 env-file。
- Codex RELAY：base URL 改写到 `host.docker.internal`；per-run relay token 写入 env-file 作为 `CODEX_API_KEY`；容器网络放通时 Docker 加 `host-gateway` extra-host。

hard-fail 是安全要求：sandbox enabled 的 run 不能因为容器或 vendor 接线失败而退回宿主裸跑。

## 11. 文件系统策略

运行期文件系统目标：

| 路径（宿主=容器同路径） | 权限          | 说明                                            |
| ----------------------- | ------------- | ----------------------------------------------- |
| 项目原目录              | ro            | 参考基线代码，禁止写回主 checkout。             |
| worktree                | rw            | agent 修改代码的唯一主路径。                    |
| `<specsBase>`           | rw            | 与宿主同绝对路径挂载，支持 specs reverse-sync。 |
| `extraMounts[i]`        | ro（默认）    | 补充依赖/缓存/参考目录，可按项声明为 rw。       |
| container rootfs        | ro by default | 由 workspace `readonlyRootfs` 控制，默认只读。  |
| 工具运行时 home/cache   | rw            | 由镜像内工具默认路径或 tmpfs 承载。             |

项目原目录只读挂载：agent 可读取基线代码，但所有写入只能落在 worktree，避免一次 run 污染用户当前 checkout。工具已随镜像分发，不再挂载 `/opt/vendor` 只读安装树。

## 12. 网络策略

网络分两个平面（大方向见 `sandbox-architecture.md` §12）：

**MCP 内部平面（始终常开）：**

- sandbox 启用时容器接入内部网络 `c3-mcp-net`（`docker network create --internal`，无外网路由）。
- forwarder sidecar 双网卡（`c3-mcp-net` + 可达宿主的 bridge），把宿主 loopback 上的 c3 MCP（及 codex relay）转发进来。
- MCP 传输统一为 loopback HTTP：两个 vendor（Claude 改用 HTTP、移除进程内绑定）的 MCP URL、以及 codex relay base URL，均改写为 sidecar 网络别名（如 `http://c3-mcp:<port>/...?token=`）。

**外部平面（`allowExternalNetwork` 控制）：**

- 缺省 `false`：容器只在 `c3-mcp-net` 上，无 internet egress。能调 c3 MCP，不能上外网。
- `true`：额外挂一张可 egress 的 bridge。用于 DIRECT 模式 CLI 直连 provider API、npm/go 拉依赖等。
- RELAY 模式无需外网：LLM 流量经 sidecar → 宿主 relay → 外网；DIRECT 模式未开外网则请求无路由 hard-fail。

限制：

- `networkAllowlist` 当前不支持，非空即拒绝启动（Phase 2）。
- 遗留磁盘键 `networkDisabled` 在 normalize 时迁移为 `allowExternalNetwork`（`= !networkDisabled`）；wire 层已单一字段。MCP 内部网始终常开，不再是旧 `--network none` 全断。
- Linux native Docker 的 `host.docker.internal` 可达性与 Docker Desktop 不完全一致，正式收敛需要后续 in-container relay sidecar 或 egress proxy。
- c3 自己的 MCP 工具面现在对两个厂商都走**宿主回环 HTTP MCP 端点**。容器内 `127.0.0.1` / `localhost` 指向容器自身而非宿主,因此从**沙箱容器内部**到达该宿主端点的能力尚未打通,与上一条同属后续 sandbox-network 工作(in-container relay sidecar / egress 通道)——本期只保证并验证宿主直连路径,是一个已知的后续阶段,而非回退。

## 13. 运行期环境卫生

env-file 来源包含 c3 server 环境与 vendor-specific env。写入前必须过滤宿主 loopback proxy：

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- 小写同名变量
- `NO_PROXY` 按 vendor 需求补充

原因：容器内 `127.0.0.1` / `localhost` 是容器自己，不是宿主。把宿主 loopback proxy 带进容器会导致 provider 请求 connection refused。

## 14. Docker 健康检查

`checkDockerAvailable()` 使用最小 `hello-world:latest` 配置启动 throw-away container，并立即 stop/remove。失败时返回明确错误，sandbox enabled 的 run 应 hard-fail 并向 UI 暴露 Docker 不可用原因。

实际启动时的 Docker socket 解析由 `DockerDriver` 完成，覆盖 Docker Desktop、Colima、Rancher Desktop、Linux native 常见路径。

## 15. Checkpoint copy

`preApproveCheckpoint()` 使用 `driver.copyFrom(handle, "<worktree 宿主同路径>", snapshotDir)` 把容器内 worktree 快照复制到宿主临时目录，再执行轻量检查。当前是 MVP 级 top-level 文件检查；后续可扩展为 git diff、文件白名单、大小限制、敏感文件扫描。

## 16. 与架构文档的分工

本文是实现设计，回答：

- 当前 sandbox 具体怎么启动？
- Docker 参数怎么映射？
- wrapper/env-file 怎么工作？
- worktree、specs、network、readonlyRootfs 的规则是什么？
- run lifecycle 如何接入？

`doc/architecture/sandbox-architecture.md` 是大方向架构，回答：

- c3 sandbox 的总体机制与演进方向是什么？
- 参考 OpenClaw、OpenHands、SWE-ReX、Docker Sandboxes 后，c3 采用什么路线？
- 目录如何同路径映射？工具如何随使用方自建镜像分发？
- 容器内 agent 如何调用 c3 MCP？网络如何分段（内部 MCP 网 + 外网开关）？
- 未来如何扩展到 stronger runtime、egress proxy、credential broker？

## 17. Phase plan

| 阶段      | 范围                                                                                                       | 状态             |
| --------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| Phase 1   | Docker runtime、配置/registry/driver、seccomp profile、worktree-only run 接线、wrapper、hard-fail。        | 当前             |
| Phase 1.5 | 同路径映射（项目原目录 ro + worktree rw + extraMounts）、镜像 inspect 健康检查、wrapper cwd/入口命令切换。 | 规划，见架构文档 |
| Phase 2   | gVisor/Kata/Firecracker backend、seccomp 收紧、resource monitoring、network allowlist/egress proxy。       | 规划             |
| Phase 3   | 远程 sandbox / cloud runtime，需要单独 ADR。                                                               | 未来             |
