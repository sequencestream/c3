// Release 构建下不带控制台窗口(Windows 上否则每次启动都会弹一个黑框)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 独立更新助手模式:同一可执行文件以 `--update-assistant` 启动,不初始化
    // WebView/窗口,只做「等壳退出 → 校验暂存包 → 平台安装 → 启动新 App」。
    if std::env::args().any(|a| a == c3_desktop_lib::install::ASSISTANT_ARG) {
        std::process::exit(c3_desktop_lib::install::update_assistant_main());
    }
    c3_desktop_lib::run()
}
