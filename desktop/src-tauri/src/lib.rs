// EVE 辅助工具桌面版 / 安卓版：一个窗口直接打开线上网站（永远是最新版），
// 页面加载前注入 app-init.js：标记运行环境（桌面版网页把菜单栏放到左侧；安卓版用手机布局），外部链接交给系统浏览器打开。
// 桌面版另有悬浮窗（float_* 命令）：网页里点「悬浮窗」开一个置顶、无边框、半透明的小窗口，加载本站 float.html，
// 内容（击杀预警、到价提醒、本地红名）由主窗口的网页经 BroadcastChannel 推过去。
// 本地红名在桌面版由 local_grab 直接截 EVE 窗口（capture.rs），不走浏览器共享屏幕（那样 Windows 会给游戏窗口加一圈黄框）。
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(desktop)]
mod capture;

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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 自动更新：启动时查 GitHub 发布仓库的 latest.json，有新版就弹窗询问
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![float_open, float_pass, float_drag, float_close, float_focus_main, update_check, capture::local_grab, capture::local_windows])
        // 关掉主窗口就退出（悬浮窗不单独留着）
        .on_window_event(|w, e| {
            if w.label() == "main" && matches!(e, tauri::WindowEvent::Destroyed) {
                tauri::Manager::app_handle(w).exit(0);
            }
        });
    builder
        .plugin(tauri_plugin_opener::init())
        // 网页的 Notification（击杀预警、压价、到价提醒）改走系统通知：插件会替换页面里的 window.Notification
        .plugin(tauri_plugin_notification::init())
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
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = update_check(handle).await;
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动失败");
}

// ---------- 悬浮窗 ----------
// 和网页版画中画一样只有一个悬浮窗（标签 float），顶部切换击杀预警 / 到价提醒 / 本地红名；位置、大小由 window-state 插件记住。
// 已经开着就切到要的内容、恢复可点击并切到前面（鼠标穿透后从主窗口再点一次「悬浮窗」就能解开）。
// 窗口建在异步命令里：Windows 上同步命令里建窗口会卡死。
#[cfg(desktop)]
#[tauri::command]
async fn float_open(app: tauri::AppHandle, webview: tauri::Webview, kind: String, title: String) -> Result<(), String> {
    use tauri::Manager;
    let kind: String = kind.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    if kind.is_empty() {
        return Err("kind".into());
    }
    let label = "float";
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.eval(format!("window.__floatPass && window.__floatPass(false); window.__floatKind && window.__floatKind('{kind}')"));
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    // 跟主窗口同一个站点
    let mut url = webview.url().map_err(|e| e.to_string())?;
    url.set_path("/float.html");
    url.set_query(Some(&format!("kind={kind}")));
    url.set_fragment(None);
    let title: String = title.chars().take(40).collect();
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(title)
        .inner_size(340.0, 420.0)
        .min_inner_size(220.0, 140.0)
        .decorations(false)
        // Windows 上无边框窗口默认带阴影，会多出一圈 1px 的直角边框，盖住网页里的圆角
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// 下面几个只对悬浮窗自己生效
#[cfg(desktop)]
fn is_float(w: &tauri::WebviewWindow) -> bool {
    w.label() == "float" || w.label().starts_with("float-")
}

// 鼠标穿透：点击直接落到下面的游戏上
#[cfg(desktop)]
#[tauri::command]
fn float_pass(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    if !is_float(&window) {
        return Ok(());
    }
    window.set_ignore_cursor_events(on).map_err(|e| e.to_string())
}

// 无边框窗口：按住标题栏拖动
#[cfg(desktop)]
#[tauri::command]
fn float_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    if !is_float(&window) {
        return Ok(());
    }
    window.start_dragging().map_err(|e| e.to_string())
}

// 直接销毁（不走关闭请求），异步命令里做，避免 Windows 上在主线程里关窗口没反应
#[cfg(desktop)]
#[tauri::command]
async fn float_close(window: tauri::WebviewWindow) -> Result<(), String> {
    if !is_float(&window) {
        return Ok(());
    }
    window.destroy().map_err(|e| e.to_string())
}

// 悬浮窗里点了击杀 / 物品：主窗口打开详情，切到前面
#[cfg(desktop)]
#[tauri::command]
fn float_focus_main(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// 查更新：启动时自动查一次，失败（断网、GitHub 访问不了）就静默跳过，不打扰用户；
// 网页左侧菜单底部的「检查更新」调 update_check 手动查，结果返回给网页提示（latest 已是最新 / later 用户选了以后再说 / busy 正在查）。
// 有新版时弹窗询问，用户点「现在更新」后下载安装包，Windows 上安装器会自动关闭本程序、装完再启动新版。
#[cfg(desktop)]
static CHECKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(desktop)]
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<String, String> {
    use std::sync::atomic::Ordering;
    if CHECKING.swap(true, Ordering::SeqCst) {
        return Ok("busy".into());
    }
    let r = check_update(app).await;
    CHECKING.store(false, Ordering::SeqCst);
    r.map(String::from)
}

#[cfg(desktop)]
async fn check_update(app: tauri::AppHandle) -> Result<&'static str, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;
    let update = match app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? {
        Some(update) => update,
        None => return Ok("latest"),
    };
    let mut msg = format!("发现新版本 {}（当前 {}），现在更新吗？", update.version, update.current_version);
    if let Some(notes) = update.body.as_deref().filter(|n| !n.trim().is_empty()) {
        msg.push_str("\n\n");
        msg.push_str(notes.trim());
    }
    let yes = app
        .dialog()
        .message(msg)
        .title("EVE 辅助工具 · 更新")
        .buttons(MessageDialogButtons::OkCancelCustom("现在更新".into(), "以后再说".into()))
        .blocking_show();
    if !yes {
        return Ok("later");
    }
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        app.dialog()
            .message(format!("更新失败：{e}\n可以到网站重新下载安装。"))
            .kind(MessageDialogKind::Error)
            .title("EVE 辅助工具 · 更新")
            .blocking_show();
        return Ok("failed");
    }
    app.restart();
}
