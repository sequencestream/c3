//! 桌面壳的更新状态机与检查/下载编排。
//!
//! 壳持有**唯一一份**更新状态(`UpdateState`),按单向流程推进:
//!
//! ```text
//! Idle → Checking → UpToDate
//!        Checking → AwaitingConfirm → Downloading → Verifying → AwaitingInstall
//! Checking/Downloading/Verifying → Failed(可重试)
//! ```
//!
//! 版本事实、传输与校验规则全部委托给 sidecar 的回环更新 API(`/api/update/*`,
//! 基于共享内核)。壳在这里只负责:**状态机、HTTP 客户端、暂存写盘与进度**——以及
//! 在用户确认安装后,落更新记录、停 sidecar、拉起独立更新助手并退出。
//!
//! 下载写入壳配置目录的 `update-staging/`,`.tmp` 未完成,校验通过后改名 `.ready`
//! 才可安装;中断或校验失败的临时文件一律删除,绝不进入安装阶段。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::install;
use crate::{shell_config_dir, ShellState};

/// 发往更新窗口的状态快照事件名。
pub const UPDATE_EVENT: &str = "c3://update-state";

/// 更新窗口标签(受 capability 授权,详见 lib.rs / capabilities)。
pub const UPDATE_WINDOW: &str = "update";

/// 检查请求超时(网络探测必须快速失败;下载不走这个超时)。
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// 下载分块读取的缓冲大小。
const DOWNLOAD_CHUNK: usize = 64 * 1024;
/// 进度事件的最小间隔 —— 避免每 64KiB 就轰炸一次 WebView。
const PROGRESS_EVERY_BYTES: u64 = 256 * 1024;

// ── 状态模型 ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    /// 无任何更新在途。
    Idle,
    /// 正在向 sidecar 查询最新版本。
    Checking,
    /// 已是最新,无可用更新。
    UpToDate,
    /// 发现新版,等待用户确认下载。
    AwaitingConfirm,
    /// 正在下载安装包。
    Downloading,
    /// 下载完成,正在做最终 sha256 校验。
    Verifying,
    /// 校验通过,等待用户确认「退出并安装」。
    AwaitingInstall,
    /// 已拉起安装助手,壳即将退出。
    Installing,
    /// 检查/下载/校验失败,可重试。
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    pub file: String,
    pub kind: Option<String>,
    pub bytes: u64,
    pub sha256: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub target_version: Option<String>,
    pub artifact: Option<ArtifactInfo>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
    /// 壳自身版本(编译期钉住;dev 构建为 None)。正常发布态它等于 current_version。
    pub shell_version: Option<String>,
}

impl Default for UpdateSnapshot {
    fn default() -> Self {
        Self {
            phase: UpdatePhase::Idle,
            current_version: String::new(),
            target_version: None,
            artifact: None,
            downloaded_bytes: 0,
            total_bytes: 0,
            error: None,
            shell_version: None,
        }
    }
}

/// 单例更新状态。`busy` 保证检查/下载绝不并发两份。
pub struct UpdateState {
    inner: Mutex<UpdateInner>,
    busy: AtomicBool,
    cancel: AtomicBool,
}

struct UpdateInner {
    snapshot: UpdateSnapshot,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(UpdateInner {
                snapshot: UpdateSnapshot::default(),
            }),
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        }
    }
}

impl UpdateState {
    pub fn snapshot(&self) -> UpdateSnapshot {
        let mut s = self.inner.lock().unwrap().snapshot.clone();
        // 「关于」需要同时展示壳版本与 sidecar 版本;壳版本是编译期常量,
        // 惰性填一次(dev 构建为 None,展示层回退到 current_version)。
        if s.shell_version.is_none() {
            s.shell_version = crate::expected_sidecar_version().map(|v| v.to_string());
        }
        s
    }

    fn set(&self, snapshot: UpdateSnapshot) {
        self.inner.lock().unwrap().snapshot = snapshot;
    }

    fn mark_busy(&self) -> bool {
        self.busy.swap(true, Ordering::SeqCst)
    }

    fn clear_busy(&self) {
        self.busy.store(false, Ordering::SeqCst);
        self.cancel.store(false, Ordering::SeqCst);
    }
}

/// 供命令读取快照。
pub fn snapshot(state: &UpdateState) -> UpdateSnapshot {
    state.snapshot()
}

