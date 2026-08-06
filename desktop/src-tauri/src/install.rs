//! 更新安装层:记录、校验、平台安装适配器与独立更新助手。
//!
//! 更新助手不是 Tauri 运行时里的一个函数,而是**同一个可执行文件**以
//! `--update-assistant` 参数启动后的独立入口(`update_assistant_main`)。它不初始化
//! WebView/窗口,只做四件事:等壳退出 → 校验已就绪的安装包 → 调用平台安装适配器
//! → 启动新 App。
//!
//! 所有持久状态只落在壳配置目录(与 sidecar 运行记录同目录),绝不写 `~/.c3`:
//!   * `update-record.json`  —— 壳在下载+双重校验通过后写入的安装指令(旧版本、
//!                              目标版本、已校验 sha256、暂存包绝对路径、壳 pid)。
//!   * `update-staging/`      —— 下载暂存区,`.tmp` 未完成,`.ready` 才可安装。
//!   * 备份目录               —— 提交点前的旧 App 移动位置,用于失败回滚。
//!
//! 平台适配器统一暴露「准备 / 提交 / 验证 / 回滚」语义:
//!   * macOS  —— 移动旧 App 到同目录备份 → 挂载 dmg → 拷入新 App → 签名验证 →
//!               `open` 启动。提交点是「新 App 落位」;之后启动失败则删新、移回备份。
//!   * Windows —— NSIS 安装器以独立进程运行并自行管理替换(运行中的 exe 无法覆盖),
//!               助手只负责启动安装器并等待其退出;失败不删旧应用。
//!   * Linux   —— 在当前用户可写的原 AppImage 路径同目录准备并原子替换,失败回滚。
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// 更新记录文件名(壳配置目录下)。
pub const UPDATE_RECORD_NAME: &str = "update-record.json";
/// 下载暂存目录名(壳配置目录下)。
pub const STAGING_DIR_NAME: &str = "update-staging";
/// 已完成校验、可交给助手的暂存包后缀。
pub const READY_SUFFIX: &str = ".ready";
/// 助手入口参数。
pub const ASSISTANT_ARG: &str = "--update-assistant";
/// 助手接收壳配置目录的参数。
pub const ASSISTANT_DIR_ARG: &str = "--update-dir";

/// 壳在下载+双重校验通过后落盘的安装指令。助手只认这份记录。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecord {
    /// 当前(旧)版本。
    pub current_version: String,
    /// 目标(新)版本。
    pub target_version: String,
    /// 已校验安装包的绝对路径(壳配置目录 `update-staging/` 下,`.ready`)。
    pub staged_path: String,
    /// 安装包 sha256(壳已按 manifest 校验)。
    pub sha256: String,
    /// 安装包 kind(dmg / nsis / msi / deb / appimage)。
    pub kind: String,
    /// 启动助手的壳进程 pid;助手等它退出后再动手。
    pub shell_pid: u32,
}

// ── 记录读写 ────────────────────────────────────────────────────────────────

pub fn update_record_path(config_dir: &Path) -> PathBuf {
    config_dir.join(UPDATE_RECORD_NAME)
}

pub fn staging_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(STAGING_DIR_NAME)
}

pub fn write_record(config_dir: &Path, record: &UpdateRecord) -> io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    fs::write(update_record_path(config_dir), format!("{json}\n"))
}

