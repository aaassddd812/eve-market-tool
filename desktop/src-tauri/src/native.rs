// 原生引擎（CCP 开源引擎 trinity，MIT）：可选下载的组件，战场 / 驾驶模拟可以改用它渲染。
// 网页还是模拟的“大脑”，每帧把船位、朝向、相机经 native_send 发过来；这里转给原生进程（host/bridge.py，只听 127.0.0.1，带口令），
// 原生进程开一个自己的窗口画出来，状态（组好几艘船、模型转换进度、帧率）经 native_poll 带回网页。
// 组件包从发布仓库的 Release「native」下载（eve-native.json 写版本、大小、SHA256；GitHub 连不上走 ghfast 镜像），
// 用系统自带的 curl.exe 下载、tar.exe 解压（Windows 10 1803 起自带），校验 SHA256 后装到本机应用数据目录 native\pkg-<版本>。
// 测试时可用环境变量 EVE_NATIVE_PKG 指定本机现成的组件目录（见 local_pkg），不用发布到公开仓库。
// 清单里的 desktop 是新组件要求的最低桌面版本（启动约定变了时组件那边提高）：本机桌面版太旧就不装，继续用已装的旧组件。
// 组件在 GitHub Actions 里编译打包（eve-market-tool 仓库 native-engine 分支），详见那边的 README。
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const MANIFEST: &str = "https://github.com/aaassddd812/eve-tool-desktop/releases/download/native/eve-native.json";
const MIRRORS: [&str; 2] = ["", "https://ghfast.top/"];

#[derive(Default)]
struct Download {
    stage: String,
    done: u64,
    total: u64,
    error: String,
    active: bool,
}

struct Session {
    child: Child,
    stream: TcpStream,
    inbox: Arc<Mutex<Vec<String>>>,
    hwnd: i64,
    logs: PathBuf,
    killed: bool, // 发不出去（原生进程卡住）被这边结束的
}

static DL: Mutex<Option<Download>> = Mutex::new(None);
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("native");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

// 测试用：环境变量 EVE_NATIVE_PKG 指向一个现成的组件目录（比如 CI 在本机组装的 F:\eve-ci\viewer-latest，和组件包同样的布局），
// 就直接用它，不下载、不查新版本，版本显示为 local
fn local_pkg() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var_os("EVE_NATIVE_PKG")?);
    (p.join("host").join("bridge.py").exists() && find_exe(&p.join("rt").join("bin")).is_some()).then_some(p)
}

fn installed(dir: &Path) -> Option<(String, PathBuf)> {
    if let Some(p) = local_pkg() {
        return Some(("local".into(), p));
    }
    let ver = std::fs::read_to_string(dir.join("current.txt")).ok()?.trim().to_string();
    let pkg = dir.join(format!("pkg-{ver}"));
    // 引擎程序被杀毒软件隔离删掉了也算没装好，下次准备时会重新下载
    (pkg.join("host").join("bridge.py").exists() && find_exe(&pkg.join("rt").join("bin")).is_some()).then_some((ver, pkg))
}

fn find_exe(bin: &Path) -> Option<PathBuf> {
    std::fs::read_dir(bin).ok()?.flatten().map(|e| e.path()).find(|p| {
        let n = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        n.starts_with("exefile") && n.ends_with(".exe")
    })
}

