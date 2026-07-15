# Sandbox Architecture

## 1. 背景与结论

c3 已经具备 Phase 1 sandbox 能力：通过本地 Docker runtime 启动容器，worktree intent-dev run 才进入 sandbox，vendor CLI 由宿主 SDK/driver spawn 一个 wrapper，再由 wrapper `docker exec` 到容器内执行。现有实现细节见 `doc/domains/core/sandbox/sandbox-design.md`，决策边界见 ADR-0024、ADR-0025。

本文负责“大方向架构设计”：说明 c3 sandbox 的整体演进路线，调研 OpenClaw、OpenHands、SWE-ReX、Docker Sandboxes 等方案，并给出 c3 sandbox 的目录映射与工具分发模型。具体 Docker 参数、wrapper、配置合并、run lifecycle 接线等实现细节，由 `doc/domains/core/sandbox/sandbox-design.md` 维护。

方案的核心调整是：

**c3 sandbox 不再负责 vendor CLI 的下载、版本化、验证与挂载。claude code、codex、npm 等所有工具由使用方预先构建进 sandbox 镜像；c3 只负责把代码目录按宿主绝对路径映射进容器，并按 workspace 配置追加补充映射目录。**

核心结论：

1. 保留现有 `SandboxLauncher + DockerDriver + wrapper` 模型。
2. 删除 vendor CLI 供应链（宿主下载、容器解包、同 profile 验证、版本目录、GC、UI 版本管理）。工具随镜像分发，“工具版本”即“镜像内版本”。
3. sandbox 镜像名由 workspace setting 配置。c3 把镜像视为不透明的工具环境，不解析、不管理其内部工具版本。
4. 目录映射采用“宿主绝对路径 = 容器绝对路径”的同路径模型：项目原目录只读、run worktree 读写，workspace 可配置补充映射目录。
5. wrapper 的容器内工作目录改为宿主 worktree 同路径，而不是固定的 `/workspace`；入口命令直接使用镜像 PATH 中的 vendor CLI。

> 与现状差异：本方案取代现设计里“worktree 固定挂到 `/workspace`、禁止挂载主项目目录”的既有决策，也取代原“宿主 vendor 供应链 + `/opt/vendor` 只读挂载”的规划。落地时需要同步更新 `sandbox-design.md`（尤其 SND-R14、SND-R20、第 8/11 节）及相关 ADR。

## 2. 开源 agent sandbox 调研

### 2.1 OpenClaw

OpenClaw 的公开文档给出的模型是“Gateway 保持在宿主，tool execution 进入 sandbox”。sandbox 默认关闭，可通过全局或 per-agent 配置启用；sandbox 后端包括 Docker、SSH、OpenShell。Docker backend 默认值包含 `network: "none"`、`readOnlyRoot: true`、`capDrop: ["ALL"]`，并明确 blocking `network: "host"` 与默认阻止容器 namespace join。参考：

- https://docs.openclaw.ai/gateway/sandboxing
- https://docs.openclaw.ai/install/docker

可借鉴点：

- 控制面留宿主，执行面进 sandbox，避免把整个 gateway/server 复杂状态迁入容器。
- sandbox scope 是显式维度：agent/session/shared。c3 当前更接近 per-run/per-session container，应继续保持，不建议共享容器作为默认。
- Docker 安全默认值务实：无网络、只读根、drop capabilities、阻止危险 network mode。
- bind mount 需要 canonicalize 与 allowlist，避免软链逃逸和覆盖保留路径。

不直接采用点：

- OpenClaw 的 sandbox 粒度是工具执行，c3 的 claude/codex wrapper 模型是把 vendor CLI 进程整体放进容器。c3 不应把 `read/write/edit/apply_patch` 拆成远程工具代理，否则会破坏现有 vendor SDK/CLI 语义。
- OpenClaw 支持 SSH/OpenShell 后端，但 c3 当前 ADR 约束是 Docker Phase 1；远程后端属于 Phase 3，需要单独 ADR。

