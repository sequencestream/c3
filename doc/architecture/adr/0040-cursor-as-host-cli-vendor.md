# 0040 — Cursor 作为宿主 CLI 厂商

- **Status:** accepted
- **Date:** 2026-08-09

## Context

c3 的三个厂商里,claude 与 codex 都由 c3 解析并 spawn 一个宿主 CLI;cursor 是唯一
的例外 —— 它由 `@cursor/sdk` 的 runtime 在 c3 服务进程内执行。这个例外并非出于
偏好,而是当时对该 SDK 与 `cursor-agent` CLI 各自能力的判断。

例外的代价散落在整个系统里:

- **凭据**。SDK 只接受 API key,不读 `cursor-agent login` 写入操作系统钥匙串的登录
  态。持订阅而无密钥的用户因此完全用不了该厂商,且没有任何配置能绕开。
- **会话可见性**。SDK 的 local agent store 只装经它创建的 agent,用户在 Cursor IDE
  或 `cursor-agent` 里产生的会话一概不可见,会话能力只能诚实地标 `partial`。
- **分发**。单文件二进制不能内含一个按平台解析原生包的 runtime,于是发布链长出一条
  只服务该厂商的支线:按 target 装配旁挂依赖树、给每个包补根入口 shim、把 SDK 排除
  出 bundle、在解析链里认一个专用环境变量。同时 shared 与 web 为"两类运行时"维持了
  一整条类型与文案分支。
- **沙箱**。arapuca 包装的是子进程;进程内 runtime 没有子进程可窄化,只能改由 SDK
  自带沙箱兑现,而它在二进制形态下不可达。

探针证明 `cursor-agent` 的非交互模式覆盖了 c3 需要的全部语义:`create-chat` 铸出的
id 就是运行自报并落盘所用的 id、`--resume` 恢复上下文、`--print --output-format
stream-json` 的帧词汇与 SDK 一致、`--auto-review` 在 headless 下不阻塞。

## Options considered

1. **维持进程内 SDK。** 零改动,但上述四项代价全部保留,且凭据一项是硬阻断。
2. **改为 spawn `cursor-agent`,并纳入 c3 的托管 npm 安装。** 与 claude/codex 完全
   同构。但 `cursor-agent` 不在 npm 上按 semver 发布 —— 它由官方安装器分发,版本号
   是发布日期加短 sha。要托管它,c3 得自研一条非 npm 的下载通道,并让版本比较接受
   一种它无法排序的格式;这等于依赖一个未公开的分发行为。
3. **改为 spawn `cursor-agent`,作为非托管宿主 CLI。**(选定)
4. **引入第三类运行时类别。** 保持 `HOST_BINARIES` 只装可托管厂商,另立注册表。这会
   把 vendor 运行时从二分变成三分,shared/web/i18n 的分支不减反增。

## Decision

Cursor 改为**每轮一个 `cursor-agent` 子进程**,并作为**非托管**宿主 CLI 进入
`HOST_BINARIES`。

厂商描述符的 npm 三项(包名、dist-tag、兼容范围)由必填改为可选,缺席即表示 c3 不
分发该 CLI:解析只走 `$CURSOR_PATH` 与宿主 PATH 两级,并且不得进入下载、版本比较、
钉选与历史清理的任何一条路径。启动、沙箱与可用性判定这三张表因此重新覆盖全部厂商,
`VendorRuntimeKind` 收敛为单一的 `host-cli`。

会话身份在 spawn 之前铸出:新会话先跑一次 `create-chat`,把得到的 id 用 `--resume`
交给本轮。这保留了"会话 id 不必等待流"的既有语义,上游绑定路径一行不改。

凭据放开为二选一:填了 API key 就用,留空则由 CLI 自己的钥匙串登录态兜底。

## Consequences

- 订阅用户无需密钥即可使用该厂商;`apiKey` 成为可选字段。
- 会话 `list` / `read` 由 `partial` 升为 `full` —— 读的是 CLI 与 IDE 共写的同一个
  磁盘库,该工作区的全部历史都在。
- Cursor 进入 arapuca 沙箱,与其他宿主 CLI 同路。其数据根是宿主 `~/.cursor`,沙箱
  内外同一个,故该厂商的 store scope 在两种 scope 下同解。
- 发布链去掉了旁挂装配阶段与其全部支持代码;二进制不再需要为该厂商携带任何东西。
- c3 不再能钉选该 CLI 的版本 —— 版本由用户的安装器决定,c3 只报告它。这是选项 3 的
  自觉代价:c3 不猜测一个它无权控制的分发渠道。
- CLI 不接受图片输入,附图在运行期被显式丢弃并告警。
- **存量 cursor 会话不迁移。** 旧会话的原生 id 由 SDK 的 store 铸出,不在磁盘会话库
  里,因此列不出也 resume 不了 —— 它们降级为孤儿记录。这是一次数据语义断裂,不是
  schema 变更:`session_metadata` 的原生 id 列只是换了内容。

## Compliance

- 非托管厂商必须在 `HOST_BINARIES` 中缺省 npm 三项;契约测试钉住"它不出现在托管集
  合里"以及"进入 npm 版本选择即抛错"。
- 二进制名从描述符读取,不得由 vendor id 推导:cursor 是二者不同的厂商。
- 能力台账的任何一项变更必须先有可复现的探针证据。会话能力升级由
  `scripts/e2e/cursor-cli-probe.mjs` 的两个阻断项背书。
- 项目 MCP 文件在轮次期间写入、轮次结束还原,且必须保留工作区自己声明的条目。因为
  回环 URL 携带本轮绑定令牌,这条路径还必须同时满足:同一工作区的并发运行拒绝启动
  而非覆盖、文件经 `.git/info/exclude` 对 git 隐身、进程退出时还原、以及下一轮识别
  并丢弃上一次未能还原的残留。
- `pnpm allcheck` 与 `pnpm vitest run` 必须为绿;vendor 覆盖契约必须证明启动、沙箱、
  能力、模式、schema 五张表恰好覆盖注册的全部厂商。

## References

- [ADR-0011](0011-vendor-neutral-agent-abstraction.md) — 厂商中立抽象与能力台账
- [ADR-0012](0012-host-binary-probe-first-capability-gate.md) — 宿主二进制解析顺序
- [ADR-0030](0030-session-store-scope-vendor-neutral-data-root.md) — 会话 store scope
- [agent-session-cursor](../../domains/core/agent-session/features/agent-session-cursor.md)
