# Sandbox Architecture

## 1. 背景与结论

c3 已经具备 Phase 1 sandbox 能力：通过本地 Docker runtime 启动容器，worktree intent-dev run 才进入 sandbox，工作目录 bind 到 `/workspace`，集中式 specs 根按宿主绝对路径挂载，vendor CLI 由宿主 SDK/driver spawn 一个 wrapper，再由 wrapper `docker exec` 到容器内执行。现有实现细节见 `doc/domains/core/sandbox/sandbox-design.md`，决策边界见 ADR-0024、ADR-0025。

本文负责“大方向架构设计”：说明 c3 sandbox 的整体演进路线，调研 OpenClaw、OpenHands、SWE-ReX、Docker Sandboxes 等方案，并提炼出 c3 在 sandbox session 启动时如何准备 vendor CLI 容器化产物的架构。具体 Docker 参数、wrapper、配置合并、run lifecycle 接线等实现细节，由 `doc/domains/core/sandbox/sandbox-design.md` 维护。

因此本文解决的不是“是否使用 sandbox”，而是“c3 启动 sandbox session 时，Claude Code / Codex 等 vendor CLI 及其版本化产物如何可靠、安全、跨架构地进入容器”。核心结论：

1. 保留现有 `SandboxLauncher + DockerDriver + wrapper` 模型，把 vendor CLI 供应链作为 sandbox 启动前置能力接入。
2. 新增 `server/src/vendor/` 管理层，负责 Linux 容器目标平台下的 vendor CLI 下载、解包、验证、版本选择、清理和 UI 状态。
3. vendor 产物一律只读挂载到 `/opt/vendor/<vendor>`；运行时可写状态、cache、auth、home 与 vendor 安装目录物理分离。
4. 版本选择的用户概念复用现有 `SystemSettings.vendorCliVersions` / `VendorHostStatus.installedVersions`，但语义扩展为“按 runtime target 解析”：direct 模式解析宿主 managed CLI，sandbox 模式解析 Linux target CLI。
5. 架构优先实现 `claude` 与 `codex` 两个 adapter，覆盖 `npm-tree` 与 `binary/bundle` 两类产物，之后再扩展其它 vendor。

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

不直接采用点：

- Docker Sandboxes 是独立产品/runtime。c3 当前 `SandboxDriver` 已预留 `gvisor/kata/firecracker` 类型，应把 microVM 作为 driver backend 演进，而不是把业务层绑死到某个外部 CLI。

## 3. c3 当前约束

c3 现有实现决定了新架构必须满足这些约束：

1. sandbox 仅服务 worktree intent-dev run。chat run、current-branch dev run 不进 sandbox。
2. sandbox 配置按 workspace 解析，实际 bind mount 的代码目录是 run 的 worktree。
3. sandbox 启用后失败路径 hard-fail，不降级 host 裸跑。
4. `networkDisabled` 与 `readonlyRootfs` 是 workspace 级安全策略，默认均为 `true`。
5. provider 连接方式由 vendor adapter 决定：Claude 走 env-file，Codex DIRECT/RELAY 需要把 API key/token 注入 env-file，RELAY 还需要 `host.docker.internal` 回连宿主 relay。
6. c3 已有 host managed vendor CLI 多版本状态：`vendorCliVersions`、`VendorHostStatus.installedVersions`、`activeVersion`、`downloadTargetVersion`。
7. `SandboxDriver` 是 kernel 内层能力；vendor 供应链不能把 UI、settings handler、adapter SDK 类型反向带入 sandbox driver。

## 4. 目标能力

### 4.1 功能特性

- 按 vendor、version、target platform/arch 管理 Linux sandbox CLI 产物。
- 支持 per-workspace override、全局默认、自动 latest compatible、离线 fallback。
- sandbox 启动前确保目标 vendor CLI 已 ready；缺失时可阻塞 prefetch，也可由 UI 提前准备。
- 下载、解包、验证有结构化进度事件，settings UI 可显示状态和错误。
- 同版本下载 single-flight，不同版本可有限并发。
- 失败可回滚到 last-known-good，不破坏当前已 ready 版本。
- vendor 安装目录只读挂载，运行时写入进入独立 tmpfs / named volume / overlay upper。
- Apple Silicon、Linux x64 等场景按 sandbox 基镜像 target 解析，不让用户手动配置不匹配的 arch。

