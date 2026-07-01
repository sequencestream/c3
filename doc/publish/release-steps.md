# 发布步骤 — c3 二进制 Release

> 对应 doc/non-functional/release.md(release 1–7)与 ADR-0026(自建 license-server 作为产物分发方)。
> 签名信任锚见 `server/src/release-pubkey.ts`(内嵌 minisign 公钥)。

## 概述

c3 发布的是**带签名的单二进制**(macOS / Linux / Windows)。可信度链条:

- **构建**:`bun build --compile` 出二进制 → 打包 tar.gz/zip + `manifest.json`。本地 `pnpm release` 用 Bun **交叉编译**在一台 macOS/Linux 机器上一次产出三目标(`linux-x64` / `macos-arm64` / `windows-x64`,无需 Docker、无需 Windows 机器);CI 则各目标跑在其原生 OS runner 上。
- **签名**:用 **minisign 私钥**对每个产物生成 `.sha256` 与 `.minisig`,并出 `SHA256SUMS` / `SHA256SUMS.minisig` 与可分发公钥 `minisign.pub`。
- **校验**:用户用 `c3 verify`(二进制内嵌公钥,离线)或官方 `minisign -V` 校验下载。
- **分发**:签名产物 POST 到**自建 license-server**(`/v1/artifact/upload`),按 `<version>/<batch>/<filename>` 落盘。**不再**走 GitHub Release / SLSA provenance(见近期提交 `a7c9db2`)。

两条发布路径:**本地手动**(`pnpm release`,在一台机器上交叉编译三目标 → 签名 → 上传)与 **CI**(各目标原生 OS)。两者调用同一批 `scripts/release/*` 脚本,逻辑同源。

---

## 前置条件(Secrets / 密钥)

| 名称       | 用途                               | 本地解析优先级 / 配置位置                                                                                                           |
| ---------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 签名私钥   | 对产物签名(base64 `keyId\|\|seed`) | `C3_MINISIGN_SECRET_KEY[_FILE]` > `--key-file` > `dist/c3-minisign-secret.key`;CI 用 GitHub Secret                                  |
| 上传地址   | license-server 上传 URL            | `--server` > `C3_ARTIFACT_SERVER_URL` > 默认 **`https://c3.sequencestream.com/`**                                                   |
| 上传 token | 上传鉴权 bearer token              | `--token` > `C3_ARTIFACT_UPLOAD_TOKEN` > `dist/.upload_license_server_auth_token.key`;须与服务端 `C3_LS_ARTIFACT_UPLOAD_TOKEN` 对齐 |

> `dist/` 全目录 gitignored,私钥文件与 token 文件放这里不会进 git。缺私钥 → 仍出 `.sha256` 但跳过 `.minisig`;缺 token → 跳过上传(no-op)。
> CI 的 build/preflight job 都声明 `environment: default`,才能读到环境级 secrets(见提交 `dc80c6a`)。

---

## 路径 A:CI 发布

CI workflow:`.github/workflows/release.yml`。各目标在其原生 OS runner 上构建(不交叉编译)。

### 触发方式

- **手动**:Actions → Release → Run workflow,可选填 `version`(如 `v0.2.0`,留空则从 git tag 推导)与 `targets`(默认四个全选)。
- **打 tag**:`git push` 一个 `v*` tag,自动重建 + 重签 + 重传。

### Job 链(`needs:` 强制顺序)

1. **setup** — 解析 `targets` / `version` / 共享 `batch`(一次 UTC 时间戳,全目标同一子目录)。
2. **preflight** — 不做任何昂贵工作前,先用「无文件 POST」探测上传端点:`400`=URL 可达且 token 被接受 ✅;`401`=token 错;`503`=服务端未配置;`000`=URL 不可达。任何非 400 直接 fail。
3. **pregate** — 源码闸门:`typecheck → lint → test → i18n:check → i18n:check-freeze`。红了不进编译。
4. **build-publish-<target>**(四个自包含 job,各跑在原生 OS)——每个目标一条龙:`build → smoke → sign → verify(postgate) → upload-to-server`。
   - 因禁止交叉编译,签名在**每个 runner** 上发生,故 minisign 私钥需对四个 OS runner 都可见。
   - **没有**跨目标统一 `manifest.json` / `SHA256SUMS`:每个目标携带自己的单目标 sidecar,用户用各自的 `.minisig` 校验。
   - 取消勾选的目标 = **跳过**(不报红)。

