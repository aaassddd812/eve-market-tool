# MutaMarket 深渊估价实现与项目接入方案

分析日期：2026-10-21（北京时间）。范围见 [scope.md](scope.md)。

## 1. 结论

可以通过站方公开 API 接入真实深渊装备估价，不需要复制界面或重建价格模型。站方明确说明：每个深渊装备类型使用独立的随机森林，输入为突变属性，训练标签为真实单件合同成交价，并使用原型装备价格作为参考。每类至少积累 50 笔成交才具备训练条件。

本项目已经有真实动态属性查询、突变质体范围数据和装配属性覆盖结构；主要缺口是单件估价服务、物品身份保存、价格与属性编辑之间的失效处理，以及界面展示。

**建议第一版做宁静服“粘贴游戏物品链接 → 查询估价 → 查看属性 → 导入装配”，然后接个人资产。** 现有手工模拟属性没有真实 item_id，公开 API 无法直接为这些假设装备运行模型。晨曦、曙光也必须使用自己的价格数据。

## 2. 估价怎样实现

站方说明见 [估价原理](https://mutamarket.com/documentation/appraisal) 和 [指标说明](https://mutamarket.com/documentation/module-details)。

### 数据与模型

1. 从物品链接解析 `showinfo:{type_id}//{item_id}`。
2. 后端从 ESI 动态物品接口读取原型、突变质体和具体属性。
3. 按深渊装备类型选取模型，预测 ISK 价格。
4. 返回估价、计算时间；另外提供该类型的训练数量、R²、MAE、NMAE 和最近训练时间。
5. 展示时并列显示实际挂牌价格、属性品质和模型价格，并提供相似装备比较。

这不是“平均属性分数 × 原装备价格”的固定公式。CPU、PG、射程、伤害、周期等属性组合的成交规律由模型拟合。属性品质条只描述 roll 所在范围，不能当作成交价格函数。基础装备未被突变的属性、供需变化也会影响市场价值；公开文档未给出模型完整特征工程、参数、训练代码或权重，不能从前端直接搬走一个可离线运行的模型。

模型统计代表该类型的总体拟合情况。**R² 不是这件装备卖出该价格的概率；MAE/NMAE 也不是这件装备的统计置信区间。** 样本偏斜、稀有组合和高价极品是站方明确列出的薄弱处。

### 当前前端调用

HTML 的 `modulepreload` 与脚本确认当前前端使用 SvelteKit。估价页的编译脚本为：

`https://mutamarket.com/_app/immutable/nodes/30.apuUpUIS.js`

其中匿名编译函数 `A(t)` 验证 `/showinfo:\d+\/\/\d+/`，再向网页路由 `POST /modules` 发送 `{message: t}`，成功后跳转物品页。网页路由返回方式适配其自身导航。

我们应使用下面的公开 `/api/modules` JSON 接口。不要依赖该网页 POST 路由或未文档化内部端点。浏览器绑定超时，本轮取得的是公开脚本静态证据和直接 HTTP 证据，未声称取得浏览器运行时调用栈。

## 3. 可接入的公开 API

来源：[公开 API 说明](https://mutamarket.com/documentation/api-overview)、[接口参考](https://mutamarket.com/documentation/api)、[OpenAPI](https://mutamarket.com/api/openapi.json)。免登录、免密钥。

| 请求 | 用途 | 接入注意 |
|---|---|---|
| `GET /api/modules/{item_id}` | 读取站方已知单件装备 | 返回 `{data: ...}`；未知物品为 404 |
| `POST /api/modules` | 根据 ESI 导入/刷新真实装备，并取得估价 | 接受 `{type_id, item_id}` 或 `{message}`；不要循环调用 |
| `GET /api/modules/type/{type_id}` | 查询该类型公开列表 | 本次返回 100 件；后续使用 `meta.next_cursor` |
| `GET /api/estimator-statistics` | 按类型查询模型质量 | 返回数组；`r2: null` 表示没有模型 |
| `GET /api/abyssal-type-statistics` | 获取属性最好/最坏范围 | 返回数组；站方建议长期缓存 |

`GET /api/modules` 不带类型会返回 404，不能用它读取全站列表。OpenAPI 指向的 `/documentation/api-modules` 本次实际返回 404；目前已验证类型列表基础调用和游标字段，复杂筛选路径暂不作为接入依赖。

导入请求示例（下列是真实公开挂牌样本；POST 会在对方站点导入/刷新，应由用户触发）：

```http
POST https://mutamarket.com/api/modules
Content-Type: application/json

{"type_id":48439,"item_id":1056160153322}
```

### 关键响应字段

| 字段 | 在本项目的用途 |
|---|---|
| `id`、`type.id` | 单件 item_id、深渊 type_id |
| `source_type.id`、`mutaplasmid.id` | 原型装备和突变质体 |
| `mutated_attributes[]` | 真实突变属性以及展示用派生、虚拟属性 |
| `estimated_value` | 参考估价；允许 null |
| `estimated_value_updated_at` | 该单件估价的上游时间，独立于本地抓取时间 |
| `contract.price` | 合同整体价格；多物品合同时不能直接当成单件成交价 |
| `slug` | 跳转原站对应装备 |

错误处理：400 为导入失败；404 为未知装备/无效类型；422 为参数校验失败；429 应遵循 Retry-After；上游 5xx、超时应显示暂不可用。站方未在所读文档公布固定请求配额。请求应标明应用身份与联系方式；本次研究 UA 使用了本站公开网址，正式部署应补充维护者认可的联系地址。

## 4. 实测结果

原始响应、请求记录及 SHA-256 见本目录 `requests.json`。以下是本次快照，不代表后续固定价格。

### 公开样本

| 项目 | 结果 |
|---|---|
| 装备 | Large Abyssal Cap Battery，type 48439 |
| 原型 | Thukker Large Cap Battery，type 41220 |
| 单件物品 ID | 1056160153322 |
| 挂牌价格 | 105,000,000 ISK |
| 模型估价 | 115,370,770.63 ISK |
| 模型样本数 | 13,904 |
| R² | 0.7878 |
| MAE | 111,187,387.72 ISK，类型整体指标 |
| NMAE | 原始数值 25.3464，按站方页面语义为约 25.35% |
| 单件估价时间 | 2026-10-20 21:03:59（北京时间） |
| 类型模型训练时间 | 2026-10-20 17:38:08（北京时间） |

注意：该次 POST 返回 200 和相同估价时间，因此只能确认导入/刷新端点能用，不能据此保证每次请求都会产生新的计算时间。

模型统计共 97 类，69 类 `r2 != null`，28 类尚无模型；范围统计有 599 行。一次携带 `Origin: https://eve.navexor.top` 的单件 GET 响应没有 `Access-Control-Allow-Origin`，所以不能把浏览器直接跨站 fetch 当作可靠接入方式。建议同源后端代理；本轮未做浏览器跨域端到端验收。

### 属性与装配交叉验证

对上述电容电池、以及一件弹道控制系统（type 49738、item 1056163236300）读取官方 ESI。前者 4 项突变属性、后者 3 项突变属性均与公开 API 的原始值一致。

弹道控制系统响应还包含虚拟 `droneDamageBonus` 和派生 `dpsIncreaseMissiles`（ID 5000004），它们不属于真实 ESI 突变值。**装配计算应取 ESI 原始值，只覆盖实际突变字段；显示用派生/虚拟字段必须过滤。** ESI 本身还会返回没有突变的完整属性，不能把所有 ESI 字段都当成突变项。

## 5. 我们项目的具体接入位置

以下位置均已按当前本地源码复核。

| 文件/函数 | 现状 | 建议改动 |
|---|---|---|
| `js/modern-app.js:3396` 的 `openDynamicItem()` | 已读 ESI 单件属性、原型和中文名 | 增加“查询深渊估价”、模型指标和“导入装配”入口 |
| `js/appraisal.js` 的 `appraise()` | 普通清单以名称/type_id 合并数量，再取挂单 | 增加独立深渊输入模式，识别 showinfo 链接，逐 item_id 估价 |
| `js/fit-mutate.js` | 已支持 `{type, mut:{base, mutator, attrs}}` | 复用真实属性覆盖结构；保存关联单件身份 |
| `js/fitting.js` 的 `cleanMut()`、`refreshFitValue()` | 清洗/估值均不保留真实 item_id；估值只收 type 和数量 | 增加单件引用的完整保存和估价来源区分 |
| `js/fitting.js` 的分享编码/解码、EFT 导入导出 | 仅保留突变属性 | 分享结构版本需兼容扩展；EFT 丢失物品身份时降级为模拟装备 |
| `js/modern-app.js` 的 `valuateItems()` | 用 type_id 读取普通市场价并累加 | 单独返回深渊参考价值和未估价数量 |
| `js/server.js` | 已有 `SERVER.id`、`IS_TQ` 和服别隔离 | 在前后端都拒绝将晨曦/曙光 ID 发往 MutaMarket |
| `server/kb_service.py`、Nginx | 已有公开 GET API 和限流设施 | 复用网络/缓存设施，新增独立深渊服务路由 |
| `server/local_launcher.py` | `/api/v1` GET 已反代，但 POST 目前只反代 `/api/esi/` | 若深渊导入使用本站 POST，桌面版启动器也要同步放行对应路由 |

### 建议的本站接口（尚未实现）

- `GET /api/v1/abyssal/modules/{item_id}?type_id=48439&server=tq`：只读本站/上游已有数据；首次未知不自动导入。
- `POST /api/v1/abyssal/appraise`：用户明确点击查询后发送 `{server, type_id, item_id}`，导入/刷新一次。
- `GET /api/v1/abyssal/models`：返回本站缓存的模型质量。

这三个路径是设计建议，本轮没有注册进应用。POST 需要专用处理方法，并同步修改 Nginx、桌面启动器和 API 文档。不能只加前端按钮就认为网页版和 EXE 都已接通。

请求过程：先查本站单件缓存，再读上游已知物品；需要导入时由用户触发 POST；ESI 真实属性与模型结果一起归一化，再交给估价页或装配页。

### 缓存与展示

- 缓存键使用 `(server, type_id, item_id)`；不要把每件属性不同的深渊装备塞进现有 `prices(type_id PRIMARY KEY)`。
- 真实属性可长期缓存；估价建议先采用 6 小时 TTL，模型统计 24 小时，属性范围 7 天。这些是本站建议策略，不是站方承诺。
- 并发合并相同请求，设置全局队列、每 IP 限流和 30 秒超时；POST 不做自动快速重试，避免反复触发 ESI/模型计算。
- 数据库保留 `fetched_at` 与 `estimated_value_updated_at` 两个时间，超时可显示带时间的旧结果。
- 展示“参考估价 / 估价时间 / 模型样本 / 平均误差 / 原站链接”。缺模型显示“暂无估价”，不能作为 0 ISK 计入总价。
- 普通装备最低卖/最高收与深渊模型预测的含义不同，单列“深渊参考价值”，不要把它伪装为可立即成交的最高收价。
- 用户点击查询会把这件装备导入对方公开页面，交互应明确说明该行为；不在资产页加载时自动批量导入所有深渊资产。

### 装配身份与失效

在现有 `mut` 旁边增加独立身份/估价元数据，例如：

```json
{
  "type": 48439,
  "mut": {
    "base": 41220,
    "mutator": 85514,
    "attrs": {"67": 1958.4045062345267, "2267": -27.931400187253953, "50": 35.11304953086376, "30": 366.24000587463377}
  },
  "abyssal": {
    "server": "tq",
    "item_id": 1056160153322,
    "estimated_value": 115370770.63225992,
    "estimated_value_updated_at": "2026-10-20 13:03:59.312113+00"
  }
}
```

该对象是拟议结构，现有代码尚不会完整保存 `abyssal`。编辑原型、质体或任一属性后，必须清除单件关联和原估价，标记为模拟装备；同时使 `refreshFitValue()` 的缓存键失效。否则用户修改属性后仍看到原物品价格，结果会误导。

### 三个明确边界

1. **真实资产/游戏链接**：有 type_id 和 item_id，可走公开估价链路。
2. **手工模拟/EFT/击杀邮件**：仅有型号或自定义属性，通常没有真实 item_id，不能获得“该件物品”的模型结果。可用公开列表做近似属性比较，但列表挂牌不等于成交；要支持任意属性直接预测，需要站方新增接口/授权模型服务，或自行积累合法成交样本训练模型。
3. **国服**：保持当前动态属性和模拟功能，模型估价标为暂不支持。不同服务器的 item_id、供需和 ISK 价格不能混用。

## 6. 可复现交付与验证等级

在项目根目录运行（Python 标准库，无新增依赖）：

```powershell
# 默认只读公开网页/API，生成带时间和 hash 的请求记录
python research\mutamarket-20261021\probe.py

# 离线用已采集数据映射成当前装配结构，无网络请求
python research\mutamarket-20261021\integration_example.py
```

`verify.py` 会额外对已公开样本执行一次 POST，然后查询 ESI 对照；本轮已执行成功，不需为读取报告重复触发。`integration_example.py` 输出 `integration-sample.json`，验证了两件装备映射、派生/虚拟字段排除、null 保留和国服拒绝。

已完成：公开文档分析、公开脚本调用定位、API GET/POST 实测、ESI 属性对照、离线结构适配。未完成：生产前后端集成、真实绑定角色资产验收、浏览器交互与跨域实测、EXE 回归、远程部署、自有模型训练。

## 7. Evidence → Finding → Path

### Evidence

以下文件 hash 与原始 URL 均记录在 `requests.json`；E-003 的源码定位可直接在仓库重跑。

| ID | source_ref | repro_command | content_hash |
|---|---|---|---|
| E-001 | `doc-appraisal.html`、`estimator-statistics.json` | `python research\mutamarket-20261021\probe.py` | 见 requests.json 对应 SHA-256 |
| E-002 | `sample-module.json`、`sample-refresh.json`、`requests.json` | `python research\mutamarket-20261021\verify.py`（含一次 POST） | 见 requests.json |
| E-003 | 当前仓库 `js/modern-app.js`、`js/fitting.js`、`js/fit-mutate.js`、`js/server.js` | `rg -n 'openDynamicItem|valuateItems|refreshFitValue|cleanMut|IS_TQ' eve-overview-clone/js` | n/a，当前源码而非归档样本 |
| E-004 | `sample-esi.json`、`bcs-esi.json`、`unit-comparison.json` | `python research\mutamarket-20261021\verify.py` | 原始响应见 requests.json；比较文件为派生产物 |
| E-005 | `scripts/30.apuUpUIS.js`、`appraise.html` | `python research\mutamarket-20261021\probe.py` | 见 requests.json |
| E-006 | `integration_example.py`、`integration-sample.json` | `python research\mutamarket-20261021\integration_example.py` | n/a，派生产物 |

### Findings

| ID | 结论 | severity / category | evidence_ids | confidence / status | location |
|---|---|---|---|---|---|
| F-001 | 每类型随机森林、真实成交训练；可用公开 JSON 接入 | n/a_re / reverse_algo | E-001, E-002 | high / validated | 文档 appraisal、公开 API |
| F-002 | 项目已有动态属性和突变装配结构，但丢失单件价格身份 | n/a_re / design | E-003, E-006 | high / validated | openDynamicItem、refreshFitValue、cleanMut |
| F-003 | 导入装配必须过滤虚拟/派生属性，使用真实 ESI 值 | n/a_re / design | E-004, E-006 | high / validated | mutated_attributes、dogma_attributes |
| F-004 | 任意模拟属性预测不在公开接口契约内；国服不能使用宁静价格 | n/a_re / design | E-001, E-003 | high / validated | OpenAPI ImportModuleRequest、server.js |
| F-005 | 前端使用网页路由 POST，本站应使用文档化 API 并代理 | n/a_re / design | E-002, E-005 | high / validated | scripts/30.apuUpUIS.js、requests.json |

### P-001：拟议接入路径

- path_type：callflow。
- start：用户粘贴真实 showinfo 链接或选择一件宁静服深渊资产。
- goal：显示单件参考估价，并将真实属性带入现有装配计算。
- steps：解析并验证服别 → 本站单件缓存/公开 API → 必要时用户触发导入 → ESI 原始属性与模型结果归一化 → 展示/导入装配。分别关联 E-002/F-001、E-003/F-002、E-004/F-003、E-006。
- residual_risks：生产路由尚未实现；模型存在市场滞后与稀有样本误差；前端/EXE 保存链路需补齐单件身份；模拟属性和国服没有对应模型数据源。

时间线见 [scope.md](scope.md)。本报告不涉及漏洞利用或安全缺陷定性。