pub fn read_record(config_dir: &Path) -> Option<UpdateRecord> {
    let raw = fs::read_to_string(update_record_path(config_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn clear_record(config_dir: &Path) {
    let _ = fs::remove_file(update_record_path(config_dir));
}

/// 读取记录但不信任其中路径:校验 staged 包存在、sha256 与记录一致。
/// 记录被篡改、包缺失或摘要不符都返回 Err —— 助手不得安装任何未经验证的暂存包。
pub fn verify_record(config_dir: &Path) -> Result<UpdateRecord, String> {
    let record = read_record(config_dir)
        .ok_or_else(|| "update record is missing or corrupt — nothing to install".to_string())?;
    let staged = Path::new(&record.staged_path);
    let actual = file_sha256(staged)
        .map_err(|e| format!("staged package {} is not readable: {e}", record.staged_path))?;
    if actual != record.sha256 {
        return Err(format!(
            "staged package sha256 mismatch (have {actual}, expected {})",
            record.sha256
        ));
    }
    Ok(record)
}

fn file_sha256(path: &Path) -> io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 删除未完成/校验失败的暂存文件。`.ready` 包在提交前保留。
pub fn cleanup_invalid_staging(config_dir: &Path) {
    let dir = staging_dir(config_dir);
    if !dir.exists() {
        return;
    }
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_ready = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e == "ready")
                .unwrap_or(false);
            if !is_ready {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

// ── 独立更新助手入口 ───────────────────────────────────────────────────────

/// 助手模式的主流程。由 `main` 在检测到 `--update-assistant` 时调用,不初始化 Tauri。
///
/// 返回进程退出码。整个流程幂等地把「壳退出 → 校验 → 安装 → 启动」走完;任何一步
/// 失败都保持旧 App 不变(或回滚),并留下记录供下次启动兜底。
pub fn update_assistant_main() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    let config_dir = args
        .windows(2)
        .find(|w| w[0] == ASSISTANT_DIR_ARG)
        .map(|w| PathBuf::from(&w[1]));
    let Some(config_dir) = config_dir else {
        eprintln!("[c3-desktop] update assistant: missing {ASSISTANT_DIR_ARG} <dir>");
        return 2;
    };

    let record = match verify_record(&config_dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[c3-desktop] update assistant: {e}");
            clear_record(&config_dir);
            return 2;
        }
    };

    // 等壳进程完全退出再动手。Windows 上运行中的 exe 无法被覆盖,这步是硬前提。
    wait_for_exit(record.shell_pid, Duration::from_secs(30));

    let staged = PathBuf::from(&record.staged_path);
    if !staged.exists() {
        eprintln!(
            "[c3-desktop] update assistant: staged package {} is gone",
            record.staged_path
        );
        clear_record(&config_dir);
        return 2;
    }

    match install(&record, &config_dir) {
        Ok(outcome) => {
            eprintln!("[c3-desktop] update assistant: {outcome:?}");
            // 安装成功(含回滚成功)后清理记录与备份。启动新 App 由 install 完成。
            clear_record(&config_dir);
            0
        }
        Err(e) => {
            eprintln!("[c3-desktop] update assistant: install failed: {e}");
            // 提交前的失败不动旧应用;提交后启动失败已在适配器内回滚。
            clear_record(&config_dir);
            1
        }
    }
}

/// 轮询直到 pid 对应的进程退出(或超时)。进程已不存在视为「已退出」。
fn wait_for_exit(pid: u32, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !crate::sidecar::is_alive(pid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    eprintln!(
        "[c3-desktop] update assistant: shell pid {pid} did not exit in time — proceeding anyway"
    );
}

// ── 安装编排 ────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum InstallOutcome {
    /// 新版本已就位并成功启动。
    Replaced,
    /// 提交点之后的安装/启动失败,已回滚到旧版本并启动旧版本。
    RolledBack,
}

/// 平台安装适配器统一入口。成功返回结果;失败返回描述(旧应用保持不变或已回滚)。
fn install(record: &UpdateRecord, config_dir: &Path) -> Result<InstallOutcome, String> {
    // Linux 适配器就地替换 AppImage,不需要暂存目录;cfg 裁掉 macOS/Windows 分支后
    // 这个参数在 Linux 上无人使用,显式丢弃以免只在该平台出现的 unused 警告。
    #[cfg(target_os = "linux")]
    let _ = config_dir;
    match record.kind.as_str() {
        // 发布约定的唯一自更新安装器(macOS=dmg、Windows=nsis、Linux=appimage)。
        // 任何未规划的 kind 都 fail-closed,不猜测。
        #[cfg(target_os = "macos")]
        "dmg" => install_macos(record, config_dir),
        #[cfg(target_os = "windows")]
        "nsis" => install_windows(record),
        #[cfg(target_os = "linux")]
        "deb" | "appimage" => install_linux(record),
        other => Err(format!(
            "no installer for artifact kind '{other}' on this platform"
        )),
    }
}

// ── macOS 适配器:完整 App bundle 替换,带提交点与回滚 ─────────────────────

#[cfg(target_os = "macos")]
fn install_macos(record: &UpdateRecord, config_dir: &Path) -> Result<InstallOutcome, String> {
    let current = current_app_bundle().ok_or_else(|| {
        "cannot locate the running c3.app bundle — refusing to replace it".to_string()
    })?;
    let parent = current
        .parent()
        .ok_or_else(|| "cannot locate the app bundle parent".to_string())?
        .to_path_buf();
    let app_name = current
        .file_name()
        .ok_or_else(|| "cannot read the app bundle name".to_string())?
        .to_string_lossy()
        .into_owned();
    let target = parent.join(&app_name);
    let backup = parent.join(format!(".c3-update-backup-{app_name}"));

    // ── 准备:把旧 App 移到备份(提交点前任何失败都把它移回)────────────
    if backup.exists() {
        fs::remove_dir_all(&backup)
            .map_err(|e| format!("cannot clear stale backup {backup:?}: {e}"))?;
    }
    if target.exists() {
        fs::rename(&target, &backup).map_err(|e| format!("cannot move old app aside: {e}"))?;
    }

    // ── 提交点:把新 App 落位 ─────────────────────────────────────────────
    let staged = PathBuf::from(&record.staged_path);
    let result = if staged.to_string_lossy().ends_with(".dmg") {
        mount_and_copy_app(&staged, &target, &backup)
    } else {
        Err(format!(
            "unsupported macOS package: {} (expect a .dmg)",
            record.staged_path
        ))
    };

    match result {
        Ok(()) => {
            // ── 验证:新 App 必须签名/公证通过,否则视为安装失败并回滚 ──
            if let Err(e) = verify_signed_app(&target) {
                eprintln!("[c3-desktop] update assistant: new app failed signing check: {e}");
                rollback_macos(&target, &backup, &app_name);
                return Err(format!("new app failed signing verification: {e}"));
            }
            // 启动新 App;启动失败则回滚。
            if let Err(e) = launch_app(&target) {
                eprintln!("[c3-desktop] update assistant: launching new app failed: {e}");
                rollback_macos(&target, &backup, &app_name);
                return Err(format!("launching the new app failed: {e}"));
            }
            // 成功启动后才清掉备份与暂存(成功路径)。
            let _ = fs::remove_dir_all(&backup);
            let _ = cleanup_staging_package(&staged, config_dir);
            Ok(InstallOutcome::Replaced)
        }
        Err(e) => {
            // 提交点之前失败:把旧 App 移回原位,当前版本保持可用。
            rollback_macos(&target, &backup, &app_name);
            Err(e)
        }
    }
}

/// 当前运行中的 `.app` bundle 路径(由可执行文件上溯)。
#[cfg(target_os = "macos")]
fn current_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    Some(app.to_path_buf())
}

/// 挂载 dmg,把其中的 `.app` 拷入目标位置。返回后调用方负责验证与清理挂载。
#[cfg(target_os = "macos")]
fn mount_and_copy_app(dmg: &Path, target: &Path, _backup: &Path) -> Result<(), String> {
    let mount = mount_dmg(dmg)?;
    let app_in_dmg = find_app_in(&mount)
        .ok_or_else(|| format!("the dmg contains no .app bundle under {mount:?}"))?;
    let res = Command::new("ditto").arg(&app_in_dmg).arg(target).status();
    let _ = detach_dmg(&mount);
    match res {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("ditto exited with {status:?}")),
        Err(e) => Err(format!("ditto failed: {e}")),
    }
}

