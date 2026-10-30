// 桌面版入口；安卓版从 lib.rs 的 run() 启动
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eve_tool_lib::run()
}
