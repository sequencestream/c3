# 0033 — Tauri 2 桌面壳:把 c3 单二进制当 sidecar 拉起,WebView 加载它自己的 SPA

- **Status:** accepted
- **Date:** 2026-08-05

## Context

c3 现有交付物只有一种形态:用户从终端运行 `./c3 --daemon`,再自己打开浏览器访问
`localhost:3000`。这对开发者可行,但把不熟悉终端的用户挡在门外,也没有「下载安装包、
双击就用」的产品化分发形态,更提供不了托盘常驻、开机自启这类桌面 App 的常驻体验。

约束来自既有系统而非新需求:

- 单二进制([ADR-0003](0003-single-binary-via-bun-compile.md))与发布信任链
  ([ADR-0010](0010-release-and-distribution-trust.md))已经成型,桌面版不能另起一套
  服务端编译或另一条校验链。
- `~/.c3` 下的设置、凭据引用、工作区注册表、SQLite 与会话是用户的真实资产,桌面版
  不得迁移、重命名或复制它们。
- 服务端当前默认绑定全部网络接口,而桌面壳需要一个只对本机可见的后端。改动必须是
  **增量**的,不能顺手改掉既有 CLI 部署的网络可达性。

## Options considered

- **Electron 壳。** 优点:渲染引擎自带、三平台一致、生态成熟。缺点:每个安装包多出
  上百 MB 与一份常驻 Chromium;对一个「壳」而言代价与收益严重不成比例。
- **仅自动打开系统浏览器。** 优点:近乎零成本。缺点:仍然不是一个 App —— 没有窗口
  归属、没有托盘、没有开机自启,用户体验上和现在没有本质差别。
- **Tauri 2 + 系统 WebView。** 优点:安装包约 5–15 MB、常驻内存低、原生托盘/自启/
  单实例都有一等支持。缺点:依赖系统 WebView(WKWebView / WebView2 / WebKitGTK),
  三者渲染存在差异;macOS 需要付费的 Developer ID 与公证;Linux 需要 WebKitGTK。
- **把 SPA 作为 Tauri 静态资产打进壳。** 优点:不必处理端口与就绪。缺点:同一份 UI
  出现两份构建产物与两套路由,登录态与工作区行为会随载体分叉。

## Decision

采用 **Tauri 2 + 系统 WebView**,并且 **WebView 加载 sidecar 已内嵌的 SPA**,而不是
在壳里再放一份 SPA。具体形态:

1. **sidecar 就是 CLI 那个二进制。** 桌面构建复用
   `server/scripts/release/build-target.mjs` 这一唯一的 `bun --compile` 原语,产物按
   Tauri `externalBin` 约定改名(`binaries/c3-<rust-triple>`)后打进安装包。桌面版
   没有第二套服务端编译路径。
2. **回环绑定通过新增的 `--host` 落到既有启动链。** `cli.ts` 的 `start` 接收可选
   `--host`,随 `ServerOptions` 传给 `startServer`,最终成为 `@hono/node-server`
   `serve()` 的 `hostname`。**省略即不变**:不传该参数时不产生 `hostname` 字段,
   既有全接口绑定行为原样保留。壳固定传 `127.0.0.1` 与本次实例探得的空闲端口,
   既不读取也不放宽设置里的 `exposure.bindAddress`。
3. **共享 c3 home。** 壳不传 `--settings`,sidecar 沿用默认解析规则(`~/.c3`,含
   `C3_DIR` 覆盖)。桌面版与 CLI 版看到同一份设置、登录态、工作区与会话。Tauri 自己
   的配置目录只存窗口偏好、开机自启状态和一份 sidecar 运行记录。
4. **两个窗口划出安全边界。** `splash` 是本地静态页(启动进度 + 失败重试/退出),是
   **唯一**被 capability 授权的窗口;`main` 承载远端(回环)SPA,不出现在任何
   capability 的 `windows` 列表里,因而没有任何插件权限。壳自定义的两条命令
   (`retry_startup` / `quit_app`)额外显式拒绝来自 `main` 的调用。WebView 内容在
   任何路径上都拿不到 shell 执行能力。
5. **生命周期由托盘决定,不由窗口决定。** 关窗只隐藏,sidecar 继续运行;托盘提供
   「打开 c3」「开机自启」「退出」。退出先向 sidecar 发 SIGTERM 并等待宽限期,超时
   才硬杀。开机自启只出现在托盘 —— 放进网页就得把 IPC 权限还给远端内容。
6. **只杀自己创建的进程。** 壳把 sidecar 的身份三元组(pid + 可执行文件路径 + 进程
   启动时间)写成运行记录。下次启动时只有三项全部吻合才清理;任何一项对不上都只删
   记录、不动那个进程。绝不按端口占用或进程名去杀 —— 那会误杀用户自己从终端启动的
   c3。

## Consequences

- **Easier:** 非 CLI 用户下载安装包、双击即用;托盘常驻与开机自启成为一等能力;
  UI 只有一套构建产物和一套 HTTP/WebSocket 路由,登录态与工作区行为与浏览器版一致。
- **Harder:** 壳必须自己处理端口竞争、就绪探测与子进程故障;三平台 WebView 回归成为
  发布门槛;macOS 需要 Developer ID 与公证,Linux 需要 WebKitGTK 运行时依赖。
- **版本必须成对。** 壳与 sidecar 版本不一致的包不许出厂:构建期比对
  `c3 --version` 与本次发布版本,运行时再比对一次编译期钉入的
  `C3_SIDECAR_VERSION`,不一致就停在启动页而不是进主界面。
- **GUI 进程的 PATH 问题被显式处理。** Finder 启动的进程只有最小 PATH,c3 却需要在
  PATH 上找到 `git` 与用户自装的 vendor CLI。壳在 Unix 上向登录 shell 问一次真实
  PATH 再传给 sidecar;取不到就什么都不做(纯增强)。
- **桌面包不携带 Cursor SDK sidecar 树。** CLI 包把 `node_modules` 放在二进制旁边,
  而 Tauri 的 `externalBin` 只搬单个文件。桌面版的 Cursor vendor 需要用户设置
  `CURSOR_SDK_PATH`,或改用 CLI 版。这是本次明确的边界,不是缺陷遗留。
- **自动更新留了扩展点,本次不实现。** 桌面产物与 CLI 产物同版本、同 manifest、同
  校验链,只是 `channel` 与文件名不同;后续的 App 内自动更新
  (意图 `47422c5e-03d7-45fa-8928-64cf905e7936`)接的就是这份 manifest 与壳的生命
  周期边界。本次不做检查、下载、替换或重启协议。

## Compliance

- sidecar 只能绑 loopback;Tauri capability 只授予 `splash` 窗口,且仅 `core:default`。
- 桌面开机自启与 `c3 install` 的系统服务是两条互不相干的路径,壳既不调用也不修改后者。
- 安装、升级、卸载桌面 App 均不得触碰 `~/.c3` 下的任何数据。
- 签名、公证、安装器生成或校验和任一失败,阻断对应桌面目标的发布;不得以未签名
  macOS 包替代正式产物。

## References

- `doc/non-functional/release.md` § 桌面渠道
- `desktop/README.md`
- [ADR-0003](0003-single-binary-via-bun-compile.md) — 单一二进制
- [ADR-0010](0010-release-and-distribution-trust.md) — 发布与分发信任
- [ADR-0023](0023-auth-abstraction-network-exposure.md) — 认证抽象与网络暴露