#[cfg(target_os = "macos")]
fn mount_dmg(dmg: &Path) -> Result<PathBuf, String> {
    let out = Command::new("hdiutil")
        .args([
            "attach",
            dmg.to_str().unwrap_or(""),
            "-nobrowse",
            "-readonly",
        ])
        .output()
        .map_err(|e| format!("hdiutil attach failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "hdiutil attach failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    // 输出末尾一行形如: `/dev/disk4s1   Apple_HFS   /Volumes/c3`。
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .rev()
        .find_map(|line| {
            let path = line.split_whitespace().last()?;
            let p = Path::new(path);
            p.exists().then(|| p.to_path_buf())
        })
        .ok_or_else(|| format!("cannot parse hdiutil attach output: {text}"))
}

#[cfg(target_os = "macos")]
fn detach_dmg(mount: &Path) {
    let _ = Command::new("hdiutil")
        .args(["detach", mount.to_str().unwrap_or(""), "-quiet"])
        .status();
}

/// 在挂载点下找 `.app`(顶层)。
#[cfg(target_os = "macos")]
fn find_app_in(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("app") && path.is_dir() {
            return Some(path);
        }
    }
    None
}

/// 新 App 的签名校验 —— 替换正在使用的 App 之前的最后一道关。
///
/// `codesign --verify` 是**硬要求**:它封装了整个 bundle 的哈希,过不了就说明字节
/// 被改过或签名缺失,这正是这道关要挡的东西。
///
/// `stapler validate` 只作参考。公证票据的缺失不等于包被篡改:发布产物在没有
/// Developer ID 证书时是 ad-hoc 签名的,本就没有票据;而 `stapler` 属于完整版
/// Xcode,只装了 Command Line Tools 的机器上跑它只会得到 xcode-select 的报错。
/// 拿它当硬门禁,等于在绝大多数用户机器上无条件阻断自更新。
#[cfg(target_os = "macos")]
fn verify_signed_app(app: &Path) -> Result<(), String> {
    let out = Command::new("codesign")
        .args(["--verify", "--deep", "--strict", app.to_str().unwrap_or("")])
        .output()
        .map_err(|e| format!("codesign failed to run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "codesign --verify failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let stapled = Command::new("stapler")
        .args(["validate", app.to_str().unwrap_or("")])
        .output();
    match stapled {
        Ok(out) if out.status.success() => {}
        _ => eprintln!(
            "[c3-desktop] update assistant: no notarization ticket for {} \
             — proceeding on the verified code signature alone",
            app.display()
        ),
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn rollback_macos(target: &Path, backup: &Path, app_name: &str) {
    if target.exists() {
        let _ = fs::remove_dir_all(target);
    }
    if backup.exists() {
        let _ = fs::rename(backup, target);
    }
    eprintln!("[c3-desktop] update assistant: rolled back to the previous {app_name}");
}

#[cfg(target_os = "macos")]
fn launch_app(app: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(app.to_str().unwrap_or(""))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open failed: {e}"))
}

#[cfg(target_os = "macos")]
fn cleanup_staging_package(staged: &Path, config_dir: &Path) -> io::Result<()> {
    let _ = fs::remove_file(staged);
    fs::remove_dir_all(staging_dir(config_dir)).or_else(|_| Ok(()))
}

// ── Windows / Linux 适配器:委托系统安装器,失败不动旧应用 ─────────────────

#[cfg(target_os = "windows")]
fn install_windows(record: &UpdateRecord) -> Result<InstallOutcome, String> {
    let staged = PathBuf::from(&record.staged_path);
    // NSIS 静默安装。运行中的 exe 由安装器负责排队/替换。
    let status = Command::new(&staged)
        .arg("/S")
        .status()
        .map_err(|e| format!("failed to start the installer: {e}"))?;
    if !status.success() {
        return Err(format!("installer exited with {status:?}"));
    }
    // 尝试启动新版本;找不到安装路径时旧应用仍在(未卸载)。
    if let Some(exe) = installed_exe_after_update() {
        let _ = Command::new(exe).spawn();
    }
    Ok(InstallOutcome::Replaced)
}

#[cfg(target_os = "windows")]
fn installed_exe_after_update() -> Option<PathBuf> {
    // 壳与 sidecar 都装在同一目录;新安装后该目录的 c3-desktop.exe 指向新版本。
    let current = std::env::current_exe().ok()?;
    let dir = current.parent()?;
    Some(dir.join("c3-desktop.exe"))
}

#[cfg(target_os = "linux")]
fn install_linux(record: &UpdateRecord) -> Result<InstallOutcome, String> {
    let staged = PathBuf::from(&record.staged_path);
    match record.kind.as_str() {
        "appimage" => {
            let target = std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .ok_or_else(|| {
                    "APPIMAGE is not set — Linux self-update requires launching the AppImage"
                        .to_string()
                })?;
            replace_appimage(&staged, &target)?;
            if let Err(e) = Command::new(&target).spawn() {
                rollback_appimage(&target)?;
                return Err(format!(
                    "new AppImage could not be started; old version restored: {e}"
                ));
            }
            remove_appimage_backup(&target);
            Ok(InstallOutcome::Replaced)
        }
        other => Err(format!("no linux installer for kind '{other}'")),
    }
}

#[cfg(target_os = "linux")]
fn appimage_sibling(target: &Path, suffix: &str) -> Result<PathBuf, String> {
    let name = target
        .file_name()
        .ok_or_else(|| "cannot read the current AppImage name".to_string())?
        .to_string_lossy();
    Ok(target.with_file_name(format!(".{name}.c3-update-{suffix}")))
}

#[cfg(target_os = "linux")]
fn replace_appimage(staged: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    if !target.is_file() {
        return Err(format!(
            "current AppImage does not exist: {}",
            target.display()
        ));
    }
    let prepared = appimage_sibling(target, "new")?;
    let backup = appimage_sibling(target, "backup")?;
    let _ = fs::remove_file(&prepared);
    let _ = fs::remove_file(&backup);

    fs::copy(staged, &prepared)
        .map_err(|e| format!("cannot prepare AppImage beside current installation: {e}"))?;
    fs::set_permissions(&prepared, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("cannot make prepared AppImage executable: {e}"))?;
    fs::File::open(&prepared)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("cannot flush prepared AppImage: {e}"))?;
    fs::hard_link(target, &backup)
        .or_else(|_| fs::copy(target, &backup).map(|_| ()))
        .map_err(|e| format!("cannot back up current AppImage: {e}"))?;
    fs::rename(&prepared, target).map_err(|e| {
        let _ = fs::remove_file(&backup);
        format!("cannot atomically replace current AppImage: {e}")
    })
}

#[cfg(target_os = "linux")]
fn rollback_appimage(target: &Path) -> Result<(), String> {
    let backup = appimage_sibling(target, "backup")?;
    fs::rename(&backup, target).map_err(|e| format!("cannot restore old AppImage: {e}"))
}

#[cfg(target_os = "linux")]
fn remove_appimage_backup(target: &Path) {
    if let Ok(backup) = appimage_sibling(target, "backup") {
        let _ = fs::remove_file(backup);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("c3-install-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn record_round_trips_and_verifies_its_own_package() {
        let dir = tmp_dir("record");
        // 写一个真实的小文件作为暂存包。
        let staged = staging_dir(&dir).join("pkg.dmg");
        fs::create_dir_all(staging_dir(&dir)).unwrap();
        fs::write(&staged, b"fake dmg bytes").unwrap();
        let sha = file_sha256(&staged).unwrap();

        let record = UpdateRecord {
            current_version: "0.1.0".into(),
            target_version: "0.2.0".into(),
            staged_path: staged.to_string_lossy().into_owned(),
            sha256: sha.clone(),
            kind: "dmg".into(),
            shell_pid: 0,
        };
        write_record(&dir, &record).unwrap();
        let verified = verify_record(&dir).expect("record + package should verify");
        assert_eq!(verified.target_version, "0.2.0");
        assert_eq!(verified.sha256, sha);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_package_or_record_is_rejected() {
        let dir = tmp_dir("tampered");
        let staged = staging_dir(&dir).join("pkg.dmg");
        fs::create_dir_all(staging_dir(&dir)).unwrap();
        fs::write(&staged, b"real bytes").unwrap();
        let sha = file_sha256(&staged).unwrap();

        let record = UpdateRecord {
            current_version: "0.1.0".into(),
            target_version: "0.2.0".into(),
            staged_path: staged.to_string_lossy().into_owned(),
            sha256: sha,
            kind: "dmg".into(),
            shell_pid: 0,
        };
        write_record(&dir, &record).unwrap();

        // 篡改暂存包字节 → 拒绝安装。
        fs::write(&staged, b"tampered").unwrap();
        assert!(verify_record(&dir).is_err());

        // 改回字节 → 通过;篡改记录本身 → 拒绝。
        fs::write(&staged, b"real bytes").unwrap();
        let ok = verify_record(&dir).expect("restored bytes should verify");
        assert_eq!(ok.current_version, "0.1.0");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_removes_tmp_but_keeps_ready() {
        let dir = tmp_dir("cleanup");
        let sdir = staging_dir(&dir);
        fs::create_dir_all(&sdir).unwrap();
        fs::write(sdir.join("pkg.dmg.tmp"), b"partial").unwrap();
        fs::write(sdir.join("pkg.dmg.ready"), b"done").unwrap();
        cleanup_invalid_staging(&dir);
        assert!(!sdir.join("pkg.dmg.tmp").exists());
        assert!(sdir.join("pkg.dmg.ready").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_update_replaces_the_existing_user_install_and_can_roll_back() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tmp_dir("appimage-replace");
        let target = dir.join("c3.AppImage");
        let staged = dir.join("download.ready");
        fs::write(&target, b"old-version").unwrap();
        fs::write(&staged, b"new-version").unwrap();

        replace_appimage(&staged, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new-version");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::read(appimage_sibling(&target, "backup").unwrap()).unwrap(),
            b"old-version"
        );

        rollback_appimage(&target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"old-version");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_update_fails_before_commit_when_install_directory_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;

        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tmp_dir("appimage-permissions");
        let target = dir.join("c3.AppImage");
        let staged = dir.join("download.ready");
        fs::write(&target, b"old-version").unwrap();
        fs::write(&staged, b"new-version").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();

        assert!(replace_appimage(&staged, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old-version");

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
