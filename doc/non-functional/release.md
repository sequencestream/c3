# 非功能性 — 发布与分发

> **状态:** release 8/7 + 7/7 + 6/7 + 5/7 + 4/7。编排 + P0 矩阵(1/7),版本注入
>
> **说明:** 分发经**公开 GitHub Release**,完整性由 **sha256 校验和(`.sha256` /
> `SHA256SUMS`)+ GitHub HTTPS** 提供;发布经 CI 的 GitHub Release,release notes 由
> GitHub `--generate-notes` 基于 PR 历史自动生成。
>
> - manifest 框架(2/7),分发信任 — SHA256SUMS + sha256 校验和 +
>   macOS ad-hoc(3/7),**分层质量门禁** — 构建前阻塞门禁 +
>   制品级无头冒烟测试 + 发布终检(5/7),**Windows 分支** — 矩阵中的
>   Windows-x64,Windows 平台代码路径
>   (4/7),**GH Actions 原生矩阵** — 用 `needs:` 链物理强制
>   门禁顺序,macOS ad-hoc 代码签名真实运行在 darwin runner 上,通过 OIDC 无密钥方式的 SLSA 溯源 — 以及
>   **二进制文件与包拆分(8/7)** — 二进制文件始终命名为 `c3`(Windows 上为 `c3.exe`);版本 + 平台信息只存在于包文件名中
>   (`c3-v{version}-{target}{.tar.gz|.zip}`);manifest `v1.2` 为每个制品新增 `binary` + `binarySha256`
>   字段 — 均已上线。macOS 公证(Developer ID + notarytool)与 Windows
>   Authenticode(signtool + PFX)推迟到后续波次 — 它们需要 GitHub Secrets 中的真实
>   证书,而我们目前还没有。
>
> **开源版说明(混淆已移除):** c3 是开源软件,已**彻底移除代码混淆
> (`javascript-obfuscator`)以及围绕它的 harden 分层机制**。构建始终为
> 「编译(`bun --compile`)→ 打包(pack)→ sha256 校验和」——不再有混淆阶段,
> 不再有 `--harden` / `RELEASE_HARDEN` / `C3_OBFUSCATE_FAIL` 参数或环境变量,
> manifest 也不再有 `harden` / `obfuscation` 字段。下文凡涉及混淆 / harden 分层的
> 描述均为**历史设计**,已删除。

`release` 是建立在既有 build/binary 原语之上的一层薄薄的**编排**层。
它不会替代 `pnpm build`(打包好的 web-plus-server 产物)或 `pnpm binary`
(单个原生可执行文件);它负责对多平台产物进行排序和扇出。参见
[ADR-0010](../architecture/adr/0010-release-and-distribution-trust.md) 与
[ADR-0003](../architecture/adr/0003-single-binary-via-bun-compile.md)。

## 分发契约 — 单一二进制文件并非自包含(ADR-0012)

`c3` 单一二进制文件本身携带 c3,再加上 vendor CLI 的安装器/解析器逻辑。默认的
智能体执行使用 c3 管理的 vendor 安装,路径为 `~/.c3/vendor/<vendor>/<version>/bin/<binary>`。
发布文档必须把这一契约写明:

- **解析优先级是固定的。** `CLAUDE_PATH` / `CODEX_PATH` 优先,其次是 c3 管理的 CLI,最后是
  降级的 host PATH 回退。
- **托管安装是经过校验且有状态的。** c3 读取 npm packument,下载 tarball,
  校验 `dist.integrity`,暂存/自检二进制文件,并把来源/版本/错误状态记录在
  `~/.c3/vendor/manifest.json` 中。
- **回退不等于成功。** 如果托管安装或同步失败,但 host PATH 中存在可用的 CLI,
  智能体可以在 `host-path-fallback` 状态下运行;日志必须保留托管失败的原因。
- **凭据在 c3 之外。** c3 从不写入或迁移 `~/.claude`、`~/.codex`、令牌、shell
  配置文件、包管理器安装,或 PATH。

这是 ADR-0012(vendor 可执行文件解析是第一个能力门禁)在分发层面的体现。

## 阶段顺序(质量门禁顺序)

构建以严格的、无竞态的阶段运行。Phase0/1 恰好各执行一次;Phase2 扇出且只是
纯读取者,因此 N 个目标从不会写同一个共享文件(这是旧竞态的根源)。