### 4.2 非目标

- 本方案不引入远程 Docker host、Kubernetes、SSH sandbox。
- 本方案不把 c3 server 放进 sandbox。
- 本方案不实现 Phase 2 网络 allowlist MITM 代理，只预留接口。
- 本方案不保证 vendor 上游包管理器的所有签名能力立即可用；但 manifest、sha256、integrity、镜像 digest pin 和 smoke verify 必须在第一期具备。
- c3 自己的 MCP 工具面现在对两个厂商（Claude 与 Codex）都走**宿主回环 HTTP MCP 端点**。容器内 `127.0.0.1` / `localhost` 指向容器自身而非宿主，因此从**沙箱容器内部**到达该宿主端点的能力**不在本期范围**，推迟到后续 sandbox-network 工作（in-container relay sidecar / egress 通道，与 §12 网络策略的后续收敛同属一处）；本期只保证宿主直连路径，这是一个已知的后续阶段，而非回退。

## 5. 架构总览

```
┌─ SandboxLauncher ──────────────────────────────────────────────┐
│  inspect sandbox image → resolveVendorMounts() → docker args    │
├─ VendorManager ─────────────────────────────────────────────────┤
│  absent → fetching → unpacking → verifying → ready / failed     │
│  single-flight lock, ref-count, event fan-out                   │
├─ Downloader ────────────────────────────────────────────────────┤
│  host fetch + container unpack + sandbox-profile verify          │
│  staging GC, retry, timeout, resource limits                    │
├─ VendorRegistry adapters ───────────────────────────────────────┤
│  claude-code.ts / codex.ts / future vendors                      │
│  pure functions: resolveVersion(), listVersions(), fetchPlan()   │
└─────────────────────────────────────────────────────────────────┘
```

建议新增目录：

```
server/src/vendor/
├── vendor-manager.ts
├── vendor-store.ts
├── downloader.ts
├── fetch-plan.ts
├── types.ts
└── registry/
    ├── claude-code.ts
    └── codex.ts
```

职责边界：

