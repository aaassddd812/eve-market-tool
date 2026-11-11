# EVE 收益助手（独立 Windows 程序）

界面全部打包在程序里（`ui/`，原生 ES 模块，不用打包工具），不打开网站；只向本站取价格、物品名称、星图和 ESI 应用配置。Tauri 2，Windows 用系统自带的 Edge WebView2。

## 功能

- **ESI**（令牌只存在本机，按服务器分开，可绑多个角色）：角色概览、技能、钱包与刷怪收益（`ui/js/ratting.js`，从网站原样复制，改动两边同步）、资产估值、订单。
- **实时收益**（`views/live.js` + `logscan.js`）：增量扫描游戏日志里的赏金挂账和采矿产出，零操作。活动计时由手动按钮控制（开始 / 暂停 / 继续 / 结束），算每小时收益。只算挂账，不算 20 分钟一次的赏金结算，不会重复计。
- **深渊收益**（`views/abyss.js`）：
  - 识别每一趟：
    - ESI 每 12 秒读一次位置，深渊星系 ID 在 32000000 段。
    - 聊天日志的本地频道换成一个不是已知星系的名字，算进入深渊。程序没开时跑的也能补记，和 ESI 记录重叠的用日志里精确到秒的时间。
  - 游戏日志（`gamelog.js`）：读每一趟的战斗统计。
  - 剪贴板（`clip.js` + `src-tauri/src/clip.rs`）：在游戏里复制货柜，程序自动记入对应的一趟，再按本站价格估值。

## 日志与剪贴板的处理细节

- **增量读取**（`logscan.js`）：
  - 每个文件记住读到的位置，一次最多读 2MB，只处理到最后一个完整的行。UTF-16 文件按两字节对齐，读到半行或半个字符就留到下一轮。
  - 文件开头 8KB 的 SHA-256 作指纹，同名文件被新会话重写时从头再读。
  - 编码：有 BOM 按 BOM 判断，没有时看零字节比例，区分 UTF-16LE 和 UTF-8。
- **赏金与采矿的匹配规则**：
  - 赏金：英文认 `ISK added to next bounty payout`，中文认「星币…添加到下一次赏金支付」。
  - 采矿：英文认 `You (successfully) mined N units of X`，中文认「开采 / 采集 / 采掘 / 采矿 / 挖掘」几种说法。
  - 先剥掉颜色标签。
- **本地频道**：认「Channel changed to Local : X」和「频道更换为 本地：X」。位置证据按时间去重、排序，重复或乱序到达都不影响。
- **剪贴板**：
  - 每 750 毫秒查一次 Windows 剪贴板序号（`GetClipboardSequenceNumber`），没变就跳过。剪贴板被占用时，同一个序号最多重试 3 次。
  - 只收含制表符、不超过 100KB 的文本。
  - 去掉物品名前的 `*`，数量去掉千分位，并限制在安全整数范围内。每批带一个 `capture_id`，内容相同的不重复记。
  - 只读，不清空也不改写剪贴板。
  - 复制的清单记为「进行中或 30 分钟内刚结束的那一趟」出深渊后的货柜，同时当作下一趟进深渊前的货柜。手动改过的货柜不会被覆盖。

## 界面

和网站「新页面」同一套样式（`ui/app.css`）：炭黑底、左侧菜单栏、内容区深灰大卡片、方角、青蓝强调色，字体 Chakra Petch（英文 / 数字）、MiSans VF（中文）、得意黑（大标题）。字体文件不重复放进仓库，打包时从 `eve-overview-clone/assets/fonts` 复制到 `ui/fonts`（已忽略）。

## 开发

- 浏览器预览：在仓库 `eve-market-tool/` 目录起静态服务，例如 `python3 -m http.server 18400`，打开 `/lite/ui/index.html?mock=1`。预览前先复制字体：`F=eve-overview-clone/assets/fonts; mkdir -p lite/ui/fonts && cp $F/chakra-petch-*.woff2 lite/ui/fonts/ && cp -r $F/misans $F/smiley lite/ui/fonts/`。用的是 `ui/js/mock.js` 的模拟数据，`?mock=abyss` 时角色在深渊里。模拟复制货柜：控制台运行 `__mockCopy('名称\t数量')`。
- 检查 Rust 代码（不链接）：在 `lite/src-tauri` 里运行 `cargo check --target x86_64-pc-windows-msvc`。HTTP 用系统 TLS（native-tls），不编译 ring。
- 网络请求走 `tauri-plugin-http`，能访问的地址列在 `src-tauri/capabilities/default.json`：ESI、CCP / 网易登录、本站。

## 发布

`.github/workflows/lite.yml` 负责发布：
- 推送标签 `lite-v0.1.0` 触发，或在 Actions 页手动运行。
- 编译 NSIS 安装包 `EVE-Lite-Setup.exe`，发到公开仓库 `aaassddd812/eve-tool-desktop` 的 Releases，用和桌面版相同的 `RELEASE_TOKEN`。
- 发布时设了 `make_latest: false`，不占桌面版自动更新读取的「最新版本」。
- 打包前会去掉 `mock.js`。
- 暂时没有自动更新。
