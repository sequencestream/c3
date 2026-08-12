//! c3 桌面壳 —— Tauri 2 外壳,把现有 c3 单二进制当作 sidecar 拉起,并在原生 WebView
//! 里渲染 **sidecar 自己内嵌的** SPA。
//!
//! 壳不是第二套服务:没有业务逻辑、没有第二份 UI 构建产物、也不复制任何业务数据。
//! sidecar 沿用用户环境里默认的数据库解析规则(默认 `~/.c3/c3.db`,含 `C3_DB_PATH` /
//! `C3_DIR` 覆盖),因此设置、登录态、工作区注册表、SQLite 与会话与 CLI 版同源。壳自己只在 Tauri 的
//! 配置目录里存一份运行记录和开机自启状态。
//!
//! 窗口分工是本壳的安全边界:
//!   * `splash` —— 本地静态页,负责启动进度与失败后的重试/退出。**唯一**被 capability
//!     授权的窗口。
//!   * `main`   —— 加载 sidecar 提供的远端(回环)SPA。不在任何 capability 的窗口列表
//!     里,因此拿不到任何插件权限,更没有 shell 执行能力。

// `install` 对外可见:独立更新助手由 `main`(外部 bin)以 `--update-assistant`
// 参数直接进入 `install::update_assistant_main`。
pub mod install;
mod sidecar;
mod tray;
mod update;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use sidecar::{ProbeError, SidecarRecord};

/// 启动进度与失败信息发往 splash 的事件名。
const EVENT_PROGRESS: &str = "c3://startup-progress";
const EVENT_ERROR: &str = "c3://startup-error";

/// 本地启动页窗口标签(受 capability 授权)。
pub const SPLASH_WINDOW: &str = "splash";
/// 承载远端 SPA 的窗口标签(不受任何 capability 授权)。
pub const MAIN_WINDOW: &str = "main";

/// 单次启动尝试等待 sidecar 应答 HTTP 的上限。c3 冷启动要建库、扫 vendor、恢复队列,
/// 慢机器上十几秒并不罕见,所以这个窗口开得比较宽。
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// 端口竞争时的重试次数。探得的端口在 sidecar bind 之前有被抢走的窗口期。
const START_ATTEMPTS: u32 = 3;
/// 请求 sidecar 优雅退出后的等待上限,超时才硬杀。
const STOP_GRACE: Duration = Duration::from_secs(10);
/// 清理上一轮遗留 sidecar 时的等待上限。
const SWEEP_GRACE: Duration = Duration::from_secs(5);

/// 壳的运行时状态。
#[derive(Default)]
pub struct ShellState {
    /// 当前受管 sidecar 的子进程句柄。硬杀时用它。
    child: Mutex<Option<CommandChild>>,
    /// 当前受管 sidecar 的身份记录。优雅停止与孤儿清理都以它为准。
    record: Mutex<Option<SidecarRecord>>,
    /// 启动流程是否正在进行 —— 防止重试按钮把多个 sidecar 叠起来。
    starting: Arc<AtomicBool>,
    /// 已就绪 sidecar 的回环 base URL。更新状态机靠它访问 sidecar 的更新 API。
    sidecar_url: Mutex<Option<String>>,
    /// sidecar 实测版本(`c3 --version`)。更新检查以此作为当前版本。
    sidecar_version: Mutex<Option<String>>,
}

impl ShellState {
    /// 已就绪 sidecar 的回环 base URL(未就绪时为 None)。
    pub fn sidecar_url(&self) -> Option<String> {
        self.sidecar_url.lock().ok().and_then(|g| g.clone())
    }

    /// sidecar 实测版本;未解析到为空串。
    pub fn sidecar_version(&self) -> String {
        self.sidecar_version
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_default()
    }
}

/// 发给 splash 的启动阶段。
#[derive(Clone, Serialize)]
struct Progress {
    stage: &'static str,
    attempt: u32,
}

/// 发给 splash 的失败信息。`log_path` 让用户能自己去看诊断。
#[derive(Clone, Serialize)]
struct StartupError {
    stage: &'static str,
    message: String,
    #[serde(rename = "logPath")]
    log_path: String,
}

