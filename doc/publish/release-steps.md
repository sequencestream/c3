# 发布步骤 — c3 二进制 Release

> 对应 doc/non-functional/release.md(release 1–7)。
>
> **开源版说明:** 已移除 minisign 签名子系统与 `c3 verify` 命令(签名密钥、`.minisig`
> 产物、`release:keygen`、`publish:binaries` 均已删除)。产物完整性由 **sha256 校验和**
> (`.sha256` / `SHA256SUMS`)+ **公开 GitHub Release 的 HTTPS** 提供。早期的自建
> license-server 产物分发端(`/v1/artifact/upload`)也已随 license-server 一并移除。
> **开源版的产物分发以 CI 切割的公开 GitHub Release 为准**;release notes 由 GitHub
> `--generate-notes` 基于 PR 历史自动生成。

## 概述

c3 发布的是**单二进制**(macOS / Linux / Windows),经公开 GitHub Release 分发。可信度链条:

- **构建**:`bun build --compile` 出二进制 → 打包 tar.gz/zip + `manifest.json`。本地 `pnpm release` 用 Bun **交叉编译**在一台 macOS/Linux 机器上一次产出三目标(`linux-x64` / `macos-arm64` / `windows-x64`,无需 Docker、无需 Windows 机器);CI 则各目标跑在其原生 OS runner 上。
- **校验和**:对每个产物生成 `.sha256`,并汇总出 `SHA256SUMS`。macOS 目标在计算哈希前先做 ad-hoc `codesign -s -`(仅临时签名,非 Apple 公证)。
- **校验**:使用者用 `shasum -a 256 -c <artifact>.sha256`(或对照 `SHA256SUMS`)校验下载完整性;传输信任来自 GitHub 的 HTTPS。
- **分发**:产物通过 CI 切成一个**公开的 GitHub Release**(仓库 `sequencestream/c3`)供用户下载。

发布路径:**本地手动**(`pnpm release`,在一台机器上交叉编译三目标 → 生成校验和 → 汇集,产物供排查/自用)与 **CI**(各目标原生 OS 构建 → 切公开 GitHub Release,面向公众)。两者调用同一批 `scripts/release/*` 脚本,逻辑同源。

---

## 前置条件

| 名称        | 用途              | 配置位置                                                  |
| ----------- | ----------------- | --------------------------------------------------------- |
| GitHub 推送 | 切 GitHub Release | 已登录且有推送权限的 `gh` CLI(CI 使用内置 `GITHUB_TOKEN`) |

> `dist/` 全目录 gitignored。开源版不再需要签名私钥。

---

## 路径 A:CI 发布(公开分发)

CI workflow:`.github/workflows/release.yml`。各目标在其原生 OS runner 上构建(不交叉编译),最终切出公开 GitHub Release。

### 触发方式

- **手动**:Actions → Release → Run workflow,可选填 `version`(如 `v0.2.0`,留空则从 git tag 推导)与 `targets`(默认四个全选)。
- **打 tag**:`git push` 一个 `v*` tag,自动重建 + 重新校验 + 重新发布。

### Job 链(`needs:` 强制顺序)

1. **setup** — 解析 `targets` / `version`。
2. **pregate** — 源码闸门:`typecheck → lint → test → i18n:check → i18n:check-freeze`。红了不进编译。
3. **build:<target>**(各跑在原生 OS)—— `build → smoke`,上传按目标分类的制品。
4. **verify-dist** — 合并各目标制品 → 生成 `SHA256SUMS` → 发布门禁(manifest ↔ SHA256SUMS ↔ 磁盘 + 必需目标完整性)。
5. **provenance** — 对每个制品生成 SLSA L3 溯源(OIDC 无密钥)。
6. **publish** — `gh release create`,携带每个制品 + `.sha256` sidecar + `SHA256SUMS`;**release notes 由 `--generate-notes` 基于 PR 历史自动生成**。
   - 取消勾选的目标 = **跳过**(不报红)。

### 校验 CI 产物

发布完成后,从 GitHub Release 下载某产物及其 `.sha256`,本地校验:

```bash
shasum -a 256 -c c3-vX.Y.Z-macos-arm64.tar.gz.sha256   # 或对照 SHA256SUMS
```

---

## 路径 B:本地手动构建(`pnpm release`)

一台 macOS/Linux 机器即可完成「交叉编译三目标 → 生成校验和 → 汇集」。产物落在 `dist/release-artifacts/v<版本>/`,供排查/自用;公开分发由 CI 负责。需装 Bun。

### `pnpm release` —— 交互式本地构建

```bash
pnpm release
```

依次执行:

1. **提示版本号**(默认给出推导值,回车采用;或 `--version=0.8.0` 非交互指定)。
2. **源码闸门 pregate**(`typecheck → lint → test → …`,红了不进编译;`--skip-gate` 跳过)。
3. **交叉编译三目标** `linux-x64` / `macos-arm64` / `windows-x64`(Bun `--target`,一台机器全出;Windows 直接产出 `c3.exe`)。构建为 `bun --compile`(minify),无代码混淆。
4. **生成校验和**:出每包的 `.sha256`、汇总 `SHA256SUMS`。
5. **汇集**到 `dist/release-artifacts/v<版本>/`。

常用参数:

```bash
pnpm release --version=0.8.0            # 非交互指定版本(无 TTY 时必需)
pnpm release --skip-upload             # 只构建+校验和+汇集
pnpm release --targets=windows-x64     # 只构建某目标(覆盖默认三目标)
pnpm release --skip-gate               # 跳过源码闸门(调试)
pnpm release --dry-run                 # 排练:跑闸门 + 打印计划,不构建
```

### `pnpm release:github` —— 一体化 GitHub 发布编排器

`pnpm release:github` 串联 gate → build → notes → publish,一键在 `sequencestream/c3` 上切一个公开 GitHub Release(release notes 由 GitHub `--generate-notes` 自动生成)。需要已登录且有推送权限的 `gh` CLI。

```bash
pnpm release:github                # 完整:gate → build(+smoke) → notes → publish
pnpm release:github --no-publish   # gate + build + checksum + notes,不创建 GitHub Release
pnpm release:github --dry-run      # 排练每个阶段,不打 tag / 不跑 gh
```

> 开源版分发以 GitHub Release 为准。CI(路径 A)是常规的自动发布入口;`pnpm release:github`(本地一键端到端)是等价的手动路径,两者调用同一批 `scripts/release/*` 脚本。

---

## 相关脚本速查

| 命令                       | 作用                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm release`             | **交互式本地构建**:提示版本 → 交叉编译三目标 → 生成校验和 → 汇集 `dist/release-artifacts/v<版本>/` |
| `pnpm release:build`       | 仅构建 + 打包 + manifest(`--targets` / `--skip-web` / `--skip-pack`)                               |
| `pnpm release:sign`        | 对 dist/ 产物生成校验和(出 `.sha256` / `SHA256SUMS`)                                               |
| `pnpm release:smoke`       | 冒烟:`--version` + headless 启动                                                                   |
| `pnpm release:verify-dist` | postgate:manifest ↔ SHA256SUMS ↔ 磁盘一致性                                                        |
| `pnpm release:github`      | GitHub 发布编排:gate → build → notes → 切公开 GitHub Release                                       |