fn emit(app: &AppHandle, state: &UpdateState) {
    let snap = state.snapshot();
    let _ = app.emit_to(UPDATE_WINDOW, UPDATE_EVENT, &snap);
}

// ── 平台/架构(与 manifest 的 platform/arch 字段一致)─────────────────────

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
}

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// 侧car 回环 base URL(从壳状态读取;sidecar 就绪后才可用)。
fn sidecar_base(app: &AppHandle) -> Option<String> {
    app.state::<ShellState>().sidecar_url()
}

/// 当前运行版本(壳启动时从 `c3 --version` 实测)。
fn current_version(app: &AppHandle) -> String {
    app.state::<ShellState>().sidecar_version()
}

// ── 检查更新 ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CheckResponse {
    available: bool,
    target_version: Option<String>,
    error: Option<String>,
    artifact: Option<ArtifactInfo>,
}

/// 后台/手动检查更新。重复调用合并到在途任务(由 `busy` 保证)。
pub fn check_update(app: &AppHandle, _manual: bool) {
    let state = app.state::<UpdateState>();
    if state.mark_busy() {
        return; // 已有一次检查/下载在途
    }
    let current = current_version(app);
    let snapshot = UpdateSnapshot {
        phase: UpdatePhase::Checking,
        current_version: current.clone(),
        ..Default::default()
    };
    state.set(snapshot);
    emit(app, &state);

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = do_check(&app, &current);
        let state = app.state::<UpdateState>();
        match outcome {
            Ok(CheckResponse {
                available: true,
                artifact: Some(artifact),
                target_version,
                ..
            }) => {
                let snap = UpdateSnapshot {
                    phase: UpdatePhase::AwaitingConfirm,
                    current_version: current,
                    target_version,
                    artifact: Some(artifact),
                    ..Default::default()
                };
                state.set(snap);
            }
            // sidecar 返回 `available:false` + error = 检查本身失败(网络/无 manifest),
            // 呈现为可重试的失败而非「已是最新」。
            Ok(CheckResponse {
                available: false,
                error: Some(e),
                ..
            }) => {
                let snap = UpdateSnapshot {
                    phase: UpdatePhase::Failed,
                    current_version: current,
                    error: Some(e),
                    ..Default::default()
                };
                state.set(snap);
            }
            // available:false 且无 error = 确实没有更新。
            Ok(CheckResponse {
                available: false,
                target_version,
                ..
            }) => {
                let snap = UpdateSnapshot {
                    phase: UpdatePhase::UpToDate,
                    current_version: current,
                    target_version,
                    ..Default::default()
                };
                state.set(snap);
            }
            // available:true 但该平台没有 desktop 制品 = 本次发布不可用于桌面更新。
            Ok(CheckResponse {
                available: true,
                artifact: None,
                target_version,
                ..
            }) => {
                let snap = UpdateSnapshot {
                    phase: UpdatePhase::UpToDate,
                    current_version: current,
                    target_version,
                    error: Some("no desktop artifact available for this platform".to_string()),
                    ..Default::default()
                };
                state.set(snap);
            }
            Err(e) => {
                let snap = UpdateSnapshot {
                    phase: UpdatePhase::Failed,
                    current_version: current,
                    error: Some(e),
                    ..Default::default()
                };
                state.set(snap);
            }
        }
        state.clear_busy();
        emit(&app, &state);
    });
}

fn do_check(app: &AppHandle, current: &str) -> Result<CheckResponse, String> {
    let base = sidecar_base(app).ok_or_else(|| "the local c3 service is not ready".to_string())?;
    let url = format!(
        "{base}/api/update/check?current={}&platform={}&arch={}",
        urlencode(current),
        platform(),
        arch()
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("cannot build http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("update check failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("update check failed: HTTP {}", resp.status()));
    }
    resp.json::<CheckResponse>()
        .map_err(|e| format!("malformed update check response: {e}"))
}

// ── 确认下载 ────────────────────────────────────────────────────────────────

