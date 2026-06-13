# 0024 — Sandbox 仅 worktree intent-dev + custom agent 随机选取 + 启用即硬隔离

- **Status:** accepted
- **Date:** 2026-06-12
- **Driver:** 让"sandbox 绑 worktree"真正落地——容器挂 worktree 工作目录而非主项目目录，并以 deny-by-default 收敛失败路径

## Context

ADR-0020/0021 建立了 sandbox 驱动与双层配置；ADR-0019 之后的 worktree intent-dev 让每个意图在
`<c3-home>/worktrees/<project>/intent-<id>/` 的隔离 worktree 上开发（`rt.effectiveCwd`）。
（follow-up 2026-06-13：worktree 根从 `$TMPDIR/c3-worktrees` 迁至 `<c3-home>/worktrees`——`$TMPDIR`
即 macOS 的 `/var/folders`，不在 Docker Desktop 默认共享集内，会让 SND-R14 的 bind-mount 挂到**空**
`/workspace`；c3-home 默认在 HOME 下，恒被共享。c3-home 由 `--settings`/`C3_DIR`/`~/.c3` 解析。）

但接线之前，sandbox 启动门是 `run-lifecycle.ts` 的 `!isIntent` 分支，且 `launchSandbox` 挂的是
`projectPath`（主项目目录）。这有两个问题：

1. **挂错目录**：容器挂主目录而非 worktree，意图 A/B 的"工作目录隔离"形同虚设——容器看到并能改主项目。
2. **门太宽**：`!isIntent` 覆盖了所有非 intent-comm run（普通 chat 会话也中招），与"sandbox 服务 worktree
   intent-dev"的意图不符。
3. **静默降级**：容器启动失败时 `console.warn` 后在 host worktree 上裸跑——违反宪法的 deny-by-default。

同时，`WorkspaceSandboxConfig.agentIds`（normalize 后为 enabled+custom 的有效 agent 池）已就位，需要决定
容器内究竟启动哪个 vendor 的 CLI。

## Decision

1. **仅 worktree intent-dev**：sandbox 只在 `rt.effectiveCwd` 已设（worktree 运行）且该 workspace 的 sandbox
   config enabled 时启动。chat run（无 effectiveCwd）与 current-branch dev run（config 被 `worktree-only`
   normalize 滤掉）一律不启。移除 `!isIntent` 路径。
2. **挂 worktree**：`launchSandbox(driver, registry, workspacePath, mountPath)` —— **config 按 workspace 取**，
   **bind mount 用 worktree**（`mountPath = effectiveCwd`）挂到 `/workspace`。labels 记 `c3.project`（workspace）
   - `c3.worktree`（mount）。
3. **随机选 custom agent 定 vendor**：启用时从 normalize 后的 `agentIds` 随机选一个（`pickSandboxAgent`，纯函数，
   注入 resolver + RNG），用 `setSessionAgent` 钉到 pending dev session 上。选中 agent 的 vendor 决定容器内二进制，
   其 provider env（claude 的 `ANTHROPIC_*`）经既有 claude wrapper 路径进 env-file。不同 run 可跑不同 agent。
4. **启用即硬隔离**：启用但 池空 / 选中已删（resolve 回落 default）/ 选中非 claude / 容器启动失败 →
   该 run **硬失败**（`turn_end` error + `finalizeRun` + `run:settled` error）后返回，**绝不 host 裸跑**。
5. **本轮限 claude vendor**：随机选中 codex/opencode → 硬失败（`unsupported-vendor`）。非 claude 的 provider 接线
   （codex relay / SDK 构造器 baseUrl/apiKey）尚不能进容器 env-file，留作后续需求。
   （**2026-06-13 放宽**：codex DIRECT(wireApi=responses) 已容器化，见下方 Follow-up。）

## Consequences

**Pro**

- 容器真正挂 worktree，意图隔离从口头变成容器级。
- 失败路径 deny-by-default，无静默裸跑，符合宪法。
- agent 选取/挂载/硬失败均为纯函数 + 注入依赖，可单测（`sandbox-agent.test.ts`、`SandboxLauncher.test.ts`）。

