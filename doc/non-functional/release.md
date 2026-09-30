# 非功能需求 — 发布与分发

c3 以单一二进制交付（[ADR-0003](../architecture/adr/0003-single-binary-via-bun-compile.md)、[ADR-0010](../architecture/adr/0010-release-and-distribution-trust.md)）。磁盘上的可执行文件名为 `c3`（Windows 为 `c3.exe`）。它不是完整的智能体运行时：宿主 CLI 是硬性依赖，解析不到则该厂商不可用（[ADR-0012](../architecture/adr/0012-host-binary-probe-first-capability-gate.md)）。环境变量覆盖优先于托管安装。

产物只经公开 GitHub Release 分发，完整性由 sha256 校验和保证（见 [security.md](security.md) SEC-8 / DIST-1）。开源、不混淆。维护者如何切公开 Release 或本机产物树见 [release-steps](../publish/release-steps.md)。

`c3 upgrade` 先校验校验和再替换磁盘上的二进制，从不自动重启。控制台侧的暂存、确认与按形态重启见 [self-update](../domains/core/self-update/self-update-overview.md)。

## 桌面渠道

同一次发布有 CLI 与桌面两个渠道，共享版本与校验链。桌面壳把该二进制当 sidecar 伴跑（[ADR-0033](../architecture/adr/0033-tauri-desktop-shell-sidecar.md)）。安装、升级、卸载桌面应用都不触碰实例目录；桌面开机自启与 `c3 install` 的系统服务互不相干。

壳与 sidecar 成对升级。单独替换 sidecar 会破坏包签名，[self-update](../domains/core/self-update/self-update-overview.md) 在桌面形态下让位。

无代码签名证书时，macOS 为 ad-hoc 签名，Windows 产物未签名。
