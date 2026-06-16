# 0024 — Sandbox 仅 worktree intent-dev + custom agent 随机选取 + 启用即硬隔离

- **Status:** accepted
- **Date:** 2026-06-12
- **Driver:** 让"sandbox 绑 worktree"真正落地——容器挂 worktree 工作目录而非主项目目录，并以 deny-by-default 收敛失败路径

## Context

ADR-0020/0021 建立了 sandbox 驱动与双层配置；ADR-0019 之后的 worktree intent-dev 让每个意图在
`<c3-home>/worktrees/<project>/intent-<id>/` 的隔离 worktree 上开发（运行的有效工作目录）。
（follow-up 2026-06-13：worktree 根从 `$TMPDIR/c3-worktrees` 迁至 `<c3-home>/worktrees`——`$TMPDIR`
即 macOS 的 `/var/folders`，不在 Docker Desktop 默认共享集内，会让 SND-R14 的 bind-mount 挂到**空**
`/workspace`；c3-home 默认在 HOME 下，恒被共享。c3-home 由 `--settings`/`C3_DIR`/`~/.c3` 解析。）

但接线之前，sandbox 启动门是 run-lifecycle 路径上"非 intent run"分支，且容器挂的是
workspace 主项目目录。这有两个问题：

1. **挂错目录**：容器挂主目录而非 worktree，意图 A/B 的"工作目录隔离"形同虚设——容器看到并能改主项目。
2. **门太宽**："非 intent run"分支覆盖了所有非 intent-comm run（普通 chat 会话也中招），与"sandbox 服务 worktree
   intent-dev"的意图不符。
3. **静默降级**：容器启动失败时打印告警后在 host worktree 上裸跑——违反宪法的 deny-by-default。

同时，workspace 的 sandbox 配置已带有有效 agent 池（normalize 后为 enabled+custom 的 agent 集），需要决定
容器内究竟启动哪个 vendor 的 CLI。

## Decision

1. **仅 worktree intent-dev**：sandbox 只在运行的有效工作目录已设（worktree 运行）且该 workspace 的 sandbox
   配置 enabled 时启动。chat run（无有效工作目录）与 current-branch dev run（配置被 `worktree-only`
   normalize 滤掉）一律不启。移除"非 intent run"启动路径。
2. **挂 worktree**：启动 sandbox 时 —— **配置按 workspace 取**，
   **bind mount 用 worktree**（mount 路径取运行的有效工作目录）挂到 `/workspace`。labels 记 `c3.project`（workspace）
   - `c3.worktree`（mount）。
3. **随机选 custom agent 定 vendor**：启用时从 normalize 后的 agent 池随机选一个（纯函数选取，
   注入 resolver + RNG），把选中 agent 钉到 pending dev session 上。选中 agent 的 vendor 决定容器内二进制，
   其 provider env（claude 的 `ANTHROPIC_*`）经既有 claude wrapper 路径进 env-file。不同 run 可跑不同 agent。
4. **启用即硬隔离**：启用但 池空 / 选中已删（resolve 回落 default）/ 选中非 claude / 容器启动失败 →
   该 run **硬失败**（发出 `turn_end` error + 收尾该 run + 该 run 以 error settle）后返回，**绝不 host 裸跑**。
   （codex relay / SDK 构造器 baseUrl/apiKey）尚不能进容器 env-file，留作后续需求。
   （**2026-06-13 放宽**：codex DIRECT(`wire_api=responses`) 已容器化，见下方 Follow-up。）

## Consequences

**Pro**

- 容器真正挂 worktree，意图隔离从口头变成容器级。
- 失败路径 deny-by-default，无静默裸跑，符合宪法。
- agent 选取/挂载/硬失败均为纯函数 + 注入依赖，可单测。

**Con / Trade-offs**

- 容器 image 须预装所选 vendor 的 CLI，否则容器内启动失败 → 该 run 硬失败（接受：启动期报错优于静默降级）。
- 随机策略无健康检查/重试：选中不可用即该 run 失败（用户已确认随机，非"首个可用"）。
- 非 claude 暂不支持容器化——与"不同 run 跑不同 vendor 程序"的最终目标尚有差距，待后续补容器内多 vendor provider 接线。

## Alternatives Considered

- **保留"非 intent run"门 + 挂 workspace 主目录**：现状，隔离不成立。否决。
- **"首个可用" agent 而非随机**：需健康探测，偏离用户确认的随机策略。否决。
- **非 claude 写约定环境变量名进 env-file**（OPENAI_BASE_URL 等）：容器内连通性未经验证、变量名可能需校正，
  作为 MVP 引入未验证行为风险高。改为本轮硬失败、留作后续。否决（本轮）。
- **容器启动失败时降级 host 裸跑**：违反 deny-by-default。否决。

