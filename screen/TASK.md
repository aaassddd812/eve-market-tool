# 任务：EVE 站点实时访问大屏

在 /opt/eve/screen/ 下开发一个"实时访问数据大屏"，读 nginx 访问日志实时展示。完成后部署为 systemd 服务并由 nginx 暴露。

## 数据源
- 日志：/var/log/nginx/eve.access.log 与 .1（warmup 用），格式示例：
  `1.2.3.4 - - [03/Nov/2026:08:15:04 +0000] "GET /api/kb/battles?window=60 HTTP/2.0" 200 46 "https://eve-tools.top/" "Mozilla/5.0 ..." xff="5.6.7.8" cf="-" rt=0.002 urt=0.001`
- 真实客户端 IP：xff 字段非 "-" 时取第一段，否则取第一个字段
- 爬虫过滤（UA 含 bot|spider|crawl|curl|wget|python|go-http|monitor|headless|scrapy 等跳过）
- 解析参考：可读 /opt/eve/stats/dau_stats.py（现有统计脚本）
- 时区：展示用北京时间（UTC+8）

## 后端要求（Python3，尽量只用标准库）
1. stdlib http.server + threading，绑定 127.0.0.1:8377
2. IP 归属地：http://ip-api.com/json/{ip}?lang=zh-CN&fields=status,country,regionName,city,query（免费 45次/分，新 IP 才查），结果缓存进 sqlite（/opt/eve/screen/geo.sqlite），国内 IP 记省份(regionName)，国外记国家；启动时先回放日志预热已有 IP
3. 接口：
   - GET / 静态 index.html
   - GET /api/stats 返回 JSON：
     { today_users, today_requests, req_per_sec(近60秒), online_now(近5分钟活跃IP), peak_online,
       provinces:[{name,users,requests}] (中国省份), countries:[{name,users}] (国外),
       recent:[{ip(打码如 1.2.*.*),region,url,t}] 最近30条,
       hourly:[{hour,users,requests}] 今日按小时,
       top_pages:[{path,count}] 今日前10, domain:{old,new} 按referer域名,
       servers:{宁静,晨曦,曙光} 按 URL 里 server= 参数统计 }
4. 后台线程持续 tail 日志（每秒读增量），数据放内存，/api/stats 直接算好返回
5. systemd 服务 /etc/systemd/system/eve-screen.service：root 运行（要读日志）、Restart=always、开机自启

## 前端要求（单文件 index.html + 本地静态资源）
1. 风格仿 Cloudflare Analytics 深色版：背景 #0f0f12，卡片 #1b1b1f 圆角带细边框 #2a2a30，主色橙 #f6821f，文字 #e7e7ea，次要文字 #9494a0，数字用等宽字体，整体克制精致
2. 布局：
   - 顶栏：站点名 + 大数字卡片一排（今日访客/今日请求/当前在线/每秒请求/今日峰值在线）
   - 中间大块：ECharts 中国地图，按省份今日用户数着色（visualMap 橙色渐变），hover 显示省名+人数；旁边一列"国外访客"国家列表
   - 左列：实时访问流（最近 IP 打码、地区、看的页面、时间，新的一条高亮滑入，保留30条）
   - 右列：省份排行（横向条形，ECharts）、热门页面 Top10、服务器分布（宁静/晨曦/曙光）、新旧域名占比
   - 底部：今日按小时访问曲线（ECharts 面积图）
3. echarts.min.js 和中国地图 geojson 必须下载到 /opt/eve/screen/static/ 本地引用（geojson 用 https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json），不要引用公网 CDN
4. 每 2 秒 fetch /api/stats 刷新；页面加 <meta name="robots" content="noindex">
5. IP 展示一律打码（如 1.2.*.*），这是公开页面

## nginx 接入
在 /etc/nginx/sites-available/eve.navexor.top 的 443 server 块内加：
  location /screen/ { proxy_pass http://127.0.0.1:8377/; proxy_http_version 1.1; }
然后 nginx -t 通过再 reload。

## 验收（必须自测通过才算完成）
1. systemctl status eve-screen 正常运行
2. curl -s localhost:8377/api/stats | python3 -m json.tool 有合理数据（today_users > 0）
3. curl -s localhost:8377/ 返回完整 HTML
4. 静态资源 echarts/geojson 本地可访问（curl 200）
5. nginx -t 通过且已 reload，curl -sk https://eve.navexor.top/screen/ -o /dev/null -w "%{http_code}" 返回 200
6. 不要动 /opt/eve 下其他服务、不要改已有 nginx 配置里的其他部分
