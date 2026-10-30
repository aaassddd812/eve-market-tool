// ---------- 本地红名：截 EVE 窗口的画面 ----------
// 网页版用浏览器的共享屏幕（getDisplayMedia），WebView2 里会走 Windows Graphics Capture，系统强制在被截的窗口外画一圈黄色边框；
// 桌面版改由这里直接截：找到标题以「EVE」开头的游戏窗口，按网页要的矩形（客户区坐标）截下来返回。
// 列表那块露在屏幕上时直接从屏幕拷这一小块（开销最小）；被别的窗口挡住时用 PrintWindow（PW_RENDERFULLCONTENT）把整个客户区画进内存再裁，
// 所以被挡住也能截（最小化时截不到）。
// 返回二进制：前 8 字节是宽、高（u32 小端），后面是 RGBA 像素。网页每 0.1 秒调一次（local-watch.js 的 grab 模式）。
// 多开时由用户选窗口：local_windows 列出所有 EVE 窗口（网页再用 local_grab 的 thumb 取缩略图给用户看），选中后每次截图都带上 hwnd。

#[derive(serde::Deserialize)]
pub struct GrabRect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[derive(serde::Serialize)]
pub struct EveWindow {
    id: i64,
    title: String,
    w: i32,
    h: i32,
    minimized: bool,
}

// 所有 EVE 窗口（含最小化的，标出来）
#[tauri::command]
pub async fn local_windows() -> Result<Vec<EveWindow>, String> {
    tauri::async_runtime::spawn_blocking(windows).await.map_err(|e| e.to_string())
}

// hwnd：用户选的窗口（不填自动找）；thumb：rect 为空时把整个画面缩到这个宽度（选窗口时的缩略图）；
// front：PrintWindow 截不到、EVE 又被挡住时，把 EVE 临时提到最上面截一张再放回去（手动框选要整个画面时用）
#[tauri::command]
pub async fn local_grab(rect: Option<GrabRect>, hwnd: Option<i64>, thumb: Option<i32>, front: Option<bool>) -> Result<tauri::ipc::Response, String> {
    let r = rect.map(|r| (r.x, r.y, r.w, r.h));
    let front = front.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || grab(r, hwnd, thumb, front))
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

#[cfg(not(windows))]
fn windows() -> Vec<EveWindow> {
    Vec::new()
}

#[cfg(not(windows))]
fn grab(_rect: Option<(i32, i32, i32, i32)>, _hwnd: Option<i64>, _thumb: Option<i32>, _front: bool) -> Result<Vec<u8>, String> {
    Err("unsupported".into())
}

#[cfg(windows)]
fn windows() -> Vec<EveWindow> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, IsIconic};
    enum_eve(true)
        .into_iter()
        .map(|(h, title)| unsafe {
            let mut r: RECT = std::mem::zeroed();
            GetClientRect(h as HWND, &mut r);
            EveWindow { id: h as i64, title, w: r.right - r.left, h: r.bottom - r.top, minimized: IsIconic(h as HWND) != 0 }
        })
        .collect()
}