| Phase    | 步骤                  | 基数                             | 产出                                                                                        |
| -------- | --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| Phase0   | web 构建              | 一次,与平台无关                  | 编译后的 web bundle                                                                         |
| Phase1   | generate-static-embed | 一次                             | web bundle 的一次性快照,可嵌入二进制文件(已被 gitignore,不提交)                             |
| Phase2   | `bun --compile` 扇出  | 每个目标一次,**并行**            | 每个目标各自 scratch 区域中的 `c3` 二进制文件(相对 Phase1 快照只读)                         |
| Phase2.5 | pack                  | 每个目标一次,Phase2 之后**串行** | 可分发的包 `c3-v{ver}-{target}{.tar.gz\|.zip}`,连同二进制文件内部的 sha256 sidecar 一起打包 |

可嵌入的快照保存在**已提交源码树之外**:源码里携带一个永久性的空占位符,供日常
bundle/dev/typecheck 路径使用,而 Bun 编译路径在构建时把该 import 重定向到 Phase1
快照。这正是让并行多目标构建时工作区保持干净的关键。

构建之后的质量门禁顺序在下面的**质量门禁**一节中规定。

## 质量门禁(release 5/7)

三层互不重叠的门禁,按成本排序,让廉价的红灯永远不会烧到昂贵的阶段。这个顺序
**就是 CI release workflow 的规格**(后续波次)——`pnpm release:github` 编排器
实现的是同一套顺序。本地 `pnpm release` 只跑门禁 0(pregate)+ 门禁 1(制品冒烟),
不跑门禁 2(发布门禁仅限打 tag/`gh`);它的产出是收集到 `dist/release-artifacts/`
的本地产物集合,而不是直接切割 GitHub Release(切割公开 Release 由 CI 的
`pnpm release:github` 负责)。

| #   | 门禁         | 层级 | 运行内容                                                              | 遇红时                       |
| --- | ------------ | ---- | --------------------------------------------------------------------- | ---------------------------- |
| 0   | **pregate**  | 源码 | `typecheck → lint → test → i18n:check → i18n:check-freeze`(严格顺序)  | 在任何编译**之前**中止       |
| 1   | **制品门禁** | 产物 | 每个 host-runnable 目标:`c3 --version` + 无头冒烟测试                 | 构建失败                     |
| 2   | **发布门禁** | 分发 | manifest ↔ SHA256SUMS ↔ 磁盘上 sha256 三方一致 + **所有 P0 目标齐全** | 在打 tag / `gh` **之前**中止 |

- **Pregate**(`release:gate`)在 `pnpm release` 中最先运行,并且快速失败:第一个
  非零门禁就中止,所以红色的 typecheck 永远不会走到多平台的 `bun --compile`。
  `--skip-gate` 可以跳过;`--dry-run` 只打印计划。
- **制品门禁**是构建过程的 **Phase3** 冒烟测试。无头冒烟测试在**随机空闲端口**上启动
  服务器(操作系统分配的 bind-0;CLI 拒绝 `--port 0`),对 `/` 做 HTTP 探测
  直到有响应,然后杀掉进程。它**从不调用 claude**——调用 claude 会让 CI 永远
  阻塞(没有交互式应答者),而一次裸的服务器启动只有在发起一次 run 时才会触碰
  claude。跨平台编译出来的二进制文件无法在异构主机上执行,所以冒烟测试**只在
  host-runnable 的目标上**运行;CI 会在各自的操作系统 runner 上冒烟测试每个平台。
  `--skip-smoke` 可以跳过。这条冒烟例程**本身就是**测试载体;一个配套的单元测试
  覆盖其中的纯函数辅助逻辑(这样 `pnpm test`——本身就是 pregate 的一部分——在任何
  制品存在之前就能保持绿色)。
- **发布门禁**(`release:verify-dist`)在生成校验和之后、打 tag 之前的发布步骤内运行:
  它重新对每个制品做哈希,检查 manifest、`SHA256SUMS` 与磁盘上的字节是否逐行一致,
  并确认**每个 P0 目标都在场**——集合不完整或已漂移都会阻断发布。

### 门禁归属:commit 级增量 vs release 全量

| 门禁                        | 范围                 | 触发时机          | 负责内容                                   |
| --------------------------- | -------------------- | ----------------- | ------------------------------------------ |
| husky + lint-staged         | **仅暂存文件**(增量) | 每次 `git commit` | `eslint --fix` + `prettier` + `i18n:check` |
| CI on push/PR               | 整棵树               | 每次 push / PR    | `typecheck` + `lint` + `i18n:check`        |
| **release pregate + gates** | 整棵树 + 每个制品    | 切割一次发布      | 上面完整的表格                             |

