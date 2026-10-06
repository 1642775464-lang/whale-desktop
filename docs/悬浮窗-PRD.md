# Whale Desktop · 悬浮窗 PRD

- 文档版本：v2.0
- 日期：2026-10-05
- 产品代号：Whale HUD（悬浮条）
- 状态：**定稿**，作为单一事实源
- 上游依据：`_inbox/extracted/PRD/悬浮窗PRD.md`（v1.0）+ `_inbox/extracted/原型/悬浮窗原型.html`
- 配套原型：同一原型文件
- 冲突裁决顺序：**本 PRD > 《悬浮窗-ARCHITECTURE.md》 > 《悬浮窗-STATUS.md》**

> 本文档与上游 v1.0 的差异，全部集中标注为「v2 变更」。无标注处即与上游逐字等价。

---

## 一、这份东西是什么

贴屏幕**顶边居中**的一条常驻悬浮条。本质是 DSH 会话的**桌面状态栏**：

```
(鲸鱼) ● 继续开发豆包式小窗口   |   – tok/s   |   193k
  ①     ②        ③              ④             ⑤
```

用户不需要打开 DSH 页面、不需要切到浏览器，余光瞥一眼就知道：现在有没有任务在跑、跑多快、上下文吃到多少。

**一句话定位**：把 DSH 会话的运行时状态，从浏览器标签页里搬到桌面上一条永远看得见的地方。

---

## 二、为什么做它

### 2.1 真实痛点

用户在 DSH 里跑长任务时，必须频繁切回浏览器标签页才能看到进度。切走之后：不知道回合跑完没有、不知道有没有卡在工具执行、不知道上下文是不是快满了、想把窗口叫回来还要找标签页。

### 2.2 为什么不做成托盘图标

托盘图标只能表达「在/不在」，表达不了「跑到哪了」。本产品的核心价值恰恰是**实时数值**：速度、上下文占用、当前会话是哪个。

### 2.3 为什么不做脉冲动效

曾规划过「脉冲动效展示任务推进」，用户看过三四版原型后明确否决。

> **结论：不做。这条写进 PRD 是为了防止后来人重新提议。**

---

## 三、功能需求

### F1 常驻顶边显示（P0）

| 项 | 要求 |
|---|---|
| 位置 | 主显示器**顶边居中**，水平居中于工作区 |
| 尺寸 | 条本体 560 × 52；窗口 588 × 72（含阴影边距） |
| 层级 | `setAlwaysOnTop(true, 'screen-saver')`，可压过最大化窗口标题栏 |
| 任务栏 | 不出现（`skipTaskbar: true`） |
| 多桌面 | 所有虚拟桌面可见（`setVisibleOnAllWorkspaces`），含全屏应用之上 |
| 焦点 | 启动用 `showInactive()`，不抢当前焦点 |
| 圆角 | 由 CSS 负责，窗口 `roundedCorners: false` |

**几何常量**（`whale-hud/main.cjs`）：

```
BAR_HEIGHT = 52
TOP_GAP = 6          上方只留 6px —— 负窗口 y 会被 Windows 夹回 0，把条推出屏幕上缘吃掉上圆角
SHADOW_PAD = 14      左右与下方留 14px 画 CSS 阴影
MENU_EXTRA_HEIGHT = 268   悬停下拉时窗口临时加高
```

### F2 五个界面元素（P0）

| 编号 | 元素 | 行为 |
|---|---|---|
| ① | 鲸鱼头像 | 单击唤起小窗；小窗已在跑时再点收起。外圈绿环 = 小窗在跑；红闪 = 操作失败 |
| ② | 状态点 | 绿呼吸 = 回合在跑；灰 = 空闲；红 = 桥连不上 |
| ③ | 会话标题 | 见 F3、F4 |
| ④ | token 速度 | 当前回合实时生成速度，单位 tok/s。数字变灰 = 回合已结束（冻结值） |
| ⑤ | 上下文占用 | 当前上下文占用（不是累计消耗）。悬停出详情弹层 |

**图标来源**：DeepSeek 官方 favicon path（`viewBox="0 0 50 50"`），从
`<DSH 安装目录>/resources/app/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg` 取得，
**不要试图手抄或用 `edit` 替换整串**，会抄错。