// 版本号比较（1.0.9 < 1.0.18），不认识的段当 0
fn ver_lt(a: &str, b: &str) -> bool {
    let parts = |s: &str| s.trim().split('.').map(|x| x.trim().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

fn safe_ver(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').take(40).collect()
}

fn running() -> bool {
    SESSION.lock().unwrap().as_mut().is_some_and(|s| matches!(s.child.try_wait(), Ok(None)))
}

// 原生进程日志（logs\bridge.txt）的最后几行，出错时带给网页（「提交工单」里附上）
fn log_tail(logs: &Path, lines: usize) -> String {
    let text = std::fs::read(logs.join("bridge.txt")).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let tail = all[all.len().saturating_sub(lines)..].join("\n");
    let start = tail.char_indices().rev().nth(3999).map(|(i, _)| i).unwrap_or(0);
    tail[start..].to_string()
}

// 退出码：Windows 崩溃是 0xC0000005 这类，按十六进制写
fn exit_code(code: Option<i32>) -> String {
    match code {
        Some(c) if c < 0 => format!("0x{:08X}", c as u32),
        Some(c) => c.to_string(),
        None => "?".into(),
    }
}

fn system32(exe: &str) -> PathBuf {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    Path::new(&root).join("System32").join(exe)
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不弹控制台
    }
    cmd
}

fn set_dl(f: impl FnOnce(&mut Download)) {
    let mut g = DL.lock().unwrap();
    f(g.get_or_insert_with(Download::default));
}

// curl.exe 下载到文件，下载过程中按文件大小报进度（total 已知时）
fn curl(url: &str, out: &Path, total: u64) -> Result<(), String> {
    let _ = std::fs::remove_file(out);
    let mut child = hidden(Command::new(system32("curl.exe")).args(["-fsSL", "--retry", "2", "--connect-timeout", "20", "-o"]).arg(out).arg(url))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("curl：{e}"))?;
    loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            return if st.success() { Ok(()) } else { Err(format!("下载失败（curl {}）", st.code().unwrap_or(-1))) };
        }
        if total > 0 {
            let done = std::fs::metadata(out).map(|m| m.len()).unwrap_or(0);
            set_dl(|d| d.done = done.min(total));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn install_blocking(dir: PathBuf, app_ver: String) -> Result<String, String> {
    set_dl(|d| *d = Download { stage: "manifest".into(), active: true, ..Default::default() });
    // 版本清单：先直连 GitHub，再走镜像
    let man_file = dir.join("eve-native.json");
    let mut manifest: Option<(Value, &str)> = None;
    let mut last = String::new();
    for m in MIRRORS {
        match curl(&format!("{m}{MANIFEST}"), &man_file, 0).and_then(|_| std::fs::read_to_string(&man_file).map_err(|e| e.to_string())) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(v) => {
                    manifest = Some((v, m));
                    break;
                }
                Err(e) => last = e.to_string(),
            },
            Err(e) => last = e,
        }
    }
    let (man, mirror) = manifest.ok_or_else(|| format!("读不到原生引擎版本信息：{last}"))?;
    let ver = safe_ver(man["version"].as_str().unwrap_or(""));
    let url = man["url"].as_str().unwrap_or("");
    let size = man["size"].as_u64().unwrap_or(0);
    let want = man["sha256"].as_str().unwrap_or("").to_ascii_lowercase();
    if ver.is_empty() || !url.starts_with("https://github.com/") || size == 0 || want.len() != 64 {
        return Err("原生引擎版本信息不对".into());
    }
    if installed(&dir).is_some_and(|(v, _)| v == ver) {
        return Ok(ver);
    }
    let need = safe_ver(man["desktop"].as_str().unwrap_or(""));
    if !need.is_empty() && ver_lt(&app_ver, &need) {
        return Err(format!("原生引擎新版本需要桌面版 {need} 以上，请先更新桌面版（当前 {app_ver}）"));
    }
    // 下载（先用拿到清单的那条线路，失败再换另一条）
    let zip = dir.join("eve-native.zip.part");
    set_dl(|d| {
        d.stage = "download".into();
        d.total = size;
        d.done = 0;
    });
    let mut ok = Err(String::new());
    for m in std::iter::once(mirror).chain(MIRRORS.into_iter().filter(|x| *x != mirror)) {
        ok = curl(&format!("{m}{url}"), &zip, size);
        if ok.is_ok() {
            break;
        }
    }
    ok?;
    set_dl(|d| d.stage = "verify".into());
    let got_size = std::fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
    if got_size != size || sha256(&zip)? != want {
        let _ = std::fs::remove_file(&zip);
        return Err("下载的文件校验不对，请重试".into());
    }
    // 解压到临时目录再改名，装到一半不会留下坏的组件
    set_dl(|d| d.stage = "extract".into());
    let tmp = dir.join(format!("pkg-{ver}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let st = hidden(Command::new(system32("tar.exe")).arg("-xf").arg(&zip).arg("-C").arg(&tmp))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("tar：{e}"))?;
    if !st.success() || !tmp.join("host").join("bridge.py").exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("解压失败".into());
    }
    // 旧版本（同版本重装也一样，比如引擎程序被杀毒软件删了）的缓存（转好的模型、下载的资源）搬过来，不用重新下载
    if let Ok(cur) = std::fs::read_to_string(dir.join("current.txt")) {
        let _ = std::fs::rename(dir.join(format!("pkg-{}", safe_ver(&cur))).join("cache"), tmp.join("cache"));
    }
    let pkg = dir.join(format!("pkg-{ver}"));
    let _ = std::fs::remove_dir_all(&pkg);
    std::fs::rename(&tmp, &pkg).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("current.txt"), &ver).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&zip);
    // 删掉别的版本
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("pkg-") && name != format!("pkg-{ver}") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(ver)
}

