# 发布步骤 — c3 二进制 Release

> 对应 doc/non-functional/release.md(release 1–7)与 ADR-0026(自建 license-server 作为产物分发方)。
> 签名信任锚见 `server/src/release-pubkey.ts`(内嵌 minisign 公钥)。

## 概述

c3 发布的是**带签名的单二进制**(macOS / Linux / Windows)。可信度链条:

- **构建**:每个目标在其原生 OS 上 `bun build --compile` 出二进制 → 打包 tar.gz/zip + `manifest.json`。
- **签名**:用离线持有的 **minisign 私钥**对每个产物生成 `.sha256` 与 `.minisig`,并出 `SHA256SUMS`。
- **校验**:用户用 `c3 verify`(二进制内嵌公钥,离线)或官方 `minisign -V` 校验下载。
- **分发**:签名产物 POST 到**自建 license-server**(`/v1/artifact/upload`),按 `<version>/<batch>/<filename>` 落盘。**不再**走 GitHub Release / SLSA provenance(见近期提交 `a7c9db2`)。

两条发布路径:**CI(推荐,默认)** 与 **本地手动**。两者调用同一批 `scripts/release/*` 脚本,逻辑同源。

---

## 前置条件(Secrets / 密钥)

| 名称                       | 用途                             | 配置位置                                                                 |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `C3_MINISIGN_SECRET_KEY`   | 签名私钥(base64 `keyId\|\|seed`) | GitHub Secret(CI)/ 环境变量或 `dist/c3-minisign-secret.key`(本地)        |
| `C3_ARTIFACT_SERVER_URL`   | license-server 上传地址          | GitHub Secret(`default` 环境)                                            |
| `C3_ARTIFACT_UPLOAD_TOKEN` | 上传鉴权 bearer token            | GitHub Secret(`default` 环境)+ 服务端 `C3_LS_ARTIFACT_UPLOAD_TOKEN` 对齐 |

> CI 的 build/preflight job 都声明 `environment: default`,才能读到环境级 secrets(见提交 `dc80c6a`)。

---

## 路径 A:CI 发布(推荐)

CI workflow:`.github/workflows/release.yml`。

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

## 路径 B:本地手动发布

需本机持有签名私钥。私钥来源(优先级):环境变量 `C3_MINISIGN_SECRET_KEY[_FILE]` > `--key-file` > 默认 `dist/c3-minisign-secret.key`。

```bash
# 1. 构建全部目标(或 --targets=… 子集);默认 harden=basic
pnpm release:build

# 2a. 一键编排:build → notes → 签名 → 发布(等价串联)
pnpm release                      # 完整流程
pnpm release --no-publish         # 只 build + sign + notes,不发布
pnpm release --dry-run            # 排练,不执行任何不可逆操作

# 2b. 或分步执行
pnpm release:sign                 # 对 dist/ 已构建产物签名(读私钥)
pnpm release:verify-dist          # 校验 manifest ↔ SHA256SUMS ↔ 磁盘一致

# 3. 推送签名产物到自建 license-server
C3_ARTIFACT_SERVER_URL=https://… C3_ARTIFACT_UPLOAD_TOKEN=… \
  node scripts/publish/upload-to-server.mjs --dist=dist
```

> `upload-to-server.mjs` 在 URL 或 token 缺失时 no-op(exit 0),本地未配置也无害。
> `scripts/publish/publish-binaries.mjs`(`pnpm publish:binaries`)是另一条「下载 CI artifacts → 本地签名 → 切 GitHub Release」的旧路径;当前分发已转向 license-server,新流程优先用上面的 upload-to-server。

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

| 命令                                   | 作用                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm release`                         | 顶层编排:build → notes → publish                                                |
| `pnpm release:build`                   | 构建 + 打包 + manifest(`--targets` / `--harden` / `--skip-web` / `--skip-pack`) |
| `pnpm release:sign`                    | 对 dist/ 产物签名(出 `.sha256` / `.minisig` / `SHA256SUMS`)                     |
| `pnpm release:smoke`                   | 冒烟:`--version` + headless 启动                                                |
| `pnpm release:verify-dist`             | postgate:manifest ↔ SHA256SUMS ↔ 磁盘一致性                                     |
| `pnpm release:keygen`                  | 生成 minisign 密钥对                                                            |
| `pnpm publish:binaries`                | (旧路径)本地签名下载的 CI artifacts 并切 GitHub Release                         |
| `scripts/publish/upload-to-server.mjs` | 推送签名产物到自建 license-server                                               |
