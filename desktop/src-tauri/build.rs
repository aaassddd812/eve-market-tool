fn main() {
    // 网页（远程站点）能调用的自定义命令：列在这里才会生成 allow-* 权限，再在 capabilities/default.json 里放行
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["float_open", "float_pass", "float_drag", "float_close", "float_focus_main", "local_grab", "local_windows", "update_check"]),
    ))
    .expect("tauri build");
}
