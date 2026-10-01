# 发布步骤

维护者如何切一份公开 GitHub Release，或只在本机做出产物树。产物形态、完整性与桌面渠道见 [release.md](../non-functional/release.md)（[桌面渠道](../non-functional/release.md#桌面渠道)）、[ADR-0010](../architecture/adr/0010-release-and-distribution-trust.md)、[ADR-0033](../architecture/adr/0033-tauri-desktop-shell-sidecar.md)。树内构建入口见 [develop.md](../develop.md)。

公开分发只走 GitHub Release。本机 `pnpm release` 交叉编译，产物供排查与自用。

CLI 与桌面是同一次发布的两个渠道。桌面渠道失败不阻断 CLI 发布。

## 公开 GitHub Release

触发：在 Actions 上手动跑 Release，或推送 `v*` tag。

源码闸门（typecheck、lint、test、i18n）红了不进编译。CI 按目标在对应原生 OS 上构建；本机 `pnpm release:github` 走交叉编译，同样切公开 Release，需要已登录且有推送权限的 `gh`。发布说明由 GitHub `--generate-notes` 根据 PR 历史生成。

macOS 桌面目标必须签名并公证，否则该目标被阻断（见 [桌面渠道](../non-functional/release.md#桌面渠道)）。CLI 的 macOS 签名见 [release.md](../non-functional/release.md)。

## 本机产物树

`pnpm release` 在一台 macOS 或 Linux 机器上用 Bun 交叉编译三平台，过同一道源码闸门后留下本机产物。桌面渠道用 `pnpm release:desktop`。