#[cfg(windows)]
fn grab(rect: Option<(i32, i32, i32, i32)>, want: Option<i64>, thumb: Option<i32>, front: bool) -> Result<Vec<u8>, String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

    const PW_CLIENTONLY: PRINT_WINDOW_FLAGS = 1;
    const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = 2;

    let hwnd = match want {
        // 选的窗口关掉了（或换成了别的窗口）
        Some(h) => enum_eve(true).into_iter().find(|&(x, _)| x as i64 == h).ok_or("gone")?.0 as HWND,
        None => find_eve().ok_or("no-eve")? as HWND,
    };
    unsafe {
        if windows_sys::Win32::UI::WindowsAndMessaging::IsIconic(hwnd) != 0 {
            return Err("minimized".into());
        }
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
        let mut pt = POINT { x: 0, y: 0 };
        ClientToScreen(hwnd, &mut pt);
        let small_dc = CreateCompatibleDC(screen);
        let small = CreateCompatibleBitmap(screen, w, h);
        let old_small = SelectObject(small_dc, small as HGDIOBJ);
        // 只要列表那一块、且这块在屏幕上没被别的窗口挡住：直接从屏幕上拷这一小块，最省（每次零点几毫秒）
        let mut ok = rect.is_some()
            && uncovered(hwnd, pt.x + x, pt.y + y, w, h)
            && BitBlt(small_dc, 0, 0, w, h, screen, pt.x + x, pt.y + y, SRCCOPY) != 0
            && !black(small_dc, 0, 0, w, h);
        let mut covered = false;
        if !ok {
            // 被挡住了（或要整个画面）：PrintWindow 把整个客户区画进内存再裁
            let big_dc = CreateCompatibleDC(screen);
            let big = CreateCompatibleBitmap(screen, cw, ch);
            let old_big = SelectObject(big_dc, big as HGDIOBJ);
            ok = PrintWindow(hwnd, big_dc, PW_CLIENTONLY | PW_RENDERFULLCONTENT) != 0 && !black(big_dc, x, y, w, h);
            if ok {
                ok = BitBlt(small_dc, 0, 0, w, h, big_dc, x, y, SRCCOPY) != 0;
            } else if uncovered(hwnd, pt.x + x, pt.y + y, w, h) {
                // 有的显卡驱动 / 游戏设置下 PrintWindow 截出来是全黑：这块露在屏幕上就从屏幕上拷
                ok = BitBlt(small_dc, 0, 0, w, h, screen, pt.x + x, pt.y + y, SRCCOPY) != 0;
            } else if front {
                // 被挡住（比如手动框选时本程序盖在 EVE 上面）：把 EVE 临时置顶（不抢焦点）截一张，再放回去
                use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetWindowPos, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
                let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
                let prev = GetForegroundWindow();
                SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
                std::thread::sleep(std::time::Duration::from_millis(300));
                ok = BitBlt(small_dc, 0, 0, w, h, screen, pt.x + x, pt.y + y, SRCCOPY) != 0;
                SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
                if !prev.is_null() && prev != hwnd {
                    SetWindowPos(prev, HWND_TOP, 0, 0, 0, 0, flags);
                }
            } else {
                // 截不到也不能从屏幕拷（拷到的是挡在前面的东西）
                covered = true;
            }
            SelectObject(big_dc, old_big);
            DeleteObject(big as HGDIOBJ);
            DeleteDC(big_dc);
        }
        // 缩略图：整个画面缩小（选窗口时给用户看）
        let (mut small_dc, mut small, mut old_small, mut w, mut h) = (small_dc, small, old_small, w, h);
        if let (Some(tw), None) = (thumb, rect) {
            let tw = tw.clamp(16, w);
            let th = (h * tw / w).max(1);
            let t_dc = CreateCompatibleDC(screen);
            let t_bmp = CreateCompatibleBitmap(screen, tw, th);
            let old_t = SelectObject(t_dc, t_bmp as HGDIOBJ);
            SetStretchBltMode(t_dc, HALFTONE);
            StretchBlt(t_dc, 0, 0, tw, th, small_dc, 0, 0, w, h, SRCCOPY);
            SelectObject(small_dc, old_small);
            DeleteObject(small as HGDIOBJ);
            DeleteDC(small_dc);
            (small_dc, small, old_small, w, h) = (t_dc, t_bmp, old_t, tw, th);
        }
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
        DeleteObject(small as HGDIOBJ);
        DeleteDC(small_dc);
        ReleaseDC(null_mut(), screen);
        if covered {
            return Err("covered".into());
        }
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

// 屏幕上这块矩形（屏幕坐标）是不是都露在外面：抽四角和中间等 9 个点，看最上层的窗口是不是 EVE
#[cfg(windows)]
unsafe fn uncovered(hwnd: windows_sys::Win32::Foundation::HWND, x: i32, y: i32, w: i32, h: i32) -> bool {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
    for i in 0..3 {
        for j in 0..3 {
            let p = POINT { x: x + (w - 1) * i / 2, y: y + (h - 1) * j / 2 };
            let top = WindowFromPoint(p);
            if top.is_null() || GetAncestor(top, GA_ROOT) != hwnd {
                return false;
            }
        }
    }
    true
}

// 抽几个点看是不是全黑（PrintWindow 截不到 DirectX 画面时就是全黑）
#[cfg(windows)]
unsafe fn black(dc: windows_sys::Win32::Graphics::Gdi::HDC, x: i32, y: i32, w: i32, h: i32) -> bool {
    use windows_sys::Win32::Graphics::Gdi::GetPixel;
    for i in 0..8 {
        for j in 0..8 {
            let c = GetPixel(dc, x + w * (2 * i + 1) / 16, y + h * (2 * j + 1) / 16);
            if c != 0 && c != 0xFFFF_FFFF {
                return false;
            }
        }
    }
    true
}

// 游戏窗口：可见、标题是「EVE」或「EVE - 角色名」（minimized 为 false 时不要最小化的）
#[cfg(windows)]
fn enum_eve(minimized: bool) -> Vec<(isize, String)> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> i32 {
        let (list, minimized) = &mut *(lp as *mut (Vec<(isize, String)>, bool));
        if IsWindowVisible(hwnd) == 0 || (!*minimized && IsIconic(hwnd) != 0) {
            return 1;
        }
        let mut buf = [0u16; 128];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n > 0 {
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            if title == "EVE" || title.starts_with("EVE - ") {
                list.push((hwnd as isize, title));
            }
        }
        1
    }
    let mut st: (Vec<(isize, String)>, bool) = (Vec::new(), minimized);
    unsafe {
        EnumWindows(Some(each), &mut st as *mut (Vec<(isize, String)>, bool) as LPARAM);
    }
    st.0
}

// 没选窗口时（旧网页）自动找：多开时先沿用上次的，再优先当前在前台的，否则取最大的
#[cfg(windows)]
fn find_eve() -> Option<isize> {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    let list: Vec<isize> = enum_eve(false).into_iter().map(|(h, _)| h).collect();
    unsafe {
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