/// 从 `c3 --version` 的输出里取出版本号:第一行的第一个词,去掉可能的前导 `v`。
///
/// 输出形如 `0.9.6 (commit c58a0b5, built 2026-…)`。
pub fn parse_version(output: &str) -> Option<String> {
    let first = output.lines().next()?.trim();
    let token = first.split_whitespace().next()?;
    let v = token.trim_start_matches('v');
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// 壳构建时钉住的 sidecar 版本(由发布脚本注入)。开发者直接 `cargo tauri build`
/// 时它是 None,此时跳过版本校验并只记一条日志 —— 否则本地壳(0.1.0)与由 git tag
/// 推导版本的 sidecar 永远对不上,开发流程会被自己的门禁挡死。
pub fn expected_sidecar_version() -> Option<&'static str> {
    option_env!("C3_SIDECAR_VERSION")
}

/// 壳自己的状态目录(运行记录与更新暂存都落在这里)。取不到时退回临时目录。
pub(crate) fn shell_config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("c3-desktop"))
}

/// 供用户排查的日志位置提示。壳把 sidecar 的 stdout/stderr 透传到自己的 stderr,
/// 而 sidecar 自身仍照常写 c3 home 下的日志文件。
fn log_hint() -> String {
    "~/.c3/log/c3.log".to_string()
}

fn emit_progress(app: &AppHandle, stage: &'static str, attempt: u32) {
    let _ = app.emit_to(SPLASH_WINDOW, EVENT_PROGRESS, Progress { stage, attempt });
}

fn emit_error(app: &AppHandle, stage: &'static str, message: String) {
    eprintln!("[c3-desktop] startup failed at {stage}: {message}");
    let _ = app.emit_to(
        SPLASH_WINDOW,
        EVENT_ERROR,
        StartupError {
            stage,
            message,
            log_path: log_hint(),
        },
    );
    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW) {
        let _ = splash.show();
        let _ = splash.set_focus();
    }
}