## Follow-up (2026-06-13) — codex DIRECT(Responses) 容器化

承接决策项 5。依赖 wire-api 判别落地后（2026-06-12-006，codex agent 配置上显式声明 `wire_api`），把 **codex DIRECT 路
（`wire_api=responses`）** 接进容器，DIRECT = 自定义 provider 原生讲 OpenAI Responses，codex 直连、无 relay。

**关键机制更正**：原决策假设「baseUrl/apiKey/model 都进不了容器、需全部翻译成 env/`-c` 标志」。实测
`@openai/codex-sdk@0.137.0` 后更正——sandbox wrapper 是 `exec docker exec --env-file <f> -i -w /workspace <cid> codex "$@"`，
SDK 仍在 host 构造 codex 的 **argv** 并 spawn wrapper，wrapper 经 `"$@"` 把全部 argv 转发进容器：

- baseUrl → SDK 译为 `--config openai_base_url="…"`（argv）→ 随 `"$@"` 进容器 ✅
- model → SDK 译为 `--model …`（argv）→ 随 `"$@"` 进容器 ✅
- apiKey → SDK 设为 **host 进程 env `CODEX_API_KEY`** → `docker exec --env-file` 不带 host 进程 env → **丢失** ❌

故 DIRECT 唯一缺失位是 `CODEX_API_KEY` 没进 env-file。**无需**注入 `-c openai_base_url` / `-c model_provider`
标志（避免重复 SDK 已做的事，与 host DIRECT 路完全等价，风险最低）。变量名 `CODEX_API_KEY` / config 键
`openai_base_url` 经 SDK 源码 + 既有 codex-relay 实现交叉校正。

**落地**：

1. codex 驱动以 sandbox wrapper 作为 codex 可执行文件覆盖（codex 跑进容器）；提供纯函数计算 codex DIRECT 的
   sandbox env：DIRECT 返回 `{CODEX_API_KEY}`，RELAY/缺 key/system 返回 `{}`。
2. codex sandbox 路径下把这份 DIRECT sandbox env 合并进 sandbox wrapper 的 env-file（覆盖 host 同名 `CODEX_API_KEY`）。
3. agent 选取放行 `codex+responses`；codex chat / system-login（`wire_api` 缺）→ 走对应失败分支。

**仍未覆盖（后续意图）**：codex RELAY 路（`wire_api=chat`，需把 c3 进程内 Responses→Chat relay 桥进容器）；

**未做 live 校验**：本轮交付含类型/单测/规范同步；「真实 Responses 兼容 provider + docker 容器内成功直连出站」
需用户在装有 codex CLI 的容器 image 上 live 验证（验收①）。

## Follow-up (2026-06-13, 第二批) — codex RELAY(Chat) 容器化 + relay 绑定面安全评审

承接上一条遗留的「codex RELAY 路（`wire_api=chat`）」。第三方 Chat-only provider（DeepSeek/Kimi 等）经 c3 进程内
Responses→Chat relay（ADR-0014）出站；relay 路由挂在 c3 主 app（host loopback）。容器内 codex 的 loopback 不是
host loopback，到不了 host relay。

**决策（用户定，2026-06-13）**：

- **Q1-A：relay 不放宽监听面**。容器经 Docker `host.docker.internal`（host-gateway）回连 host loopback relay，
  relay 本身仍只挂主 app；**零新网络暴露**。Docker Desktop 直通 host loopback（支持的目标路径）；Linux 原生只到
  bridge 网关，正式支持留待**方案二（容器内 relay sidecar）**，本期列为已知限制（codex-relay.md §2.6/§6）。
- **Q2-B：F1 仅记录、本期不动 bind**。发现主 server 监听未传 hostname → Node 绑 `0.0.0.0`，与
  constitution C-SEC-5（localhost-only）冲突、且使 relay「loopback-only」防御层在当前代码里为假。这是**独立于本任务
  的既有偏差**，记为 finding（codex-relay.md §2.7/§6 限制 9），建议单独修为绑 `127.0.0.1`；本任务刻意不依赖
  该 0.0.0.0 行为。

**落地**：

1. codex 驱动的 relay 分支感知 sandbox（sandbox wrapper 在场时）。提供纯函数把 relay base_url 的
   loopback host 改写为 `host.docker.internal`（保留 port/path），写回 `model_providers.c3relay.base_url`；另提供
   纯函数计算 codex RELAY 的 sandbox env（→ `CODEX_API_KEY` + `NO_PROXY`）。
   token 在注册时铸造（晚于 env-file），驱动将其追加进 env-file——env-file 被
   `docker exec` 在流式运行时懒读，时序成立。`-c model_providers.c3relay.*` 是 SDK argv，随 `"$@"` 自动进容器。
