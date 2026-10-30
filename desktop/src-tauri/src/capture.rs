// ---------- 本地红名：截 EVE 窗口的画面 ----------
// 网页版用浏览器的共享屏幕（getDisplayMedia），WebView2 里会走 Windows Graphics Capture，系统强制在被截的窗口外画一圈黄色边框；
// 桌面版改由这里直接截：找到标题以「EVE」开头的游戏窗口，PrintWindow（PW_RENDERFULLCONTENT）把客户区画进内存，
// 再按网页要的矩形（客户区坐标）裁下来返回。被别的窗口挡住也能截（最小化时截不到）。
// 返回二进制：前 8 字节是宽、高（u32 小端），后面是 RGBA 像素。网页每 0.1 秒调一次（local-watch.js 的 grab 模式）。

#[derive(serde::Deserialize)]
pub struct GrabRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[tauri::command]
pub async fn local_grab(rect: Option<GrabRect>) -> Result<tauri::ipc::Response, String> {
    let r = rect.map(|r| (r.x, r.y, r.w, r.h));
    tauri::async_runtime::spawn_blocking(move || grab(r))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

#[cfg(not(windows))]
fn grab(_rect: Option<(i32, i32, i32, i32)>) -> Result<Vec<u8>, String> {
    Err("unsupported".into())
}

#[cfg(windows)]
fn grab(rect: Option<(i32, i32, i32, i32)>) -> Result<Vec<u8>, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

    const PW_CLIENTONLY: PRINT_WINDOW_FLAGS = 1;
    const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = 2;

    let hwnd = find_eve().ok_or("no-eve")? as HWND;
    unsafe {
        let mut cr: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut cr) == 0 {
            return Err("no-eve".into());
        }
        let (cw, ch) = (cr.right - cr.left, cr.bottom - cr.top);
        if cw <= 0 || ch <= 0 {
            return Err("minimized".into());
        }
        let (x, y, w, h) = match rect {
            Some((x, y, w, h)) => {
                let x0 = x.clamp(0, cw);
                let y0 = y.clamp(0, ch);
                (x0, y0, (x + w).clamp(0, cw) - x0, (y + h).clamp(0, ch) - y0)
            }
            None => (0, 0, cw, ch),
        };
        if w <= 0 || h <= 0 {
            return Err("empty".into());
        }
        let screen = GetDC(null_mut());
        let big_dc = CreateCompatibleDC(screen);
        let big = CreateCompatibleBitmap(screen, cw, ch);
        let old_big = SelectObject(big_dc, big as HGDIOBJ);
        let ok = PrintWindow(hwnd, big_dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT) != 0;
        // 裁出要的矩形
        let small_dc = CreateCompatibleDC(screen);
        let small = CreateCompatibleBitmap(screen, w, h);
        let old_small = SelectObject(small_dc, small as HGDIOBJ);
        BitBlt(small_dc, 0, 0, w, h, big_dc, x, y, SRCCOPY);
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // 从上到下
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;
        let n = (w * h * 4) as usize;
        let mut out = vec![0u8; 8 + n];
        out[0..4].copy_from_slice(&(w as u32).to_le_bytes());
        out[4..8].copy_from_slice(&(h as u32).to_le_bytes());
        let lines = GetDIBits(small_dc, small, 0, h as u32, out[8..].as_mut_ptr().cast(), &mut bi, DIB_RGB_COLORS);
        SelectObject(small_dc, old_small);
        SelectObject(big_dc, old_big);
        DeleteObject(small as HGDIOBJ);
        DeleteObject(big as HGDIOBJ);
        DeleteDC(small_dc);
        DeleteDC(big_dc);
        ReleaseDC(null_mut(), screen);
        if !ok || lines == 0 {
            return Err("capture".into());
        }
        // BGRA → RGBA
        for px in out[8..].chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        Ok(out)
    }
}

// 游戏窗口：可见、没最小化、标题是「EVE」或「EVE - 角色名」；多开时先沿用上次的，再优先当前在前台的，否则取最大的
#[cfg(windows)]
fn find_eve() -> Option<isize> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> i32 {
        let list = &mut *(lp as *mut Vec<isize>);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }
        let mut buf = [0u16; 128];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 {
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            if title == "EVE" || title.starts_with("EVE - ") {
                list.push(hwnd as isize);
            }
        }
        1
    }
    let mut list: Vec<isize> = Vec::new();
    unsafe {
        EnumWindows(Some(each), &mut list as *mut Vec<isize> as LPARAM);
        // 上次截的那个还在就接着用（多开时切换前台不会跳到别的客户端）
        let last = LAST.load(Ordering::Relaxed);
        if list.contains(&last) {
            return Some(last);
        }
        let fg = GetForegroundWindow() as isize;
        let pick = if list.contains(&fg) {
            Some(fg)
        } else {
            list.into_iter().max_by_key(|&h| {
                let mut r: RECT = std::mem::zeroed();
                GetClientRect(h as HWND, &mut r);
                (r.right - r.left) as i64 * (r.bottom - r.top) as i64
            })
        };
        if let Some(h) = pick {
            LAST.store(h, Ordering::Relaxed);
        }
        pick
    }
}
#[cfg(windows)]
static LAST: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
#[cfg(windows)]
use std::sync::atomic::Ordering;