husky/lint-staged 守护的是 **commit 级增量**;release 门禁守护的是**完整分发**。
它们刻意不重叠——`test` 和 `i18n:check-freeze` 只在 release 时跑(对每次 commit
来说太重)。

## CI:GH Actions 原生矩阵(release 6/7)

GH Actions release workflow 在真实的 GH Actions runner 上执行五层门禁顺序,
并用 `needs:` **物理**强制阶段顺序——上游任务一红,所有下游任务全部跳过。这正是
解锁 macOS ad-hoc + SLSA 收益的关键(见下文「SLSA 溯源」):每个目标都构建在自己的
**原生操作系统 runner** 上(`ubuntu-latest` / `macos-14` / `windows-latest`),
因此跨平台编译不再是问题。(字节码本来也会是仅原生才有的收益,但它已被禁用——见
下文「字节码 — 已禁用」。)

```text
setup (ubuntu-latest)
  └─ 解析 version → outputs.{version,batch}(目标固定,每次构建全部)
pregate (ubuntu-latest)
  └─ typecheck → lint → test → i18n:check → i18n:check-freeze
build:linux-x64      (ubuntu-latest)     needs: [pregate, setup]
build:macos-arm64    (macos-14)          needs: [pregate, setup]
build:windows-x64    (windows-latest)    needs: [pregate, setup]   ⚠️experimental
  └─ pnpm release:build --targets=<one> --skip-smoke   (env C3_RELEASE_VERSION=<version>)
  └─ 在 darwin runner 上做 ad-hoc codesign(在 linux/windows 上是空操作)
  └─ actions/upload-artifact@v4 → c3-<target>(上传的是包的 sidecar,而非二进制文件本身)
smoke:<target>       (same OS as build)  needs: [build:<target>]
  └─ pnpm release:smoke --file=<artifact>  (--version + 无头 HTTP 探测)
verify-dist          (ubuntu-latest)     needs: [setup, smoke:{linux,macos-arm64,windows}-x64]
  └─ if: !cancelled()  (被排除的目标是 SKIPPED,不是红——发布门禁才是真正的关卡)
  └─ 下载制品(按目标分子目录,NO merge-multiple)→ 合并 → 发布门禁
     (每个 build 任务各自产出自己的 manifest;merge-multiple 会让它们互相覆盖,
      导致只有一个目标存活——合并步骤把各子目录折叠成一份完整的 manifest +
      SHA256SUMS,随后发布门禁检查 manifest↔SHA256SUMS↔磁盘 + 必需目标完整性)
provenance           (ubuntu-latest)     needs: [setup, verify-dist]   if: !cancelled() && !failure()
  └─ 下载所有制品(merge-multiple 可以——包名各不相同,不需要 manifest)
  └─ actions/attest-build-provenance@v2 针对每个已选目标(OIDC 无密钥;SLSA L3)
publish              (ubuntu-latest)     needs: [setup, provenance]    if: !cancelled() && !failure()
  └─ 下载制品(按目标分子目录)→ 合并(发布步骤读取合并后的 manifest)
  └─ pnpm release:publish(生成 sha256 校验和 + verify-dist 复检 + 打 tag + gh release,notes 由 --generate-notes 生成)
```

来自 `needs:` + `if:` 的阶段顺序保证:

- 红色的 `pregate` 会跳过全部三个 `build:` 任务(不会在红色源码树上尝试跨平台编译)。
- 一个**必需**目标出现红色的 `build:<target>` ⇒ 它的制品在重新聚合的制品集合中
  缺席 ⇒ 发布门禁会因缺少必需目标而中止 `verify-dist`。
- 红色的 `verify-dist` ⇒ `failure()` ⇒ `provenance` 和 `publish` 都跳过(不打 tag,不跑 `gh`)。
- 红色的 `provenance` ⇒ `failure()` ⇒ `publish` 跳过。

该 workflow 在 `workflow_dispatch`(手动发布入口)和 `push tags: 'v*'`
(重新发布、重新校验)上运行。`workflow_dispatch` 的输入项:

- **`version`** — 显式的发布版本,例如 `v0.1.0`。会作为 `C3_RELEASE_VERSION` 传递给每个
  build + publish 任务(覆盖 `git describe`;见「版本单一真源」)。为空 ⇒ 从
  git tag 推导(`push tags` 路径总是留空)。
- 目标是**固定的**(`linux-x64,macos-arm64,windows-x64`),没有目标子集输入项——每次
  运行都构建全部目标。每个 build 任务通过 `C3_REQUIRED_TARGETS=<自身目标>` 把该目标
  传给发布门禁 / `verify-dist`。