// 状态：装了哪个版本、是否在运行、下载进度
#[tauri::command]
pub fn native_status(app: tauri::AppHandle) -> Result<Value, String> {
    let dir = root(&app)?;
    let running = running();
    let dl = DL.lock().unwrap();
    Ok(json!({
        "supported": cfg!(windows),
        "installed": installed(&dir).map(|(v, _)| v),
        "running": running,
        "download": dl.as_ref().map(|d| json!({ "stage": d.stage, "done": d.done, "total": d.total, "error": d.error, "active": d.active })),
    }))
}

// 下载安装（已是最新就直接返回版本号；原生窗口开着时不换版本，直接返回已装的）；进度用 native_status 查
#[tauri::command]
pub async fn native_install(app: tauri::AppHandle) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("原生引擎只有 Windows 版".into());
    }
    if local_pkg().is_some() {
        return Ok("local".into());
    }
    if DL.lock().unwrap().as_ref().is_some_and(|d| d.active) {
        return Err("busy".into());
    }
    let dir = root(&app)?;
    if running() {
        if let Some((v, _)) = installed(&dir) {
            return Ok(v);
        }
    }
    let app_ver = app.package_info().version.to_string();
    let r = tauri::async_runtime::spawn_blocking(move || install_blocking(dir, app_ver)).await.map_err(|e| e.to_string())?;
    set_dl(|d| {
        d.active = false;
        d.stage = if r.is_ok() { "done".into() } else { "error".into() };
        d.error = r.as_ref().err().cloned().unwrap_or_default();
    });
    r
}

#[tauri::command]
pub async fn native_uninstall(app: tauri::AppHandle) -> Result<(), String> {
    shutdown();
    let dir = root(&app)?;
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

fn token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    (0..4)
        .map(|i| {
            let mut h = RandomState::new().build_hasher();
            h.write_u64(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

fn start_blocking(pkg: PathBuf, rect: Option<[i64; 4]>, scene: Option<String>, gfx: Option<String>) -> Result<Value, String> {
    let rt = pkg.join("rt");
    let bin = rt.join("bin");
    let exe = find_exe(&bin).ok_or("组件里的引擎程序不见了（可能被杀毒软件删了），下次开始时会重新下载")?;
    let logs = pkg.join("logs");
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let info = logs.join("bridge-info.json");
    let _ = std::fs::remove_file(&info);
    let tok = token();
    let path = [bin.clone(), bin.join("python"), rt.join("pylib"), rt.join("lib"), rt.join("DLLs"), pkg.join("host")]
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(";");
    let mut cmd = Command::new(&exe);
    // /nocrashreportupload：引擎默认会把崩溃转储传到 CCP 的崩溃收集服务器，不传
    cmd.args(["/inherit", "/nocrashreportupload", "/buildflavor=internal", "/py"])
        .arg(pkg.join("host").join("bridge.py"))
        .current_dir(&bin)
        .env("PYTHONPATH", path)
        .env("TRINITYPLATFORM", "dx11")
        .env("TRINITYFLAVOR", "internal")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("EVE_BRIDGE_TOKEN", &tok)
        .env("EVE_BRIDGE_INFO", &info)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some([x, y, w, h]) = rect {
        cmd.env("EVE_BRIDGE_RECT", format!("{x},{y},{w},{h}"));
    }
    if let Some(s) = scene.filter(|s| s.starts_with("res:/") && s.len() < 200) {
        cmd.env("EVE_SCENE", s);
    }
    // 画质档位（host/gfx.py）：auto 和客户端一样按显卡型号分档
    if let Some(g) = gfx.filter(|g| ["auto", "high", "medium", "low"].contains(&g.as_str())) {
        cmd.env("EVE_GFX", g);
    }
    let mut child = hidden(&mut cmd)
        .spawn()
        .map_err(|e| format!("启动失败：{e}（可能被杀毒软件拦了，可以把 {} 加到信任列表后重试）", pkg.display()))?;
    // 第一次启动要下载资源索引、转模型，最多等 10 分钟
    let t0 = Instant::now();
    let port = loop {
        if let Ok(text) = std::fs::read_to_string(&info) {
            if let Some(p) = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["port"].as_u64()) {
                break p as u16;
            }
        }
        if let Ok(Some(st)) = child.try_wait() {
            // 「\n---\n」后面是日志最后几行：网页提示里只显示前半，「提交工单」里附上日志
            return Err(format!("原生引擎启动后退出了（退出码 {}）\n---\n{}", exit_code(st.code()), log_tail(&logs, 30)));
        }
        if t0.elapsed() > Duration::from_secs(600) {
            let _ = child.kill();
            return Err(format!("原生引擎 10 分钟没启动起来\n---\n{}", log_tail(&logs, 30)));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let mut stream = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);
    // 原生进程卡住时网页这边不要跟着卡（每帧都会发）
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    stream.write_all(format!("{}\n", json!({ "t": "hello", "token": tok })).as_bytes()).map_err(|e| e.to_string())?;
    let inbox = Arc::new(Mutex::new(Vec::new()));
    let reader = stream.try_clone().map_err(|e| e.to_string())?;
    let sink = inbox.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let mut q = sink.lock().unwrap();
            if q.len() < 200 {
                q.push(line);
            }
        }
    });
    let hwnd = std::fs::read_to_string(&info).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["hwnd"].as_i64()).unwrap_or(0);
    *SESSION.lock().unwrap() = Some(Session { child, stream, inbox, hwnd, logs, killed: false });
    Ok(json!({ "hwnd": hwnd }))
}