/// 用户确认下载。仅在 `AwaitingConfirm` 状态下有效;下载失败保留旧版本并可重试。
pub fn confirm_download(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    if state.mark_busy() {
        return;
    }
    let snap = state.snapshot();
    if snap.phase != UpdatePhase::AwaitingConfirm || snap.artifact.is_none() {
        state.clear_busy();
        return;
    }
    state.set(UpdateSnapshot {
        phase: UpdatePhase::Downloading,
        downloaded_bytes: 0,
        total_bytes: snap.artifact.as_ref().map(|a| a.bytes).unwrap_or(0),
        ..snap
    });
    emit(app, &state);

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = do_download(&app);
        let state = app.state::<UpdateState>();
        match outcome {
            Ok(_staged) => {
                let mut snap = state.snapshot();
                snap.phase = UpdatePhase::AwaitingInstall;
                snap.downloaded_bytes = snap.total_bytes;
                snap.error = None;
                state.set(snap);
                state.clear_busy();
                emit(&app, &state);
            }
            Err(e) => {
                let mut snap = state.snapshot();
                snap.phase = UpdatePhase::Failed;
                snap.error = Some(e);
                state.set(snap);
                state.clear_busy();
                emit(&app, &state);
            }
        }
    });
}

/// 取消当前更新动作:
///   * 等待确认(用户拒绝下载)→ 回到空闲;
///   * 下载中 → 给在途下载发中断信号;
///   * 等待安装(用户取消安装)→ 回到空闲,保留已下载包供下次重试;
///   * 其他阶段 → 无操作。
pub fn cancel_download(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let snap = state.snapshot();
    match snap.phase {
        UpdatePhase::AwaitingConfirm | UpdatePhase::AwaitingInstall => {
            let snap = UpdateSnapshot {
                phase: UpdatePhase::Idle,
                target_version: None,
                artifact: None,
                downloaded_bytes: 0,
                total_bytes: 0,
                error: None,
                ..snap
            };
            state.set(snap);
            emit(app, &state);
        }
        UpdatePhase::Downloading | UpdatePhase::Verifying => {
            state.cancel.store(true, Ordering::SeqCst);
        }
        _ => {}
    }
}

fn do_download(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<UpdateState>();
    let snap = state.snapshot();
    let artifact = snap
        .artifact
        .as_ref()
        .ok_or_else(|| "no update artifact selected".to_string())?;
    let base = sidecar_base(app).ok_or_else(|| "the local c3 service is not ready".to_string())?;
    let url = format!(
        "{base}/api/update/download?url={}&bytes={}&sha256={}",
        urlencode(&artifact.url),
        artifact.bytes,
        artifact.sha256
    );

    let config_dir = shell_config_dir(app);
    install::cleanup_invalid_staging(&config_dir);
    let staging = install::staging_dir(&config_dir);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("cannot create the update staging dir: {e}"))?;
    let tmp_path = staging.join(format!("{}.tmp", artifact.file));
    let ready_path = staging.join(format!("{}.ready", artifact.file));

    let client = reqwest::blocking::Client::builder()
        .build()
        .map_err(|e| format!("cannot build http client: {e}"))?;
    let mut resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let expected_sha = resp
        .headers()
        .get("x-c3-sha256")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let expected_sha =
        expected_sha.ok_or_else(|| "download response is missing its checksum".to_string())?;

    let total = snap.total_bytes;
    let mut file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("cannot write the staged download: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; DOWNLOAD_CHUNK];
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut cancelled = false;

    loop {
        if app.state::<UpdateState>().cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let n = resp
            .read(&mut buf)
            .map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("cannot write the staged download: {e}"))?;
        hasher.update(&buf[..n]);
        downloaded += n as u64;

        if downloaded.saturating_sub(last_emit) >= PROGRESS_EVERY_BYTES {
            last_emit = downloaded;
            let state = app.state::<UpdateState>();
            let mut snap = state.snapshot();
            snap.phase = UpdatePhase::Downloading;
            snap.downloaded_bytes = downloaded;
            emit(app, &state);
        }
    }

    if cancelled {
        drop(file);
        let _ = std::fs::remove_file(&tmp_path);
        return Err("download cancelled".to_string());
    }
    if downloaded != total {
        drop(file);
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "download incomplete: got {downloaded} of {total} bytes"
        ));
    }

    // 最终校验:下载完成 ≠ 可安装 —— 字节数必须等于 manifest 的字节数,且本线程
    // 独立计算的 sha256 必须等于 sidecar 验证过的 manifest 摘要。
    let actual = format!("{:x}", hasher.finalize());
    if !download_ok(downloaded, total, &actual, &expected_sha) {
        drop(file);
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "download verification failed (got {downloaded}/{total} bytes, sha {actual})"
        ));
    }
    drop(file);
    std::fs::rename(&tmp_path, &ready_path)
        .map_err(|e| format!("cannot finalize the staged download: {e}"))?;
    Ok(ready_path)
}