本地 `pnpm release` 与 CI 共享**同一套 node 脚本**(`release:build`、
`release:smoke`、`release:verify-dist`、`release:publish`)——矩阵只是一个扇出的
载体,不是第二套实现。

## 字节码 — 已禁用(ESM/CJS 不兼容)

Bun 的 `--bytecode` 会把 JS 预编译成字节码,给冷启动省下几百毫秒。目前它在每个
目标上都**已禁用**。Bun 的字节码路径只接受 **CommonJS** bundle,而我们暂存的
bundle 是 **ESM**,所以 `bun --compile --bytecode` 产出的二进制文件会在启动时
中止,报出 `TypeError: Expected CommonJS module to have a function wrapper`。

字节码只是一个启动耗时的性能缓存——它**不是**防篡改手段,也不提供任何反反编译
价值。与其把整个 bundle 转成 CJS(有 Zod 方法分发被破坏的风险),我们选择保持
`--bytecode` 关闭,接受这点小小的冷启动代价。每个目标的构建日志会打印
`bytecode=off` 以明确这一点。

> 说明(release 6/7 历史):规格文档曾经声称原生 host 构建会自动开启字节码,
> 但这个标志实际上从未被真正注入到编译命令中——是个潜藏的空操作。等它真正
> 被接上之后,才暴露出上面的 ESM/CJS 不兼容问题,于是被刻意禁用。

## SLSA 溯源 — P1(release 6/7)

GH Actions release workflow 有一个 `provenance` 任务(`needs: [verify-dist]`),
针对每个制品运行一次 `actions/attest-build-provenance@v2`,使用 runner 的
**OIDC token**(`permissions: id-token: write`、`attestations: write`)。生成的
`.intoto.jsonl` SLSA L3 溯源认证会连同二进制文件一起上传到 GitHub Release,
可以用 `gh attestation verify <file>` 离线验证。

**溯源认证有意不放进 `verify-dist` 门禁。** 它是一个并行的「供应链透明度」制品;
**sha256 校验和 + 公开 GitHub Release(HTTPS)才是信任根**(见下文「分发信任」)。
这种分离让我们可以在不收紧信任底线、也不让 OIDC 故障成为发布阻断项的前提下加入
溯源——即便溯源生成失败,链条仍会走完(只是跳过 attest 步骤),`release:verify-dist` 不受影响。

从优先级意义上说,溯源认证是 **P1**:它会被生成并随发布上线,但项目目前还不
依赖下游验证方去消费它。未来的波次可以通过在 `verify-dist` 中要求 attestation
存在来收紧这道门禁。

## 平台波次

| 波次   | 目标                 | bun target         | 字节码 | 压缩   | 状态                  |
| ------ | -------------------- | ------------------ | ------ | ------ | --------------------- |
| **P0** | macOS-arm64          | `bun-darwin-arm64` | 关     | ✓      | 已上线                |
| **P0** | Linux-x64-glibc      | `bun-linux-x64`    | 关     | ✓      | 已上线                |
| 实验性 | Windows-x64          | `bun-windows-x64`  | 关     | ✓      | 已上线 — **⚠️实验性** |
| 后续   | Linux-arm64、musl 等 | _待定_             | _待定_ | _待定_ | 占位                  |

**`--bytecode`** 在**每个目标上都是关闭的**(ESM/CJS 不兼容——见上文「字节码 —
已禁用」)。发布构建始终 `minify`、不产出 sourcemap。CI 与本地共享同一套脚本。

**P0 与实验性目标。** P0 是**必需**集合——`release:build` 默认使用完整的
P0 矩阵,且**发布对已选中的 P0 子集把关**(发布门禁的必需集合 =
`P0 ∩ C3_REQUIRED_TARGETS`,未设置时默认为完整 P0):一个缺席的 P0 目标
会阻断发布。实验性目标(目前只有 `windows-x64`)是**尽力而为**:构建
编排器会警告并丢弃一个失败的实验性目标,而不是中止整个构建,这样
Windows 跨平台编译的小故障不会拖垮 P0 的切割。P0/实验性分类的友好名称
单一真源是一个独立的目标分类模块。

### Windows:在真正冒烟测试通过前保持实验性(release 4/7)

**Windows 平台代码路径**在任何冒烟测试之前就已合并(它们属于实验性目标):

- **vendor CLI 发现** — Windows 上默认托管路径位于 `%USERPROFILE%\.c3\vendor`,
  POSIX 上是 `~/.c3/vendor`;host PATH 查找仍然是平台特定的回退方式(Windows 上
  用 `where`,POSIX 上通过 `sh` 用 `command -v`)。