| 模块              | 职责                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SandboxLauncher` | 仍负责 sandbox start/wrapper/tmpDir 生命周期；新增调用 `VendorManager.resolveMounts()` 并把 mounts 注入 `driver.start()`。 |
| `VendorManager`   | 门面。解析目标平台、版本策略、ready 检查、触发下载、返回 mount plan；发出进度事件。                                        |
| `VendorStore`     | 管理 `~/.c3/vendor` 下 index/manifest/ref-count/current symlink/last-known-good；所有写入 atomic。                         |
| `Downloader`      | 执行 fetch/unpack/verify pipeline；维护 staging、job timeout、并发上限和 GC。                                              |
| `VendorRegistry`  | vendor-specific 纯 adapter。只描述上游包、版本、入口、校验、smoke command，不做 IO 状态管理。                              |

## 6. Vendor 目录布局

推荐布局：

```
~/.c3/vendor/
├── archives/
│   └── <vendor>-<version>-<platform>-<arch>.<ext>
├── linux-arm64/
│   ├── claude/
│   │   ├── 0.9.5/
│   │   │   ├── installed/
│   │   │   ├── manifest.json
│   │   │   └── .ready
│   │   └── current -> 0.9.5
│   └── codex/
├── linux-x64/
├── .registry-index.json
├── .last-known-good.json
└── manifest.json
```

说明：

- target 维度是 sandbox target，不是宿主 target。目录使用 `<os>-<arch>`，第一期只落 `linux-arm64` 与 `linux-x64`。
- vendor 维度使用 c3 的 `VendorId`：`claude`、`codex`。
- version 目录内只有验证通过的 `installed/` 进入 sandbox。
- `.ready` 是最终完成标记，只能在 manifest 写入、验证通过、atomic rename 完成后创建。
- `current` symlink 只是排障辅助，不作为配置真相源。

`manifest.json` 建议字段：

```ts
interface VendorInstallManifest {
  schemaVersion: 1
  vendor: VendorId
  version: string
  target: { os: 'linux'; arch: 'arm64' | 'x64'; libc?: 'glibc' | 'musl' }
  entryType: 'binary' | 'bundle' | 'npm-tree'
  source: {
    registry: 'npm' | 'github-release' | 'vendor-url'
    url: string
    integrity?: string
    sha256?: string
    signature?: string
  }
  entry: {
    command: string
    argv?: string[]
    env?: Record<string, string>
  }
  mounts?: {
    vendorRoot: string
    writableOverlays?: string[]
  }
  verifiedAt: string
  buildDate?: string
}
```

## 7. 版本选择模型

配置真相源保持在 settings，不以 symlink 为准：

```ts
interface RuntimeVendorConfig {
  defaults: Partial<Record<VendorId, string>>
  locks: Record<string, Partial<Record<VendorId, string>>>
}
```

落地时可分两步：

1. 复用现有 `SystemSettings.vendorCliVersions?: Partial<Record<VendorId, string>>` 作为全局默认。
2. 后续在 `WorkspaceSetting` 增加 `vendorCliVersions?: Partial<Record<VendorId, string>>`，形成 per-workspace override。

解析顺序：

1. workspace override。
2. 全局默认。
3. latest compatible ready version。
4. 离线 fallback：同 target 下最新 `.ready` 版本。
5. last-known-good。
6. 仍缺失则启动前 prefetch；prefetch 失败 hard-fail sandbox run。

重要语义：

- version 切换只对下一次 sandbox 启动生效。运行中的 container bind mount 不热切换。
- direct 与 sandbox 的 vendor 产物不可复用。direct 解析宿主可执行文件；sandbox 解析 Linux target。
- 如果用户选择的版本未安装或与 target 不兼容，UI 显示 `lastError`，runtime 降级到 latest compatible ready，而不是静默清空配置。

## 8. 下载、解包、验证流水线

统一采用三阶段 pipeline：

| 阶段   | 执行位置                | 目标                                                                              |
| ------ | ----------------------- | --------------------------------------------------------------------------------- |
| fetch  | 宿主机                  | 拉取原始 archive bytes 到 `archives/`；复用 c3 现有 fetch/proxy/缓存能力。        |
| unpack | 最小专用容器            | 用 Linux/GNU tar/npm 工具解包，规避 macOS BSD tar、权限位、软链、shebang 差异。   |
| verify | sandbox 同 profile 容器 | 在与实际 sandbox ABI 接近的环境里执行 sha/integrity/signature/smoke `--version`。 |

### 8.1 FetchPlan

`VendorRegistry` 输出 `FetchPlan`，不直接下载：

```ts
interface FetchPlan {
  vendor: VendorId
  version: string
  target: { os: 'linux'; arch: 'arm64' | 'x64'; libc?: 'glibc' | 'musl' }
  source: {
    kind: 'npm' | 'github-release' | 'url'
    packageName?: string
    url: string
    integrity?: string
    sha256?: string
    signatureUrl?: string
  }
  entryType: 'binary' | 'bundle' | 'npm-tree'
  entryCommand: string
  smoke: { argv: string[]; expectVersion?: string }
}
```

### 8.2 原子落盘

流程：

1. 创建 `.staging-<jobId>/`。
2. fetch archive 到 `archives/<name>.partial`，完成后 atomic rename。
3. unpack 到 `.staging-<jobId>/installed/`。
4. verify 通过后写 `.staging-<jobId>/manifest.json`。
5. atomic rename `.staging-<jobId>` 到 `<target>/<vendor>/<version>`。
6. 创建 `.ready`。
7. 更新 index/current/last-known-good。

任何失败只留下 staging，GC 可按 label/jobId/mtime 清理。

### 8.3 并发与生命周期

- 同一 `(vendor, version, target)` 使用 single-flight lock。
- 不同版本可并行，但全局并发建议 2-3。
- unpack/verify 容器使用 `--rm`、硬 timeout、`--memory`、`--cpus`、`--label c3.vendor-job=<jobId>`。
- 下载辅助镜像必须 digest pin，例如 `c3/vendor-fetcher@sha256:<digest>`，避免 tag 漂移。
- job 失败写入结构化状态：`failedStage`、`uiCode`、`stderrTail`、`retryable`。

### 8.4 容器安全参数

fetch/unpack 容器建议：

- `--read-only`
- `--tmpfs /tmp`
- `--cap-drop ALL`
- `--security-opt no-new-privileges:true`
- 非 root 用户
- 只挂载当前 `.staging-<jobId>` 与必要 archive 文件
- 默认无宿主 Docker socket

verify 容器建议：

- 使用 sandbox profile 基镜像或同 libc/arch 的验证镜像。
- vendor root 只读挂载。
- 网络默认关闭；只有 npm provenance / sigstore online 验证确需网络时才启用专门 verify network profile。

## 9. 跨平台与架构

target arch 从 sandbox 基镜像派生：

1. `SandboxLauncher` 在启动前对 resolved image 执行 `docker image inspect`。
2. 读取 `Os`、`Architecture`、必要时读取 libc label 或通过短命容器探测 `ldd`。
3. 得到 `linux/arm64` 或 `linux/amd64`，映射到 vendor target `linux-arm64` / `linux-x64`。
4. `VendorManager.resolve()` 使用该 target。

原则：

- 用户不直接配置 vendor arch，避免 sandbox image 与 CLI 产物错配。
- Apple Silicon 默认使用 linux/arm64 sandbox + arm64 vendor CLI。
- x64 emulation/Rosetta 只作兜底，不作为默认；V8 JIT、`io_uring`、`clone3` 等 syscall/ABI 问题要视为高风险。
- vendor 目录不跨架构复用；CI/cache 拷贝时必须包含 target 维度。
- 下载/验证容器的 `--platform` 必须与 target 一致。

## 10. Sandbox 启动集成

目标启动流程：

```
用户启动 worktree intent-dev run
  → runtime.mode == sandbox ? 否：direct 路径
  → resolve workspace sandbox config
  → docker inspect sandbox image 得到 target
  → pick sandbox agent 得到 vendor
  → VendorManager.resolve(vendor, versionPolicy, target, profile)
       本地 ready：返回 mount plan
       本地缺失：触发阻塞 prefetch
       失败：hard-fail run
  → SandboxLauncher 合并 mounts:
       worktree:/workspace
       specsBase:specsBase
       vendor installed:/opt/vendor/<vendor>:ro
       vendor writable overlay/tmpfs/volume
  → DockerDriver.start()
  → createSandboxWrapper(handle, tmpDir, /opt/vendor/<vendor>/<entry.command>, env)
  → vendor adapter spawn wrapper