### 2.2 OpenHands

OpenHands / Agent Canvas 强调 agent backend 可在本地、Docker、VM、云端或企业基础设施中运行，Agent Server 通过 REST API 承载多个 agent。其论文与仓库描述了 native remote execution、environment sandboxing、REST/WebSocket service、lifecycle control 等能力。参考：

- https://github.com/OpenHands/openhands
- https://arxiv.org/html/2511.03690v2

可借鉴点：

- 把 agent 执行环境抽象成 backend/runtime，前端控制台不直接绑定某一种执行位置。
- lifecycle、恢复、事件流与 sandbox runtime 解耦，利于后续远程/云端执行。

不直接采用点：

- OpenHands 的 Agent Server 可整体运行在远端或容器内；c3 当前 server 是单进程、WebSocket、进程内 session runtime registry。把 c3 server 放入每个 sandbox 会重写 composition root、session registry、provider 凭据与端口生命周期，当前不作为本方案目标。

### 2.3 SWE-agent / SWE-ReX

SWE-ReX 是 sandboxed shell runtime interface，同一 agent 逻辑可以跑在本地、Docker、AWS、Modal 等环境，并支持大量并行 shell session。参考：

- https://github.com/SWE-agent/swe-rex

可借鉴点：

- agent 逻辑与执行基础设施分离，runtime contract 承担 shell/session 生命周期。
- 并发运行需要 first-class lifecycle、resource limit、cleanup，而不是临时拼命令。

不直接采用点：

- SWE-ReX 以 shell runtime 为中心；c3 以 vendor CLI session 为中心。c3 应扩展已有 `SandboxDriver`，而不是引入一套独立 shell runtime。

### 2.4 Docker Sandboxes / microVM 方向

Docker Sandboxes 面向 coding agents 提供 microVM 隔离，支持 Claude Code、Codex 等 CLI，强调 filesystem/network/resource policy 和 YOLO/autonomous 模式下的安全边界。Docker 的 agent 安全建议也强调每个 agent 使用独立、可销毁环境，限制网络到必要 endpoint，并使用 scoped credentials。参考：

- https://www.docker.com/products/docker-sandboxes/
- https://www.docker.com/blog/how-to-secure-ai-agents/

可借鉴点：

- microVM 是 Docker container 之后的自然升级方向，可作为 c3 Phase 2/3 runtime backend。
- YOLO / bypass permission 只有在强隔离边界内才合理；这与 c3 ADR-0024 的 hard isolation 一致。
- 网络 egress allowlist 与 credential broker 应独立于“容器是否存在”，作为安全控制面单独设计。
- 把工具预装进容器镜像、按镜像分发是这些产品的通行做法，与本方案“工具随镜像分发”一致。

不直接采用点：

- Docker Sandboxes 是独立产品/runtime。c3 当前 `SandboxDriver` 已预留 `gvisor/kata/firecracker` 类型，应把 microVM 作为 driver backend 演进，而不是把业务层绑死到某个外部 CLI。

## 3. c3 当前约束

c3 现有实现决定了新架构必须满足这些约束：

1. sandbox 仅服务 worktree intent-dev run。chat run、current-branch dev run 不进 sandbox。
2. sandbox 配置按 workspace 解析，实际 bind mount 的代码目录是 run 的 worktree。
3. sandbox 启用后失败路径 hard-fail，不降级 host 裸跑。
4. `networkDisabled` 与 `readonlyRootfs` 是 workspace 级安全策略，默认均为 `true`。
5. provider 连接方式由 vendor adapter 决定：Claude 走 env-file，Codex DIRECT/RELAY 需要把 API key/token 注入 env-file，RELAY 还需要 `host.docker.internal` 回连宿主 relay。
6. wrapper 把 vendor CLI 进程整体转发进容器；vendor SDK/driver 仍以为自己 spawn 的是本地 CLI。
7. `SandboxDriver` 是 kernel 内层能力；目录映射与镜像选择只能停留在 `SandboxLauncher` / config 层，不能把 UI、settings handler、adapter SDK 类型反向带入 driver。