- **家目录** — `~/.c3` 通过操作系统的家目录约定来解析(Windows 上 →
  `%USERPROFILE%\.c3`),从不使用裸的 `~`。这在 c3 读取家目录的所有场景中一直
  成立;4/7 只是补充了覆盖范围。
- **`bun:sqlite` 启动探测** — 服务器启动时,c3 会在平台驱动上打开一个内存数据库
  并执行 `SELECT 1`。如今在 Windows Bun 二进制文件上缺失 `bun:sqlite` 会**响亮地**
  失败(`[c3] FATAL: SQLite driver "bun:sqlite" unavailable …`),而不是悄悄降级成
  一个没有持久化能力的应用。应用仍然会启动(调用方降级处理),但会大声报警。
- **构建主机** — 构建编排器查找 Bun 的逻辑也有分支(win32 上用 `where bun`),
  这样 windows-latest runner 就能构建 + 冒烟测试。

**去实验性门禁(release 6/7 已接入)。** `windows-x64` 会一直留在实验性集合中
(其 manifest 条目携带 `"experimental": true`,README 用 ⚠️ 标记)**直到真正的
无头冒烟测试在 windows-latest runner 上通过为止**——因为跨平台编译出来的二进制
文件无法在异构主机上做冒烟测试,必须用它自己的操作系统。这个冒烟测试由
GH Actions release workflow 接入(`smoke:windows-x64` 任务,`runs-on: windows-latest`);
一旦该任务变绿,把 `windows-x64` 从实验性集合中移除就是一行改动就能去掉这个
标签(它会级联生效:manifest 条目失去 `"experimental": true`,README 失去 ⚠️,
发布门禁继续强制 P0 完整性不变,因为无论如何 P1 集合都是空的)。

## 制品命名(release 8/7)

`release:build` 有意为每个目标产出**两种**不同的输出:

- **二进制文件**始终命名为 `c3`(Windows 上为 `c3.exe`),按目标各自保存在自己的
  内部 scratch 区域中。版本与平台信息**不**存在于二进制文件名中——这个二进制
  文件就是消费者拿到的 `c3`,仅此而已。各目标的 scratch 区域是内部的(每个原生
  目标一个,以便多平台在一次多目标构建中共存)。
- **包**是 GitHub Release 发布的可分发归档文件:POSIX 上是
  `c3-v{version}-{target}.tar.gz`,Windows 上是 `c3-v{version}-{target}.zip`。
  归档内部的顶层文件是 `c3`、`c3.sha256`(平铺,没有外层目录),
  所以 `tar -xzf … && ./c3 --version` 开箱即用。

在 target 标记中,`darwin`→`macos`,`win32`→`windows`;开头的 `v` 是固定的,
已带 `v` 前缀的版本号不会被重复添加。

`pnpm binary`(自用快捷方式)保留的是**不带版本号、不打包**的
host-target `c3`,不产出包。

渠道后缀(例如 `-nightly`)仍是后续波次的占位项。

命名规则(由单一真源统一支配):

- 包内的二进制文件名是 `c3` / `c3.exe`;
- 包文件名是 `c3-v{ver}-{target}{.tar.gz|.zip}`;
- 包扩展名在 Windows 上是 `.zip`,其他平台是 `.tar.gz`。

## 版本单一真源(release 2/7)

版本的**单一真源是 git tag**,而不是 `package.json` 的版本号递增——发布是通过
打 tag 来切割的(`git describe --tags --abbrev=7`)。版本解析优先级:显式的
**`C3_RELEASE_VERSION`** 覆盖值(CI 的 `version` 输入,例如 `v0.1.0`,开头的单个
`v` 会被归一化去掉)优先;其次是 **git tag**;再其次是 `package.json` 中的
**兜底基线值**,它与最新 tag 保持同步,只有在没有可达的 tag 时才会使用
(例如一次零 tag 的全新 clone)。这个覆盖值让 `workflow_dispatch` 运行可以在
tag 存在之前先盖上一个选定的版本号——之后 `release:publish` 再去切割那个
确切的 tag。

解析出的版本号、短 commit(`git rev-parse --short=7`)以及构建时间
(ISO 8601)在**编译期**通过 esbuild / Bun 的 `define` 作为构建期常量注入。
两条构建链注入的是同一批常量。编排器**只计算一次**,再传递给每个目标,
这样所有制品(以及 manifest)共享同一个构建时间。

