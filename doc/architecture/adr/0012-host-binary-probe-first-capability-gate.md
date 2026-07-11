# 0012 — 厂商可执行文件解析是首要能力关卡

- **Status:** accepted, revised 2026-07-01
- **Date:** 2026-06-06

## Context

ADR-0011 让智能体层变得厂商中立，但每个已实现的厂商仍然通过自己的 CLI 执行。默认依赖
用户登录 shell 的 PATH，会让 c3 的行为随主机上恰好安装的 `claude` / `codex` 版本而漂
移。它在守护进程与操作系统服务启动方式下也会失效，因为这类场景的 PATH 往往与交互式
shell 不同。

## Decision

c3 拥有默认厂商 CLI 来源。启动器按以下固定顺序解析每个厂商：

1. 显式的 `CLAUDE_PATH` / `CODEX_PATH`；
2. `~/.c3/vendor/<vendor>/<version>/bin/<binary>` 下 c3 托管的 CLI；
3. 降级的宿主 `PATH` 回退。

一个无效的显式覆盖项对该厂商而言是硬性的解析失败。它不会被静默绕过，因为操作者提供的
路径是有意为之的配置。

托管安装器通过 HTTPS 读取 npm packument，下载所选的包 tarball，校验 npm 的
`dist.integrity`，暂存并自检该可执行文件，然后发布该版本目录。状态记录在
`~/.c3/vendor/manifest.json` 中，包括选定/手动/最新兼容版本、来源、路径、兼容范围、错
误与近期版本历史。c3 从不写入厂商凭据或登录状态。

宿主 PATH 仅作为迁移与故障恢复手段保留。使用它时，健康检查与设置状态必须标注
`host-path-fallback`，并保留托管安装失败的原因，以免回退掩盖了安装或升级失败。

## Consequences

- 守护进程与操作系统服务启动方式与终端启动方式使用相同的 `~/.c3/vendor` 默认值，无需
  shell PATH 注入；
- c3 升级可以改变厂商兼容范围，下一次启动会将托管 CLI 同步到新的兼容选择；
- 环境变量覆盖项对开发、调试与企业锁定版本仍然有用；
- c3 现在拥有 npm 包下载、完整性校验、原子替换、平台标签与版本兼容策略；
- c3 不修改用户 PATH、shell 配置文件、Homebrew/npm 全局安装、或 Claude/Codex 凭据。

## Compliance

- 解析结果必须是结构化的，来源状态须为 `env-override`、`managed`、
  `host-path-fallback`、`missing`、`install-failed`、`override-invalid` 之一。
- 托管安装失败不得删除或覆盖已存在的可用版本。
- `vendorCliVersions.claude` / `vendorCliVersions.codex` 选择的是运行时*生效*的托管版
  本——它们**不是**下载锁定项。同步流程始终追踪最新的兼容发布版本；一个缺失或不兼容的
  生效版本会降级为最新兼容版本，记录一条可见的 `lastError`，并且**不会**改写用户的选
  择。多版本目录共存于 `~/.c3/vendor/<vendor>/<version>/` 下；活动版本可通过系统设置面
  板从已安装的版本集合中选取。
- 版本解析是厂商相关的；一个通用的宽松正则表达式是不够的。
- 测试必须覆盖解析器优先级、安装失败恢复、类服务场景下空 PATH 的托管解析、npm
  packument 选择、以及健康检查/状态的来源上报。

## References

- [ADR 0011](0011-vendor-neutral-agent-abstraction.md) — 厂商适配器抽象。
- [ADR 0009](0009-unidirectional-boundaries.md) — kernel 边界规则。
- [release non-functional spec](../../non-functional/release.md) — 分发与服务预期。