## 4. 目标能力

### 4.1 功能特性

- workspace 配置 sandbox 镜像名，镜像内预装 claude、codex、npm 及其运行依赖。
- 同路径映射：项目原目录 ro、run worktree rw、specsBase rw，容器内外路径完全一致。
- workspace 可配置补充映射目录（`extraMounts`），默认同路径映射、默认只读，可按项声明读写。
- 保留路径与补充路径 canonicalize + allowlist，拒绝软链逃逸与覆盖保留路径。
- sandbox 启动前健康检查：Docker 可用、镜像存在、arch 可运行。
- wrapper 直接调用容器 PATH 中的 vendor 入口命令，容器内 cwd 为宿主 worktree 同路径。

### 4.2 非目标

- 不下载、不解包、不版本化、不验证 vendor CLI。
- 不构建 sandbox 镜像。镜像由使用方自备（自建或从镜像仓库拉取）。
- 不引入远程 Docker host、Kubernetes、SSH sandbox。
- 不把 c3 server 放进 sandbox。
- 不实现通用 egress allowlist / MITM 代理；sandbox 网络接入采用「内部 MCP 网络 + 外网开关」的网络分段（见 §12），而非 per-endpoint 代理白名单。

## 5. 架构总览

```
┌─ SandboxLauncher ──────────────────────────────────────────────┐
│  resolve workspace sandbox config（含镜像名 + extraMounts）      │
│  docker image inspect <image> → 缺失 hard-fail                  │
│  resolveMounts()：项目原目录 ro + worktree rw + specs + 补充     │
│  driver.start() → wrapper → vendor adapter spawn                │
├─ DockerDriver ──────────────────────────────────────────────────┤
│  start/stop/exec/stream/snapshot/health/copy                     │
│  同路径 bind，deny-by-default（禁网、只读根、资源上限）           │
├─ sandbox 镜像（使用方自建） ─────────────────────────────────────┤
│  claude / codex / npm 等工具与依赖预装，视为不透明工具环境        │
└─────────────────────────────────────────────────────────────────┘
```

本方案不再新增 `server/src/vendor/` 供应链层。原规划中的 `VendorManager` / `Downloader` / `VendorRegistry` / 版本目录 / GC 全部删除，职责外移到镜像构建流程（使用方 CI/Dockerfile）。

职责边界：

