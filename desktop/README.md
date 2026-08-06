# `desktop/` — c3 的 Tauri 2 桌面壳

把现有的 c3 单二进制包成一个双击即用的桌面 App。**壳里没有业务逻辑**:UI 仍由
`web/` 提供、服务能力仍由 `server/` 提供,这里只负责「拉起后端 → 等它就绪 → 在原生
窗口里显示它」以及托盘常驻。

设计取舍与安全边界见 [ADR-0033](../doc/architecture/adr/0033-tauri-desktop-shell-sidecar.md)。

## 它做什么

启动时依次:

1. **清理上一轮的孤儿**。壳异常退出可能留下 sidecar。按运行记录里的身份三元组
   (pid + 可执行文件路径 + 进程启动时间)校验,三项全中才清理 —— 绝不按端口或
   进程名去杀,那会误伤用户自己从终端启动的 c3。
2. **校验版本**。sidecar 自报的版本必须等于壳编译时钉入的 `C3_SIDECAR_VERSION`,
   不一致就停在启动页。
3. **选一个空闲回环端口**,启动 `c3 start --host 127.0.0.1 --port <port>`。
4. **探测就绪**,成功后把主窗口导航到该地址;sidecar 缺失、崩溃、端口被抢或超时
   都会给出可重试的错误界面,不会出现白窗。
5. **异步检查更新**(不阻塞主窗口)。托盘「检查更新…」与更新窗口提供手动入口;发现
   新版后用户确认下载、校验、退出安装,由独立更新助手替换完整桌面包并重启。

关窗只隐藏,后端继续跑;托盘提供「打开 c3」「开机自启」「检查更新…」「退出」。

## 目录

```
desktop/
  ui/index.html        启动页(进度 + 失败重试/退出)
  ui/main.html         主窗口占位页,就绪后被导航到 sidecar 的 SPA
  ui/update.html       更新/关于窗口(检查、进度、确认安装)
  src-tauri/
    src/lib.rs         编排:启动流程、窗口、命令、退出
    src/sidecar.rs     进程原语:端口、就绪探测、身份记录、停止、孤儿清理
    src/update.rs      更新状态机 + 检查/下载编排(sidecar 回环 API)
    src/install.rs     更新记录、平台安装适配器、独立更新助手
    src/tray.rs        托盘菜单
    capabilities/      仅授权 `splash` 与 `update` 窗口,仅 `core:default`
    binaries/          sidecar 暂存位(构建时生成,已 gitignore)
    icons/             由 `pnpm -F @ccc/desktop icon` 从 `icons/source.png` 生成
```

## 构建

```bash
pnpm release:desktop                 # 宿主平台的完整发布构建(见下)
pnpm release:desktop --skip-web      # 复用已有的 web/dist,迭代壳时快得多
pnpm release:desktop --require-signing   # 正式产物:签名未达当前档位要求即失败(CI 用)
```

`release:desktop` 的顺序与 CLI 渠道同构,并复用同一批原语:

| 阶段   | 做什么                                                                   |
| ------ | ------------------------------------------------------------------------ |
| Phase0 | `pnpm -F @ccc/web build`                                                 |
| Phase1 | `generate-static-embed`                                                  |
| Phase2 | `server/scripts/release/build-target.mjs` —— 唯一的 `bun --compile` 原语 |
| Phase3 | 按 Tauri 三元组约定暂存 sidecar,并校验其 `--version`                     |
| Phase4 | `tauri build`(原生 runner;Tauri 不做跨平台打包)                          |
| Phase5 | 收集 bundle → `dist/c3-desktop-v{ver}-{target}{ext}`,sha256 + manifest   |

产物:

| 平台        | 产物                  |
| ----------- | --------------------- |
| macos-arm64 | `.dmg`、`.app.tar.gz` |
| windows-x64 | `.msi`、`.exe`(NSIS)  |
| linux-x64   | `.deb`、`.AppImage`   |

### 直接跑 `cargo` / `tauri` 需要先暂存 sidecar

`externalBin` 要求 `src-tauri/binaries/c3-<rust-triple>` 存在,否则连 `cargo check`
都会以 `resource path doesn't exist` 失败。跑一次 `pnpm release:desktop` 就会把它放
好;此后 `cargo test`、`cargo check` 都能直接用。

### 各平台的额外依赖

- **macOS** —— 签名分两档,由凭证是否可用自动决定,无需额外开关。`APPLE_CERTIFICATE`
  与 `APPLE_CERTIFICATE_PASSWORD` 均非空(仅从 CI secrets 注入,连同
  `APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`)时走
  Developer ID 并可公证;否则由 Tauri 打包器做 ad-hoc 自签。本地构建走的是后者 ——
  能装能跑,但用户需要 `xattr -dr com.apple.quarantine` 才能绕过 Gatekeeper。
  空字符串等同于没有凭证,详见 `doc/non-functional/release.md`。
- **Windows** —— 有 `WINDOWS_CERTIFICATE` 时由 Tauri 打包器完成 Authenticode 签名;
  没有则产物未签名,发布说明必须写明 SmartScreen 提示。
- **Linux** —— 需要 `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、
  `libayatana-appindicator3-dev`、`librsvg2-dev`、`libxdo-dev`。CI 会显式安装并用
  `pkg-config --modversion` 校验。应用内更新以 AppImage 为首选制品,在当前 `$APPIMAGE`
  所在目录准备、备份并原子替换,因此安装目录必须由当前用户可写且无需 root。

## 测试

```bash
cd desktop/src-tauri && cargo test    # 端口、就绪探测、身份记录、孤儿清理、版本解析、更新状态、暂存校验
pnpm test -- scripts/release/desktop  # 命名/三元组/bundle 发现/manifest 渠道/preferred
```

## 已知边界

- 桌面包**不携带** Cursor SDK sidecar 树(Tauri 的 `externalBin` 只搬单个文件)。
  桌面版要用 Cursor vendor 需自行设置 `CURSOR_SDK_PATH`,或改用 CLI 版。
- 应用内自动更新安装**完整桌面包**(壳与 sidecar 成对升级),不是改写 bundle 内的
  sidecar —— 单文件替换会破坏 macOS 代码签名。更新器的版本事实、下载与双重 sha256
  校验复用 CLI 的共享升级内核,经 sidecar 回环 API 提供;暂存、写盘与安装由壳负责,
  不写 `~/.c3`。发布链为每个桌面目标在 manifest 里标记唯一 `preferred` 安装器。
- 桌面开机自启与 `c3 install` 的系统服务是两条路径,**不要同时启用**,否则会有两个
  c3 实例争同一份数据目录。