```text
$ c3 --version
0.1.0 (commit c58a0b5, built 2026-06-05T07:22:53.535Z)
```

开发路径不应用任何 `define`;版本报告器随后通过运行时兜底逻辑退回到
`0.0.0-dev` / `unknown` / `dev`。

## 构建加固:仅 minify(混淆已移除)

发布构建对**原生二进制文件**(`pnpm release:build`、`pnpm binary`)只做一件加固相关
的事:靠 Bun 的 `--minify` 压缩、并去掉 sourcemap。由 `pnpm start` 运行的普通 node
bundle 会拿到版本 `define`,但不会被 minify。

**开源版不做代码混淆。** 早期版本曾有 `RELEASE_HARDEN` / `--harden=none|basic|standard`
分层,其中 `standard` 会用 `javascript-obfuscator` 做字符串数组化 + 标识符改名,失败
时优雅回退到裸编译并在 manifest 记录 `obfuscation.applied`。这套混淆分层**已彻底移除**
——它对真正的分发威胁(制品冒充 / 供应链篡改)没有防御价值,而信任完全来自 sha256
校验和 + 公开 GitHub Release(HTTPS,见「分发信任」与 security.md 的「非目标:
反反编译/混淆」)。

## Manifest(release 2/7,v1.2 于 release 8/7)

`pnpm release:build` 会写出一份分发 manifest —— 一份可即时校验的分发信任记录
(逐制品 sha256)。它的 `schema: c3-release-manifest/v1.2`:

```json
{
  "schema": "c3-release-manifest/v1.2",
  "version": "0.1.0",
  "commit": "c58a0b5",
  "buildTime": "2026-06-05T07:22:53.535Z",
  "artifacts": [
    {
      "target": "macos-arm64",
      "file": "c3-v0.1.0-macos-arm64.tar.gz",
      "binary": "c3",
      "binarySha256": "9b74c989…bac",
      "bytes": 25100384,
      "sha256": "ed0a…2a11"
    }
  ]
}
```

- `file` 是**包**的名字;`bytes` / `sha256` 是包的字节数 / 哈希值。
- `binary` 是包内二进制文件的名字(POSIX 上是 `c3`,Windows 上是 `c3.exe`)。
- `binarySha256` 是**内层二进制文件**的十六进制哈希,与解压后对
  `c3` 执行 `shasum -a 256` 的结果一致。

消费者可以对 `c3-v{ver}-{target}{.tar.gz|.zip}` 执行 `shasum -a 256` 并与
`artifacts[].sha256` 比对;内层二进制文件的 `binarySha256` 与在解压出的
二进制文件上执行 `shasum -a 256 -c c3.sha256` 得到的结果一致。这份 manifest 是一份
**多制品**分发记录;`pnpm binary`(单个自用二进制文件)不会产出它。一个
实验性的 P1 制品(release 4/7)会在其条目上额外携带 `"experimental": true`
(P0/已验证的条目上没有——schema 仍保持 `v1.2`)。

## 分发信任(release 3/7,8/7 变为两层)

> **信任底线:** **sha256 校验和 + 公开 GitHub Release(HTTPS)**(见 security.md
> DIST-1/SEC-8)。

sha256 校验和生成在**两个不同的层级**:

- **内层 sidecar**(在包内,紧挨着 `c3` 二进制文件):`c3.sha256`——由打包步骤
  针对代码签名后的二进制文件字节生成。(解压后)`shasum -a 256 -c c3.sha256`
  会用它校验这个二进制文件。
- **外层 sidecar**(与包并列):`<package>.sha256`——由 `release:checksum`(以及
  `release:publish`)针对包的字节生成。一份汇总的 `SHA256SUMS` 覆盖每一个包。

`release:checksum`(以及 `release:publish`)读取分发 manifest,生成**外层**
sidecar + 汇总的 `SHA256SUMS`。所有外层 sidecar 覆盖的是包(tar/zip 之后)的
**最终**字节;内层 sidecar 覆盖的是二进制文件的**最终**字节(在 macOS ad-hoc
`codesign` 之后——这一步发生在编译原语内部,所以哈希看到的是已签名的 Mach-O)。

