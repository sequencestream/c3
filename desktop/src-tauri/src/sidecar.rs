//! Sidecar 进程的底层原语:回环端口选择、就绪探测、进程身份记录与停止。
//!
//! 这里刻意不依赖 Tauri:所有函数都是可独立推理的进程/网络操作,壳的编排逻辑放在
//! `lib.rs`。两个安全性要点集中在本文件:
//!
//! 1. **只绑回环**。端口从 `127.0.0.1:0` 探得,并原样传给 sidecar 的 `--host/--port`。
//!    壳从不读取、也不放宽用户设置里的 `exposure.bindAddress`。
//! 2. **只杀自己创建的进程**。孤儿清理依据壳自己写下的身份三元组(pid + 可执行文件
//!    路径 + 进程启动时间)校验,绝不按端口占用或进程名去杀 —— 那会误杀用户自己从
//!    终端启动的 c3。

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};

/// 桌面壳固定使用的 IPv4 回环地址。
pub const LOOPBACK: Ipv4Addr = Ipv4Addr::LOCALHOST;

/// sidecar 在 Tauri `externalBin` 中的基名(实际文件带目标三元组后缀)。
pub const SIDECAR_NAME: &str = "c3";

/// 壳写在自己配置目录下的运行记录文件名。只记录壳自身状态,不含任何业务数据。
pub const RUN_RECORD_NAME: &str = "sidecar-run.json";

/// 单次 TCP 连接/读写的超时。探测循环整体还有一个更长的 deadline。
const PROBE_IO_TIMEOUT: Duration = Duration::from_millis(1500);
/// 两次探测之间的间隔。
const PROBE_INTERVAL: Duration = Duration::from_millis(200);

/// 壳为某个 sidecar 子进程记录的身份。三个字段缺一不可:
/// pid 会被系统复用,单独使用不足以识别;可执行文件路径把范围收窄到本壳携带的
/// sidecar;启动时间使 pid 复用后的同名进程也无法冒充。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidecarRecord {
    pub pid: u32,
    /// sidecar 可执行文件的绝对路径(壳自己的 externalBin)。
    pub exe: String,
    /// 进程启动时间(Unix 秒),由 sysinfo 在启动后立刻读取。
    pub start_time: u64,
    /// 该实例选中的回环端口,仅用于诊断输出。
    pub port: u16,
}

/// 探测失败的原因。调用方据此决定「换端口重试」还是「向用户报错」。
#[derive(Debug)]
pub enum ProbeError {
    /// sidecar 在就绪之前就退出了(通常是端口竞争或启动错误)。
    Exited,
    /// 到达 deadline 仍未应答。
    Timeout,
}

