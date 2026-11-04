# 任务4：大屏两处改动（/opt/eve/screen/）

## 1. 底部小时图：柱形图改为折线面积图
- 数据、横轴（近24小时、今天/昨天双色概念）不变，只换图形：平滑折线 + 面积填充
- 今天：实色折线（2px）+ 正常不透明度面积渐变填充；昨天：淡色折线 + 低不透明度面积
- hover 交互保持：hover 到今天的数据点/线段 → 昨天整体隐藏（反之亦然），移开恢复；图例"今天/昨天"仍可点击固定切换
- 实现：两条独立 series（stack 不叠），symbolSize 小圆点，areaStyle 渐变

## 2. 实时访问流：历史首次出现的新 IP 醒目标注
判断口径：该 IP（经真实 IP 映射后的最终 IP）从未在历史流量中出现过。
后端：
- 启动时构建"全历史已知 IP 集合"（存 md5 哈希）：
  a) 读取 /opt/eve/stats/dau_total.json 的 ips 数组（已有的全站历史档案）
  b) 读取自己维护的 /opt/eve/screen/known_ips.json（没有则空）
  c) 回放日志过程中出现的 IP 一并并入
- 运行期：访问记录的 IP 哈希不在集合中 → is_new=true，同时把该哈希追加进 known_ips.json（json 数组，写时先读后写、失败静默）并加入内存集合
- /api/stats：recent[] 每条加 is_new 布尔；另加 new_count_24h（近24小时新 IP 数，仅 API 字段，页面不加卡片）
前端：
- recent 列表里 is_new=true 的条目：亮橙色描边"新"徽章 + 该行淡橙色背景高亮，视觉上要比"代理"徽章更醒目
- 打码规则不变

## 约束与自测
- 不改：其他布局、2 秒刷新、滚动24小时口径、批量归属地、realip 逻辑
- 自测：systemctl is-active eve-screen；curl localhost:8377/ 200；/api/stats 的 recent 含 is_new 字段、new_count_24h 存在；页面包含"新"徽章样式代码；known_ips.json 生成且随访问增长