- **`c3 upgrade`** —— 从 GitHub Releases 自更新:它下载 `<package>` +
  `<package>.sha256`,在**解包之前**先校验包的字节 sha256,然后解包出内层的
  `c3`/`c3.exe`,原子性地替换正在运行的二进制文件(Windows 上是
  `.exe.old` 占位交换)。sha256 不匹配或字节损坏会中止,旧的二进制文件保持完好。
  upgrade 从不会重启正在运行的 c3——`c3 restart` 会重新读取 service unit /
  重新启动 `--daemon` 来加载新版本。平台→目标的映射与包命名是
  `scripts/release/{targets,artifact-name}.mjs` 在二进制文件内的一个小副本
  (该目录不会被打包),由测试交叉断言以确保两者不会漂移。
  - **最新版本解析**优先使用 GitHub Releases 的**重定向**而非 JSON API,以
    绕开未认证的 `api.github.com` 限速(60/小时/IP)——共享出口的用户(企业
    代理 / NAT)经常因此触发 403。主路径以 `redirect: 'manual'` 请求
    `github.com/<repo>/releases/latest`,从 `Location` 响应头中读取发布 tag;
    下载 URL 随后从该 tag **确定性地推导**出来
    (`releases/download/<tag>/<pkg>{,.sha256}`,包的 basename 来自
    `packageNameFor`)——不枚举资源列表,不需要 token。只有当重定向没有拿到
    可用的 tag 时,才会**回退**到 `api.github.com/repos/<repo>/releases/latest`
    (JSON),这条路径保留了带 token 的 `GITHUB_TOKEN`/`GH_TOKEN` 请求头、
    资源列表选择,以及 403 限速提示。这个改动只影响*如何定位最新版本 +
    下载 URL*;GitHub Releases 仍然是唯一的分发来源(没有新增镜像)。
- **macOS ad-hoc** `codesign --force -s -` —— 仅在 macOS 目标 + darwin 主机 +
  存在 `codesign` 时才生效;否则尽力而为、警告后继续。仅 ad-hoc(没有
  Developer ID / 公证);用户需要用 `xattr -dr com.apple.quarantine` 清除
  Gatekeeper 隔离标记。

`pnpm release` 是**交互式本地构建+入库**流程:提示输入版本号(或接受
`--version=X.Y.Z`),在本机跨平台编译三个发布目标——`linux-x64`、
`macos-arm64`、`windows-x64`,全部通过 Bun 的 `--target` 在一台
macOS/Linux 机器上完成构建(不需要 Docker,不需要 Windows runner;
`bun --compile --target=bun-windows-x64` 直接写出 `c3.exe`)——然后为它们
生成 sha256 校验和,把包集合 + sidecar + `manifest.json` 收集到
`dist/release-artifacts/v<ver>/` 下。这批本地产物供排查/自用;**面向公众的分发
由 CI 的 GitHub Release 负责**(见下)。

`--skip-gate` 绕过源码 pregate,`--targets` 可以覆盖默认目标集合(默认三个目标)。
`--dry-run` 会预演门禁与计划,但不触碰任何东西。

GitHub 发布编排器是 **`pnpm release:github`**(串联 gate → build → notes →
publish;`--dry-run` 预演,不打 tag/不跑 `gh`;`--no-publish` 会在本地生成
校验和,但在打 tag + 创建 GitHub Release 之前停止)。该包始终不会发布到 npm
(二进制文件只通过 GitHub Releases 发布,从不发布到 npm)。

## 发布分发(公开 GitHub Release)

开源版的二进制文件从公开分发仓库 `sequencestream/c3` 的 **GitHub Release**
发布。发布经 **CI**(GH Actions release workflow)完成:各目标在其原生 OS
runner 上构建 → 冒烟 → 生成 sha256 校验和 → verify-dist 一致性校验 → `gh
release create`,携带每个制品 + `.sha256` sidecar + 汇总 `SHA256SUMS`。

- **Release notes 自动生成。** 使用 GitHub 的 `--generate-notes`,基于自上个
  tag 以来的 PR / commit 历史自动汇总,无需手工维护签名/校验说明。
- **完整性由使用者自校验。** 下载产物后用 `shasum -a 256 -c <artifact>.sha256`
  (或对照 `SHA256SUMS`)即可确认字节完整;传输信任来自 GitHub 的 HTTPS。
- **没有本地签名步骤。** 开源版不再有「在持有私钥的机器上本地签名再发到公共
  镜像」的流程(旧 `publish:binaries` 已删除)。

## 命令