### 校验 CI 产物

发布完成后,从 license-server 下载某产物及其 `.minisig`,本地校验:

```bash
c3 verify ./c3-vX.Y.Z-macos-arm64           # 用二进制内嵌公钥
minisign -Vm c3-vX.Y.Z-macos-arm64 -P RWQzBKv0lANWnVsOQNO6o7YjLi0MbFGbI0K0fUTIaXTWKM62tlosg306
```

---

## 路径 B:本地手动发布(`pnpm release`)

一台 macOS/Linux 机器即可完成「交叉编译三目标 → 签名 → 汇集 → 上传」。需装 Bun,并本机持有签名私钥(见前置条件)。

### `pnpm release` —— 交互式一键发布

```bash
pnpm release
```

依次执行:

1. **提示版本号**(默认给出推导值,回车采用;或 `--version=0.8.0` 非交互指定)。
2. **源码闸门 pregate**(`typecheck → lint → test → …`,红了不进编译;`--skip-gate` 跳过)。
3. **交叉编译三目标** `linux-x64` / `macos-arm64` / `windows-x64`(Bun `--target`,一台机器全出;Windows 直接产出 `c3.exe`)。默认 `--harden=standard`(**混淆**:字符串数组 + 标识符重命名),可 `--harden=basic`(仅 minify)/ `--harden=none`(调试)。
4. **签名**:出每包的 `.sha256` / `.minisig`、`SHA256SUMS` / `SHA256SUMS.minisig`,并派生可分发公钥 `minisign.pub`(与二进制内嵌公钥同源,`c3 verify` 与 `minisign -V` 均可校验)。找不到私钥则只出 sha256 并告警。
5. **汇集**到 `dist/release-artifacts/v<版本>/`(即 `publish:server` / `publish:binaries` 读取的扁平布局)。
6. **询问是否上传** license-server(交互 y/N,默认 N);token 存在且确认后才上传。

常用参数:

```bash
pnpm release --version=0.8.0            # 非交互指定版本(无 TTY 时必需)
pnpm release --harden=basic            # 只 minify,不混淆
pnpm release --skip-upload             # 只构建+签名+汇集,不上传
pnpm release --targets=windows-x64     # 只构建某目标(覆盖默认三目标)
pnpm release --skip-gate               # 跳过源码闸门(调试)
pnpm release --dry-run                 # 排练:跑闸门 + 打印计划,不构建不上传
pnpm release --server=… --token=…      # 覆盖上传地址 / token
```

> 上传地址默认 `https://c3.sequencestream.com/`;token 默认取 `dist/.upload_license_server_auth_token.key`(见前置条件)。设好这两项后 `pnpm release` 末尾即可一路上传到生产 license-server。

### `pnpm publish:server` —— 单独上传已构建产物

已经 `pnpm release`(或 `--skip-upload`)产出了 `dist/release-artifacts/v<版本>/`,想稍后单独推送时用:

```bash
pnpm publish:server --dist=dist/release-artifacts/v0.8.0 --version=v0.8.0
pnpm publish:server --dist=dist/release-artifacts/v0.8.0 --version=v0.8.0 --dry-run   # 只打印 PUT 清单,不上传
```

- **上传地址**:`--server` > `C3_ARTIFACT_SERVER_URL` > 默认 `https://c3.sequencestream.com/`。
- **token**:`--token` > `C3_ARTIFACT_UPLOAD_TOKEN` > `dist/.upload_license_server_auth_token.key`;都没有则 no-op(exit 0),本地未配置也无害。
- **批次** `--batch=20260701-1354Z`(默认取当前 UTC 时间戳);同一次发布的所有文件共用一个批次,落到 `<版本>/<批次>/` 同一子目录。
- 上传集 = 每个包 + `.sha256` / `.minisig` + `SHA256SUMS`(`.minisig`)+ `minisign.pub` + `manifest.json`,逐个 POST 到 `/v1/artifact/upload`,带 `X-Artifact-Sha256` 头供服务端校验。

### `pnpm publish:binaries` —— 发布到公开 GitHub Release(旧路径)

