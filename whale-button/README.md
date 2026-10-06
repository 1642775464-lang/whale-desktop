# whale-button · 页面内小鲸鱼按钮

> **本目录不实现按钮代码。** 真正的实现在 `whale-bridge/lib/client.js`。

## 为什么代码不在这里

《轻量架构草案》§5.4「归属决策」早已拍板：

> Cordis 的客户端半侧插件**必须与宿主插件同包声明**（`client.js` 要在 `package.json`
> 里声明为客户端入口）。
> 决策：按钮代码物理上放 `whale-bridge/lib/client.js`；`whale-button/` 目录
> **不重复实现**，只放说明与产物。

理由：避免同一份代码两处维护（单一事实源）。代价是目录名与实际位置不完全对应，
架构草案已**显式记录此偏离**，本文件是它在实施层的对应说明。

## 按钮是什么

| 项 | 值 |
|---|---|
| 位置 | DSH 页面右下角，距边 20px |
| 尺寸 | 40×40，圆形（`border-radius: 50%`） |
| 图标 | 与悬浮条同一枚鲸鱼（源：`whale-hud/renderer/favicon-whale.svg`） |
| 挂载槽 | `shell.overlay`（PRD F8 指定） |
| 单击行为 | **同时**拉起悬浮条与小窗（两个 `POST /whale/open`，`target` 分别为 `hud` / `window`） |

## 两条容易踩的坑

**一、`shell.overlay` 是 click-through 的。**
宿主原文：*"The layer itself is click-through — entries opt back into pointer events."*
组件的根节点必须自己写 `pointerEvents: 'auto'`。不写时按钮**看得见但点不动**，
而且不报错——最难查的那种。验收判据 E6 专门盯这一条。

**二、图标 path 不要手抄。**
那条 path 有 3394 个字符。写这个按钮时我凭印象编了一段鲸鱼形状，
与真图标完全不同——PRD 早就警告过「不要试图手抄，会抄错」。
现在由 `tools/whale-btn-icon.mjs` 机械注入，注入结果与源文件逐字符核对。

```bash
node tools/whale-btn-icon.mjs           # 注入
node tools/whale-btn-icon.mjs --check   # 校验（CI 用）
node tools/verify-btn-icon.mjs          # 独立复核（另一套抽取逻辑）
```

## 相关文件

| 文件 | 作用 |
|---|---|
| `whale-bridge/lib/client.js` | 按钮实现（客户端半侧） |
| `whale-bridge/package.json` | 声明 `exports["./client"]` 与 `dsh.client` |
| `whale-bridge/cordis.patch.yml` | bundle 补丁（安装时读它） |
| `tools/whale-btn-icon.mjs` | 图标机械注入 |
| `tools/button-probe.mjs` | 验收探针 |
| `tests/contract/whale-button.test.mjs` | 契约测试 |