> v2 变更：上游写「3394 字符」，本机实测该文件 3634 字节。以**文件为准**，实现时直接复制文件内容，
> 不按字符数校验。复制命令见《悬浮窗-ARCHITECTURE.md》6.3 节。

**配色（用户 2026-10-04 裁定）**：浅紫淡蓝渐变底 `linear-gradient(135deg,#E9EBFC,#DDE2FA)` +
深色鲸鱼 `#1F2430` + 更浅紫蓝外环。与官方侧边栏那枚圆形按钮同款。

> 换配色的**硬约束**：底色与填充必须反色。深底配白、浅底配深。曾经在蓝紫底上放黑标志，图标整个看不见。

### F3 悬停详情（P0）

鼠标停在⑤上下文段上，窗口临时加高（72 → 340px），弹出五行详情：

| 行 | 含义 |
|---|---|
| 上下文占用 | 当前上下文占用，**不累加**（口径见 4.1） |
| 累计输出 | 每条 `outputTokens` 累加 |
| 累计输入 | 每条 `inputTokens` 累加 |
| 累计缓存读 | 每条 `cacheReadTokens` 累加 |
| 步数 / 回合 | `step/start` 与 `turn/start` 计数 |

鼠标移开 180ms 内缩回；另有 **3 秒兜底定时器**，防止漏发缩回指令导致窗口一直高着。

> **为什么不常驻高窗口**：Electron 的透明窗口在 Windows 上**照样拦截鼠标事件**（透明像素不穿透）。常驻一个 588×270 的高窗口等于凭空多出一大片「隐形点击陷阱」，比下拉偶尔被裁严重得多。

### F4 多会话滚筒翻转（P0）

**触发条件**：同时有 **2 个及以上**会话的回合在跑。

| 项 | 规格 |
|---|---|
| 停留 | 每个标题 **3 秒** |
| 翻转 | **0.5 秒**（上半程 250ms + 下半程 250ms） |
| 总周期 | **3500ms** |
| 锁定 | 单击标题锁定，右侧出 🔒；再点解锁 |
| 悬停 | 出下拉列全部进行中会话，当前显示的项高亮 |
| 点下拉项 | 跳转该会话并顺手锁定（否则 3 秒后又翻走） |
| 单会话 | **不翻转**，标题静止 |

**「进行中」判据**：`speed.phase === 'running'`，即**回合还没结束**。

> 不能用「最近有没有出 token」判定：工具执行阶段（跑命令、读文件）根本不产 token，但回合明显在跑。实测一条回合里 tool/call 有 **309 次**，用 token 判会把这类活跃会话误判成空闲。

**翻转的两个防御机制**（踩坑后加的，别删）：

1. **DOM 代际号 `reelGen`**：翻转由两个定时器驱动，中途若重建 DOM，旧定时器会去改**已脱离文档的孤儿节点**，表现为翻转卡住且无报错。代际号让过期回调自行作废。
2. **`rolling` 自愈看门狗**：`rolling` 是防重入互斥锁，只有两个翻身定时器会放掉它。万一有路径绕过（定时器被降频、异常中断），它会永久停在 `true`，表现为「标题再也不动且毫无报错」。看门狗强制放掉。另外 `stopRoll()`（点击锁定时调用）也主动放掉 `rolling`。

**翻转的视觉实现要点**：两个面不同时透明还不够。必须保证**同一个可见面上的文字不被中途改写**。

- `swapAt`（250ms）里**只改 `front`，刻意不碰 `back`**
- 下半程**先清类再改 `back`**

原因：清类后 `front` 恢复 `opacity:1`，而 DOM 顺序上 `front` 在 `back` **之后**（更上层），`back` 被完全盖住，这时改它看不见。顺序反了会有 16ms 的可见窗口，闪出一个错误标题。

**锁的自动清除**：会话掉到 1 个时自动清锁。否则出现「只剩一个会话、🔒 还挂着」的状态，那个锁既无法解释，本来就没在滚，点了也没反应。

### F5 收起 / 展开（P0）

**收起**：点击条右端的箭头按钮（**朝左**），条从右向左收进去，缩成一个圆形悬浮球。

**展开**：点击悬浮球，条从球的位置向右伸出去。

**核心模型（用户 2026-10-04 裁定）**：

> 球就是条左端的那个图标，全程**不动**。收起 = 其余部分缩回图标右边缘；展开 = 从那里向右长出。

屏幕上**永远只有一个鲸鱼图标**。

