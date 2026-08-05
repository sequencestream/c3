//! 系统托盘 —— 关窗之后 c3 依然常驻的那个入口。
//!
//! 托盘承担三件事:恢复窗口、切换开机自启、退出。开机自启**只**出现在托盘,不经由
//! WebView 的 IPC 暴露:承载远端 SPA 的 `main` 窗口刻意不在任何 capability 里,把
//! 这个开关放进网页就得把 IPC 权限还给远端内容,与本壳的安全边界冲突。
//!
//! 该开关注册的是当前这个桌面 App,与 `c3 install` 的系统服务是两条互不相干的路径,
//! 这里既不调用也不修改后者。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

const ID_OPEN: &str = "open";
const ID_AUTOSTART: &str = "autostart";
const ID_QUIT: &str = "quit";

/// 托盘文案。Web UI 有 zh/en 两种语言,托盘跟随系统语言做同样的二选一,免得中文
/// 用户在一个中文产品里看到一个纯英文托盘。
struct Labels {
    open: &'static str,
    autostart: &'static str,
    quit: &'static str,
}

fn labels() -> Labels {
    let chinese = sys_locale::get_locale()
        .map(|l| l.to_ascii_lowercase().starts_with("zh"))
        .unwrap_or(false);
    if chinese {
        Labels {
            open: "打开 c3",
            autostart: "开机自启",
            quit: "退出",
        }
    } else {
        Labels {
            open: "Open c3",
            autostart: "Start at login",
            quit: "Quit",
        }
    }
}

/// 读取开机自启当前是否启用。插件不可用时按「未启用」处理 —— 显示一个未勾选、
/// 点了会报错的开关,好过让整个托盘构建失败。
fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// 安装托盘图标与菜单。
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let l = labels();
    let open = MenuItem::with_id(app, ID_OPEN, l.open, true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        ID_AUTOSTART,
        l.autostart,
        true,
        autostart_enabled(app),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ID_QUIT, l.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &autostart, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("c3")
        .tooltip("c3")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            ID_OPEN => crate::focus_visible_window(app),
            ID_AUTOSTART => toggle_autostart(app, &autostart),
            ID_QUIT => crate::shutdown_and_exit(app),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// 切换开机自启,并把勾选状态与**实际**注册结果对齐 —— 失败时不能留下一个勾上了
/// 但其实没注册的菜单项。
fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let currently = autostart_enabled(app);
    let result = if currently {
        app.autolaunch().disable()
    } else {
        app.autolaunch().enable()
    };
    if let Err(e) = result {
        eprintln!("[c3-desktop] could not toggle autostart: {e}");
    }
    // 重新读取真实状态,而不是假定切换成功。多次开关因此是幂等的。
    let _ = item.set_checked(autostart_enabled(app));
}
