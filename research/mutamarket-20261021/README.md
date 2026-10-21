# MutaMarket 深渊估价调研

[分析报告与接入方案](2026-10-21_分析-MutaMarket-report.md) · [范围与执行记录](scope.md)

## 离线验证

```powershell
python research\mutamarket-20261021\integration_example.py
```

使用两件公开装备样本，将真实 ESI 属性映射到当前装配结构，并检查派生/虚拟属性过滤、空估价与服务器隔离。输出 `integration-sample.json`。

## 重新采集公开接口

```powershell
python research\mutamarket-20261021\probe.py
```

默认仅执行少量公开 GET 请求。`verify.py` 会额外对已公开样本执行一次 POST 导入/刷新，再读取 ESI 进行属性对照。两个脚本均只使用 Python 标准库，访问网络需联网。

GitHub 保存报告、复现程序、模型统计和两件公开样本。完整网页 HTML、网站编译脚本和大列表响应保留在本地，也可由采集程序重新生成。`requests.json` 记录分析当时的 URL、响应状态、时间与文件 SHA-256，其中包含本地原始抓取文件的记录；线上数据更新后重新采集的 hash 可能变化。

本目录是调查与适配验证产物，正式应用路由和界面接入尚未实现。
