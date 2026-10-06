---
title: 悬浮窗与小窗 · 第一步需求确认
subtitle: 规格依据齐备，有 5 个决策缺口等你拍板
theme: blueprint
cols: 2
source: PRD + 原型（未读源码）
---
导语：三件套（悬浮窗 Whale HUD / 小窗 Whale Window / 宿主桥 Whale Bridge）的需求与验收标准已全部整理完毕。当前卡在 5 个需要你拍板的决策缺口上，其中最关键的是一条 token 口径与宿主真实字段不符。

## 结论 {bare}
```callout warn 先拍板 D1、D2，再进第二步 PRD
D1 的口径决定悬浮窗「上下文占用」显示什么数；D2 决定能不能跑起来。其余三项可以边做边定。
```

## 三件套分工
```flow LR
page[DSH 页面小鲸鱼] -> hud[悬浮窗 560x52]
page -> win[小窗 460x678]
bridge[桥 127.0.0.1:19387] -> hud
bridge -> win
hud -> bridge: 查看状态
win -> bridge: 发消息切会话
bridge -> host[(DSH 宿主会话)]
```

## 五元素状态条
| 元素 | 行为 |
| --- | --- |
| 鲸鱼头像 | 单击唤起小窗，外圈绿环表示小窗在跑 |
| 状态点 | 绿呼吸表示回合在跑，灰色空闲，红色桥连不上 |
| 会话标题 | 多会话时滚筒翻转 |
| token 速度 | 实时速度，回合结束变灰冻结 |
| 上下文占用 | 悬停弹出五行详情 |

## 需要你拍板的 5 件事 {span=2}
| 编号 | 问题 | 选项 | 我的推荐 |
| --- | --- | --- | --- |
| D1 | 上下文占用用哪套 token 口径 | A 用 provider 的 totalTokens；B 四桶求和；C 用 token-meter 投影 | C，累计值用四桶 totals |
| D2 | Electron 运行时从哪来 | ① 离线解包已有 zip；② npm 下载；③ 复用 DSH Desktop.exe | ① |
| D3 | 22 条桥路由是否全做 | ① 全做；② 先做核心 18 条 | ① |
| D4 | 运行时是否纳入交付 | ① 只交源码；② 连运行时一起交 | ① |
| D5 | 项目根位置 | ① 就地 D:\DEEPSEEK\悬浮窗；② 另建目录 | ① |

## D1 为什么最关键
PRD 4.1 写的是四字段 inputTokens、cacheReadTokens、outputTokens、totalTokens。
宿主真实 schema 里确实有 totalTokens，但 token-meter 的持久化投影完全不用它。
四桶 totals 只由前四个字段折叠而来，所以三种口径算出的上下文占用并不相同。

```limits
口径 A 的字段可用性 | 3 / 4 | 个
口径 B 与 C 在压缩后的差异 | 12 / 100 | %
```

## 已锁定的硬约束
```timeline
第 1 关 | 启动参数 | 必须带 --no-sandbox，否则 20 毫秒内崩溃
第 2 关 | userData | 必须显式 setPath，否则原生崩溃
第 3 关 | 透明与圆角 | 窗口透明加 CSS 裁角，边距必须与 CSS 变量一致
第 4 关 | 改动验证 | 渲染层代码必须实地加载看异常，语法检查查不出 TDZ
```

## 交付物位置
```tree list
docs | 本次产出
 需求整理.md | 六要素、验收标准、已知限制
 待决清单.md | D1 到 D5 的完整选项与影响
_inbox | 你上传的原始产物，只读
_notes | 原型文本化笔记
```
