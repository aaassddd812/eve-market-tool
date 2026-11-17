# EVE 辅助工具 · 桌面版 / 安卓版

Windows 10 / 11 桌面程序与安卓 App（Tauri 2，Windows 用系统自带的 Edge WebView2），窗口直接打开线上网站 https://eve.navexor.top/ ，网站更新后自动是最新的，不用重新发版。
安卓版注入 `window.__EVE_APP__`（网页给 `<html>` 加 `is-app`，隐藏下载入口），布局用网站本身的手机布局（≤768px）。

- `src-tauri/`：桌面 / 安卓共用的壳（`src/lib.rs` 的 `run()`，桌面入口 `main.rs`）。`src/app-init.js` 在每个页面加载前注入：
  - 设置 `window.__EVE_DESKTOP__`，网页（`index-v2.html` 头部脚本）据此给 `<html>` 加 `is-desktop`，菜单栏改成左侧分组、可折叠、可收起成图标（`modern-app.js` 的 `initRail`）。网页加 `?desktop=1` 可以在浏览器里预览这个布局。
  - 本站以外的链接、新窗口打开的链接交给系统浏览器（ESI 登录在浏览器里完成，复制回调地址粘贴回桌面版绑定）。
  - 只给线上站点开放 `opener:default`、`notification:default` 权限（`capabilities/default.json`）。
  - 插件：系统通知（替换网页的 `window.Notification`）；仅桌面：单实例（再次双击切回已开窗口）、记住窗口位置与大小、自动更新。
- `android/`：安卓工程补丁（工作流里 `tauri android init`、`tauri icon` 之后跑 `android/patch.sh`）：`MainActivity.kt` 让网页铺满全屏，并把状态栏 / 导航栏高度经 `EveApp` 交给网页（`app-init.js` 写到 `--sa-top` / `--sa-bottom`，安卓 WebView 不报 `env(safe-area-inset-*)`），键盘弹出时让出键盘高度；`res/` 是矢量自适应图标（背景铺满，图案缩在安全区里，各种遮罩形状都不裁）。
- 日志预警（仅桌面，`src/logs.rs`）：`logs_dir` 自动找「文档\EVE\logs」（系统文档文件夹，含 OneDrive 重定向），`logs_list` / `logs_stat` / `logs_read` 只读地列出、读取 Chatlogs / Gamelogs 里的 .txt；网页 `intel.js` 把它们包成和浏览器文件夹句柄一样的接口，不用选文件夹、不用每次重新授权。
- 托盘（仅桌面，`src/tray.rs`）：点主窗口 ✕ 时弹本地页面 `dist/close.html`（窗口 `close-ask`，权限只有 `allow-close-choice`，见 `capabilities/close-ask.json`）问「最小化到托盘 / 退出程序」，勾「记住我的选择」写到配置文件夹的 `close-action`（ask / tray / exit）；托盘右键菜单「点关闭按钮时」可以改回来。藏到托盘时网页照常运行（WebView2 关了后台降速，所有窗口用同一套启动参数 `BROWSER_ARGS`）。
- 悬浮窗（仅桌面，`float_*` 命令）：网页点「悬浮窗」调 `float_open`，开一个置顶、无边框、透明背景、不占任务栏的窗口（标签 `float-<kind>`，加载本站 `float.html`），
  窗口里调 `float_drag`（拖动标题栏）、`float_pass`（鼠标穿透）、`float_close`、`float_focus_main`（点了详情切回主窗口）。远程网页调自定义命令要在 `build.rs` 的 AppManifest 里登记，
  再在 `capabilities/default.json` 放行 `allow-float-*`。主窗口真正关掉（退出）时整个程序退出。