**Con / Trade-offs**

- 容器 image 须预装所选 vendor 的 CLI，否则容器内启动失败 → 该 run 硬失败（接受：启动期报错优于静默降级）。
- 随机策略无健康检查/重试：选中不可用即该 run 失败（用户已确认随机，非"首个可用"）。
- 非 claude 暂不支持容器化——与"不同 run 跑不同 vendor 程序"的最终目标尚有差距，待后续补容器内多 vendor provider 接线。

## Alternatives Considered

- **保留 `!isIntent` 门 + 挂 projectPath**：现状，隔离不成立。否决。
- **"首个可用" agent 而非随机**：需健康探测，偏离用户确认的随机策略。否决。
- **非 claude 写约定环境变量名进 env-file**（OPENAI_BASE_URL 等）：容器内连通性未经验证、变量名可能需校正，
  作为 MVP 引入未验证行为风险高。改为本轮硬失败、留作后续。否决（本轮）。
- **容器启动失败时降级 host 裸跑**：违反 deny-by-default。否决。

## Follow-up (2026-06-13) — codex DIRECT(Responses) 容器化

承接决策项 5。依赖 wireApi 判别落地后（2026-06-12-006，`CodexAgentConfig.wireApi`），把 **codex DIRECT 路
（`wireApi=responses`）** 接进容器，DIRECT = 自定义 provider 原生讲 OpenAI Responses，codex 直连、无 relay。

**关键机制更正**：原决策假设「baseUrl/apiKey/model 都进不了容器、需全部翻译成 env/`-c` 标志」。实测
`@openai/codex-sdk@0.137.0` 后更正——sandbox wrapper 是 `exec docker exec --env-file <f> -i -w /workspace <cid> codex "$@"`，
SDK 仍在 host 构造 codex 的 **argv** 并 spawn wrapper，wrapper 经 `"$@"` 把全部 argv 转发进容器：

- `baseUrl` → SDK 译为 `--config openai_base_url="…"`（argv）→ 随 `"$@"` 进容器 ✅
- `model` → SDK 译为 `--model …`（argv）→ 随 `"$@"` 进容器 ✅
- `apiKey` → SDK 设为 **host 进程 env `CODEX_API_KEY`** → `docker exec --env-file` 不带 host 进程 env → **丢失** ❌

故 DIRECT 唯一缺失位是 `CODEX_API_KEY` 没进 env-file。**无需**注入 `-c openai_base_url` / `-c model_provider`
标志（避免重复 SDK 已做的事，与 host DIRECT 路完全等价，风险最低）。变量名 `CODEX_API_KEY` / config 键
`openai_base_url` 经 SDK 源码 + 既有 codex-relay 实现交叉校正。

**落地**：

1. `codex/driver.ts`：`opts.sandboxWrapperPath` 作 `codexPathOverride`（codex 跑进容器）；导出纯函数
   `codexDirectSandboxEnv({apiKey,wireApi})` → DIRECT 返回 `{CODEX_API_KEY}`，RELAY/缺 key/system 返回 `{}`。
2. `run-via-driver.ts`：codex sandbox 路径下把 `codexDirectSandboxEnv(...)` 合并进 `createSandboxWrapper` 的 env-file
   （覆盖 host 同名 `CODEX_API_KEY`）。
3. `pickSandboxAgent`：resolve 回调扩 `wireApi?`；放行 `codex+responses`；codex chat / system-login（wireApi 缺）→
   新拒因 `unsupported-wire`；opencode/其它仍 `unsupported-vendor`。

**仍未覆盖（后续意图）**：codex RELAY 路（`wireApi=chat`，需把 c3 进程内 Responses→Chat relay 桥进容器）；
opencode；system-login codex（容器内无注入凭据）。这些命中即硬失败（`unsupported-wire` / `unsupported-vendor`）。

**未做 live 校验**：本轮交付含类型/单测/规范同步；「真实 Responses 兼容 provider + docker 容器内成功直连出站」
需用户在装有 codex CLI 的容器 image 上 live 验证（验收①）。

