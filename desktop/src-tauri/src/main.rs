// Release 构建下不带控制台窗口(Windows 上否则每次启动都会弹一个黑框)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    c3_desktop_lib::run()
}
