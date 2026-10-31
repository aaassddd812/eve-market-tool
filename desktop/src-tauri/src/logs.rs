// 日志预警（网页 intel.js）在桌面版自动找 EVE 日志文件夹，不用用户在浏览器里选文件夹、每次打开还要重新授权：
//   logs_dir   找「文档\EVE\logs」（系统的文档文件夹，含被 OneDrive 重定向的；再试几个常见位置），返回路径，找不到返回 null
//   logs_list  列出 Chatlogs / Gamelogs 里最近 8 天改过的 .txt：[[文件名, 大小], …]
//   logs_stat  一个文件当前的大小
//   logs_read  从偏移量读一段（原始字节，网页按 BOM 自己解码）
// 只读、只认这两个子文件夹里的 .txt 文件名（不能带路径），网页拿不到别的文件。
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const SUBS: [&str; 2] = ["Chatlogs", "Gamelogs"];
const MAX_READ: u64 = 4 << 20;

fn find_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let mut cands = Vec::new();
    if let Ok(d) = app.path().document_dir() {
        cands.push(d);
    }
    if let Ok(h) = app.path().home_dir() {
        for d in ["Documents", "OneDrive/Documents", "OneDrive/文档", "文档"] {
            cands.push(h.join(d));
        }
    }
    cands
        .into_iter()
        .map(|d| d.join("EVE").join("logs"))
        .find(|d| SUBS.iter().any(|s| d.join(s).is_dir()))
}

fn sub_dir(app: &tauri::AppHandle, sub: &str) -> Result<PathBuf, String> {
    if !SUBS.contains(&sub) {
        return Err("sub".into());
    }
    find_dir(app).map(|d| d.join(sub)).ok_or_else(|| "没有找到 EVE 日志文件夹".into())
}

fn file_path(app: &tauri::AppHandle, sub: &str, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.contains("..") || !name.to_ascii_lowercase().ends_with(".txt") {
        return Err("name".into());
    }
    Ok(sub_dir(app, sub)?.join(name))
}

#[tauri::command]
pub fn logs_dir(app: tauri::AppHandle) -> Option<String> {
    find_dir(&app).map(|d| d.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn logs_list(app: tauri::AppHandle, sub: String) -> Result<Vec<(String, u64)>, String> {
    let dir = sub_dir(&app, &sub)?;
    let since = SystemTime::now() - Duration::from_secs(8 * 86400);
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() || meta.modified().map(|t| t < since).unwrap_or(false) {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.to_ascii_lowercase().ends_with(".txt") {
            out.push((name, meta.len()));
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn logs_stat(app: tauri::AppHandle, sub: String, name: String) -> Result<u64, String> {
    std::fs::metadata(file_path(&app, &sub, &name)?).map(|m| m.len()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn logs_read(app: tauri::AppHandle, sub: String, name: String, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file_path(&app, &sub, &name)?).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(len.min(MAX_READ)).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}