| 模块              | 职责                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SandboxLauncher` | 解析 workspace sandbox config（镜像名 + 映射）、镜像健康检查、`resolveMounts()`、启动容器、创建 wrapper、清理 tmpDir。 |
| `DockerDriver`    | runtime backend contract 实现；把 resolved config + mounts 映射为 Docker create options。                              |
| sandbox 镜像      | 由使用方维护，预装并 pin vendor CLI 与依赖；c3 不感知其内部结构，只依赖 PATH 中的入口命令可执行。                      |

## 6. 目录映射模型

同路径原则：宿主 `/abs/path` 映射到容器 `/abs/path`，绝对路径完全一致。理由：

- vendor CLI 与 agent 生成的路径（诊断、日志、patch、报错、绝对路径工具调用）在容器内外一致，无需路径改写。
- specs reverse-sync、绝对路径引用不因 `/workspace` 前缀漂移。
- 补充目录可无歧义地按原样映射，无需为每个目录约定容器内前缀。

固定映射：

| 宿主路径                     | 容器路径 | 权限 | 说明                                      |
| ---------------------------- | -------- | ---- | ----------------------------------------- |
| 项目原目录（workspace root） | 同路径   | ro   | agent 参考基线代码，禁止写回主 checkout。 |
| run worktree                 | 同路径   | rw   | 唯一代码改动面。                          |
| specsBase                    | 同路径   | rw   | 集中式 specs，支持 reverse-sync。         |

补充映射：workspace 配置 `extraMounts`，每项 `{ path, readonly? }`。默认同路径映射、默认只读；按项可声明读写。用于把额外的依赖目录、共享缓存、参考仓库等按原路径带入容器。

约束：

- 所有映射路径先 canonicalize，再对照 allowlist / denylist；拒绝映射敏感系统目录、拒绝软链逃逸。
- 补充目录不得覆盖或被覆盖于 worktree、项目原目录、specsBase 等保留路径。
- 项目原目录只读，防止一次 run 污染主 checkout；agent 的所有写入应落在 worktree。
- 补充目录默认只读；确需写入时由 workspace 显式声明，风险由使用方承担。

## 7. 镜像模型

- 镜像名来自 workspace setting，由现有 sandbox 配置的 `image` / `imageOverride` 字段承载。workspace 未指定 `sandbox` 名时，回退到名为 `default` 的 system 沙箱定义并使用其镜像；无 `default` 定义则视为未配置沙箱（等同禁用）。
- 镜像被视为不透明的工具环境：预装 claude、codex、npm 及其运行所需依赖。
- c3 不解析、不管理镜像内工具版本。“用哪个工具版本”等价于“配哪个镜像”。
- wrapper 直接调用容器 PATH 中的入口命令（`claude` / `codex` / `npm` / `gh` …），不再指向 `/opt/vendor/...`。
- 启动前 `docker image inspect <image>`：镜像缺失则 hard-fail，并提示使用方拉取或构建镜像。
- 镜像构建规范（Dockerfile、工具版本 pin、目标 arch、非 root 用户）由使用方维护，不属于 c3 运行时职责。c3 可在文档中提供参考 Dockerfile，但参考镜像不进入启动路径。
- 依赖凭证的 CLI（如 `gh`、`glab`）默认不预装：其价值在于访问远程,而 c3 不把凭证映射进 sandbox,且沙箱默认断网,装了也无法使用。远程操作留在宿主(见文件系统与凭据说明);确需在沙箱内使用时由使用方自建镜像并自行注入 scoped 凭证。

## 8. Sandbox 启动集成

目标启动流程：

```
用户启动 worktree intent-dev run
  → runtime.mode == sandbox ? 否：direct 路径
  → resolve workspace sandbox config（镜像名 + extraMounts + 安全策略）
  → docker image inspect <image>
       缺失或 arch 不符：hard-fail run
  → pick sandbox agent 得到 vendor（决定入口命令与 provider 接线）
  → resolveMounts():
       workspace root:workspace root:ro
       worktree:worktree:rw
       specsBase:specsBase:rw
       extraMounts[i]:extraMounts[i]:(ro|rw)
  → DockerDriver.start(image, binds, labels)
  → createSandboxWrapper(handle, tmpDir, entryCommand, cwd=worktree 宿主同路径, env)
  → vendor adapter spawn wrapper
  → run 完成后 stop container + 删除 tmpDir
