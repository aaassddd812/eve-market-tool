# 任务2：大屏 logo + WebRTC 真实 IP 识别

## A. 大屏图标换成站点 logo
1. 把 /opt/eve/dist/favicon.svg 复制到 /opt/eve/screen/static/logo.svg
2. index.html 顶部 "EVE 工具站 · 实时访问" 标题前的橙色图标元素换成 <img src="/screen/static/logo.svg">，高度与原图标一致（约 28-32px），加 alt="EVE 工具站"

## B. WebRTC 真实 IP 识别（"以泄露为准"）
原理：访客浏览器用 RTCPeerConnection + 公共 STUN 拿到自己绕过代理的公网 IP（WebRTC 泄露），上报给后端；后端把"日志里看到的 IP（代理出口）→ 上报的真实 IP"建映射；大屏统计与展示优先用真实 IP。

### 1. 后端 server.py 改动
- 加 POST /api/realip：收 JSON {ip}；校验是公网 IPv4（拒绝私有/保留段）；以"本次请求自身的客户端 IP（xff 首段优先，否则 remote_addr）"为 key 存内存映射 {key: (real_ip, ts)}；每 key 每分钟最多记 5 次；条目 TTL 12 小时滚动清理
- /api/stats 增加：proxied_count（映射存在且 real≠key 的数量）；recent 列表每条加 real_ip 与 proxied 布尔（real_ip 也打码）

### 2. 大屏展示"以泄露为准"
- recent 访问流：有映射且不同 → 显示真实 IP（打码）并加一个小"代理"徽章（橙色描边小标签）
- 省份/国家统计、今日访客去重：归属地查询与去重前先做映射替换（以真实 IP 为准）
- 顶部数字卡加一张：今日识别代理用户 N（proxied_count）
- IP 打码规则保持不变

### 3. 探测脚本（两处注入）
定义同一份内联 JS（幂等标记 <!-- EVE-REALIP-SNIPPET -->）：
- 用 RTCPeerConnection({iceServers:[{urls:"stun:stun.cloudflare.com:3478"},{urls:"stun:stun.l.google.com:19302"}]})，createDataChannel + createOffer + setLocalDescription 后监听 icecandidate
- 取 srflas 候选里的公网 IPv4；忽略 .local、私有段（10./172.16-31./192.168./100.64./169.254.）
- sessionStorage("eve-rip-done") 防重，每会话只上报一次
- fetch("/screen/api/realip", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ip}), keepalive:true}).catch(()=>{}) 静默
- 3 秒 setTimeout 兜底 close(pc)
注入位置：
  a) /opt/eve/screen/index.html 的 </head> 前（大屏自己的访客也探测）
  b) /opt/eve/dist/index-v2.html 的 </head> 前（主站，幂等：grep 标记存在就跳过）——小心不要破坏原 HTML，插完 curl 确认主站 200 且结构正常

## C. 自测
1. curl -s -X POST -H "Content-Type: application/json" -d "{\"ip\":\"8.8.8.8\"}" localhost:8377/api/realip 返回成功
2. /api/stats 出现 proxied_count 与 recent[].real_ip 字段
3. curl -s localhost:8377/ 与 https://eve.navexor.top/ 都是 200，主站 HTML 里有 EVE-REALIP-SNIPPET 标记
4. systemctl is-active eve-screen；不改动其他任何服务