| 常量 | 值 | 含义 |
|---|---|---|
| `BALL_WINDOW_SIZE` | 88 | 球形态窗口边长 |
| `BALL_INSET_X` | 24 | 球在窗口内的左边距 |
| `BALL_INSET_Y` | 12 | 球在窗口内的上边距 |
| `BALL_DIAMETER` | 40 | 球直径 |
| `BAR_ICON_CENTER_X` | 42 | 图标在条内的中心 x |
| `BAR_ICON_CENTER_Y` | 32 | 图标在条内的中心 y |
| `COLLAPSE_MS` | 275 | 收起动画时长 |
| `EXPAND_MS` | 335 | 展开动画时长 |

**球可拖动，支持全屏拖**。拖动阈值 3px：`mousedown` → `mouseup` 之间位移超过 3px 算拖动，否则算单击。

**三个必须绕开的坑**：

1. **摘掉动画类会连 `forwards` 填充一起消失**，条会弹回 560px，被 88px 窗口裁出一圈「蓝紫渐变残影」。终态必须由 `.collapsed` 自己声明 `transform: scaleX(0)`。
2. **`overflow: hidden` 对所有后代生效**（含 `position: fixed`）。收起态必须 `overflow: visible`。
3. **祖先一旦自带 `transform`，就成为后代的包含块** —— 后代 `position: fixed` 不再相对视口。条的 `scaleX(0)` 会把图标压成 0 宽（实测 `whale.w = 0`），此时 `position:fixed` / `z-index` / `overflow:visible` **全都救不了**。

> 第 3 条的**唯一解**：收起时把 `#whaleBtn` 从 `.bar` 物理挪到 `document.body`，展开时按原位插回。用 `whaleHome = {parent, next}` 记录原位，靠 `insertBefore` 还原而不是 `appendChild`。

**`whaleHome` 是内存态**：页面 reload 后它丢失但 DOM 不复原（图标还挂在 body 下），必须处理「已经在 body 里」的情况 —— 按**首位**插回条内。

**展开顺序**：先恢复窗口（`window.hud.ballMode(false)`）**再**播动画。窗口是裁剪边界，必须先到位。

### F6 会话完成提醒（P1）

会话完成时：标题框显示对应会话标题 + 悬浮条小幅震动，持续 2 秒。

> 震动是**位移**类动效，不是脉冲。脉冲已被否决（见 2.3）。

### F7 右键菜单（P0）

条面上不放 `⋯` 按钮（用户要求只留五元素）。但「隐藏 / 退出」不能丢 —— 托盘图标已移除，右键菜单是关掉这条的**唯一途径**。

| 项 | 行为 |
|---|---|
| 重新加载界面 | 重载渲染层，不动会话 |
| 隐藏悬浮条 | 只隐藏窗口，进程还在 |
| 退出悬浮条 | 真退出 |

### F8 入口：DSH 页面内的小鲸鱼按钮（P0）

用户 2026-10-04 原话：「小窗和悬浮窗不需要右下角图标，直接把他们做成一个小鲸鱼放在 DEEPSEEK 页面这个位置，点击就弹出悬浮窗和小窗」。

- 位置：DSH 页面右下角
- 实现：`whale-button` 客户端插件，挂 `shell.overlay` 槽
- 行为：单击**同时**拉起悬浮条与小窗
- 两个系统托盘图标已按此要求**移除**（`createTray()` 直接 return null，`createTrayLegacy()` 保留备用）

---

## 四、数据来源

```
DSH 会话事件（assistant/message.usage）
      ↓  桥订阅 session/event 并折叠
桥的 hudBySession（按会话维护统计）
      ↓  GET /whale/hud（一次性全量）+ GET /whale/hud/events（SSE 增量）
悬浮条渲染
```

### 4.1 token 口径（v2 变更 —— 本条推翻上游 v1.0）

> **上游 v1.0 原文**：usage 四字段 `inputTokens / cacheReadTokens / outputTokens / totalTokens`，
> 其中「上下文占用 = 最后一条 `totalTokens`，不累加」。
>
> **本机实测**：宿主 `@deepseek-ai/dsh-llm` 的 `TokenUsage` 确实**声明**了 `totalTokens?: number`，
> 但 `@deepseek-ai/dsh-token-meter` 的持久化投影**完全不读它**。上游 v1.0 的口径依赖一个 provider
> 可选上报、宿主不保证存在的字段，属于不可靠口径。用户在步骤 1 拍板选 C，本条随之改写。

