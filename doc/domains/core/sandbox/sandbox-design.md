# sandbox — 领域实现设计

## 1. 定位

sandbox 领域为 agent 执行提供容器级隔离。c3 不再让 vendor CLI 直接在宿主工作区里运行，而是在满足条件的 worktree intent-dev run 中启动一个轻量容器，把 run 的 isolated worktree 挂载到容器 `/workspace`，再通过宿主 wrapper 把 Claude Code / Codex CLI 进程转发到容器内执行。

本文负责实现细节：配置模型、配置合并、sandbox driver contract、Docker runtime、run lifecycle 接线、wrapper、网络与文件系统策略、运行期环境卫生。大方向架构和 vendor CLI 容器化供应链见 `doc/architecture/sandbox-architecture.md`。

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
- vendor CLI 的下载、版本化、验证与只读挂载属于 vendor runtime 供应链，架构见 `doc/architecture/sandbox-architecture.md`。

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
  networkDisabled?: boolean
  readonlyRootfs?: boolean
  imageOverride?: string
  memoryLimitOverride?: string
  cpuLimitOverride?: number
  envVarsOverride?: Record<string, string>
}
```

`enabled` 与 `sandbox` 同时有效时，才有机会启动 sandbox。`agentIds` 来自 normalize 后的 custom agent pool；sandbox 只从这个 pool 随机选一个 agent。

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

| ID      | 规则                                                                                                                                                                         |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SND-R1  | Phase 1 仅支持 Docker runtime。`gvisor`、`kata`、`firecracker` 是后续 backend。                                                                                              |
| SND-R2  | 每个 system sandbox definition 通过唯一 `name` 标识。重复注册时 registry 覆盖旧值。                                                                                          |
| SND-R3  | workspace config 通过 `sandbox` 字段引用 system definition；解析时把 system base 与 workspace override 合并。                                                                |
| SND-R4  | workspace override 优先级高于 system definition。同名 env var 由 workspace 覆盖，env map 是 merge 不是 replace。                                                             |
| SND-R5  | 缺省值 deny-by-default：512 MB、1 CPU、禁网、只读 rootfs、空 env。                                                                                                           |
| SND-R6  | Docker runtime 只连接本地 Docker daemon；不支持远程 Docker host。                                                                                                            |
| SND-R7  | stop 是幂等操作；容器已停止或已删除时吞掉错误。                                                                                                                              |
| SND-R8  | health check 不抛运行态错误；inspect 失败返回 `running: false` 与错误信息。                                                                                                  |
| SND-R9  | 当前默认 seccomp profile 是 MVP permissive；后续阶段收紧。                                                                                                                   |
| SND-R10 | `networkDisabled` 默认 true，对应 Docker `NetworkMode: "none"`。                                                                                                             |
| SND-R11 | `networkAllowlist` 是 Phase 2 extension point；当前非空时拒绝启动。                                                                                                          |
| SND-R12 | `resourceLimits` 优先于 flat `memoryLimit` / `cpuLimit`；stop timeout 只能通过 `resourceLimits.stopTimeoutMs` 表达。                                                         |
| SND-R13 | sandbox 只服务 worktree intent-dev run；普通 chat run 与 current-branch dev run 不进入 sandbox。                                                                             |
| SND-R14 | sandbox 配置按 workspace 解析，实际 bind mount 的代码目录是 run 的 worktree，容器路径固定为 `/workspace`；workspace specs root 以宿主相同绝对路径读写挂载。                  |
| SND-R15 | sandbox 启用时，从 normalized custom agent pool 随机选择一个 agent 并 pin 到 pending run；被选 agent 的 vendor 决定容器内 binary 与 provider 接线。                          |
| SND-R17 | codex RELAY 在网络放通时通过 `host.docker.internal:host-gateway` 回连宿主 loopback relay，不扩大 relay 监听面。                                                              |
| SND-R18 | composition root 必须实例化 Docker runtime 与 SandboxRegistry，并注入 run launch 依赖；否则 sandbox gate 永远不会触发。                                                      |
| SND-R19 | Docker daemon socket 解析顺序为 `DOCKER_HOST`、`/var/run/docker.sock`、`~/.docker/run/docker.sock`、`~/.colima/default/docker.sock`、`~/.rd/docker.sock`、dockerode 默认值。 |
| SND-R20 | 宿主 spawn wrapper 的 cwd 必须是宿主 worktree；容器内 cwd 由 wrapper 的 `docker exec -w /workspace` 单独设置。                                                               |
| SND-R21 | wrapper env-file 会过滤指向宿主 loopback 的 proxy env，避免容器内访问 `127.0.0.1` 时误连自己。                                                                               |
| SND-R22 | Claude sandbox wrapper 注入 `IS_SANDBOX=1`，允许 root 容器内使用 skip-permissions 模式。                                                                                     |
| SND-R23 | worktree 必须位于 c3 home 下，避免 macOS `$TMPDIR` 不在 Docker Desktop file sharing 范围导致 `/workspace` 空挂载。                                                           |
| SND-R24 | `networkDisabled` / `readonlyRootfs` 是 workspace 级安全策略，不属于 system definition；缺省均为 true。                                                                      |

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

| c3 字段                                 | Docker 字段                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `memoryLimit` / `resourceLimits.memory` | `HostConfig.Memory`                                                             |
| `cpuLimit` / `resourceLimits.cpu`       | `HostConfig.CpuPeriod` + `HostConfig.CpuQuota`                                  |
| `readonlyRootfs`                        | `HostConfig.ReadonlyRootfs`                                                     |
| `networkDisabled`                       | `HostConfig.NetworkMode = "none"`                                               |
| `networkDisabled = false`               | 不设置 `NetworkMode`，并加 `ExtraHosts = ["host.docker.internal:host-gateway"]` |
| `resourceLimits.stopTimeoutMs`          | `HostConfig.StopTimeout`                                                        |
| `seccomp`                               | `HostConfig.SecurityOpt`                                                        |
| start `binds`                           | `HostConfig.Binds`                                                              |
| `envVars`                               | `Env`                                                                           |
| `workingDir`                            | `WorkingDir`                                                                    |
| `entrypoint`                            | `Cmd`                                                                           |

`dockerOptions.HostConfig` 会 deep merge 到 `HostConfig`，用于专家级扩展。使用者要避免通过 `dockerOptions` 绕开 deny-by-default 安全策略；需要新增安全能力时优先扩展显式字段。

## 8. Sandbox 启动流程

当前启动流程：

```
run lifecycle
  → 确认 run 有 effectiveCwd，即 worktree run
  → 读取 workspace sandbox config
  → sandbox 未启用或 system def 不存在：返回 null，不启动 sandbox
  → registry.resolve(systemName, workspaceConfig)
  → driver.start(resolvedConfig, binds + labels)
  → 创建 tmpDir
  → createSandboxWrapper(handle, tmpDir, vendorBinary, envVars)
  → vendor SDK/driver spawn wrapper
  → run 完成后 stop container + 删除 tmpDir