```

wrapper 形态调整为宿主同路径 cwd + 镜像内入口命令：

```sh
#!/bin/sh
exec docker exec --env-file "<envFile>" -i -w "<worktreeHostPath>" "<containerId>" "<entryCommand>" "$@"
```

- `-w` 从固定 `/workspace` 改为宿主 worktree 同路径。
- `<entryCommand>` 是镜像 PATH 中的 vendor CLI 名，不再是 `/opt/vendor/<vendor>/<cmd>`。
- 宿主 spawn cwd 仍是宿主 worktree；容器内 cwd 与之同路径，语义天然一致。
- env-file 卫生规则（过滤宿主 loopback proxy、codex RELAY 追加 per-run token）保持不变，见 `sandbox-design.md`。

## 9. 文件系统与权限模型

运行时挂载：

| 路径（宿主=容器同路径） | 来源            | 权限          | 说明                                  |
| ----------------------- | --------------- | ------------- | ------------------------------------- |
| 项目原目录              | workspace root  | ro            | 基线代码参考，禁止写回。              |
| run worktree            | worktree        | rw            | agent 修改代码的唯一主路径。          |
| specsBase               | host specs root | rw            | 与宿主同绝对路径，支持 reverse-sync。 |
| extraMounts[i]          | 使用方指定目录  | ro（默认）    | 补充依赖/缓存/参考仓库，可声明为 rw。 |
| container rootfs        | 镜像            | ro by default | 由 workspace `readonlyRootfs` 控制。  |
| 工具运行时 home/cache   | 镜像/tmpfs      | rw            | 由镜像内工具默认路径或 tmpfs 承载。   |

原则：

- 工具已随镜像分发，无需再挂 `/opt/vendor` 只读安装树。
- 项目原目录只读，worktree 读写，隔离一次 run 对主 checkout 的影响。
- container rootfs 继续遵守 workspace `readonlyRootfs`；若镜像内工具需要在特定目录写入 cache，优先用 tmpfs，而不是放开整个 rootfs 可写。

## 10. 跨平台与架构

- 镜像 arch 匹配由使用方保证；c3 只运行 workspace 配置的镜像，不再从镜像派生 vendor target，也不维护 arch 维度的产物目录。
- 启动前 `docker image inspect` 读取 `Os`/`Architecture`，与宿主平台不兼容时 hard-fail 并提示。
- Apple Silicon 建议使用 linux/arm64 镜像；x64 emulation/Rosetta 只作兜底，性能与 syscall/ABI 风险由镜像使用方承担。
- 多 arch 支持是镜像构建侧问题（multi-arch image / 分别构建），不再是 c3 运行时的下载维度。

## 11. 镜像信任与完整性

- 建议 workspace 用 digest pin 配置镜像（`image@sha256:...`）而非浮动 tag，避免 tag 漂移导致工具环境静默变化。
- 启动前 `docker image inspect` 确认镜像存在与 arch，缺失/不符即 hard-fail。
- 工具供应链的信任转移到镜像构建流程：使用方应在 Dockerfile / CI 中 pin 工具版本、校验来源、固定基镜像 digest。
- c3 侧最低要求：把镜像名/digest 记录进 run 元数据，便于审计“这次 run 用的是哪个工具环境”。
- credential broker 作为独立安全控制面另起 ADR；sandbox 的网络分段与受控 egress 见 §12。

## 12. Sandbox 网络与 c3 MCP 接入

sandbox 里运行的 vendor agent 需要调用 c3 自身的 MCP 工具（`publish_event`、`save_intents`、spec 查询、automation 等）。

**MCP 传输统一为 loopback HTTP：** 两个 vendor 都通过宿主回环上的 c3 HTTP MCP 端点（`http://127.0.0.1:<port>/internal/...`）访问工具。c3 已为每组工具维护 HTTP 端点（`intent-mcp`/`event-mcp`/`automation-mcp`/`spec-query-mcp`，codex 在用），Claude 也改用同一 HTTP 端点，不再走进程内（stdio）MCP。这样容器内外机制一致，沙箱只需一条网络路径（见 §12.5）。

沙箱里容器的 `127.0.0.1` 是容器自己，连不到宿主。采用「内部网络 + MCP 转发 sidecar」把宿主 MCP 受控地暴露给容器，同时默认禁绝外网。

### 12.1 网络拓扑

```
              c3-mcp-net (docker network --internal, 无 internet 路由)
   ┌───────────────────┴───────────────────┐
   │                                        │
[sandbox 容器]                       [c3-mcp-forwarder sidecar]
 只接 c3-mcp-net                       双网卡:c3-mcp-net + 可达宿主的 bridge
 → 只能到 sidecar                      转发 c3-mcp-net:<port> → 宿主 127.0.0.1:<mcp/relay port>
 → 无 internet 路由                            │
                                               ▼
                                       宿主 c3 server(MCP + codex relay)
```