/// 下载结果的判定规则:字节数必须等于预期,摘要必须等于预期。
/// 截断传输、内容被篡改、流提前结束都在这里被拒绝。
fn download_ok(downloaded: u64, total: u64, actual_sha: &str, expected_sha: &str) -> bool {
    downloaded == total && actual_sha == expected_sha
}

// ── 确认安装(退出并交给安装助手)──────────────────────────────────────────

/// 用户确认安装:写更新记录 → 停 sidecar → 拉起独立更新助手 → 退出壳。
pub fn confirm_install(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let snap = state.snapshot();
    if snap.phase != UpdatePhase::AwaitingInstall {
        return;
    }
    let artifact = match &snap.artifact {
        Some(a) => a,
        None => return,
    };
    let config_dir = shell_config_dir(app);
    let staged_path = install::staging_dir(&config_dir)
        .join(format!("{}.ready", artifact.file))
        .to_string_lossy()
        .into_owned();

    let record = install::UpdateRecord {
        current_version: snap.current_version.clone(),
        target_version: snap.target_version.clone().unwrap_or_default(),
        staged_path,
        sha256: artifact.sha256.clone(),
        kind: artifact.kind.clone().unwrap_or_default(),
        shell_pid: std::process::id(),
    };
    if let Err(e) = install::write_record(&config_dir, &record) {
        let mut snap = state.snapshot();
        snap.phase = UpdatePhase::Failed;
        snap.error = Some(format!("cannot write the update record: {e}"));
        state.set(snap);
        emit(app, &state);
        return;
    }

    let mut snap = state.snapshot();
    snap.phase = UpdatePhase::Installing;
    state.set(snap);
    emit(app, &state);

    // 先按既有生命周期规则停掉本壳创建的 sidecar,再拉起助手并退出。
    crate::stop_sidecar(app);
    let exe = std::env::current_exe().unwrap_or_default();
    let _ = std::process::Command::new(exe)
        .arg(install::ASSISTANT_ARG)
        .arg(install::ASSISTANT_DIR_ARG)
        .arg(&config_dir)
        .spawn();
    app.exit(0);
}

// ── 工具 ────────────────────────────────────────────────────────────────────

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_query_values() {
        assert_eq!(urlencode("0.1.0"), "0.1.0");
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn platform_and_arch_map_to_manifest_names() {
        // 与 manifest 的 platform/arch 字段一致;不能出现 `darwin`/`aarch64` 这类
        // 宿主词误入 manifest 匹配。
        assert!(matches!(platform(), "macos" | "windows" | "linux"));
        assert!(matches!(arch(), "arm64" | "x64"));
    }

    #[test]
    fn download_accepts_only_complete_untampered_transfers() {
        // 完整 + 摘要一致 → 可安装。
        assert!(download_ok(100, 100, "abc", "abc"));
        // 中断(字节数不足)。
        assert!(!download_ok(99, 100, "abc", "abc"));
        // 超量。
        assert!(!download_ok(101, 100, "abc", "abc"));
        // 摘要不一致(内容被篡改)。
        assert!(!download_ok(100, 100, "abc", "abd"));
    }

    #[test]
    fn snapshot_serializes_to_camel_case() {
        let snap = UpdateSnapshot {
            phase: UpdatePhase::AwaitingConfirm,
            current_version: "0.1.0".into(),
            target_version: Some("0.2.0".into()),
            artifact: Some(ArtifactInfo {
                file: "c3-desktop-v0.2.0-macos-arm64.dmg".into(),
                kind: Some("dmg".into()),
                bytes: 100,
                sha256: "ab".repeat(32),
                url: "https://github.com/x/y".into(),
            }),
            downloaded_bytes: 0,
            total_bytes: 100,
            error: None,
            shell_version: Some("0.1.0".into()),
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"currentVersion\""));
        assert!(json.contains("\"targetVersion\""));
        assert!(json.contains("\"downloadedBytes\""));
        assert!(json.contains("\"shellVersion\""));
        assert!(json.contains("\"awaitingConfirm\""));
    }
}