// 启动原生窗口：rect 是网页里 3D 画面的位置大小（CSS 像素，相对网页），原生窗口开在屏幕上同一个地方；scene 是星系场景（res:/…）；
// gfx 是画质档位 auto / high / medium / low
#[tauri::command]
pub async fn native_start(app: tauri::AppHandle, window: tauri::WebviewWindow, rect: Option<[f64; 4]>, scene: Option<String>, gfx: Option<String>) -> Result<Value, String> {
    if let Some(s) = SESSION.lock().unwrap().as_mut() {
        if matches!(s.child.try_wait(), Ok(None)) {
            return Ok(json!({ "hwnd": s.hwnd, "again": true }));
        }
    }
    let (_, pkg) = installed(&root(&app)?).ok_or("还没下载原生引擎")?;
    let rect = rect.and_then(|[x, y, w, h]| {
        let pos = window.inner_position().ok()?;
        let k = window.scale_factor().ok()?;
        (w > 50.0 && h > 50.0).then(|| [pos.x as i64 + (x * k) as i64, pos.y as i64 + (y * k) as i64, (w * k) as i64, (h * k) as i64])
    });
    tauri::async_runtime::spawn_blocking(move || start_blocking(pkg, rect, scene, gfx)).await.map_err(|e| e.to_string())?
}

// 网页发给原生进程（一行或多行 JSON）；连接断了返回 false（进程结束，退出信息由下一次 native_poll 带回）
#[tauri::command]
pub fn native_send(text: String) -> bool {
    let mut g = SESSION.lock().unwrap();
    let Some(s) = g.as_mut() else { return false };
    let mut data = text.into_bytes();
    if data.last() != Some(&b'\n') {
        data.push(b'\n');
    }
    if s.stream.write_all(&data).is_err() {
        let _ = s.child.kill();
        s.killed = true;
        return false;
    }
    true
}

// 原生进程发回来的消息（JSON 字符串）；进程退出了最后加一条 {"t":"exit","code":退出码,"killed":是否被这边结束,"log":日志最后几行}
// （退出码 0：用户自己关了窗口）
#[tauri::command]
pub fn native_poll() -> Vec<String> {
    let mut g = SESSION.lock().unwrap();
    let Some(s) = g.as_mut() else { return vec![] };
    let mut out: Vec<String> = std::mem::take(&mut *s.inbox.lock().unwrap());
    match s.child.try_wait() {
        Ok(None) => {}
        r => {
            let code = r.ok().flatten().and_then(|st| st.code());
            let log = if code == Some(0) && !s.killed { String::new() } else { log_tail(&s.logs, 30) };
            out.push(json!({ "t": "exit", "code": code, "codeText": exit_code(code), "killed": s.killed, "log": log }).to_string());
            *g = None;
        }
    }
    out
}

#[tauri::command]
pub async fn native_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(shutdown).await.map_err(|e| e.to_string())
}

// 关掉原生进程：先让它自己退出，3 秒不退就结束进程（主程序退出时也调用）
pub fn shutdown() {
    let Some(mut s) = SESSION.lock().unwrap().take() else { return };
    let _ = s.stream.write_all(b"{\"t\":\"quit\"}\n");
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(3) {
        if !matches!(s.child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = s.child.kill();
}
