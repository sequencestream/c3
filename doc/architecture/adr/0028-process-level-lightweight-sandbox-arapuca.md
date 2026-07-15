# 0028 — 进程级 arapuca 沙箱取代容器方案

- **Status:** accepted
- **Date:** 2026-07-15
- **Driver:** 容器方案"映射目录 + 注入凭证 + 网络分段 sidecar"过重且注入凭证本身不安全;沙箱当前只需"控制目录读写",故整体切换为进程级隔离,凭证默认不可见

## Context

原 sandbox(ADR-0020/0021/0024/0025)是**容器方案**:独立 rootfs、bind mount worktree/原目录/specs、per-run env-file 注入 provider 凭证、`--network none` + host-gateway 回连 + 内部网络 forwarder sidecar。它满足强隔离,但对"只想限制目录读写"的日常 dev run 过重,且带来三处固有成本:

1. **映射目录成本高**:每个保留路径 + 补充路径都要 bind,还要处理各平台目录共享限制。
2. **凭证注入不安全**:DIRECT/RELAY 都要把 API key/token 写进 env-file 下沉容器——凭证离开宿主本身就是攻击面。
3. **网络分段复杂**:让容器既够到 c3 MCP 又默认断外网,需内部网络 + 双网卡 forwarder sidecar。