**权威来源（三条，各管各的，不得混用）**：

| 用途 | 取值 | 来源 |
|---|---|---|
| **上下文占用**（分子） | `contextPressure` 投影的 `projectedTokens`，缺失时回退 `pressureTokens` | `contextPressure` 投影 `wire.view` |
| **上下文占用**（分母） | `contextWindow` | `request/context` 事件 |
| **累计输出 / 累计输入 / 累计缓存读** | `tokenUsage` 投影 `totals` 的 `outputTokens` / `uncachedInputTokens` / `cacheReadTokens` | `tokenUsage` 投影 `wire.view` |
| **tok/s** | 最近 8 秒窗口内 `outputTokens` 增量 ÷ 窗口时长 | 见 4.2 |

**两个投影的精确形状**（实现必须照抄，不得自创字段）：

```js
// tokenUsage 投影：key 'tokenUsage'，wire.view(state) => state.totals
totals = { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }

// contextPressure 投影：key 'contextPressure'，wire.view 输出
{
  contextWindow?,     // 分母，request/context 提供
  pressureTokens?,    // 分子：prompt 侧压力，不含 output
  projectedTokens?,   // 分子：max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens)
}
```

**为什么投影口径能反映 compaction**：`pressureTokens` 只在请求上报 usage 时前进，它看不见压缩；
投影因此额外维护一个 `surfaceTokens` 运行总量，用「采样点 + 采样后 surface 的有符号位移」
得出 `projectedTokens`，回答的是**下一次请求**的上下文占用。

> 上游 v1.0 里「不累加」「取最后一条」的**语义判断仍然正确**（上下文是某个瞬时值，不是累计量），
> 被改写的只是**取哪一个字段**。累计输出/输入/缓存读仍然是逐条累加，这一点不变。

### 4.2 速度算法

**用最近 8 秒窗口内的 output 增量 ÷ 窗口时长**，不是「回合总量 ÷ 回合总时长」。

原因：回合时长里含工具执行、等待用户、网络往返等**不产 token** 的时间。用总量算会被严重低估且剧烈抖动。

```
SPEED_WINDOW_MS = 8000
```

- 窗口内样本都过期后速度**归零**（但累计数字不受影响）
- 回合结束时速度**冻结**，用户仍能看到刚才跑多快
- 新回合开始时清空采样，避免上一回合的尾巴算进新回合
- 桥侧每 **2 秒**心跳重算一次，让「已经停了」的速度自然衰减

### 4.3 统计内核

`whale-hud/lib/usage-stats.mjs`，**纯函数**，不碰任何宿主 API，因此可以脱离宿主单测。

单独一个文件的理由：桥的 `host-impl.js` 会撑得很大，且 import 了 cordis 服务只能在宿主进程跑；而统计内核是纯的。

---

## 五、技术约束（改代码前必读）

### 5.1 必须带 `--no-sandbox`

开 Chromium 沙箱时，GUI 初始化阶段直接崩 `0x80000003`（STATUS_BREAKPOINT），**存活仅 15~20ms，连 `main.cjs` 的模块体都执行不到**，所以看不到任何日志，表现成「双击没反应」。

逐层剥离实测，**只有 `--no-sandbox` 能越过去**（5009ms 存活 vs 20ms 崩溃）：

```
--disable-gpu  --disable-gpu-sandbox  --no-zygote  --in-process-gpu
--disable-dev-shm-usage  --disable-features=RendererCodeIntegrity
--disable-crashpad          ← 以上全部无效
```

### 5.2 必须显式 `app.setPath('userData', ...)`

让 Electron 去解析**默认** userData 路径会让进程**原生崩溃** —— 退出码 `-36861` / `0xFFFF7003`，**不抛 JS 异常、try/catch 接不住、日志来不及写**。

原子级对照（四个变体只差一行）：

| 变体 | 结果 |
|---|---|
| 仅 `require('electron')` | 崩 `0xC0000005` |
| `+app.setName(...)` | 崩 `0xC0000005` |
| `+app.getPath('userData')` | 崩 **`0xFFFF7003`** ← 就是这一行触发的 |
| `+setPath + 建窗` | **正常存活，窗口创建成功** |