## Follow-up (2026-06-13, 第二批) — codex RELAY(Chat) 容器化 + relay 绑定面安全评审

承接上一条遗留的「codex RELAY 路（`wireApi=chat`）」。第三方 Chat-only provider（DeepSeek/Kimi 等）经 c3 进程内
Responses→Chat relay（ADR-0014）出站；relay 路由挂在 c3 主 app（host loopback）。容器内 codex 的 loopback 不是
host loopback，到不了 host relay。

**决策（用户定，2026-06-13）**：

- **Q1-A：relay 不放宽监听面**。容器经 Docker `host.docker.internal`（host-gateway）回连 host loopback relay，
  relay 本身仍只挂主 app；**零新网络暴露**。Docker Desktop 直通 host loopback（支持的目标路径）；Linux 原生只到
  bridge 网关，正式支持留待**方案二（容器内 relay sidecar）**，本期列为已知限制（codex-relay.md §2.6/§6）。
- **Q2-B：F1 仅记录、本期不动 bind**。发现主 server `serve({ port })` 未传 hostname → Node 绑 `0.0.0.0`，与
  constitution C-SEC-5（localhost-only）冲突、且使 relay「loopback-only」防御层在当前代码里为假。这是**独立于本任务
  的既有偏差**，记为 finding（codex-relay.md §2.7/§6 限制 9），建议单独修 `hostname:'127.0.0.1'`；本任务刻意不依赖
  该 0.0.0.0 行为。

**落地**：

1. `codex/driver.ts`：relay 分支感知 sandbox（`opts.sandboxWrapperPath` 在场）。导出纯函数
   `rewriteRelayHostForSandbox(baseUrl)`（loopback host → `host.docker.internal`，保留 port/path）改写
   `model_providers.c3relay.base_url`；导出 `codexRelaySandboxEnv(token)`（→ `CODEX_API_KEY` + `NO_PROXY`）。
   token 在 `register()` 内铸造（晚于 env-file），driver `appendFileSync` 把它追加进 env-file——env-file 被
   `docker exec` 在 `runStreamed` 时懒读，时序成立。`-c model_providers.c3relay.*` 是 SDK argv，随 `"$@"` 自动进容器。
2. `DriverStartOptions.sandboxEnvFile`：env-file 路径，由 `run-via-driver.ts` 传入；`SandboxLauncher` 导出
   `sandboxEnvFilePath(tmpDir)` 作文件名单一来源。
3. `DockerDriver.start`：`networkDisabled=false` 时加 `HostConfig.ExtraHosts=['host.docker.internal:host-gateway']`。
4. `pickSandboxAgent`：放行 `codex + wireApi=chat`（与 `responses` 并列）；`unsupported-wire` 现仅命中 system-login
   codex（`wireApi` 缺）。`run-lifecycle.ts` 文案随之更新。

**仍未覆盖（后续意图）**：Linux 原生 RELAY（→ 方案二 sidecar）；F1 主 server bind 修复；opencode；system-login codex。

**未做 live 校验**：base_url 改写 + token 穿透 + ExtraHosts + pick 放行均有单测；「wireApi=chat 第三方 provider +
docker 容器内经 relay 成功出站」需用户在装有 codex CLI 的 image（Docker Desktop）上 live 验证（验收①）。

## Follow-up (2026-06-13, 第三批) — opencode 明确不支持(决策记录,不实作)

承接决策项 5 一直遗留的「opencode」。本条**只记决策、不实作**：明确写下 sandbox 当前不支持 opencode vendor
及其原因，避免后人误以为是「漏接线」而重复调研。

**为什么不兼容 wrapper 隔离模型**：claude / codex 的 sandbox 容器化建立在「per-run 子进程 + wrapper 替换二进制」
之上——sandbox wrapper 是 `exec docker exec --env-file <f> -i -w /workspace <cid> <vendor-cli> "$@"`，每个 run
spawn 一个 vendor CLI 子进程，wrapper 把这个子进程换成「容器内执行」即完成隔离，provider 凭据经 per-run env-file
注入。opencode 的进程模型截然不同：