- 自动更新（仅桌面，`lib.rs` 的 `check_update`）：启动时读 Releases 最新版的 `latest.json`（失败再读走 ghfast 镜像的 `latest-mirror.json`），版本比当前新就弹窗「现在更新 / 以后再说」，确认后下载安装包、校验签名、静默安装并重启；查不到更新或网络不通就静默跳过。网页内容本来就是线上最新的，只有壳（Rust、插件、权限）改动时才需要发新版。
- 原生引擎（仅 Windows 桌面，1.0.18 起，`src/native.rs`）：驾驶模拟开始前的设置里可选「原生引擎」（战场模拟 3D 画面也有按钮，网页 `js/native-engine.js`），用 CCP 开源的 trinity 引擎另开一个窗口画同一场战斗。
  组件第一次用时下载（约 120 MB）：`native_install` 读公开仓库 Release `native` 的 `eve-native.json`（`{version,proto,desktop,url,size,sha256}`，url 必须是 `https://github.com/` 开头；连不上走 ghfast 镜像；`desktop` 比本机桌面版新时不装，提示先更新桌面版），
  用系统自带的 `curl.exe` 下载、校验大小和 SHA256、`tar.exe` 解压到应用数据目录 `native\pkg-<版本>`（`current.txt` 记当前版本，换版本时沿用旧的 `cache\` 模型缓存）；
  `native_status` 报版本和下载进度；`native_start` 启动组件里的 `host\bridge.py`（随机口令，只连本机端口），`native_send` 转发网页每帧的相机和船位，`native_poll` 取回状态，`native_stop` / 主窗口关闭时结束进程；`native_uninstall` 删掉整个组件。
  组件包由 eve-market-tool 的 `native-engine` 分支 CI 生成和发布（见那边的 README）。命令登记在 `build.rs`，权限只给主窗口（`capabilities/native.json`）。
  测试：设环境变量 `EVE_NATIVE_PKG` 指向一个现成的组件目录（和组件包同样的布局：`host\bridge.py`、`rt\bin\exefile*.exe`，比如 CI 在本机组装的 `F:\eve-ci\viewer-latest`），
  桌面版就直接用它，不下载、不查新版本（版本显示 `local`），不用先发布组件。
- `downloader/Downloader.cs`：下载器（.NET Framework 4.x WinForms，约 60 KB）。从 `aaassddd812/eve-tool-desktop` 的最新 Release 下载 `EVE-Tool-Setup.exe` 并启动安装；GitHub 连不上时依次改用 ghfast.top、gh-proxy.com 镜像；校验文件头与大小。
  网站「桌面版」弹窗提供的是 `eve-overview-clone/downloads/EVE-Tool-Downloader.exe`（Linux 上可用 `mcs -target:winexe -out:… -win32icon:src-tauri/icons/icon.ico -r:System.Windows.Forms.dll -r:System.Drawing.dll downloader/Downloader.cs` 重新编译）。

## 发布

`.github/workflows/desktop.yml`：`windows-latest` 编译 NSIS 安装包与下载器，`ubuntu-latest` 编译安卓 APK（`tauri android init/build`，再用 apksigner 签名），两边结束后一起发布到公开仓库 **aaassddd812/eve-tool-desktop** 的 Releases（资产名固定：`EVE-Tool-Setup.exe`、`EVE-Tool-Downloader.exe`、`EVE-Tool.apk`）；一边失败另一边照样发布。

一次性准备：
1. 在 GitHub 新建公开仓库 `aaassddd812/eve-tool-desktop`，勾选「Add a README」（发布需要已有 main 分支）。
2. 新建 Fine-grained token：只选这个仓库，Contents 读写；在本仓库 Settings → Secrets → Actions 添加为 `RELEASE_TOKEN`。
3. 安卓签名：`ANDROID_KEYSTORE_B64`（jks 文件的 base64）与 `ANDROID_KEYSTORE_PASSWORD`（密钥库与密钥同一个密码，别名 `eve-tool`）。密钥只放在服务器 `/root/study/EVEonlineHelp/eve-android-signing/`，不进仓库；以后每次更新 APK 都必须用同一把，丢了用户就只能卸载重装。
4. 自动更新签名：`TAURI_SIGNING_PRIVATE_KEY`（私钥文件内容）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥放在服务器 `/root/study/EVEonlineHelp/eve-updater-signing/`，公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey`；私钥丢了已安装的桌面版就再也收不到更新（只能重新下载安装）。

发版：推送标签 `desktop-v1.0.0`（版本号取自标签，必须比上一版大，桌面版才会提示更新），或在 Actions 页手动运行 `desktop`。
只想自己先试：手动运行时勾选「只打 Windows 测试包」，安装包在这次运行的 Artifacts（`windows`）里，不编安卓、不发布，用户不会收到更新。
测试包装过的机器不会自动更新到同一个版本号，正式发版用更大的版本号（或手动重装）。

本地检查 Rust 代码（不链接）：`cargo check --target x86_64-pc-windows-msvc`（需要 `llvm-rc`）。
依赖里的 `ring` 要用 C 编译器编：Linux 上可以把 `clang` 链接成 `clang-cl` 当 MSVC 编译器，再给几个空的 C 头文件（`assert.h`、`string.h`、`stdlib.h`，只为通过预处理），
`CC_x86_64_pc_windows_msvc=<clang-cl> AR_x86_64_pc_windows_msvc=llvm-lib CFLAGS_x86_64_pc_windows_msvc="/I<头文件目录>" cargo check --offline --target x86_64-pc-windows-msvc`。