```

启动时固定 mount：

- `<worktree>:/workspace`。
- `<specsBase>:<specsBase>`。

启动时固定 label：

- `c3.sandbox=true`。
- `c3.project=<workspace path escaped>`。
- `c3.worktree=<worktree path escaped>`。

后续 vendor runtime 供应链接入后，还会增加：

- `<vendor installed>:/opt/vendor/<vendor>:ro`。
- vendor runtime home/cache 的 tmpfs、named volume 或 overlay upper。

## 9. Wrapper 机制

`createSandboxWrapper()` 在宿主 tmpDir 写两个文件：

- `env.txt`：传给 `docker exec --env-file`。
- `wrapper.sh`：宿主可执行脚本。

wrapper 形态：

```sh
#!/bin/sh
exec docker exec --env-file "<envFile>" -i -w /workspace "<containerId>" "<binaryName>" "$@"
```

vendor SDK/driver 仍以为自己在 spawn 一个普通本地 CLI；实际进程被 wrapper 转发到容器内。

关键要求：

- 宿主 spawn cwd 必须是宿主 worktree，不是 `/workspace`。
- 容器内 cwd 固定为 `/workspace`。
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

| 路径                   | 权限          | 说明                                                    |
| ---------------------- | ------------- | ------------------------------------------------------- |
| `/workspace`           | rw            | run worktree，是 agent 修改代码的唯一主路径。           |
| `<specsBase>`          | rw            | 与宿主同绝对路径挂载，支持 specs reverse-sync。         |
| container rootfs       | ro by default | 由 workspace `readonlyRootfs` 控制，默认只读。          |
| `/opt/vendor/<vendor>` | ro            | vendor CLI 安装树，属于 vendor runtime 供应链后续扩展。 |
| vendor home/cache      | rw isolated   | 后续通过 tmpfs/named volume/overlay upper 提供。        |

不得把 workspace 主项目目录挂入容器。容器看到的是 isolated worktree，不是用户当前 checkout。

## 12. 网络策略

默认：

- `networkDisabled = true`。
- Docker `NetworkMode = "none"`。

放通：

- workspace 显式设置 `networkDisabled = false`。
- Docker runtime 不设置 `NetworkMode`。
- 增加 `host.docker.internal:host-gateway`，供 codex RELAY 回连宿主 loopback relay。

限制：

- `networkAllowlist` 当前不支持，非空即拒绝启动。
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

`preApproveCheckpoint()` 使用 `driver.copyFrom(handle, "/workspace", snapshotDir)` 把容器内 workspace 快照复制到宿主临时目录，再执行轻量检查。当前是 MVP 级 top-level 文件检查；后续可扩展为 git diff、文件白名单、大小限制、敏感文件扫描。

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
- vendor CLI 如何版本化、下载、验证并挂进 sandbox？
- 未来如何扩展到 stronger runtime、egress proxy、credential broker？

## 17. Phase plan

| 阶段      | 范围                                                                                                 | 状态             |
| --------- | ---------------------------------------------------------------------------------------------------- | ---------------- |
| Phase 1   | Docker runtime、配置/registry/driver、seccomp profile、worktree-only run 接线、wrapper、hard-fail。  | 当前             |
| Phase 1.5 | vendor CLI sandbox 供应链：版本化目录、下载/解包/验证、只读挂载、UI 状态。                           | 规划，见架构文档 |
| Phase 2   | gVisor/Kata/Firecracker backend、seccomp 收紧、resource monitoring、network allowlist/egress proxy。 | 规划             |
| Phase 3   | 远程 sandbox / cloud runtime，需要单独 ADR。                                                         | 未来             |