- `c3-mcp-net` 用 `docker network create --internal` 创建：该网络**没有到外网的路由**，「禁外网」由网络构造本身保证，不依赖 iptables 规则。
- **sandbox 容器只接 `c3-mcp-net`**（单网卡），唯一可达的是 sidecar；到不了 internet，也到不了宿主其它端口。
- **sidecar 双网卡**：一头 `c3-mcp-net`（供 sandbox），一头普通 bridge / host-gateway（可达宿主）；职责单一——把内部网端口转发到宿主 loopback 上的 c3 MCP（以及 codex relay）。

### 12.2 端点改写

- 两个 vendor 的 MCP server URL 都从 `http://127.0.0.1:<port>/internal/...` 改写为 sidecar 的网络别名 `http://c3-mcp:<port>/internal/...?token=<per-run>`，与现有 relay 改写 `host.docker.internal` 属同一类操作。
- codex relay 的 LLM API base URL 同样指向 sidecar 转发端口，不再依赖 `host.docker.internal:host-gateway` 直连——顺带解决 codex-relay 文档里「Linux 原生 host.docker.internal 已知限制」，统一为一个 sidecar 承载 MCP + relay。
- 回环纵深防御从「`isLoopback` 拒非回环 peer」调整为「仅 `c3-mcp-net` 可达 + per-run 不透明 token」。

### 12.3 外部网络开关

workspace 新增 `allowExternalNetwork`（缺省 `false`），控制容器是否额外获得 internet egress：

- `false`（默认）：容器只在 `c3-mcp-net` 上。**能调 c3 MCP，不能上外网**。
- `true`：额外挂一张可 egress 的 bridge。用于 DIRECT 模式 vendor CLI 直连 `api.anthropic.com` / `api.openai.com`，或 npm/go 拉依赖等。

与 provider 接线的关系：

- **RELAY 模式**：LLM 流量经 sidecar → 宿主 relay → 外网，容器自身无需外网，`allowExternalNetwork=false` 即可工作，沙箱保持 internet 隔离。
- **DIRECT 模式**：CLI 直连 provider API，必须 `allowExternalNetwork=true`，否则请求无路由而 hard-fail。

`allowExternalNetwork` 取代旧 `networkDisabled`（ADR-0025）作为面向 workspace 的外网控制，收敛为单一字段：`networkDisabled` 已从配置面移除，遗留磁盘键在 normalize 时迁移为 `allowExternalNetwork = !networkDisabled`。**关键差异是 MCP 内部网始终常开**（旧 `--network none` 会连 MCP 也断）。收敛决策建议以一条 ADR 记录（补/订正 ADR-0025）。

### 12.4 生命周期

- `c3-mcp-net` 与 forwarder sidecar 随 sandbox run 起停；可 per-run 独立，或按 workspace 复用一张网络 + 一个 sidecar（需评估多 run 隔离与 token 作用域）。
- `StartOptions` / `DockerDriver` 需扩展：支持挂自定义网络、附带 sidecar、按 `allowExternalNetwork` 决定是否再挂 egress bridge。当前仅有 `--network none` 与 host-gateway extra-host 两条路径。
- sidecar 镜像 digest pin，职责仅转发，cap-drop、只读根、非 root。

### 12.5 MCP 传输统一

现状：c3 为每组工具**同时**维护两条绑定——`bindInProcessMcp`（Claude 进程内 `createSdkMcpServer`）与 `bindDriverMcp`（loopback HTTP，codex 在用）。两条调用同一套 handler 逻辑，HTTP 端点明确「re-exposes the SAME tool set」。

决策：**Claude 也改用 HTTP MCP 端点，移除进程内绑定**，让两个 vendor 走同一机制。