```

`StartOptions` 需要扩展：

```ts
interface StartOptions {
  binds?: readonly string[]
  tmpfs?: readonly string[]
  mounts?: readonly DockerMount[]
  labels?: Record<string, string>
  entrypoint?: readonly string[]
}
```

短期也可以继续把只读 vendor mount 编进 `binds`：

```
<vendorDir>/installed:/opt/vendor/<vendor>:ro
```

但 overlay/tmpfs 需要 `HostConfig.Mounts` 或明确的 `Tmpfs` 支持，建议正式扩展 `DockerDriver`。

## 11. 文件系统与权限模型

运行时挂载建议：

| 路径                      | 来源                | 权限 | 说明                                              |
| ------------------------- | ------------------- | ---- | ------------------------------------------------- |
| `/workspace`              | worktree            | rw   | run 的有效工作目录。                              |
| `<specsBase>`             | host specs root     | rw   | 与宿主同绝对路径，保证 reverse-sync。             |
| `/opt/vendor/<vendor>`    | vendor installed    | ro   | 已验证 CLI 产物，禁止运行时写回。                 |
| `/home/c3` 或 vendor home | tmpfs/named volume  | rw   | Claude/Codex runtime home、auth/cache。           |
| npm/cache 写入点          | overlay upper tmpfs | rw   | 解决 npm-tree 运行时写 `.cache` 或 lazy install。 |

原则：

- vendor 安装树不可写，防止一次 run 污染后续 run。
- auth 与 token 不写入 vendor tree。
- 如果某 vendor 必须写安装目录，优先用 overlayfs：lowerdir 是只读 installed，upperdir 是 tmpfs，workdir 是 tmpfs。
- container rootfs 继续遵守 workspace `readonlyRootfs`，vendor overlay 不应成为全局可写 rootfs 的理由。

## 12. 信任链与完整性

最低要求：

1. archive sha256 或 npm integrity 校验。
2. manifest 记录 source URL、integrity/sha256、target、entry、verifiedAt。
3. verify 容器内执行 smoke `--version`，并确认解析版本等于目标版本。
4. 启动时不全量重算 sha；读取 manifest + `.ready` + mtime/ctime 快速校验。发现异常则标记 failed 并重新 resolve。

增强要求：

- 支持上游 GPG/Sigstore/npm provenance。对支持签名的 vendor，此验证不可被配置降级为“仅 sha256”。
- 下载/验证辅助镜像 digest pin。
- `VendorRegistry` 内置官方 registry/source，禁止 UI 直接输入任意下载 URL；第三方 vendor 需要单独 adapter。
- manifest 可引入 c3 本地签名，保护安装后 manifest 被篡改的检测能力。

## 13. 事件与 UI

事件建议复用现有 automation viewer fan-out / server-to-client 广播机制，新增结构化 topic：

- `vendor:download-started`
- `vendor:download-progress`
- `vendor:unpack-started`
- `vendor:verify-started`
- `vendor:ready`
- `vendor:verify-failed`
- `vendor:failed`
- `vendor:gc`

UI 增加 `settings/VendorVersionsPanel`，按 vendor 分组，并显示 direct/sandbox target：

- vendor 名称、target platform、active version、download target。
- installed versions radio：`Auto` + 已 ready 版本。
- 状态：ready/downloading/verifying/failed。
- 错误：使用 `UiCode`，不要硬编码英文文案。
- 切换版本后提示：仅下次启动 sandbox 生效。
- 首次切 sandbox 时显示“准备沙箱环境”向导，阻塞到 vendor ready 或用户取消。

协议扩展建议：

```ts
interface VendorRuntimeStatus {
  vendor: VendorId
  runtime: 'direct' | 'sandbox'
  target?: { os: 'linux'; arch: 'arm64' | 'x64'; libc?: string }
  installedVersions: VendorCliVersionEntry[]
  activeVersion?: string
  downloadTargetVersion?: string
  state: 'ready' | 'fetching' | 'unpacking' | 'verifying' | 'failed'
  progress?: { bytesDone?: number; bytesTotal?: number; stage?: string }
  lastError?: { code: string; params?: Record<string, string> }
}
```

为了兼容现有 UI，可先把 sandbox 状态并入 `VendorHostStatus` 的可选字段；长期建议拆出 `vendorRuntimeStatus`，避免 `hostStatus` 名称承载容器 target。

## 14. 版本生命周期与 GC

策略：

- 版本发现：后台 TTL 检查 + 用户手动检查更新 + sandbox 启动缺失时同步 prefetch。
- 下载时机：用户确认后下载；当前运行 session 继续旧版本。
- 保留策略：每 vendor/target 保留 active + last-known-good + 最近 2 个旧 ready 版本。
- ref-count：运行中 sandbox 持有 `(vendor,target,version)` 引用，引用归零前不删除。
- GC 只删除非 active、非 last-known-good、ref-count 为 0、超出保留策略的版本。
- failed/staging：按 mtime 清理，保留最近失败摘要供 UI 排障。

## 15. direct → sandbox 迁移路径

direct 模式使用宿主 CLI，sandbox 模式使用 Linux CLI，两者不可复用。

首次切 sandbox：

1. 检测当前 direct active vendor 版本。
2. 推导 Linux target。
3. 查找同版本 Linux 产物；若不可用则选择 latest compatible，并在 UI 明示。
4. prefetch + verify。
5. ready 后允许启动 sandbox run。
6. 失败时不破坏 direct 模式；用户可继续 direct，但 sandbox run hard-fail。

迁移文案要明确：“准备 sandbox 环境”不是安装 c3 本身，而是安装目标容器内要执行的 vendor CLI。

## 16. 分阶段实施

### Phase A：文档与类型

- 新增本架构文档。
- 补充 `FetchPlan`、`VendorRuntimeStatus`、错误码草案。
- 明确 `VendorHostStatus` 与 sandbox runtime status 的兼容策略。

### Phase B：VendorStore + Registry adapter

- 实现 `server/src/vendor/vendor-store.ts`。
- 实现 `registry/claude-code.ts` 与 `registry/codex.ts`。
- 只做本地状态读写与 fetch plan 生成，不接 Docker。

### Phase C：Downloader pipeline

- 实现 fetch 到 `archives/`。
- 实现 container unpack。
- 实现 verify smoke。
- single-flight、staging GC、manifest、`.ready`。

### Phase D：SandboxLauncher 集成

- `docker image inspect` 派生 target。
- `VendorManager.resolveMounts()` 接入 `launchSandbox()`。
- `createSandboxWrapper()` 使用 `/opt/vendor/<vendor>/<entry.command>`。
- DockerDriver 扩展 tmpfs/mounts。

### Phase E：UI 与迁移

- Settings vendor versions panel 显示 direct + sandbox 状态。
- 首次 sandbox prefetch 向导。
- 版本切换“下次启动生效”提示。
- verify failed toast 与结构化错误。

### Phase F：安全增强

- 上游签名/provenance。
- overlay upper tmpfs。
- manifest 本地签名。
- 网络 allowlist / credential broker 另起 ADR。

## 17. 风险与决策

| 风险                                   | 决策                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------- |
| 上游 vendor 分发格式变化               | adapter 隔离变化；manifest 记录 entryType；verify smoke 兜底。          |
| sandbox image 与 vendor ABI 不匹配     | target 从 image inspect 派生，并在同 profile verify。                   |
| 下载容器扩大攻击面                     | digest pin、cap-drop、只读 root、tmpfs、非 root、精确 mount、timeout。  |
| npm-tree 运行时写安装目录              | vendor root ro；overlay tmpfs upper 或 vendor-specific writable mount。 |
| 用户误以为切版本立即影响运行中 session | UI 与文档明确下次 sandbox 启动生效。                                    |
| Apple Silicon 误下 x64                 | arch 不暴露为用户配置，从 sandbox image 自动派生。                      |
| Docker 不可用                          | 启动前健康检查；sandbox enabled 时 hard-fail，不降级 direct。           |

## 18. 推荐最终方案

采用“宿主拉字节 + 容器内解包 + 同 profile 容器验证 + 只读 vendor mount”的混合方案。

这条路径与 c3 现有架构契合：控制面留在本地 c3 server，执行面仍是每个 run 的 vendor CLI 容器进程，版本供应链独立在 `server/src/vendor/`，不污染 `SandboxDriver` 的通用 runtime contract。它同时吸收了 OpenClaw 的宿主 gateway/执行 sandbox 分离、OpenHands/SWE-ReX 的 runtime 抽象、Docker Sandboxes 的强隔离与网络/文件系统策略方向。

优先级建议：

1. 先实现 `claude` 与 `codex`。
2. 先支持当前 sandbox image 的 `linux/arm64` 或 `linux/x64` 单 target 按需下载，不预下载双架构。
3. 先做 sha/integrity + smoke verify，再补强 GPG/Sigstore/provenance。
4. 先用只读 bind mount，随后补 overlay tmpfs 解决 npm-tree 写 cache。
5. 所有失败路径保持 sandbox hard-fail，避免回到 host 裸跑。
