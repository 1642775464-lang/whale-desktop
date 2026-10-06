# Whale Desktop · ARCHITECTURE 总入口

- 文档版本：v1.0
- 日期：2026-10-05
- 状态：**草案**（架构层持续迭代，每次改动追加迭代日志，不覆盖历史）
- 项目根：`D:\DEEPSEEK\悬浮窗`
- 冲突裁决顺序：**PRD > ARCHITECTURE > STATUS**

---

## 一、这份文件的作用

本文件是**架构层的总入口**，回答「用什么做」和「怎么摆」：

| 层 | 文档 | 回答什么 |
|---|---|---|
| 边界与 NFR | [`docs/边界与NFR说明书.md`](docs/边界与NFR说明书.md) | 做到哪、不做什么、47 条非功能指标、14 类失效模式 |
| 技术栈 | [`docs/技术栈选型说明书.md`](docs/技术栈选型说明书.md) | 六层选型与推荐理由；运行时第三方依赖 = 0 |
| 架构草案 | [`docs/轻量架构草案.md`](docs/轻量架构草案.md) | 目录分层、核心模块、数据模型、服务端逻辑、迭代日志 |
| 前端设计规范 | [`docs/前端设计规范.md`](docs/前端设计规范.md) | 视觉单一事实源（步骤 3 锁定） |
| 页面框架 | [`docs/页面框架.md`](docs/页面框架.md) | 页面清单与框架结构 |

---

## 二、三层结构（一句话版）

```
第 3 层 呈现层   whale-hud / whale-window / whale-button
                 └── 独立 Electron 进程 ×2，宿主客户端插件 ×1
                          │
                          │  HTTP / SSE（唯一通路，零宿主包依赖）
                          ▼
第 2 层 桥        whale-bridge · Cordis 插件 · 127.0.0.1:19387
                 └── HTTP 服务 / SSE 广播 / 双折叠器 / 进程管理
                          │
                          │  进程内直接调用
                          ▼
第 1 层 宿主      DSH Desktop（既有，不改）
                 └── sessions / agents / commands / persistence
```

图解与完整目录树见 [`docs/轻量架构草案.md`](docs/轻量架构草案.md) 第二章。

---

## 三、架构层铁律

| 编号 | 铁律 | 可机械检查 |
|---|---|---|
| A-1 | 呈现层**不得**出现 `require('@deepseek-ai/...')` 或 `import '@deepseek-ai/...'` | ✅ `tests/layering.test.mjs` 静态扫描 |
| A-2 | 呈现层与宿主之间**唯一通路**是 `127.0.0.1:19387` 的 HTTP / SSE | ✅ 扫描硬编码宿主端口 |
| A-3 | 纯函数模块（`fold.mjs` / `usage-stats.mjs` / `zstd-frame.mjs`）不得引入 IO 依赖 | ✅ 单测可脱离宿主运行 |
| A-4 | 渲染层零框架零构建 | — 目录内无 `package.json` 依赖 |

---

## 四、关键实现口径（易错点）

| 项 | 口径 | 出处 |
|---|---|---|
| 上下文占用 | `inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)`，分母 `request/context.data.contextWindow` | D1·C 方案 |
| 累计用量 | `tokenUsage.totals` 四桶（uncachedInput / output / cacheRead / cacheWrite） | 同上 |
| 落盘 usage 字段 | 仅 4 个：`inputTokens` / `outputTokens` / `totalTokens` / `cacheReadTokens`。**无 `cacheWriteTokens`** | 实测 187/187 条 |
| 读落盘事件流 | **逐帧**解 zstd：扫魔数 `28 b5 2f fd` 偏移，按帧切片 `zstdDecompressSync` 后拼接 | 实测单文件 1148 帧 |
| 提交通路 | `agent.followup(message)`；steer 用 `agent.steer(message)` 且要求 `agent.status === "running"` | 对齐宿主 UI |
| 中断 | `agent.cancel({ kind: "user" }, { keepInbox: true })` | 宿主停止键同此 |
| 拉窗复用 | 启动前 `delete process.env.ELECTRON_RUN_AS_NODE`，带 `--no-sandbox` | F6 |
| 速度窗口 | `SPEED_WINDOW_MS = 8000`，心跳 2 秒 | F5 |

---

## 五、架构层风险登记

| 编号 | 风险 | 应对 |
|---|---|---|
| R0 | `C:\docs` 目录联接是编辑器预览的**必要基础设施**，不可删除 | 删除后汇报页在编辑器内立即失效。重建：`cmd /c mklink /J "C:\docs" "D:\DEEPSEEK\悬浮窗\docs"`（需管理员） |
| R1 | `cordis.patch.yml` 被宿主启动时整体重写 | 桥的挂载不能只靠改文件；需验证流程 + 回退脚本 |
| R6 | 按钮目录名与实际位置不符 | 实施时按实际路径校正 |
| R7 | 两份 `usage-stats.mjs` 可能漂移 | 规划为单一实现 + 引用，不复制 |
| R8 | 40 条 tail 上限可能不够 | 观察后调整，属参数非结构 |

---

## 六、架构层待决事项

**当前无待决项。** 后续新增决策缺口追加为架构层待决项，**不得由 AI 自行决定**。

---

## 七、版本沿革

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-05 | 建立总入口；收拢边界/技术栈/架构三份文档并确立四条架构铁律 |
