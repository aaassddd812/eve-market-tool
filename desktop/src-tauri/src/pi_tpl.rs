// 行星殖民地模板（网页 pi-editor.js / pi-planner.js 的「存到游戏」）：直接写进游戏读模板的文件夹「文档\EVE\PlanetaryInteractionTemplates」，
// 游戏里行星界面的模板列表就能选到，不用再复制粘贴。只往这个文件夹写 .json，文件名由模板名清理得到（同名覆盖）。
use std::path::PathBuf;

const MAX_TEXT: usize = 256 << 10;

// 已有 EVE 文件夹（玩过游戏就有 logs 等）的那个「文档」优先，都没有就用系统的文档文件夹
fn tpl_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let docs = crate::logs::doc_dirs(app);
    let root = docs.iter().find(|d| d.join("EVE").is_dir()).or(docs.first()).ok_or("没有找到文档文件夹")?;
    Ok(root.join("EVE").join("PlanetaryInteractionTemplates"))
}

// 模板名 → 文件名：去掉 Windows 不允许的字符和首尾的点、空格，最长 60 个字
fn file_name(name: &str) -> String {
    let s: String = name.chars().filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c)).take(60).collect();
    let s = s.trim().trim_matches('.').trim();
    if s.is_empty() { "template".into() } else { s.to_string() }
}

// 返回写入的完整路径
#[tauri::command]
pub async fn pi_tpl_save(app: tauri::AppHandle, name: String, text: String) -> Result<String, String> {
    if text.len() > MAX_TEXT {
        return Err("模板太大".into());
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|_| "不是有效的模板".to_string())?;
    if !v.get("P").is_some_and(|p| p.is_array()) {
        return Err("不是有效的模板".into());
    }
    let dir = tpl_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", file_name(&name)));
    std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
