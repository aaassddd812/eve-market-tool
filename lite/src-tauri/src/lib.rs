// EVE 收益助手：界面（../ui）打包在程序里，不打开网站。
//   ESI：角色概览与技能、钱包与刷怪收益、资产与订单（令牌只存在本机）
//   深渊收益：ESI 位置 + 聊天日志本地频道识别每一趟进出深渊，读游戏日志补战斗记录，货柜清单（粘贴或剪贴板自动记入，clip.rs）按本站价格估值
//   实时收益：增量扫描游戏日志里的赏金挂账与采矿产出（logs.rs，只读）
// 网络请求走 tauri-plugin-http（地址白名单见 capabilities/default.json），本站只提供价格与物品名称。
mod clip;
mod logs;

pub fn run() {
    tauri::Builder::default()
        // 再次双击图标时切回已打开的窗口，不开第二个
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![logs::logs_dir, logs::logs_list, logs::logs_stat, logs::logs_read, clip::clip_seq, clip::clip_text])
        .run(tauri::generate_context!())
        .expect("启动失败");
}
