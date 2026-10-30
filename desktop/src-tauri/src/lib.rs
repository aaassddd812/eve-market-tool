// EVE 辅助工具桌面版 / 安卓版：一个窗口直接打开线上网站（永远是最新版），
// 页面加载前注入 app-init.js：标记运行环境（桌面版网页把菜单栏放到左侧；安卓版用手机布局），外部链接交给系统浏览器打开。
use tauri::{WebviewUrl, WebviewWindowBuilder};

const SITE: &str = "https://eve.navexor.top/";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let flag = if cfg!(desktop) { "__EVE_DESKTOP__" } else { "__EVE_APP__" };
    let init = include_str!("app-init.js")
        .replace("__FLAG__", flag)
        .replace("__VERSION__", env!("CARGO_PKG_VERSION"));
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder
        // 再次双击图标时切回已打开的窗口，不开第二个
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // 记住窗口大小、位置与最大化状态
        .plugin(tauri_plugin_window_state::Builder::default().build());
    builder
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(SITE.parse().unwrap()))
                .initialization_script(&init);
            #[cfg(desktop)]
            let win = win
                .title("EVE 辅助工具")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .center();
            win.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}