- 无需新工具代码：4 组工具（intent/event/spec/automation）的 HTTP 端点均已存在，codex 已在用。
- 简化沙箱：不再有「Claude stdio 天然幸存」的特例，URL 改写与 sidecar 路径对两个 vendor 一致。
- 减重复：可删掉 `bindInProcessMcp` + `createSdkMcpServer` 四个工厂，每组工具只留 HTTP 一条绑定，消除两条绑定手工同步的漂移风险。

注意：

- direct（非沙箱）模式下 Claude 也改走 loopback HTTP + per-run token，比原纯 stdio 略增回环依赖/暴露面；沿用现成的 `isLoopback` + token 防御即可。
- handler 自发的权限确认（如 `save_intents` 的 `permission_request`）与 Claude 的 per-tool 审批均与传输无关，切 HTTP 后行为不变，但落地时应补验证用例。
- `AdapterCapabilities.inProcessMcp` 能力位保留给未来，c3 工具不再依赖它。
- 本节仅统一 **MCP**；Claude 在沙箱内访问 **provider API** 仍是另一回事（Claude 无 relay，DIRECT 直连需 `allowExternalNetwork=true`）。

落地属实现阶段（见 §16 Phase F）。

## 13. 事件与 UI

- 移除 vendor download/unpack/verify/gc 事件与 `settings/VendorVersionsPanel`。
- 保留/新增启动路径的结构化错误 topic：镜像缺失、arch 不符、Docker 不可用、启动失败。
- workspace sandbox 设置面板：
  - 镜像名/digest 输入。
  - 补充映射目录列表：`path` + `ro/rw`。
  - 会话种类勾选 `sandboxSessionKinds`（缺省只勾 `work`）。
  - 外部网络开关 `allowExternalNetwork`（缺省关，仅放通 c3 MCP 内部网）/ `readonlyRootfs` 开关。
- 首次启用 sandbox：检查镜像是否存在。缺失时提示使用方准备镜像（拉取或构建），而不是由 c3 自动下载工具。
- 错误使用 `UiCode`，不硬编码英文文案。

## 14. 配置模型变更

`WorkspaceSandboxConfig` 增加补充映射：

```ts
interface WorkspaceSandboxConfig {
  // ...existing fields...
  extraMounts?: readonly {
    path: string // 宿主绝对路径，同路径映射进容器
    readonly?: boolean // 默认 true
  }[]
  sandboxSessionKinds?: SessionKind[] // 哪些 SessionKind 进沙箱，缺省 ['work']
  allowExternalNetwork?: boolean // 是否放通外网,缺省 false(仅 c3-mcp 内部网)
}
```

`sandboxSessionKinds` 让 workspace 勾选哪些 `SessionKind` 的 run 进沙箱，缺省只勾 `work`；叠加在「worktree-only + 可解析定义」前置条件之上，从不产生 worktree run 的种类即使勾选也不会进容器。

`allowExternalNetwork` 是外网开关，缺省 `false`：容器只接入 `c3-mcp-net`（能调 c3 MCP、不能上外网）；勾选后额外挂 egress bridge。取代已移除的 `networkDisabled`（遗留磁盘键自动迁移），语义见 §12.3。

移除原规划中的 vendor 供应链协议：`RuntimeVendorConfig`、`VendorInstallManifest`、`FetchPlan`、`VendorRuntimeStatus`、per-workspace `vendorCliVersions` override 等一律不引入。

`SystemSettings.vendorCliVersions` / `VendorHostStatus` 仅保留 direct 模式宿主 CLI 的用途，不再扩展 sandbox target 语义。

## 15. 风险与决策