- opencode 是 **host 常驻 server**（`opencode serve`），由 `OpencodeSupervisor`
  （`kernel/agent/adapters/opencode/supervisor.ts`）管理生命周期——managed 模式下 c3 自己 spawn 并健康检查/自愈，
  run 之间复用同一个 server 进程。
- **provider 配置是 server 级、boot 时注入**：经 `OPENCODE_CONFIG_CONTENT` 在 server 启动时一次性写入，不是 per-run。
- run 通过 **REST/SSE 够到这个 host server**，而非 spawn 一个可被 wrapper 替换的子进程。

故「run 用的二进制」就是这台 host server——**没有可被 sandbox wrapper 替换的 per-run 子进程**，wrapper 隔离模型
（替子进程 + per-run env-file）对 opencode 根本不适用。

**为何不能照搬 codex RELAY 方向（容器内 opencode → 宿主 server）**：一个自然的设想是「让容器里的 opencode 经
`host.docker.internal` 连宿主常驻 server，复用 codex RELAY 的回连」。**方向恰好反了，且会让沙箱隔离彻底失效**——

- codex RELAY 跨边界的只有 **LLM provider 网络出站**：codex CLI **本身跑在容器里**，改文件/跑 bash 都在容器内对
  `/workspace`，relay 只给「那一个网络调用」找条路回宿主 loopback。隔离成立，是因为**执行器（动文件、跑命令的进程）在容器里**。