配套要求：**不要在模块顶层调 `app.getPath()`**，日志路径用惰性 `ensureLogPaths()`。

### 5.3 CSP 必须放行 `'self'`

```
default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';
connect-src http://127.0.0.1:* http://localhost:*
```

若只写 `script-src 'unsafe-inline'`，那只放行**内联**代码，`<script src="hud.js">` 与 `<link href="hud.css">` 会被**静默拦截** —— 窗口里只剩 HTML 字面文本（「未连接」）、没样式没数据，且除了渲染进程控制台之外看不到任何报错。

### 5.4 Windows 上做不到桌面毛玻璃

实测把高对比条纹图铺在窗口背后：窗口内条纹方差 11527 vs 窗口外 12327（比值 **0.935 ≈ 没模糊**），条纹亮度在窗口边界从 21.2 硬跳到 250.6。

原因：Chromium 的 `backdrop-filter` 只能取**同一合成层内**的兄弟元素，桌面不属于这个 WebContents 的合成图，故它对着空集合做模糊。

> **白底浮在白色窗口上时靠三层阴影 + 描边与背景分离，不靠底色反差。**

### 5.5 client 侧 JS 改动必须实地跑

`node --check` **只查语法**，查不出 TDZ（`ReferenceError: Cannot access 'X' before initialization`）。

**实际踩过**：把时长口径自检的 `if` 塞在它引用的 `const FLIP_HALF_MS` 之前 → 脚本顶层抛错 → **后面的事件绑定一行都没执行到** → 元素都在、看得见，但单击/右键/滚轮全哑。

规则：改完 client 侧 JS 必须**实地加载**一次并看 `Runtime.exceptionThrown`。离线正则单测和 `node --check` 都不算数。

### 5.6 CDP 调试端口 9334 就是悬浮条自己的渲染进程

**永不对它发 `Page.navigate`** —— 那等于把悬浮条窗口劫持成浏览器。验证原型用独立浏览器实例。

---

## 六、已知限制

| 限制 | 说明 | 是否要修 |
|---|---|---|
| 无全局热键 | `globalShortcut` 在 DSH 壳内 0 处，属刻意 | 延后 |
| 位置固定顶边居中，不支持拖动 | 它是「状态栏」语义，固定才有可预期性 | 不修 |
| 顶边被最大化窗口标题栏压住 2~3px | `floating` 层级低于最大化前台窗口标题栏。改 `screen-saver` 能压过去但会挡住全屏应用 | 有意保留 |
| 与页面右下角按钮存在视觉重叠风险 | 顶边居中 vs 右下角，同屏时注意 | 观察 |
| 会话列表只显示桥已知的会话 | 纯磁盘上的历史会话需先唤醒 | 不修 |
| 速度显示 `–` 表示样本不足 | 如正卡在工具执行阶段 | 正常 |
| 绿环在浅色底上对比度略降 | 换浅底配色后的副作用 | 不修 |

---

## 七、文件与目录（v2 变更 —— 按本仓库布局）

```
whale-hud/
├── main.cjs              Electron 主进程（窗口 / IPC；托盘代码已停用）
├── preload.cjs           只暴露 window.hud.{openWindow,hide,quit,reload}
├── run.ps1               启动脚本（必用）
├── package.json
├── assets/hud.png        图标资源（托盘已停用，备用）
├── renderer/
│   ├── index.html        结构 + CSP
│   ├── hud.js            渲染逻辑 + SSE 接入
│   ├── hud.css           样式
│   └── favicon-whale.svg 从 DSH 安装目录复制的官方鲸鱼 path
├── lib/usage-stats.mjs   统计内核（纯函数，可单测）
├── .userdata/            运行数据（userData，日志在此）
└── shots/                验收截图
```

- **运行时共享**：与小窗共用同一个 Electron，放在仓库根 `runtime/electron.exe`，不各存一份副本。
- **日志**：`whale-hud/.userdata/whale-hud.log`

---

## 八、验收标准

