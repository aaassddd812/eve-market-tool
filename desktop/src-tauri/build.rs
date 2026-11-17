fn main() {
    // 网页（远程站点）能调用的自定义命令：列在这里才会生成 allow-* 权限，再在 capabilities/default.json 里放行
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["float_open", "float_pass", "float_drag", "float_close", "float_focus_main", "float_detail", "local_grab", "local_windows", "update_check", "logs_dir", "logs_list", "logs_stat", "logs_read", "pi_tpl_save", "close_choice", "native_status", "native_install", "native_uninstall", "native_start", "native_send", "native_poll", "native_stop"]),
    ))
    .expect("tauri build");
}