[arapuca](https://github.com/sergio-correia/arapuca)(Rust,Apache-2.0)是**进程级**沙箱:进程在宿主同一文件系统内运行,用内核 MAC 收窄权限,而非另起 rootfs。能力面正好对应 c3 诉求:

- **文件系统**:deny-by-default,`-v /path:ro` / `:rw` 显式放行。Linux=Landlock,macOS=Seatbelt(`sandbox-exec`),Windows=AppContainer。
- **网络**:全断 / 宿主代理 / 全开三档;`--allow-host host:443` per-host 白名单(仅 Linux)。
- **凭证反转为默认不可见**:进程即当前用户,凭证本在宿主 home;deny-by-default 下不显式放行就读不到 `~/.ssh`、`~/.aws` 等,凭证无需传递也不暴露。

成熟度:Linux/Windows production ready;macOS 可用但 `--allow-host` 不支持、Seatbelt 已被 Apple 标记 deprecated(15 仍可用)、Apple Silicon 跳过 `RLIMIT_AS`。

**当前范围收敛**:本轮沙箱只做"文件目录 ro/rw 控制",**网络先全开**。网络禁用/白名单/代理列为后续阶段。

## Options considered

- **A｜进程级 arapuca 取代容器(选定)**:sandbox backend 从容器整体切到 arapuca 进程包裹。Docker 驱动/镜像/供应链/网络 sidecar 全部移除。
  - Pro:消解映射/凭证/网络三成本;宿主同路径无 bind;凭证默认不可见;agent 是宿主进程,`127.0.0.1` 直达宿主 c3 MCP,无需 sidecar。
  - Con:进程级隔离弱于容器/microVM,不适合完全不可信代码;跨平台能力不一致(macOS 无网络白名单、Seatbelt deprecated)。
- **B｜arapuca 与容器双档并存**:workspace 选档。
  - Con:维持两套 backend 与两套配置面,复杂度不降反升;当前诉求只需目录控制,强隔离档暂无明确用例。否决(可留作未来强隔离需求出现时再引入)。
- **C｜维持容器方案,仅优化 bind/凭证**:
  - Con:凭证下沉与映射复杂度是容器模型固有,优化不掉痛点根因。否决。

## Decision

1. **进程级取代容器**:sandbox backend 从容器切换为 arapuca 进程包裹。移除 `DockerDriver`、镜像健康检查、供应链、env-file 凭证注入、`c3-mcp-net` 内部网络与 forwarder sidecar、MCP/relay URL 改写。

2. **wrapper 包裹进程,不套 container-shaped driver**:arapuca 无长驻容器。per-run wrapper 直接包裹 vendor CLI 启动:

   ```sh
   exec arapuca run -v <原目录>:ro -v <worktree>:rw -v <specsBase>:rw \
        -- <entryCommand> "$@"
   ```

   vendor SDK 仍以为自己 spawn 的是本地 CLI,与原 wrapper 替换二进制的 per-run 隔离模型一致(`docker exec … -- <cli> "$@"` → `arapuca run … -- <cli> "$@"`)。

3. **当前只控目录 ro/rw**:项目原目录 ro、worktree rw、specsBase rw、`extraMounts` 默认 ro 可逐项 rw;deny-by-default 使敏感目录默认不可见。

4. **网络先全开**:当前不施加网络约束。网络禁用/出站白名单(Linux `--allow-host`)/代理与对应 workspace 开关列为后续阶段。因 agent 是宿主进程,网络全开时回环 c3 MCP 与 DIRECT provider 直连天然可用。

5. **凭证默认不可见,不注入**:进程即当前宿主用户,沿用宿主侧既有认证;vendor CLI 自身配置目录由 wrapper 最小化放行,不牵连 home 其它敏感目录。

6. **启用即硬隔离(沿用 ADR-0024)**:arapuca fail-closed(任一层失效即非零退出),与 deny-by-default 一致;探测缺失/启动失败该 run 硬失败,绝不宿主裸跑。

7. **二进制走宿主预装 + 探测(类比 ADR-0012)**:c3 不捆绑 arapuca;使用方在宿主自装。启动前探测二进制存在与平台能力,缺失/不支持 hard-fail 并给出明确 UiCode。

## Consequences

**Pro**

- 沙箱零 bind、凭证默认不可见、无镜像供应链、无网络 sidecar。
- 宿主同路径,消除容器内外路径改写;agent 为宿主进程,`127.0.0.1` 直达 c3 MCP,§12 网络分段整章消失。
- worktree-only 门控、随机 agent 选取、启用即硬隔离、wrapper 替换二进制模型全部保留。

**Con / Trade-offs**

- 进程级隔离弱于容器(内核漏洞/逃逸面更大),不适合完全不可信代码;若未来出现强隔离需求需另引 backend。
- 跨平台能力不一致:macOS 缺 per-host 网络白名单、Seatbelt deprecated;Windows 未验证。
- 引入 arapuca 宿主二进制依赖(Rust musl 静态二进制),需宿主预装 + 探测。
- 当前网络全开,出站不受控——已知取舍,网络收窄留待后续阶段。

**Supersession**

- 本 ADR 取代 ADR-0024/0025 中与容器 backend、镜像、env-file 凭证注入、网络分段相关的机制,以及 ADR-0020/0021 中容器驱动/双层配置里绑定容器的部分。按 `adr.md` 生命周期约定,被取代的 ADR **不删除**:0024/0025 已加指向本 ADR 的 supersede 说明并移入 `deprecated/`;0020/0021 中仍适用的抽象(SandboxDriver 作为独立 kernel 模块、系统+项目双层配置)保留,仅容器绑定部分作废。

## Compliance

- sandbox backend 选择与 workspace normalize 由单测覆盖(容器字段被移除/迁移)。
- wrapper 参数(ro/rw 放行、凭证不下沉)由纯函数生成 + 单测,类比 ADR-0024 的纯函数选取/挂载。
- 启动前探测 arapuca 二进制与平台能力(类比 ADR-0012 第一道能力关卡),缺失/降级明确 UiCode,不静默降级。
- 保留路径 canonicalize + allowlist 沿用架构文档 §7;敏感目录默认不进放行集。

## References

- ADR-0020(SandboxDriver 独立模块)、ADR-0021(双层配置)、ADR-0024(worktree-only + 启用即硬隔离)、ADR-0025(网络/只读工作区策略)— 本 ADR 取代其容器相关机制
- ADR-0012(宿主二进制探测)、ADR-0009(单向边界)
- `doc/architecture/sandbox-architecture.md`
- https://github.com/sergio-correia/arapuca