- opencode 把「客户端」与「执行器」拆开了：工具调用（read/write/edit/**bash**）真正执行在 **host 的 `opencode serve`
  进程**里，c3 只是 REST/SSE 客户端 + 审批网关（`task-store.ts` 注释明确 c3 OBSERVE-ONLY）。**容器里根本没有 opencode 进程**。
- 故即便在容器里塞个 opencode 客户端连宿主 server，真正改文件/跑 bash 的仍是**宿主 server 进程**，副作用全落在**宿主文件系统**，
  容器成空壳——沙箱「把 agent 副作用关进容器」的全部意义归零。**relay 隔离的是网络，opencode 要隔离的是执行器，而执行器在宿主。**
- 退一步连目录都立不住：sandbox 路径下 `driverCwd = rt.sandboxHandle ? '/workspace' : …`（`run-via-driver.ts`），`/workspace`
  是**容器内**路径；宿主 server 收到 `directory: '/workspace'` 会按宿主路径解析——宿主上无此路径，cwd 都对不上。

结论：relay 能搬的前提是「执行器已在容器里、只差网络」；opencode 缺的不是网络，是**执行器的位置**。所以方向必须反过来——
把 **server 放进容器**（host→容器），即下方方案草图，而非容器→宿主的 relay。

**将来支持的方案草图（不实作，留作另起意图的锚点）**：要让 opencode 进沙箱，须换整条 launch 路径——
① 在**容器内**起 `opencode serve`（容器内常驻 server，而非 host）；② host 侧 REST/SSE 客户端改为**够到容器映射端口**
（容器网络/端口直通，类比 codex RELAY 的 `host.docker.internal` 回连，但方向相反——host→容器）；
③ `OpencodeSupervisor` **面向容器改造**生命周期（容器内 spawn/健康检查/进程树杀死/provider config 经容器原生
env/config 而非 host `OPENCODE_CONFIG_CONTENT`）。改造面覆盖 supervisor + launch + 配置注入三处，过大，本阶段不值得。

**难度拆解（2026-06-13 第二次调研补，附证据）**。当前事实：c3 **完全忽略 opencode 的 `baseUrl/apiKey`**
（`agent-config/index.ts:150-155`，注释明示 server-level / supervisor boot 应用，凭据实走 opencode 自己在宿主的 auth）；
supervisor 是**全局单例**，一个宿主 `opencode serve` 被所有 run 共用（`server.ts:262` 全局变量 + `index.ts:88`
`getClient=()=>supervisor.client()`）；server 端口动态分配、绑 `127.0.0.1`（`supervisor.ts:496/505`）；即便 sandbox handle
在场，REST 仍打宿主 server（driver 零 sandbox 感知，只换 `directory=/workspace`，`run-via-driver.ts:244` + `driver.ts:109`）。
难度极不均匀：

- **A｜全局单例 → 每容器一实例（最大头）**：今天「一个宿主 server 服务所有 run + 宿主 `spawn`/进程树杀死」要改成「每沙箱 run
  一个容器内 server」——启动改容器 entrypoint/`docker exec`、健康检查改探容器端口、杀死 = stop 容器、并把 adapter 的全局
  `getClient()` 换成 **runId/containerId → client 注册表**。等于给 `supervisor.ts` 写一套面向容器的孪生实现 + 改
  `server.ts`/`index.ts` 全局接线。工作量主体在此。
- **B｜host→容器可达性（中）**：容器内 server 绑容器端口，宿主 c3 经 `-p 127.0.0.1:<hostport>:<cport>`（**只绑 loopback，守
  C-SEC-5**）够到，每容器分配唯一宿主端口，per-run `OpencodeClient` 指向之；SSE 走映射端口。
- **C｜凭据/egress 入容器（中）**：宿主 opencode auth 不在容器里，须解决凭据进入——见下「经宿主够 provider」。

**「让容器内 server 经宿主够到 LLM provider」评估（回应该方向提问）**。这是解 C 的最优解，思路与 codex RELAY 的宿主 hop 同源，
但**三个要点**决定它不是「接根线」：

- **它不是复用 codex relay，是新建组件**：codex relay 是 **Responses→Chat 协议翻译器**（专给 OpenAI wire）；opencode 用自己
  provider 层讲 Anthropic/OpenAI 等**原生协议**，故须在宿主**新起一个通用认证转发代理**（收容器请求→注入真实凭据→转发上游）。
  **赢点**：凭据**留宿主、不下沉容器**（复用 SND-R17 `host.docker.internal`，Docker Desktop 零新暴露）。
- **前提未验证：opencode 自定义 baseURL**：把 provider 指向 `host.docker.internal:<port>` 需把 baseURL 写进容器内 server 的
  `OPENCODE_CONFIG_CONTENT`——而 c3 现在根本不写（`index.ts:150` 忽略）；且原生 Anthropic/Google provider 是否统一认 baseURL
  覆盖，需对 opencode provider schema 验证，**逐 provider 可行性不一**。
- **egress 须锁定**：够 `host.docker.internal` 要 `networkDisabled=false`（SND-R17 才加 ExtraHosts），但默认 `--network none`
  （SND-R10）；不把出站限定到这条宿主 hop，隔离就只是「网络开着」——真正锁住要靠 Phase 2 egress 过滤 / 自定义网络。
- 更简单但更差的替代：把 opencode auth **挂/注入进容器**让其直连 provider——接线简单，但**凭据下沉容器** + 仍需开放/allowlist 出站。

**分阶段路径（若另起意图）**：先做 A+B 把容器内 server 跑通（凭据先用「挂载 auth 进容器」的简单形态验证隔离打通）→ 再上宿主认证代理
把凭据收回宿主（C 的最优解）。

**决策**：本阶段**接受 opencode agent 在 sandbox 下不可用**；随机选中 opencode → 维持现状硬失败
（`pickSandboxAgent` 返回 `unsupported-vendor`，run-lifecycle 硬失败文案指向本 ADR）。**不**为 opencode 实作容器内 serve。

**文案确认（验收②）**：硬失败走 `unsupported-vendor` catch-all，文案
`[c3] sandbox-selected agent <id> is not a sandbox-capable vendor (the sandbox supports Claude and custom Codex agents; ADR-0024).`
——opencode 准确落入「非 sandbox-capable vendor」且指向本 ADR。该 catch-all **同时覆盖其它未知 vendor**，故**刻意不点名
opencode**（点名会使其它 vendor 的文案失真）；保持泛化 + 指向 ADR-0024 即准确。无代码逻辑改动。