| 编号 | 项 | 判据 |
|---|---|---|
| A1 | 顶边居中显示 | 主屏工作区水平居中，y = 顶边 |
| A2 | 不抢焦点 | 启动后当前焦点窗口不变 |
| A3 | 不占任务栏 | 任务栏无条目 |
| A4 | 五元素齐全 | 鲸鱼 / 点 / 标题 / 速度 / 上下文 |
| A5 | 悬停详情 | 移入加高到 340px，移出 180ms 内缩回 |
| A6 | 滚筒时长 | 停留 3000ms（±50）、翻转 500ms（±50）、周期 3500ms（±50） |
| A7 | 滚筒不闪假标题 | 可见文字序列中不出现「下一个的下一个」 |
| A8 | 收展几何 | 展开 `winW 588 / bar 560 / whale [22,12,40,40] parent=DIV`；收起 `winW 88 / bar 0 / whale [24,12,40,40] parent=BODY` |
| A9 | 收展不跳 | 图标屏幕坐标两态一致（实测都是 36） |
| A10 | 球可拖 | 全屏范围可拖，单击/拖动阈值 3px |
| A11 | 无控制台报错 | `Runtime.exceptionThrown` 为空 |

### 8.1 逐条可测化（v2 新增，满足「逐功能可测 + 量化验收」门禁）

| 编号 | 自动化判据 | 验证手段 |
|---|---|---|
| A1 | `window.getBounds()` 的 `x + 588/2 === workArea.x + workArea.width/2`（±1），`y === workArea.y + 6`（±1） | 主进程日志 + CDP `Runtime.evaluate` |
| A2 | 启动前后 `GetForegroundWindow()` 返回同一 HWND | PowerShell 子进程 |
| A3 | `Get-Process electron` 主窗句柄的 `MainWindowTitle` 不出现在任务栏枚举里（`skipTaskbar` 生效） | `ITaskbarList` 不可直接读，改判：`BrowserWindow.isVisible()` 为 true 且进程无任务栏按钮 → 用 UIA 枚举任务栏子项计数不变 |
| A4 | DOM 查询五个元素选择器全部命中且 `offsetWidth > 0` | CDP 9334 |
| A5 | 悬停前 `getBounds().height === 72`；悬停后 340；`mouseleave` 后 180ms±40 内回到 72 | CDP 派发 `mouseenter`/`mouseleave` + 主进程日志时间戳 |
| A6 | 采集 3 个完整周期的 `swapAt` 时间戳，间隔 3500±50ms；单次翻转动画起止差 500±50ms | 渲染层埋点 `window.__hudTiming` 数组 |
| A7 | 采集连续 20 次翻转的可见标题序列，不含「跳过一项」的模式 | 渲染层埋点采样 |
| A8 | 收起态 `document.getElementById('whaleBtn').parentElement === document.body`；展开态 `=== .bar`；两态 `winW` 分别 88 / 588 | CDP 9334 |
| A9 | 两态下 `getBoundingClientRect()` + `screenX/screenY` 换算出的图标屏幕坐标相同（±1px） | CDP + `physicalBounds()` |
| A10 | `mousedown`→移动 4px→`mouseup`：窗口 `x` 变化 4px（±1）；移动 2px 则判定为单击且触发 `openWindow` | CDP 派发合成鼠标事件 |
| A11 | 全程 `Runtime.exceptionThrown` 事件数 = 0 | CDP 9334 订阅 |

---

## 九、版本沿革

| 日期 | 变更 |
|---|---|
| 2026-10-03 | 初版：深色底、条高 34、窗口宽 620 |
| 2026-10-04 | 白底改版（用户裁定「白底 + 更明显的边界」），条高 34→52 |
| 2026-10-04 | 移除 `唤` 与 `⋯` 两个按钮；托盘图标移除；入口改为页面内小鲸鱼按钮 |
| 2026-10-04 | 图标换成 DeepSeek 官方 favicon path |
| 2026-10-04 | 加固完成提醒（标题跳 + 2s 震动） |
| 2026-10-04 | 收起 / 展开功能（箭头朝左） |
| 2026-10-04 | 收起改版：球与条左端图标合一，球全程不动 |
| 2026-10-04 | 图标配色改浅底深鲸鱼（用户从五版原型中选①） |
| 2026-10-04 | 滚筒时长口径：停留 3s + 翻转 0.5s（总周期 3500ms） |
| 2026-10-05 | 修复「假标题一闪」（swapAt 只改 front） |
| 2026-10-05 | 修复 TDZ 导致的全交互失效 |
| **2026-10-05** | **v2.0 定稿：按本仓库重新实施；F3「上下文占用」口径改为 token-meter 投影（D1 决策 C）；目录结构改为仓库根 runtime 共享；新增 8.1 逐条可测化** |
