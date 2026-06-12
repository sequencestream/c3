# 0024 — Sandbox 仅 worktree intent-dev + custom agent 随机选取 + 启用即硬隔离

- **Status:** accepted
- **Date:** 2026-06-12
- **Driver:** 让"sandbox 绑 worktree"真正落地——容器挂 worktree 工作目录而非主项目目录，并以 deny-by-default 收敛失败路径

## Context

ADR-0020/0021 建立了 sandbox 驱动与双层配置；ADR-0019 之后的 worktree intent-dev 让每个意图在
`$TMPDIR/c3-worktrees/<project>/intent-<id>/` 的隔离 worktree 上开发（`rt.effectiveCwd`）。

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
