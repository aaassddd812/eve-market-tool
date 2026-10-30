# EVE 辅助工具 · 桌面版 / 安卓版

Windows 10 / 11 桌面程序与安卓 App（Tauri 2，Windows 用系统自带的 Edge WebView2），窗口直接打开线上网站 https://eve.navexor.top/ ，网站更新后自动是最新的，不用重新发版。
安卓版注入 `window.__EVE_APP__`（网页给 `<html>` 加 `is-app`，隐藏下载入口），布局用网站本身的手机布局（≤768px）。

- `src-tauri/`：桌面 / 安卓共用的壳（`src/lib.rs` 的 `run()`，桌面入口 `main.rs`）。`src/app-init.js` 在每个页面加载前注入：
  - 设置 `window.__EVE_DESKTOP__`，网页（`index-v2.html` 头部脚本）据此给 `<html>` 加 `is-desktop`，菜单栏改成左侧分组、可折叠、可收起成图标（`modern-app.js` 的 `initRail`）。网页加 `?desktop=1` 可以在浏览器里预览这个布局。
  - 本站以外的链接、新窗口打开的链接交给系统浏览器（ESI 登录在浏览器里完成，复制回调地址粘贴回桌面版绑定）。
  - 只给线上站点开放 `opener:default` 权限（`capabilities/default.json`）。
  - 插件：单实例（再次双击切回已开窗口）、记住窗口位置与大小（仅桌面）。
- `downloader/Downloader.cs`：下载器（.NET Framework 4.x WinForms，约 60 KB）。从 `wbw5780/eve-tool-desktop` 的最新 Release 下载 `EVE-Tool-Setup.exe` 并启动安装；GitHub 连不上时依次改用 ghfast.top、gh-proxy.com 镜像；校验文件头与大小。
  网站「桌面版」弹窗提供的是 `eve-overview-clone/downloads/EVE-Tool-Downloader.exe`（Linux 上可用 `mcs -target:winexe -out:… -win32icon:src-tauri/icons/icon.ico -r:System.Windows.Forms.dll -r:System.Drawing.dll downloader/Downloader.cs` 重新编译）。

## 发布

`.github/workflows/desktop.yml`：`windows-latest` 编译 NSIS 安装包与下载器，`ubuntu-latest` 编译安卓 APK（`tauri android init/build`，再用 apksigner 签名），两边结束后一起发布到公开仓库 **wbw5780/eve-tool-desktop** 的 Releases（资产名固定：`EVE-Tool-Setup.exe`、`EVE-Tool-Downloader.exe`、`EVE-Tool.apk`）；一边失败另一边照样发布。

一次性准备：
1. 在 GitHub 新建公开仓库 `wbw5780/eve-tool-desktop`，勾选「Add a README」（发布需要已有 main 分支）。
2. 新建 Fine-grained token：只选这个仓库，Contents 读写；在本仓库 Settings → Secrets → Actions 添加为 `RELEASE_TOKEN`。
3. 安卓签名：`ANDROID_KEYSTORE_B64`（jks 文件的 base64）与 `ANDROID_KEYSTORE_PASSWORD`（密钥库与密钥同一个密码，别名 `eve-tool`）。密钥只放在服务器 `/root/study/EVEonlineHelp/eve-android-signing/`，不进仓库；以后每次更新 APK 都必须用同一把，丢了用户就只能卸载重装。

发版：推送标签 `desktop-v1.0.0`（版本号取自标签），或在 Actions 页手动运行 `desktop`。

本地检查 Rust 代码（不链接）：`cargo check --target x86_64-pc-windows-msvc`（需要 `llvm-rc`）。