/// 从内核借一个空闲回环端口:绑定 `127.0.0.1:0`、读回端口号、随即释放。
///
/// 释放到 sidecar 真正 bind 之间存在窗口期,别的进程可能抢走该端口。调用方因此把
/// 「sidecar 提前退出」当作可重试信号并换一个端口,而不是直接报错。
pub fn pick_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(LOOPBACK, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// 该端口上的服务地址(壳内部唯一的 URL 构造点)。
pub fn loopback_url(port: u16) -> String {
    format!("http://{LOOPBACK}:{port}")
}

/// 单次探测:连上回环端口并发一个最小 HTTP 请求,只要对端回了 `HTTP/1.x` 状态行
/// 就算就绪。任何状态码都算活着 —— 我们证明的是「HTTP 服务器在应答」,不是某条路由。
fn probe_once(port: u16) -> bool {
    let addr = SocketAddr::from(SocketAddrV4::new(LOOPBACK, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, PROBE_IO_TIMEOUT) else {
        return false;
    };
    if stream.set_read_timeout(Some(PROBE_IO_TIMEOUT)).is_err()
        || stream.set_write_timeout(Some(PROBE_IO_TIMEOUT)).is_err()
    {
        return false;
    }
    let request =
        format!("GET / HTTP/1.1\r\nHost: {LOOPBACK}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 16];
    let mut filled = 0usize;
    while filled < buf.len() {
        match stream.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    buf[..filled].starts_with(b"HTTP/1.")
}

/// 轮询直到服务就绪、sidecar 提前退出、或超过 `timeout`。
///
/// `exited` 由调用方在收到子进程 `Terminated` 事件时置位 —— 提前退出必须比超时更早
/// 被识别,否则用户会对着一个已经死掉的后端干等整个超时窗口。
pub fn wait_until_ready(
    port: u16,
    timeout: Duration,
    exited: &dyn Fn() -> bool,
) -> Result<(), ProbeError> {
    let deadline = Instant::now() + timeout;
    loop {
        if exited() {
            return Err(ProbeError::Exited);
        }
        if probe_once(port) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(ProbeError::Timeout);
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
}

/// 读取 pid 对应进程的身份(可执行文件路径 + 启动时间)。进程不存在时返回 None。
pub fn identify(pid: u32) -> Option<(String, u64)> {
    let mut sys = System::new_all();
    sys.refresh_all();
    let proc = sys.process(Pid::from_u32(pid))?;
    let exe = proc.exe()?.to_string_lossy().into_owned();
    Some((exe, proc.start_time()))
}

/// 判断记录中的进程是否**仍然是**当初那个 sidecar。
///
/// 三元组全部吻合才算数。任何一项对不上都视为「记录已陈旧」,调用方只删记录、
/// 不动那个进程 —— 它可能是别人的。
pub fn record_still_alive(record: &SidecarRecord) -> bool {
    match identify(record.pid) {
        Some((exe, start_time)) => exe == record.exe && start_time == record.start_time,
        None => false,
    }
}

/// 请求进程优雅退出。
///
/// Unix 上发 `SIGTERM`,c3 服务端为它注册了关机钩子(停调度器、关连接、落日志)。
/// Windows 没有等价的协作式信号,该平台上本函数是空操作,由调用方在宽限期后走硬杀。
#[cfg(unix)]
pub fn request_stop(pid: u32) {
    // SAFETY: kill(2) 只接受一个 pid 和一个信号;传入的 pid 来自壳自己的运行记录,
    // 且调用点已先用 record_still_alive 校验过身份。
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
pub fn request_stop(_pid: u32) {}

/// 进程是否还活着。Unix 用 `kill(pid, 0)`;其他平台退回到 sysinfo 查询。
#[cfg(unix)]
pub fn is_alive(pid: u32) -> bool {
    // SAFETY: 信号 0 不投递信号,只做权限与存在性检查。
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    // EPERM 表示进程存在但属于别的用户 —— 仍算活着。
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn is_alive(pid: u32) -> bool {
    identify(pid).is_some()
}

/// 运行记录文件路径。
pub fn record_path(config_dir: &Path) -> PathBuf {
    config_dir.join(RUN_RECORD_NAME)
}

/// 写入运行记录。失败只影响下次启动的孤儿清理能力,不应中断本次启动,所以返回
/// `io::Result` 由调用方降级为一条日志。
pub fn write_record(config_dir: &Path, record: &SidecarRecord) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(record)
        .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
    fs::write(record_path(config_dir), format!("{json}\n"))
}

/// 读取运行记录。文件缺失或损坏一律当作「没有记录」。
pub fn read_record(config_dir: &Path) -> Option<SidecarRecord> {
    let raw = fs::read_to_string(record_path(config_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 清除运行记录。
pub fn clear_record(config_dir: &Path) {
    let _ = fs::remove_file(record_path(config_dir));
}

/// 上次运行留下的孤儿 sidecar 的清理结果,用于日志与测试断言。
#[derive(Debug, PartialEq, Eq)]
pub enum SweepOutcome {
    /// 没有运行记录。
    NoRecord,
    /// 记录存在但那个进程已经不是当初的 sidecar —— 只删记录。
    StaleRecord,
    /// 确认是本壳上次留下的 sidecar,已请求并确认其结束。
    Reaped { pid: u32 },
    /// 确认身份但在宽限期内没能让它退出。
    Undead { pid: u32 },
}

/// 清理上次壳异常退出时遗留的 sidecar。
///
/// 只处理身份完全吻合的进程;吻合后先请求优雅退出,宽限期过后才硬杀。无论结果如何
/// 都会清掉记录 —— 记录的意义是「上一轮的线索」,不是长期状态。
pub fn sweep_orphan(config_dir: &Path, grace: Duration) -> SweepOutcome {
    let Some(record) = read_record(config_dir) else {
        return SweepOutcome::NoRecord;
    };
    if !record_still_alive(&record) {
        clear_record(config_dir);
        return SweepOutcome::StaleRecord;
    }
    let pid = record.pid;
    request_stop(pid);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !is_alive(pid) {
            clear_record(config_dir);
            return SweepOutcome::Reaped { pid };
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
    // 仍在运行:身份已确认,可以硬杀。
    hard_kill(pid);
    let hard_deadline = Instant::now() + grace;
    while Instant::now() < hard_deadline {
        if !is_alive(pid) {
            clear_record(config_dir);
            return SweepOutcome::Reaped { pid };
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
    clear_record(config_dir);
    SweepOutcome::Undead { pid }
}

/// 硬终止一个**已确认身份**的进程。
#[cfg(unix)]
pub fn hard_kill(pid: u32) {
    // SAFETY: 同 request_stop,pid 来自已校验身份的运行记录。
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
pub fn hard_kill(pid: u32) {
    let mut sys = System::new_all();
    sys.refresh_all();
    if let Some(proc) = sys.process(Pid::from_u32(pid)) {
        proc.kill();
    }
}

/// GUI 启动的 App 继承不到登录 shell 的 `PATH`(macOS 上尤其明显:Finder 启动的进程
/// 只有 `/usr/bin:/bin:/usr/sbin:/sbin`)。c3 需要在 PATH 上找到 `git` 以及用户自行
/// 安装的 vendor CLI,所以这里向登录 shell 问一次真实的 PATH。
///
/// 纯增强:拿不到就返回 None,sidecar 继承壳的 PATH,行为与不做这件事时一致。
#[cfg(unix)]
pub fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok()?;
    let out = std::process::Command::new(shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

#[cfg(not(unix))]
pub fn login_shell_path() -> Option<String> {
    // Windows 的 GUI 进程本来就继承完整的用户 PATH。
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_usable_loopback_port() {
        let port = pick_loopback_port().expect("a free port");
        assert!(port > 0);
        // 端口已释放,应当能再次绑定。
        let again = TcpListener::bind(SocketAddrV4::new(LOOPBACK, port));
        assert!(again.is_ok(), "picked port should be free right after picking");
    }

    #[test]
    fn loopback_url_is_always_ipv4_loopback() {
        assert_eq!(loopback_url(3000), "http://127.0.0.1:3000");
    }

    #[test]
    fn probe_reports_ready_only_for_an_http_answer() {
        let listener = TcpListener::bind(SocketAddrV4::new(LOOPBACK, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let mut sink = [0u8; 256];
                let _ = sock.read(&mut sink);
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });
        assert!(wait_until_ready(port, Duration::from_secs(5), &|| false).is_ok());
        handle.join().unwrap();
    }

    #[test]
    fn probe_gives_up_on_a_dead_port_without_waiting_out_the_timeout() {
        // 没有监听者时,一个宽超时也应立刻因「已退出」而返回。
        let port = pick_loopback_port().unwrap();
        let err = wait_until_ready(port, Duration::from_secs(30), &|| true).unwrap_err();
        assert!(matches!(err, ProbeError::Exited));
    }

    #[test]
    fn probe_times_out_when_nothing_ever_answers() {
        let port = pick_loopback_port().unwrap();
        let err = wait_until_ready(port, Duration::from_millis(300), &|| false).unwrap_err();
        assert!(matches!(err, ProbeError::Timeout));
    }

    #[test]
    fn record_round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("c3-desktop-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let record = SidecarRecord {
            pid: 4321,
            exe: "/opt/c3/c3".into(),
            start_time: 1_700_000_000,
            port: 51234,
        };
        write_record(&dir, &record).unwrap();
        assert_eq!(read_record(&dir).as_ref(), Some(&record));
        clear_record(&dir);
        assert_eq!(read_record(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_record_reads_as_absent_rather_than_panicking() {
        let dir = std::env::temp_dir().join(format!("c3-desktop-bad-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut f = fs::File::create(record_path(&dir)).unwrap();
        f.write_all(b"{not json").unwrap();
        assert_eq!(read_record(&dir), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_without_a_record_is_a_no_op() {
        let dir = std::env::temp_dir().join(format!("c3-desktop-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(
            sweep_orphan(&dir, Duration::from_millis(50)),
            SweepOutcome::NoRecord
        );
    }

    #[test]
    fn sweep_leaves_a_foreign_process_alone_and_only_drops_the_record() {
        // 这个 pid 存在(就是测试进程自己),但可执行文件路径与启动时间都对不上,
        // 因此必须被判为陈旧记录 —— 绝不能去杀它。
        let dir = std::env::temp_dir().join(format!("c3-desktop-foreign-{}", std::process::id()));
        let record = SidecarRecord {
            pid: std::process::id(),
            exe: "/definitely/not/our/sidecar".into(),
            start_time: 1,
            port: 1234,
        };
        write_record(&dir, &record).unwrap();
        assert_eq!(
            sweep_orphan(&dir, Duration::from_millis(50)),
            SweepOutcome::StaleRecord
        );
        assert_eq!(read_record(&dir), None);
        // 仍然活着 —— 证明我们没有按 pid 盲杀。
        assert!(is_alive(std::process::id()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn self_identity_matches_what_identify_reports() {
        let me = std::process::id();
        let (exe, start_time) = identify(me).expect("this process must be visible to sysinfo");
        let record = SidecarRecord {
            pid: me,
            exe,
            start_time,
            port: 0,
        };
        assert!(record_still_alive(&record));
    }
}