**与 `publish:server` 的区别:分发目标不同。** `publish:server` 推到**自建 license-server**;`publish:binaries` 是把签名产物切成一个**公开的 GitHub Release**(默认仓库 `sequencestream/c3`)。设计动机:源码仓库私有,但签名二进制要公开下载,于是在持有私钥的可信机器上本地签名后发到公开镜像仓库。

```bash
pnpm publish:binaries [<版本>]                     # 默认自动选 dist/release-artifacts/ 下最高版本
pnpm publish:binaries --dry-run                    # 排练:打印完整计划(版本/key id/目标/create-vs-clobber),不 merge/sign/commit/gh
pnpm publish:binaries --repo=owner/name --clobber  # 覆盖目标仓库 / 对已存在 tag 重传资产
```

它读取 `dist/release-artifacts/<版本>/`(扁平或按目标分子目录两种布局都认),然后:**签名**每个包(私钥同 `release:sign`)+ 写 `minisign.pub` + 自校验一条签名 → **verify-dist** 一致性校验 → 若公开仓库空则先 bootstrap 一次 README commit → **`gh release create`**(带全部产物 + sidecar + `SHA256SUMS`(`.minisig`)+ `minisign.pub`)。需要已登录且有推送权限的 `gh` CLI。其它开关:`--allow-unsigned`(不推荐,不带 `.minisig`)、`--yes`(跳过 bootstrap 确认)、`--key-file=<path>`。

> `pnpm release:github` 是**旧的 GitHub 发布编排器**(gate → build → notes → publish,一键切源码仓库的 GitHub Release)。当前分发以 **license-server 为准**,`publish:binaries` / `release:github` 两条 GitHub 路径都属保留备用。

---

## 密钥轮换(rotate)

⚠️ 当前生效公钥 **key id `3304abf49403569d`**(2026-06-19 轮换;旧 `061223695cdd6df5` 已作废)。

轮换会让旧公钥签出的所有已发布产物**无法被新二进制校验**,反之亦然,务必整套替换:

```bash
# 1. 生成新密钥对(私钥写 dist/c3-minisign-secret.key,mode 600,gitignored;私钥不打印)
node scripts/release/keygen.mjs          # 或 pnpm release:keygen
```

2. 把打印出的新公钥替换到**两处**:
   - `server/src/release-pubkey.ts`(公钥文本 + 注释里的 key id)
   - `README.md`(公钥块 + `minisign -P` 命令行)
3. **重新构建二进制**(`pnpm release:build`),让新公钥嵌进去。
   - 严禁直接对「CI 用旧 key 构建后下载的 `dist/release-artifacts/<v>` 旧产物」签名发布 —— 那批二进制内嵌的是旧公钥,会出现「内嵌公钥 ≠ 签名密钥」的不一致。
4. 更新 GitHub Secret(覆盖旧值)并离线备份私钥:
   ```bash
   gh secret set C3_MINISIGN_SECRET_KEY < dist/c3-minisign-secret.key
   # 离线备份后删除本地文件:
   rm dist/c3-minisign-secret.key
   ```
5. 提交 `release-pubkey.ts` + `README.md` 改动,重新发布。

---

## 相关脚本速查

| 命令                       | 作用                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm release`             | **交互式本地发布**:提示版本 → 交叉编译三目标 → 签名 → 汇集 `dist/release-artifacts/v<版本>/` → 询问上传    |
| `pnpm publish:server`      | 把已构建的 `--dist=<目录>` 推送到自建 license-server(默认地址 c3.sequencestream.com,token 取自 dist/ 文件) |
| `pnpm release:build`       | 仅构建 + 打包 + manifest(`--targets` / `--harden` / `--skip-web` / `--skip-pack`)                          |
| `pnpm release:sign`        | 对 dist/ 产物签名(出 `.sha256` / `.minisig` / `SHA256SUMS`)                                                |
| `pnpm release:smoke`       | 冒烟:`--version` + headless 启动                                                                           |
| `pnpm release:verify-dist` | postgate:manifest ↔ SHA256SUMS ↔ 磁盘一致性                                                                |
| `pnpm release:keygen`      | 生成 minisign 密钥对                                                                                       |
| `pnpm release:github`      | (旧路径)GitHub 发布编排:gate → build → notes → 切 GitHub Release                                           |
| `pnpm publish:binaries`    | (旧路径)本地签名下载的 CI artifacts 并切 GitHub Release                                                    |