```bash
pnpm release:build                                  # P0 矩阵,并行,+manifest(minify,字节码关闭)
pnpm release:build --targets=linux-x64              # 子集
pnpm release:build --skip-pack                       # 只出二进制,不打包(调试用)
pnpm release:build --dry-run                        # 打印计划,不执行
pnpm release:checksum                                    # SHA256SUMS + 每产物 .sha256(读取 manifest)
pnpm release:notes                                   # 发布说明(版本 + CHANGELOG 顶部小节)
pnpm release:gate                                    # pregate:typecheck→lint→test→i18n:check→check-freeze
pnpm release:smoke -- --file=<inner-binary>        # 对内层二进制文件做无头冒烟测试(CI 中先解压 tarball)
pnpm release:smoke -- --manifest=<manifest>        # 或:通过 manifest 挑出内层二进制文件
pnpm release:verify-dist                              # 发布终检:manifest↔SHA256SUMS↔磁盘 + P0
pnpm release:publish --dry-run                        # 预演发布:只出计划,不打 tag/不跑 gh
pnpm release                                          # 交互式:提示版本 → 构建 linux-x64+macos-arm64+windows-x64 → 生成 sha256 校验和 → 收集到 dist/release-artifacts/
pnpm release --version=0.8.0                           # 非交互式指定版本(没有 TTY 时需要)
pnpm release --skip-upload                             # 收集到 dist/release-artifacts/v<ver>/ 后停止
pnpm release --skip-gate --targets=windows-x64         # 跳过源码 pregate / 覆盖目标集合(调试用)
pnpm release --dry-run                                 # 预演门禁 + 计划,不触碰任何东西
pnpm release:github                                    # GitHub 发布编排器:gate → build(+smoke) → notes → publish(完整)
pnpm release:github --no-publish                       # gate + build + checksum + notes,不创建 GitHub Release
pnpm binary                                          # 原生单一二进制文件(自用快捷方式,字节码关闭)
# CI:公开分发以 CI 切割的 GitHub Release 为准
#   GH Actions release workflow  →  workflow_dispatch(手动)或 push tags: v*
#   release notes 由 GitHub --generate-notes 基于 PR 历史自动生成
```

## 职责划分(以能力划分,而非文件)

发布机制被拆解为以下职责——按它们做什么来描述,而不是按它们放在哪里:

- **构建编排器** —— 把每个目标的构建扇出到 P0 矩阵上(`--targets`、
  `--dry-run`、`--skip-smoke`、`--skip-pack`),并承载 Phase3 制品冒烟测试。
- **本地编排器**(`pnpm release`) —— 交互式构建流程:提示版本 →
  在本机跨平台编译三个发布目标 → 生成 sha256 校验和 → 收集到
  `dist/release-artifacts/v<ver>/`(`--version`、`--targets`、
  `--skip-gate`、`--skip-upload`、`--dry-run`)。这批本地产物供排查/自用;
  公开分发由 CI 的 GitHub Release 负责。
- **GitHub 编排器**(`pnpm release:github`) —— 串联 gate → build → notes →
  publish(`--dry-run`、`--no-publish`、`--skip-gate`)。
- **目标分类** —— P0 / P1 / 实验性 / 已知 / 默认目标集合,以及 host-target
  检测、host-runnable 检测的单一真源。
- **平台分支** —— 按操作系统区分的 `claude` 发现分支和 SQLite 驱动探测分支,
  以及按目标区分的构建矩阵(包括 P1 + Windows `.exe` 的情形)。
- **Pregate** —— 严格顺序的源码门禁。
- **制品冒烟测试** —— 无头制品门禁,以及它的空闲端口 / 版本断言辅助函数。
- **发布门禁** —— 最终的 manifest ↔ `SHA256SUMS` ↔ 磁盘 + 必需目标检查。
- **单目标构建原语** —— bundle → compile(minify;字节码已禁用——ESM/CJS)、
  以及 ad-hoc 代码签名。
- **版本单一真源** —— 版本/commit/构建时间的解析,以及构建期 define 值。
- **Manifest** —— 构建分发 manifest 与逐制品哈希。
- **制品命名** —— 二进制文件名、包名、包扩展名,以及版本号归一化。
- **打包** —— 内层 `c3.sha256` sidecar + `.tar.gz` / `.zip` 归档。
- **校验和、notes、publish** —— sha256 校验和生成(`release:checksum`)以及
  notes/publish 步骤。
- **运行时版本** —— 二进制文件报告的版本字符串。
- **快照生成器** —— 产出可嵌入的 web-bundle 快照。
- **CI release workflow** —— 矩阵式的 `pregate → 4 个 build → 4 个 smoke →
verify-dist → provenance → publish`,由 `needs:` 强制顺序。
- **测试** —— 覆盖 build、checksum(证明 sha256 校验和/SHA256SUMS 一致性)、
  smoke(制品门禁辅助函数 + 有条件的真实冒烟测试)等行为。