| 风险                                   | 决策                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| 镜像内工具版本不可控 / 漂移            | 使用方在镜像构建侧 pin；建议 workspace 用 digest pin；run 元数据记录 digest。           |
| 同路径映射暴露宿主目录结构             | canonicalize + allowlist；项目原目录 ro；补充目录默认 ro。                              |
| 镜像缺失或 arch 不符                   | 启动前 `docker image inspect`，hard-fail 并给出明确 UiCode。                            |
| 补充目录逃逸或覆盖保留路径             | 保留路径（worktree/原目录/specsBase）不可被 `extraMounts` 覆盖。                        |
| 镜像未包含所需工具                     | 首个 exec 失败即 hard-fail；可选启动 smoke 校验入口命令存在。                           |
| 用户误以为切镜像立即影响运行中 session | UI 与文档明确：镜像/映射变更仅对下次 sandbox 启动生效。                                 |
| Docker 不可用                          | 启动前健康检查；sandbox enabled 时 hard-fail，不降级 direct。                           |
| 容器内 agent 调不到 c3 MCP（codex）    | 内部 `c3-mcp-net` + forwarder sidecar；MCP URL 改写到 sidecar 别名（§12）。             |
| 沙箱意外获得外网                       | 默认只挂 `--internal` 内部网；外网仅在 `allowExternalNetwork=true` 时挂 egress bridge。 |
| sidecar 扩大攻击面                     | sidecar 仅转发、digest pin、cap-drop、只读根、非 root；per-run token 限权。             |

## 16. 分阶段实施

### Phase A：文档与配置类型

- 更新本架构文档（已完成）。
- `WorkspaceSandboxConfig` 增加 `extraMounts`；明确镜像名语义。
- 移除 `sandbox-design.md` 与协议中对 vendor 供应链的引用。

### Phase B：同路径映射

- `SandboxLauncher.resolveMounts()`：项目原目录 ro + worktree rw + specsBase + `extraMounts`。
- 保留路径校验、canonicalize、allowlist。

### Phase C：wrapper 调整

- 容器内 cwd 改为宿主 worktree 同路径。
- 入口命令改为镜像 PATH 中的 vendor CLI，不再指向 `/opt/vendor`。

### Phase D：镜像健康检查

- 启动前 `docker image inspect`：镜像存在 + arch 校验。
- 缺失/不符 hard-fail，UI 提示准备镜像。

### Phase E：辅助与审计

- 提供参考 Dockerfile 示例与 digest pin 建议。
- run 元数据记录镜像 digest 供审计。

### Phase F：网络与 c3 MCP 接入

- MCP 传输统一：Claude 从进程内绑定切到 loopback HTTP MCP，移除 `bindInProcessMcp` + `createSdkMcpServer` 四工厂；补权限门控验证用例（见 §12.5）。
- `DockerDriver` 扩展：自定义内部网络 `c3-mcp-net`、forwarder sidecar、按 `allowExternalNetwork` 决定是否挂 egress bridge。
- 两 vendor 的 MCP / relay URL 改写到 sidecar 别名；回环防御调整为 `c3-mcp-net` + per-run token。
- workspace `allowExternalNetwork` 开关 UI；DIRECT 模式未开外网时 hard-fail 明确提示。

## 17. 推荐最终方案

采用“使用方自建镜像 + 宿主同路径目录映射”的方案。工具供应链外移到镜像构建流程，c3 运行时只做隔离与目录映射：

- 大幅简化 server 侧：删除 vendor 下载、解包、验证、版本目录、GC 与相关 UI。
- 容器内外路径一致，消除 `/workspace` 前缀带来的路径改写与 reverse-sync 复杂度。
- 工具版本、arch、签名等复杂度收敛到镜像构建这一处，由使用方用成熟的镜像工具链解决。

它同时保留了 OpenClaw 的“宿主控制面 / 容器执行面”分离、OpenHands/SWE-ReX 的 runtime 抽象、Docker Sandboxes 的强隔离与文件系统/网络策略方向。

优先级建议：

1. 先实现同路径映射 + `extraMounts` + 保留路径校验。
2. 再做镜像 `inspect` 健康检查与 hard-fail。
3. 再切换 wrapper 的 cwd 与入口命令。
4. 提供参考 Dockerfile 与 digest pin 建议、run 审计记录。
5. 所有失败路径保持 sandbox hard-fail，避免回到 host 裸跑。
