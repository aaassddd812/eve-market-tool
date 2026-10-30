// EVE 辅助工具桌面版：一个窗口直接打开线上网站（永远是最新版），
// 页面加载前注入 desktop-init.js：标记桌面版（网页据此把菜单栏放到左侧），外部链接交给系统浏览器打开。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const SITE: &str = "https://eve.navexor.top/";

fn main() {
    let init = include_str!("desktop-init.js").replace("__VERSION__", env!("CARGO_PKG_VERSION"));
    tauri::Builder::default()
        // 再次双击图标时切回已打开的窗口，不开第二个
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // 记住窗口大小、位置与最大化状态
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(SITE.parse().unwrap()))
                .title("EVE 辅助工具")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .initialization_script(&init)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
