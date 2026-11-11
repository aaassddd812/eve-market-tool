// Windows 正式版不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    eve_lite_lib::run()
}
