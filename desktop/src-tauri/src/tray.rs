// 托盘与关闭按钮：点主窗口的 ✕ 时先问「最小化到托盘」还是「退出程序」（本地页面 dist/close.html，开在主窗口上面的小窗口 close-ask），
// 勾了「记住我的选择」就写到配置文件夹的 close-action（ask / tray / exit），以后不再问；托盘右键菜单「点关闭按钮时」可以随时改回来。
// 最小化到托盘只是把主窗口藏起来：网页照常运行，击杀预警、到价提醒、本地红名和悬浮窗都不受影响；单击托盘图标或再双击桌面图标就切回来。
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const ACTIONS: [(&str, &str); 3] = [("ask", "每次询问"), ("tray", "最小化到托盘"), ("exit", "直接退出")];
static TOLD: AtomicBool = AtomicBool::new(false);   // 本次运行是否已经提示过「还在托盘里」

struct Checks(Vec<CheckMenuItem<tauri::Wry>>);

fn pref_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("close-action"))
}
fn read_pref(app: &AppHandle) -> &'static str {
    let saved = pref_path(app).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    ACTIONS.iter().map(|(k, _)| *k).find(|k| *k == saved.trim()).unwrap_or("ask")
}
fn write_pref(app: &AppHandle, action: &str) {
    if let Some(p) = pref_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, action);
    }
    sync_checks(app, action);
}
// 菜单里三项当单选用：点了哪项只勾哪项（Windows 点勾选项会自己切换，这里统一改回来）
fn sync_checks(app: &AppHandle, action: &str) {
    if let Some(c) = app.try_state::<Checks>() {
        for (item, (k, _)) in c.0.iter().zip(ACTIONS) {
            let _ = item.set_checked(k == action);
        }
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    if !TOLD.swap(true, Ordering::SeqCst) {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("EVE 辅助工具").body("已最小化到托盘，预警照常运行；单击托盘图标打开").show();
    }
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let h = app.handle();
    let cur = read_pref(h);
    let checks = ACTIONS
        .iter()
        .map(|(k, label)| CheckMenuItem::with_id(h, format!("close:{k}"), *label, true, *k == cur, None::<&str>))
        .collect::<tauri::Result<Vec<_>>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = checks.iter().map(|c| c as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let close_menu = Submenu::with_items(h, "点关闭按钮时", true, &refs)?;
    let menu = Menu::with_items(h, &[
        &MenuItem::with_id(h, "show", "打开主窗口", true, None::<&str>)?,
        &PredefinedMenuItem::separator(h)?,
        &close_menu,
        &PredefinedMenuItem::separator(h)?,
        &MenuItem::with_id(h, "quit", "退出", true, None::<&str>)?,
    ])?;
    app.manage(Checks(checks));
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("EVE 辅助工具")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            id => {
                if let Some(k) = id.strip_prefix("close:") {
                    write_pref(app, k);
                }
            }
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

// 主窗口的关闭请求：按设置藏到托盘、直接退出，或先弹窗问
pub fn on_close(w: &tauri::Window, api: &tauri::CloseRequestApi) {
    let app = w.app_handle().clone();
    if app.tray_by_id("main").is_none() {
        return;   // 没有托盘图标：藏起来就找不回来了，直接退出
    }
    match read_pref(&app) {
        "exit" => {}
        "tray" => {
            api.prevent_close();
            hide_main(&app);
        }
        _ => {
            api.prevent_close();
            // 窗口建在异步任务里：Windows 上在主线程的事件回调里建窗口会卡住
            tauri::async_runtime::spawn(async move {
                if let Some(w) = app.get_webview_window("close-ask") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    return;
                }
                let Some(main) = app.get_webview_window("main") else { return };
                let b = WebviewWindowBuilder::new(&app, "close-ask", WebviewUrl::App("close.html".into()))
                    .title("关闭 EVE 辅助工具")
                    .inner_size(380.0, 190.0)
                    .resizable(false)
                    .minimizable(false)
                    .maximizable(false)
                    .skip_taskbar(true)
                    .always_on_top(true)
                    .center();
                let b = crate::browser_args(b);
                let b = match b.parent(&main) {
                    Ok(b) => b,
                    Err(_) => return,
                };
                let _ = b.build();
            });
        }
    }
}

// 询问窗口的两个按钮：tray / exit；remember 勾上就记住，以后不再问
#[tauri::command]
pub async fn close_choice(app: AppHandle, window: tauri::WebviewWindow, action: String, remember: bool) -> Result<(), String> {
    if window.label() != "close-ask" || !matches!(action.as_str(), "tray" | "exit") {
        return Err("action".into());
    }
    if remember {
        write_pref(&app, &action);
    }
    let _ = window.destroy();
    if action == "exit" {
        app.exit(0);
    } else {
        hide_main(&app);
    }
    Ok(())
}
