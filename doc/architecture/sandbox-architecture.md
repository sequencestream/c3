# Sandbox Architecture

## 1. 背景与结论

c3 的 sandbox 服务**工作区启用且 SessionKind 入选**的 run:是否进沙箱由工作区 `enabled` 主开关与该 run 的 `sessionKind` 是否命中 `sandboxSessionKinds` 决定,与 run 来源(Intent / spec / 普通)、是否使用 worktree、`gitBranchMode` 无关。普通工作会话、current-branch dev run 只要 kind 命中即进沙箱。沙箱的职责是给这次 run 的 vendor CLI(claude / codex)加一层**进程级隔离**,约束它能读写哪些目录、能否访问网络。

本文负责"大方向架构设计"。具体启动参数、wrapper、配置合并、run lifecycle 接线等实现细节,由 `doc/domains/core/sandbox/sandbox-design.md` 维护。

**核心方案:c3 sandbox 采用进程级轻量隔离([arapuca](https://github.com/sergio-correia/arapuca)),不使用容器。** vendor CLI 作为宿主进程运行,由 arapuca 用内核 MAC(Linux Landlock / macOS Seatbelt / Windows AppContainer)收窄其文件系统与网络权限,而不是另起独立 rootfs 的容器。

核心结论:

1. **进程级隔离取代容器**:agent 进程直接在宿主文件系统内运行,同路径、无 bind mount、无镜像。隔离由 arapuca 的内核 MAC 施加,fail-closed(任一隔离层失效即非零退出)。
2. **当前范围:只控文件目录读写**。沙箱当前只强制"哪些目录只读、哪些可写";**网络先全开**。网络收窄(禁网 / 出站白名单 / 代理)列为后续阶段。
3. **无凭证注入**:进程即当前宿主用户,不再把 API key/token 下沉进隔离环境。vendor CLI 沿用宿主侧既有认证。
4. **同路径、无映射**:进程在宿主原路径上运行,不存在容器内外路径改写;沙箱只是给这些路径打上 ro/rw 标签。
5. **c3 MCP 天然直连**:agent 是宿主进程,`127.0.0.1` 就是宿主本机,访问 c3 回环 HTTP MCP 端点无需任何转发 sidecar 或自定义网络。

## 2. 为什么用进程级 arapuca

容器方案(独立 rootfs + bind mount + 凭证注入 + 网络分段 sidecar)能提供强隔离,但对"只想限制目录读写与网络出站"的日常 dev run 过重,且带来三处固有成本:

1. **映射目录成本高**:每个保留路径与补充路径都要 bind,还要处理各平台的目录共享限制。
2. **凭证注入不安全**:让 vendor CLI 直连 provider,必须把 API key/token 下沉进隔离环境——凭证离开宿主本身就是攻击面。
3. **网络分段复杂**:要让隔离环境既够到 c3 MCP 又默认断外网,需要额外的内部网络 + 双网卡转发 sidecar。

arapuca 是**进程级**沙箱:进程在宿主同一文件系统内运行,用内核 MAC 收窄权限,而非另起 rootfs。它的能力面正好对应 c3 的诉求,并逐一消解上述成本:

- **文件系统**:deny-by-default,`-v /path:ro` / `-v /path:rw` 显式放行 → 无需 bind,同路径即生效。
- **凭证**:进程即当前用户,凭证本在宿主 home;deny-by-default 下不显式放行就读不到 → 无需注入,敏感目录默认不可见。
- **网络**:全断 / 宿主代理 / 全开三档 → 沙箱是宿主进程,网络全开时 `127.0.0.1` 直达宿主 c3 MCP,不需要任何转发层。

## 3. arapuca 能力与平台支持

arapuca:Rust,Apache-2.0,"Process sandbox for Linux, macOS, and Windows providing kernel-enforced isolation"。

| 维度     | Linux                                | macOS                                         | Windows                    |
| -------- | ------------------------------------ | --------------------------------------------- | -------------------------- |
| 文件系统 | Landlock(内核文件 MAC)               | Seatbelt(`sandbox-exec`,deny-default)         | AppContainer(deny-default) |
| 网络     | 网络命名空间 + `--allow-host` 白名单 | 全开 / 代理 / 全断三档,**无 per-host 白名单** | Job Objects / 进程缓解策略 |
| 系统调用 | seccomp BPF                          | —                                             | 进程缓解策略               |
| 资源限制 | cgroups v2                           | POSIX rlimit(best-effort)                     | Job Objects                |

平台注意事项(供后续网络阶段参考,不影响当前"只控目录 + 网络全开"范围):

- **网络白名单 `--allow-host` 仅 Linux**;macOS 只有 全开 / 代理 / 全断 三档。
- macOS Seatbelt 已被 Apple 标记 deprecated(macOS 15 仍可用)。
- Apple Silicon 上 `RLIMIT_AS` 会立即 SIGKILL,arapuca 在该架构跳过虚拟内存上限。
- arapuca 会剥离 `ARAPUCA_*` / `LD_*` / `DYLD_*` 等危险前缀环境变量,保留 `AGENT_*`。

## 4. c3 沙箱约束(保留自既有决策)

以下约束沿用,不因换成 arapuca 而变:

1. sandbox 的适用条件为工作区 `enabled` + 该 run 的 `sessionKind` 命中 `sandboxSessionKinds`,不再以 worktree、来源或分支模式为前提。
2. sandbox 配置按 workspace 解析;实际参与隔离的代码目录是该 run 的执行根(`rt.effectiveCwd ?? workspacePath`——worktree 或源工作区)。
3. sandbox 启用后失败路径 hard-fail,不降级 host 裸跑。arapuca 的 fail-closed 与此一致。
4. run 始终保留其正常解析出的 agent(system / custom 皆可),其 vendor 决定沙箱内启动哪个 CLI;沙箱不参与 agent 选择,无专属角色配置与换绑分支。

## 5. 目标能力与非目标

### 5.1 当前功能范围

- 工作区启用且 SessionKind 入选的 run 启动时,vendor CLI 经 arapuca wrapper 启动。
- 文件系统 deny-by-default:执行根 rw、源工作区 ro(执行根为 worktree 时;current-branch 下二者同路径合并为单条 rw)、specsBase rw;补充目录(`extraMounts`)默认 ro、可逐项声明 rw。
- 同路径:宿主 `/abs/path` 就是进程看到的 `/abs/path`,不存在路径改写。
- 敏感目录(其它项目、`~/.ssh`、`~/.aws` 等)不在放行集内即不可见。
- **网络全开**:当前不施加网络约束;宿主设有标准代理变量时经 `--allow-proxy-env` 让沙箱内 CLI 看得见宿主代理端点(arapuca ≥ 0.2.5)。
- 启动前探测 arapuca 二进制与平台可用性;缺失即 hard-fail。

### 5.2 非目标(当前阶段)

- 不做网络禁用 / 出站白名单 / 代理(留待后续网络阶段,见 §8)。
- 不使用容器、镜像、bind mount、rootfs 隔离。
- 不注入 provider 凭证。
- 不实现远程 / 云端 sandbox。
- 不把 c3 server 放进沙箱。

## 6. 架构总览

```
┌─ SandboxLauncher ──────────────────────────────────────────────┐
│  resolve workspace sandbox config(启用? + extraMounts)         │
│  probe arapuca 二进制 + 平台能力 → 缺失 hard-fail               │
│  resolvePaths()：项目原目录 ro + worktree rw + specs rw + 补充   │
│  createSandboxWrapper(entryCommand, paths, cwd=worktree)        │
├─ ProcessSandbox(arapuca wrapper) ──────────────────────────────┤
│  wrapper = arapuca run -v …:ro -v …:rw -- <entryCommand> "$@"   │
│  vendor adapter spawn wrapper（SDK 以为 spawn 的是本地 CLI）     │
├─ arapuca（c3 管理版本，缺失时回退宿主 PATH） ───────────────────┤
│  内核 MAC 施加 ro/rw；fail-closed；网络当前全开                  │
└─────────────────────────────────────────────────────────────────┘
```

职责边界:

| 模块              | 职责                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `SandboxLauncher` | 解析 workspace sandbox config、探测 arapuca、`resolvePaths()`、生成 wrapper。                          |
| ProcessSandbox 层 | 把 resolved 路径集映射为 arapuca `run` 参数;把 vendor CLI 包成 `arapuca run -- <cli>` 形态的 wrapper。 |
| arapuca 二进制    | c3 关联并自动安装一个经过验证的版本;管理版本不可用时回退宿主 PATH 上使用方自装的二进制。               |

> 与容器方案的差异:不再有 `DockerDriver` / 镜像 / bind mount / env-file 注入 / 转发 sidecar / 自定义网络。原容器供应链、网络分段章节整体移除。

## 7. 文件系统与权限模型(核心)

同路径原则:进程在宿主原路径上运行,沙箱只给路径打 ro/rw 标签,不做任何前缀改写。

固定放行:

| 路径                       | 权限 | 说明                                        |
| -------------------------- | ---- | ------------------------------------------- |
| 项目原目录(workspace root) | ro   | agent 参考基线代码,禁止写回主 checkout。    |
| run worktree               | rw   | agent 修改代码的唯一主路径。                |
| specsBase                  | rw   | 集中式 specs,支持 reverse-sync,宿主同路径。 |

补充放行:workspace 配置 `extraMounts`,每项 `{ path, readonly? }`。默认 ro,可逐项声明 rw。用于把额外依赖目录、共享缓存、参考仓库带进放行集。

约束:

- 所有放行路径先 canonicalize,再对照 allowlist / denylist;拒绝放行敏感系统目录、拒绝软链逃逸。
- 补充路径不得覆盖或被覆盖于 worktree、项目原目录、specsBase 等保留路径。
- 项目原目录只读,防止一次 run 污染主 checkout;agent 写入应落在 worktree。
- **deny-by-default 是安全底座**:未显式放行的目录(其它项目、home 内敏感目录)一律不可见,无需额外配置即隔离凭证与无关代码。
- vendor CLI 运行自身所需的最小集(可执行文件、运行库、其自身 home/配置)由 wrapper 生成逻辑纳入放行,细节见 `sandbox-design.md`。

## 8. 网络模型

**当前:网络全开。** 沙箱当前不施加网络约束,vendor CLI 与 agent 可正常访问 provider API、拉取依赖等。实现上 wrapper 传 `--seccomp baseline` 打开出站网络;arapuca 默认 `strict` 会全断网络,vendor CLI 的 provider 调用会 `ConnectionRefused`,故必须显式开网。

后续阶段(非当前范围)可按平台收窄:

- Linux:网络命名空间禁直连 + 宿主 CONNECT 代理,配 `--allow-host host:port` 出站白名单(经 unix domain socket,无需 TLS 拦截)。
- macOS:全开 / 代理 / 全断三档,无 per-host 白名单。

收窄时以 workspace 级开关(如 `allowExternalNetwork`)控制,并明确标注平台能力差异。这部分留待网络阶段单独设计与决策。

## 9. 凭证模型

- **无注入**:不再有 env-file 下沉 provider 凭证的机制。vendor CLI 作为当前宿主用户运行,沿用宿主侧既有认证(env 变量或其自身配置目录)。
- **默认不可见**:凭证若以文件存在(如 `~/.ssh`、`~/.aws`、其它工具 token),因 deny-by-default 且不在放行集内,agent 读不到。
- **最小暴露**:vendor CLI 自身认证所需的配置目录由 wrapper 逻辑最小化放行(细节见 `sandbox-design.md`),不牵连 home 下其它敏感目录。
- 网络全开阶段,DIRECT 模式 CLI 直连 provider 天然可用,无需回连宿主的 relay 通道。

## 10. 启动集成

目标启动流程:

```
run 启动（任意来源 / 分支模式）
  → 工作区 enabled 且 sessionKind 命中 sandboxSessionKinds ? 否：direct 路径
  → executionRoot = rt.effectiveCwd ?? workspacePath（worktree 或源工作区）
  → probe arapuca 二进制 + 平台能力及 macOS 嵌套 Seatbelt：缺失/不支持/嵌套 → hard-fail run
  → resolve 入选 run 的 vendor（决定入口命令）
  → resolvePaths():
       executionRoot:rw
       workspace root:ro（仅当 ≠ executionRoot；同路径并入 executionRoot rw）
       specsBase:rw
       extraMounts[i]:(ro|rw)
       codexHome:rw（`~/.c3/sandbox-home/<project>/.codex`，持久，跨 run 存活）
  → 在执行根内创建逐 run tmpDir（仅放 wrapper 脚本）
  → createSandboxWrapper(entryCommand, paths, cwd=executionRoot, env)
  → vendor adapter spawn wrapper
  → run 完成后清理 wrapper tmpDir（无容器需停止；持久 codexHome 不清理）
```

wrapper 形态(进程包裹,非 `docker exec`):

```sh
#!/bin/sh
mkdir -p "/tmp/claude-<uid>" 2>/dev/null || true
exec arapuca run \
  --seccomp baseline \
  --cwd "<executionRoot>" \
  --env "CODEX_HOME=<持久 per-workspace codexHome>" \   # ~/.c3/sandbox-home/<project>/.codex，跨 run 存活
  --env "CODEX_API_KEY=$CODEX_API_KEY" \   # codex 分支:relay token,运行时展开,值不落盘
  # claude 分支改为:--env "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" --env "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" --env "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN" \
  -v "<持久 per-workspace codexHome>:rw" \
  -v "<canonical /tmp>/claude-<uid>:rw" \
  -v "<executionRoot>":rw \
  [ -v "<workspaceRoot>":ro ]   # 仅当 workspaceRoot ≠ executionRoot \
  -v "<specsBase>":rw \
  [ -v "<extraMount>":ro|rw ... ] \
  -- "<entryCommand>" "$@"
```

- `<entryCommand>` 是宿主 PATH 中的 vendor CLI 名(`claude` / `codex`)。
- vendor SDK/driver 仍以为自己 spawn 的是本地 CLI;wrapper 只是把这次 spawn 包进 arapuca。
  provider 认证由 driver 经子进程 env 注入(claude 的 `ANTHROPIC_*`、codex 的 relay token `CODEX_API_KEY`),
  但 arapuca env deny-by-default 不继承父 env,故 wrapper 须按 vendor 用 `--env "KEY=$KEY"` 显式透传
  ——`$KEY` 由 `/bin/sh` 在运行时从 wrapper 进程 env 展开,token **值不落盘**到脚本文本;未设的变量展开为
  `KEY=`,arapuca 视为未设(安全 no-op)。wrapper 仍不挂订阅 / keychain。
- `--seccomp baseline` 打开出站网络(当前网络模型"全开",见 §8);arapuca 默认 `strict` 会
  全断网络,导致 vendor CLI 的 provider 调用 `ConnectionRefused`。macOS 无 per-host 白名单;
  Linux 后续可用 `--allow-host` 收窄到 provider 域名。
- **CODEX_HOME 持久化(codex resume)**:CODEX_HOME 指向 **per-workspace 持久目录**
  `~/.c3/sandbox-home/<project>/.codex`(`getSandboxCodexHome(workspace)`),位于执行根**之外**、
  独立 rw volume 挂载。arapuca 管理 HOME/TMPDIR 且禁止覆盖,故通过 Codex 支持的 CODEX_HOME
  避免默认临时 HOME 被 Codex 拒绝创建 PATH helper。**为何持久而非逐 run**:codex 多轮对话第二轮
  `thread/resume` 需要第一轮 `startThread` 写在 `CODEX_HOME/sessions/` 的 rollout 文件;若 CODEX_HOME
  随 run 清理,下一轮拿到空目录 → `no rollout found`。持久目录让同工作区所有 session 共用一个 home、
  每个 thread 的 rollout(以 thread id 命名)跨 run 存活以供续接。**不挂宿主 `~/.codex`**:rollout 本就
  写在持久目录而非宿主 `~/.codex`,且挂宿主 `auth.json` 会破坏 deny-by-default。逐 run tmpDir 现仅放
  wrapper 脚本并随 run 清理;持久 codexHome 由每日 janitor 按工作区保留天数清理(见 §10.1)。
- Claude Code 把逐用户运行时目录硬编码在 `/tmp/claude-<uid>`(shell-snapshot / IPC),不尊重
  TMPDIR 且 arapuca 锁定 TMPDIR 无法重定向,故 wrapper 预建该宿主目录并按 canonical 路径放行。
  它是逐用户共享目录(非逐 run),放行但不清理;codex 不使用它。
- Codex 在 arapuca 内以 `danger-full-access` 关闭其内层文件系统 sandbox，避免 macOS Seatbelt
  嵌套启动返回 EPERM；外层 arapuca 仍执行目录隔离，Codex approval policy 保持原值。
- 宿主 spawn cwd 是宿主 worktree;进程同路径运行,cwd 语义天然一致。
- 无长驻容器,无需 start/stop 容器;run 结束清理临时 wrapper 文件即可。

> **平台前提(macOS)**:上述在 macOS 上依赖 arapuca 的两处 Seatbelt profile 修复——
> (1) 为每个用户挂载补各级祖先目录的 `file-read-metadata` 遍历(否则 codex 的
> `canonicalize(CODEX_HOME)` EPERM);(2) 放行 `/tmp` symlink 入口(否则 claude 的
> `mkdir /tmp/claude-<uid>` EPERM)。二者已在 arapuca 上游修复;使用方需安装含该修复的
> arapuca。验证见 `scripts/e2e/e2e-arapuca-capability-test.mjs` 与
> `scripts/e2e/e2e-sandbox-vendor-token-test.mjs`。

### 10.1 rollout 保留与每日清理(janitor)

持久 CODEX_HOME 不逐 run 清理,rollout 会无限累积。**每日 janitor**(`features/sandbox/rollout-janitor.ts`,
随服务启动、开机延迟首跑后固定 24h 周期,`setTimeout().unref()`,fail-soft)扫描
`~/.c3/sandbox-home/*/.codex/sessions/`,删除 mtime 超过该工作区**保留天数**的 rollout 文件。
保留天数为 per-workspace 配置 `WorkspaceSandboxConfig.sessionRetentionDays`(默认 30,最小 1;见 §15),
janitor 用 `projectDirName` 把每个磁盘目录映射回工作区取其窗口,无匹配配置的孤儿目录(如已删除工作区)按默认窗口清理。仅删文件、不删空目录树,单文件出错记录后跳过不中断整轮。

## 11. c3 MCP 接入

沙箱内 vendor agent 需要调用 c3 自身的 MCP 工具(`publish_event`、`save_intents`、spec 查询、automation 等)。两个 vendor 都通过宿主回环上的 c3 HTTP MCP 端点(`http://127.0.0.1:<port>/internal/...`)访问。

**进程级沙箱下这一路径天然成立**:agent 是宿主进程,`127.0.0.1` 就是宿主本机,直接够到 c3 回环 HTTP MCP 端点。**不需要**内部网络、转发 sidecar 或 URL 改写——这些都是容器方案为"容器内 loopback 不是宿主 loopback"而付出的复杂度,进程级沙箱直接消除。

回环纵深防御沿用现成的 `isLoopback` + per-run 不透明 token。网络全开阶段,该路径无额外约束;后续网络收窄时,需保证回环 MCP 端点仍在放行集内。

## 12. 跨平台与架构

- arapuca 跨 Linux / macOS / Windows;c3 探测宿主平台并据此确定可用能力档。
- 文件系统 ro/rw 控制三平台均支持,是当前范围的公共能力面。
- 网络白名单等平台差异属后续网络阶段,不影响当前"只控目录 + 网络全开"。
- 无镜像 arch 维度问题——进程直接用宿主已装工具,不存在容器架构匹配。

## 13. arapuca 二进制依赖与探测

- c3 显式关联一个经过验证的 arapuca 版本并自动安装到 `~/.c3/sandbox/arapuca/`,校验通过后才激活——vendor CLI(claude/codex)仍由使用方预装,arapuca 是唯一例外,因为沙箱能否成立直接取决于它的版本。
- 二进制解析链:c3 管理版本优先,宿主 PATH 兜底。管理版本缺失时后台异步安装,当次 run 不等待、按 PATH 结果判定。
- 启动前探测:平台能力满足当前策略 + 至少一条链解析出可执行文件。类比宿主二进制探测作为第一道能力关卡。
- 两条链皆无或平台不支持时 hard-fail,给出明确 UiCode,不静默降级。
- 探测结果可缓存于 host 能力状态,供 UI 展示"沙箱是否可用";后台安装成功会使缓存失效。
- 实现细节(目录布局、校验与原子激活、single-flight)见 `doc/domains/core/sandbox/sandbox-design.md` §14。

## 14. 事件与 UI

- 移除容器相关的镜像/供应链/网络分段事件与面板。
- 保留/新增启动路径的结构化错误 topic:arapuca 缺失、平台不支持、放行路径非法、启动失败。
- workspace sandbox 设置面板:
  - 启用开关。
  - 补充放行目录列表:每项 `path` + `ro/rw` 权限选择器,默认 `ro`,需要写入时显式切 `rw`。
  - 会话种类勾选 `sandboxSessionKinds`(缺省只勾 `work`)。
  - 网络开关在当前阶段为"全开"占位;网络阶段落地后再暴露收窄选项。
- 错误使用 `UiCode`,不硬编码英文文案。

## 15. 配置模型变更

`WorkspaceSandboxConfig`:

```ts
interface WorkspaceSandboxConfig {
  enabled?: boolean
  extraMounts?: readonly {
    path: string // 宿主绝对路径,同路径放行
    readonly?: boolean // 默认 true;缺省即 ro,可逐项显式设为 false 放开 rw
  }[]
  sandboxSessionKinds?: SessionKind[] // 哪些 SessionKind 进沙箱,缺省 ['work']
  sessionRetentionDays?: number // 持久 CODEX_HOME rollout 保留天数,缺省 30、最小 1(见 §10.1)
  // 网络开关留待网络阶段引入;当前网络全开,无对应字段。
}
```

- `sessionRetentionDays`:normalize 对有限正数向下取整并 clamp 到最小 1;非有限 / ≤ 0 / 缺省视为未设(读取时回落默认 30)。仅当值 ≠ 默认才落盘,保持旧配置整洁。

- 移除容器相关配置:镜像名 / `imageOverride` / `readonlyRootfs` / `networkDisabled` / `allowExternalNetwork` 等一律不在当前模型中。网络收窄阶段再按需引入网络字段。
- 移除容器供应链协议:`RuntimeVendorConfig`、`VendorInstallManifest`、`FetchPlan` 等一律不引入。

## 16. 风险与决策

| 风险                             | 决策                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程级隔离弱于容器/microVM       | 明确定位:当前只做目录 ro/rw + 网络全开,不承诺完全不可信代码的强隔离。                                                                                                                                                                                                   |
| 同路径放行暴露宿主目录结构       | canonicalize + allowlist;项目原目录 ro;补充目录默认 ro;敏感目录不放行。                                                                                                                                                                                                 |
| arapuca 缺失或平台不支持         | 启动前探测,hard-fail 并给出明确 UiCode。                                                                                                                                                                                                                                |
| 补充目录逃逸或覆盖保留路径       | 保留路径(worktree/原目录/specsBase)不可被 `extraMounts` 覆盖。                                                                                                                                                                                                          |
| vendor CLI 认证所需配置读不到    | wrapper 最小化放行其自身配置目录;不牵连 home 其它敏感目录。                                                                                                                                                                                                             |
| macOS Seatbelt 已 deprecated     | 当前范围只用文件系统 MAC(15 仍可用);能力差异在文档标注。                                                                                                                                                                                                                |
| 网络当前全开带来的出站风险       | 已知取舍:当前范围不控网络;网络收窄列为后续阶段(§8)。                                                                                                                                                                                                                    |
| sandbox session 历史读写目录错位 | 已知限制(待修):transcript 读取端硬编码宿主 home,与 sandbox per-workspace home 不一致,sandbox session 历史读不到 / 切模式续接失败。vendor 中立(codex `CODEX_HOME` / claude `CLAUDE_CONFIG_DIR`)。方向见 design §9.1(读取端两处扫兜底 + session `storeScope` 冻结 fact)。 |

## 17. 分阶段实施

### Phase A：文档与配置类型

- 本架构文档改为 arapuca 进程级方案(本次)。
- `WorkspaceSandboxConfig` 收敛为 `enabled` + `extraMounts` + `sandboxSessionKinds`;移除容器/网络字段。
- 移除 `sandbox-design.md` 与协议中的容器供应链、网络分段引用,改写为 arapuca 实现。

### Phase B：arapuca wrapper 与路径放行

- `SandboxLauncher.resolvePaths()`:项目原目录 ro + worktree rw + specsBase rw + `extraMounts`。
- 保留路径校验、canonicalize、allowlist。
- 生成 `arapuca run -v … -- <cli> "$@"` wrapper,替换原 `docker exec` wrapper。

### Phase C：探测、自动安装与硬失败

- 平台能力门禁 + 「c3 管理版本 → 宿主 PATH」二进制解析链;管理版本缺失时异步安装,不阻塞当次 run。
- 所有失败路径保持 sandbox hard-fail,不回落 host 裸跑。

### Phase D：网络收窄(后续阶段)

- 按平台引入网络禁用 / 出站白名单 / 代理与对应 workspace 开关(§8)。
- 保证回环 c3 MCP 端点在收窄后仍可达。

## 18. 与容器方案的迁移说明

- 沙箱从"容器 + 镜像 + bind mount + 凭证注入 + 网络 sidecar"整体切换为"arapuca 进程级隔离"。
- 删除:`DockerDriver`、镜像健康检查、供应链、env-file 凭证注入、`c3-mcp-net` 内部网络与 forwarder sidecar、MCP/relay URL 改写。
- 保留:`enabled` + `sandboxSessionKinds` 资格门控、随机 agent 选取定 vendor、启用即硬隔离、wrapper 替换二进制的 per-run 隔离模型、宿主回环 c3 MCP 端点(现在天然直达)。
- 相关历史 ADR(容器驱动、双层配置、网络/只读工作区策略)由 ADR-0028 标记 supersede;按宪法这些 ADR 文件保留不删。
