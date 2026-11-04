# 实时访问大屏（/screen/）

线上地址：<https://eve-tools.top/screen/>（直连 <https://eve.navexor.top/screen/>）

读 nginx 访问日志（`/var/log/nginx/eve.access.log`）实时展示：近 24 小时访客 / 请求 / 在线、
中国地图省份着色、国外访客、实时访问流（新 IP 高亮、代理用户按 WebRTC 泄露的真实 IP 标注）、
省份排行、热门页面、服务器分布（宁静 / 晨曦 / 曙光）、新旧域名占比、底部今天 / 昨天双色折线面积图。
浅色 Cloudflare 风格，每 2 秒自刷新，IP 一律打码显示。

## 组成

- `server.py` —— 纯标准库后端：tail 日志、IP 归属地（ip-api 批量接口 + geo.sqlite 缓存）、
  真实 IP 映射（`POST /api/realip`，主站 index-v2.html 里的 `EVE-REALIP-SNIPPET` 上报）、
  全历史新 IP 名册（known_ips.json + /opt/eve/stats/dau_total.json 做种子）、`GET /api/stats`
- `index.html` —— 单文件前端（ECharts），静态资源全部在 `static/` 本地引用
- `static/` —— echarts.min.js、中国地图 geojson（阿里 DataV）、站点 logo
- `eve-screen.service` —— systemd 单元（root 运行读日志，监听 127.0.0.1:8377）
- `TASK.md` / `FIX*.md` —— 当初交给服务器上的 claude 无头执行的构建 / 迭代任务书，留作变更记录

## 部署（新机器恢复步骤）

```bash
# 1. 放到 /opt/eve/screen
rsync -a screen/ root@源站:/opt/eve/screen/

# 2. systemd
cp eve-screen.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now eve-screen

# 3. nginx（eve 站点 server 块内）
#    location /screen/ { proxy_pass http://127.0.0.1:8377/; proxy_http_version 1.1; }
nginx -t && systemctl reload nginx
```

## 运行时产物（不入库）

`geo.sqlite`（归属地缓存）、`known_ips.json`（历史 IP 名册）、`fix*.log` —— 由服务自己生成。
