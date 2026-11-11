// 剪贴板（深渊货柜：玩家在游戏里全选货柜按 Ctrl+C，程序自动记入）
//   clip_seq   Windows 剪贴板序号（GetClipboardSequenceNumber）：每次复制都会加一，和窗口焦点、窗口消息无关，
//              游戏全屏时也可靠；界面每 750 毫秒问一次，没变就什么都不做
//   clip_text  读剪贴板文本（CF_UNICODETEXT）；剪贴板正被别的程序占着（游戏刚复制大清单时）返回 null，由界面稍后重试。
//              只读，不清空、不改写剪贴板；超过 100KB 的文本不返回（游戏复制的物品清单远小于这个）
#[cfg(windows)]
#[tauri::command]
pub fn clip_seq() -> u32 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(windows)]
#[tauri::command]
pub fn clip_text() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    const MAX_UNITS: usize = 100 * 1024;
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
            return Some(String::new());
        }
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let mut out = None;
        let h = GetClipboardData(CF_UNICODETEXT);
        if !h.is_null() {
            let p = GlobalLock(h) as *const u16;
            if !p.is_null() {
                let cap = GlobalSize(h) / 2;
                let mut len = 0;
                while len < cap && len <= MAX_UNITS && *p.add(len) != 0 {
                    len += 1;
                }
                out = Some(if len > MAX_UNITS { String::new() } else { String::from_utf16_lossy(std::slice::from_raw_parts(p, len)) });
                GlobalUnlock(h);
            }
        }
        CloseClipboard();
        out
    }
}

// 其他系统（开发时）：没有剪贴板监控
#[cfg(not(windows))]
#[tauri::command]
pub fn clip_seq() -> u32 {
    0
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clip_text() -> Option<String> {
    Some(String::new())
}