2. sandbox env-file 路径由 run-via-driver 路径传入；env-file 文件名有单一来源。
3. Docker 驱动在容器网络未禁用时加 Docker 的 extra-hosts 选项 `host.docker.internal:host-gateway`。
4. agent 选取放行 `codex + wire_api=chat`（与 `responses` 并列）；`unsupported-wire` 失败分支现仅命中 system-login
   codex（`wire_api` 缺）。run-lifecycle 路径的文案随之更新。

**未做 live 校验**：base_url 改写 + token 穿透 + extra-hosts + pick 放行均有单测；「`wire_api=chat` 第三方 provider +
docker 容器内经 relay 成功出站」需用户在装有 codex CLI 的 image（Docker Desktop）上 live 验证（验收①）。

及其原因，避免后人误以为是「漏接线」而重复调研。

**为什么不兼容 wrapper 隔离模型**：claude / codex 的 sandbox 容器化建立在「per-run 子进程 + wrapper 替换二进制」
之上——sandbox wrapper 是 `exec docker exec --env-file <f> -i -w /workspace <cid> <vendor-cli> "$@"`，每个 run
spawn 一个 vendor CLI 子进程，wrapper 把这个子进程换成「容器内执行」即完成隔离，provider 凭据经 per-run env-file

run 之间复用同一个 server 进程。

- run 通过 **REST/SSE 够到这个 host server**，而非 spawn 一个可被 wrapper 替换的子进程。

故「run 用的二进制」就是这台 host server——**没有可被 sandbox wrapper 替换的 per-run 子进程**，wrapper 隔离模型

`host.docker.internal` 连宿主常驻 server，复用 codex RELAY 的回连」。**方向恰好反了，且会让沙箱隔离彻底失效**——

- codex RELAY 跨边界的只有 **LLM provider 网络出站**：codex CLI **本身跑在容器里**，改文件/跑 bash 都在容器内对
  `/workspace`，relay 只给「那一个网络调用」找条路回宿主 loopback。隔离成立，是因为**执行器（动文件、跑命令的进程）在容器里**。
- 退一步连目录都立不住：sandbox 路径下驱动 cwd 在 sandbox handle 在场时取 `/workspace`，`/workspace`
  是**容器内**路径；宿主 server 收到 `directory: '/workspace'` 会按宿主路径解析——宿主上无此路径，cwd 都对不上。

把 **server 放进容器**（host→容器），即下方方案草图，而非容器→宿主的 relay。

（容器网络/端口直通，类比 codex RELAY 的 `host.docker.internal` 回连，但方向相反——host→容器）；

adapter 经全局 client 取得 supervisor 的 client）；server 端口动态分配、绑 `127.0.0.1`；即便 sandbox handle
在场，REST 仍打宿主 server（driver 零 sandbox 感知，只换 `directory=/workspace`）。
难度极不均匀：

- **A｜全局单例 → 每容器一实例（最大头）**：今天「一个宿主 server 服务所有 run + 宿主 `spawn`/进程树杀死」要改成「每沙箱 run
  一个容器内 server」——启动改容器 entrypoint/`docker exec`、健康检查改探容器端口、杀死 = stop 容器、并把 adapter 的全局
  client 取得换成 **runId/containerId → client 注册表**。等于给 supervisor 写一套面向容器的孪生实现 + 改
  composition root 的全局接线。工作量主体在此。
- **B｜host→容器可达性（中）**：容器内 server 绑容器端口，宿主 c3 经 `-p 127.0.0.1:<hostport>:<cport>`（\*\*只绑 loopback，守

**「让容器内 server 经宿主够到 LLM provider」评估（回应该方向提问）**。这是解 C 的最优解，思路与 codex RELAY 的宿主 hop 同源，
但**三个要点**决定它不是「接根线」：

provider 层讲 Anthropic/OpenAI 等**原生协议**，故须在宿主**新起一个通用认证转发代理**（收容器请求→注入真实凭据→转发上游）。
**赢点**：凭据**留宿主、不下沉容器**（复用 SND-R17 `host.docker.internal`，Docker Desktop 零新暴露）。

- **egress 须锁定**：够 `host.docker.internal` 要容器网络未禁用（SND-R17 才加 extra-hosts），但默认 `--network none`
  （SND-R10）；不把出站限定到这条宿主 hop，隔离就只是「网络开着」——真正锁住要靠 Phase 2 egress 过滤 / 自定义网络。

**分阶段路径（若另起意图）**：先做 A+B 把容器内 server 跑通（凭据先用「挂载 auth 进容器」的简单形态验证隔离打通）→ 再上宿主认证代理
把凭据收回宿主（C 的最优解）。

**文案确认（验收②）**：硬失败走 unsupported-vendor 失败分支，面向用户的文案为
`[c3] sandbox-selected agent <id> is not a sandbox-capable vendor (the sandbox supports Claude and custom Codex agents; ADR-0024).`
