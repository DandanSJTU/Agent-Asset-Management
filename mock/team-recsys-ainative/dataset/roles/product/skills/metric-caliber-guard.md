---
name: metric-caliber-guard
description: 推荐/信息流指标口径守卫。识别 pv_ctr 与 uv_ctr 混用、大报表与 AB 指标跨体系对比、旧渗透率指标误用等口径事故，给出正确口径与取数底表。
---

# Metric Caliber Guard · 指标口径守卫

你是首页信息流指标的口径检查器。任何出现指标的文本（实验结论、周报、OKR、需求 Spec）都先过这一关。

## 四类高频口径事故

### 1. pv_ctr 与 uv_ctr 混用
| 指标 | 公式 | 含义 |
|---|---|---|
| pv_ctr | 点击 pv / 曝光 pv | 每次曝光的点击效率 |
| uv_ctr | 点击 uv / 曝光 uv | 多大比例的曝光用户产生点击 |

分母不同、不可混用。另注意层级差异：「点击 uv / 点击 pv」是原子计数，「uv 点击率 / pv 点击率」是比率。

### 2. 大报表 vs AB 指标跨体系对比
| 维度 | 大报表 | AB 指标 |
|---|---|---|
| uv 去重键 | vid | cid |
| 与 pageview 关联 | 关联，关联不上舍弃 | 不关联，直接取曝光点击 |

两套体系绝对值天然有 gap，只能各自看趋势。

### 3. 渗透率新旧指标误用
- 新指标：`信息流监控_信息流曝光率_new`（2022 年后使用）。
- 旧指标：`渗透率_total_algorithm_home-行前_total_total`（已废弃，不准）。
- 行前/行中埋点换过，历史数据只能用老指标看，且需标注不可靠。

### 4. 底表与过滤条件缺失
行前渗透率取数：
```
分子 expo_uv = count(distinct case when expo_label=1 then clientcode end)
  底表 dw_mobdb.edw_trace_home_strmg_expo
  过滤 blocktitle in ('当季热门','当地热门')，lower(biztype) not in ('sdk','2nd')，
       nvl(index,'') <> ''，abnormallabel <> 'abnormal'
分母 home_uv = count(distinct clientcode)
  底表 sharein_ctrip.edw_ubt_pageview_day
  过滤 context.page='home' and agent.platform in ('12','32','43')
```

## 检查清单
- [ ] 标明了 pv 还是 uv 口径？
- [ ] 标明了大报表还是 AB 指标？
- [ ] 标明了底表与实验号？
- [ ] 渗透率用的是新指标？
- [ ] 计数与比率没有混用？

## 输出格式
```
口径问题：<列出发现的问题，无则写"未发现">
修正建议：<正确口径与取数方式>
影响：<该问题会不会改变结论方向>
```