/// 显示并聚焦「用户此刻应该看到」的窗口:后端就绪后是主窗口,否则是启动页。
/// 托盘「打开 c3」和第二次双击(单实例回调)都走这里。
pub fn focus_visible_window(app: &AppHandle) {
    let main = app.get_webview_window(MAIN_WINDOW);
    let main_is_live = main
        .as_ref()
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    // 后端已就绪时主窗口才是「c3」;否则用户该看到的是启动页(可能带着错误)。
    let target = if main_is_live {
        main
    } else {
        app.get_webview_window(SPLASH_WINDOW).or(main)
    };
    if let Some(window) = target {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 托盘「检查更新」入口:显示更新窗口并立即做一次手动检查。窗口隐藏创建,
/// 只有托盘与本地入口能把它唤出来。
pub fn open_update_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(update::UPDATE_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    update::check_update(app, true);
}

/// 停止本壳创建的 sidecar:先请求优雅退出并等待,超时后才硬杀。
///
/// 只作用于壳自己的记录 —— 用户从终端另行启动的 c3 与本函数无关。
pub fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<ShellState>();
    let record = state.record.lock().ok().and_then(|mut r| r.take());
    let child = state.child.lock().ok().and_then(|mut c| c.take());

    if let Some(record) = record {
        sidecar::request_stop(record.pid);
        let deadline = std::time::Instant::now() + STOP_GRACE;
        while std::time::Instant::now() < deadline {
            if !sidecar::is_alive(record.pid) {
                sidecar::clear_record(&shell_config_dir(app));
                println!("[c3-desktop] sidecar {} exited gracefully", record.pid);
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // 宽限期用尽:身份已确认,可以硬杀。优先用 Tauri 的子进程句柄(Windows 上
        // 这是唯一手段),再补一次信号兜底。
        if let Some(child) = child {
            let _ = child.kill();
        }
        sidecar::hard_kill(record.pid);
        eprintln!(
            "[c3-desktop] sidecar {} did not stop within the grace window — terminated",
            record.pid
        );
    } else if let Some(child) = child {
        let _ = child.kill();
    }
    sidecar::clear_record(&shell_config_dir(app));
}

/// 优雅退出整个 App:先停 sidecar,再退壳。托盘「退出」走这里。
pub fn shutdown_and_exit(app: &AppHandle) {
    stop_sidecar(app);
    app.exit(0);
}

/// 启动后端并在就绪后把主窗口切到 sidecar 的 SPA。
///
/// 整个流程跑在后台任务里,`setup` 立刻返回,用户先看到启动页而不是白窗。
pub fn start_backend(app: AppHandle) {
    {
        let state = app.state::<ShellState>();
        if state.starting.swap(true, Ordering::SeqCst) {
            return; // 已有一次启动在进行中(重试按钮连点)
        }
    }
    tauri::async_runtime::spawn(async move {
        let result = run_startup(&app).await;
        app.state::<ShellState>()
            .starting
            .store(false, Ordering::SeqCst);
        match result {
            Ok(url) => {
                if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
                    match url.parse() {
                        Ok(parsed) => {
                            if let Err(e) = main.navigate(parsed) {
                                emit_error(&app, "navigate", e.to_string());
                                return;
                            }
                        }
                        Err(e) => {
                            emit_error(&app, "navigate", format!("{e}"));
                            return;
                        }
                    }
                    let _ = main.show();
                    let _ = main.set_focus();
                }
                if let Some(splash) = app.get_webview_window(SPLASH_WINDOW) {
                    let _ = splash.hide();
                }
                // 记下 sidecar 地址,并在后台异步检查一次更新(不阻塞主窗口)。
                if let Ok(mut u) = app.state::<ShellState>().sidecar_url.lock() {
                    *u = Some(url.clone());
                }
                println!("[c3-desktop] ready at {url}");
                update::check_update(&app, false);
            }
            Err((stage, message)) => emit_error(&app, stage, message),
        }
    });
}

/// 一次完整的启动尝试序列。成功返回 SPA 的回环 URL;失败返回(阶段, 说明)。
async fn run_startup(app: &AppHandle) -> Result<String, (&'static str, String)> {
    // ── 版本一致性:壳与 sidecar 必须同版本 ────────────────────────────────
    emit_progress(app, "version", 0);
    let version_out = app
        .shell()
        .sidecar(sidecar::SIDECAR_NAME)
        .map_err(|e| ("sidecar", format!("sidecar not found: {e}")))?
        .args(["--version"])
        .output()
        .await
        .map_err(|e| ("sidecar", format!("sidecar could not be executed: {e}")))?;
    if !version_out.status.success() {
        return Err((
            "sidecar",
            format!(
                "`c3 --version` exited with {:?}: {}",
                version_out.status.code(),
                String::from_utf8_lossy(&version_out.stderr).trim()
            ),
        ));
    }
    let actual = parse_version(&String::from_utf8_lossy(&version_out.stdout)).ok_or((
        "sidecar",
        "could not parse `c3 --version` output".to_string(),
    ))?;
    // 更新检查以 sidecar 实测版本为当前版本;正常发布态它与壳版本一致。
    if let Ok(mut v) = app.state::<ShellState>().sidecar_version.lock() {
        *v = Some(actual.clone());
    }
    match expected_sidecar_version() {
        Some(expected) if expected != actual => {
            return Err((
                "version",
                format!("desktop shell expects c3 {expected} but the bundled sidecar reports {actual}"),
            ));
        }
        Some(expected) => println!("[c3-desktop] sidecar version {expected} verified"),
        None => println!(
            "[c3-desktop] sidecar version check skipped (unpinned dev build; sidecar reports {actual})"
        ),
    }

    // ── 拉起 sidecar,必要时换端口重试 ─────────────────────────────────────
    let mut last: Option<String> = None;
    for attempt in 1..=START_ATTEMPTS {
        emit_progress(app, "starting", attempt);
        match spawn_and_wait(app, attempt).await {
            Ok(url) => return Ok(url),
            Err(err) => {
                eprintln!("[c3-desktop] start attempt {attempt} failed: {err}");
                last = Some(err);
            }
        }
    }
    Err((
        "starting",
        last.unwrap_or_else(|| "sidecar did not become ready".to_string()),
    ))
}

/// 单次尝试:选端口 → 启动 sidecar → 等待就绪。失败时确保不留下受管子进程。
async fn spawn_and_wait(app: &AppHandle, attempt: u32) -> Result<String, String> {
    let port = sidecar::pick_loopback_port().map_err(|e| format!("no free loopback port: {e}"))?;

    let mut env: HashMap<String, String> = HashMap::new();
    if let Some(path) = sidecar::login_shell_path() {
        // GUI 启动的进程拿不到登录 shell 的 PATH,c3 却需要在 PATH 上找到 git 与
        // 用户自装的 vendor CLI。纯增强:取不到就什么都不做。
        env.insert("PATH".to_string(), path);
    }

    let command = app
        .shell()
        .sidecar(sidecar::SIDECAR_NAME)
        .map_err(|e| format!("sidecar not found: {e}"))?
        .args([
            "start",
            "--host",
            &sidecar::LOOPBACK.to_string(),
            "--port",
            &port.to_string(),
        ])
        .envs(env);

    let (mut rx, child) = command.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    let pid = child.pid();

    // 子进程身份:pid + 可执行文件 + 启动时间。缺了身份,下次启动就只能靠端口或
    // 进程名去猜,那会误杀用户自己启动的 c3。
    let identity = sidecar::identify(pid);
    let record = identity.map(|(exe, start_time)| SidecarRecord {
        pid,
        exe,
        start_time,
        port,
    });
    if let Some(record) = &record {
        if let Err(e) = sidecar::write_record(&shell_config_dir(app), record) {
            eprintln!("[c3-desktop] could not persist the sidecar run record: {e}");
        }
    }
    {
        let state = app.state::<ShellState>();
        *state.child.lock().unwrap() = Some(child);
        *state.record.lock().unwrap() = record.clone();
    }

    // sidecar 的输出透传到壳的 stderr(打包后可用 `Console.app` / 终端启动查看),
    // 并把「提前退出」立刻反馈给探测循环。
    let exited = Arc::new(AtomicBool::new(false));
    {
        let exited = exited.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        eprint!("[c3] {}", String::from_utf8_lossy(&line))
                    }
                    CommandEvent::Stderr(line) => {
                        eprint!("[c3] {}", String::from_utf8_lossy(&line))
                    }
                    CommandEvent::Terminated(payload) => {
                        exited.store(true, Ordering::SeqCst);
                        eprintln!("[c3-desktop] sidecar exited: {payload:?}");
                        on_sidecar_exit(&app);
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    let ready = {
        let exited = exited.clone();
        tauri::async_runtime::spawn_blocking(move || {
            sidecar::wait_until_ready(port, READY_TIMEOUT, &move || exited.load(Ordering::SeqCst))
        })
        .await
        .map_err(|e| format!("readiness probe crashed: {e}"))?
    };

    match ready {
        Ok(()) => Ok(sidecar::loopback_url(port)),
        Err(ProbeError::Exited) => {
            stop_sidecar(app);
            Err(format!(
                "attempt {attempt}: sidecar exited before it was ready on port {port}"
            ))
        }
        Err(ProbeError::Timeout) => {
            stop_sidecar(app);
            Err(format!(
                "attempt {attempt}: sidecar did not answer on port {port} within {}s",
                READY_TIMEOUT.as_secs()
            ))
        }
    }
}

/// sidecar 在壳还活着的时候退出了(崩溃、被外部杀死)。已经进入主界面的话,退回
/// 启动页并给出可行动的错误,而不是让用户对着一个连不上后端的 SPA。
fn on_sidecar_exit(app: &AppHandle) {
    let state = app.state::<ShellState>();
    if state.starting.load(Ordering::SeqCst) {
        return; // 启动流程自己会处理这次退出
    }
    let had_record = state.record.lock().map(|r| r.is_some()).unwrap_or(false);
    if !had_record {
        return; // 我们主动停的,不是意外
    }
    *state.record.lock().unwrap() = None;
    *state.child.lock().unwrap() = None;
    sidecar::clear_record(&shell_config_dir(app));
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        let _ = main.hide();
    }
    emit_error(
        app,
        "crashed",
        "the c3 backend stopped unexpectedly".to_string(),
    );
}

// ── 供本地启动页调用的命令 ──────────────────────────────────────────────────
// 两条命令都显式拒绝来自 `main` 窗口的调用。capability 已经把插件权限限定在 splash,
// 这层检查覆盖的是 App 自定义命令 —— 远端 SPA 内容不该有能力重启后端或退出 App。

#[tauri::command]
fn retry_startup(app: AppHandle, window: WebviewWindow) {
    if window.label() != SPLASH_WINDOW {
        return;
    }
    start_backend(app);
}

#[tauri::command]
fn quit_app(app: AppHandle, window: WebviewWindow) {
    if window.label() != SPLASH_WINDOW {
        return;
    }
    shutdown_and_exit(&app);
}

// ── 更新命令 ──────────────────────────────────────────────────────────────
// 五条命令全部显式拒绝非 `update` 窗口的调用。capability 已把权限限定在 update
// 窗口;这层检查覆盖的是 App 自定义命令 —— 加载远端 SPA 的 `main` 窗口不该有能力
// 触发检查、下载或安装。

#[tauri::command]
fn check_update(app: AppHandle, window: WebviewWindow) {
    if window.label() != update::UPDATE_WINDOW {
        return;
    }
    update::check_update(&app, true);
}

#[tauri::command]
fn confirm_update(app: AppHandle, window: WebviewWindow) {
    if window.label() != update::UPDATE_WINDOW {
        return;
    }
    update::confirm_download(&app);
}

#[tauri::command]
fn cancel_update(app: AppHandle, window: WebviewWindow) {
    if window.label() != update::UPDATE_WINDOW {
        return;
    }
    update::cancel_download(&app);
}

#[tauri::command]
fn install_update(app: AppHandle, window: WebviewWindow) {
    if window.label() != update::UPDATE_WINDOW {
        return;
    }
    update::confirm_install(&app);
}

#[tauri::command]
fn get_update_state(app: AppHandle, window: WebviewWindow) -> update::UpdateSnapshot {
    if window.label() != update::UPDATE_WINDOW {
        return update::UpdateSnapshot::default();
    }
    update::snapshot(&app.state::<update::UpdateState>())
}

/// 构建并运行桌面壳。
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册:重复双击应聚焦已有窗口,而不是再起一个壳和一个 sidecar。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_visible_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(ShellState::default())
        .manage(update::UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            retry_startup,
            quit_app,
            check_update,
            confirm_update,
            cancel_update,
            install_update,
            get_update_state
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 上一轮壳异常退出可能留下 sidecar。按身份三元组校验后清理,
            // 保证「一个壳最多一个受管 sidecar」。
            let outcome = sidecar::sweep_orphan(&shell_config_dir(&handle), SWEEP_GRACE);
            if !matches!(outcome, sidecar::SweepOutcome::NoRecord) {
                println!("[c3-desktop] orphan sweep: {outcome:?}");
            }
            // 上一轮更新若在下载中断开,清理未完成暂存;`.ready` 包保留到本轮
            // 检查(若没有可安装记录,校验通过的旧包会在下次更新时被覆盖)。
            install::cleanup_invalid_staging(&shell_config_dir(&handle));
            tray::install(&handle)?;
            start_backend(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关窗只隐藏:后端继续跑,托盘可随时恢复。
                // 三个窗口都只隐藏。App 的存活由托盘决定,唯一的退出入口是托盘
                // 「退出」—— 否则关掉启动页就等于杀掉一个正在跑活儿的后端。
                if window.label() == MAIN_WINDOW
                    || window.label() == SPLASH_WINDOW
                    || window.label() == update::UPDATE_WINDOW
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the c3 desktop shell")
        .run(|app, event| {
            // 兜底:任何退出路径都不应留下由本壳创建的 sidecar。托盘「退出」已经先
            // 停过一次,重复调用是幂等的(记录被 take 走后就没有可停的东西了)。
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                stop_sidecar(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_version_from_a_real_version_line() {
        assert_eq!(
            parse_version("0.9.6 (commit c58a0b5, built 2026-08-05T00:00:00Z)\n").as_deref(),
            Some("0.9.6")
        );
    }

    #[test]
    fn tolerates_a_v_prefix() {
        assert_eq!(parse_version("v1.2.3\n").as_deref(), Some("1.2.3"));
    }

    #[test]
    fn rejects_empty_output() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("\n"), None);
        assert_eq!(parse_version("v"), None);
    }
}
