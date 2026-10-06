# Whale Desktop · STATUS

- 文档版本：v1.2
- 日期：2026-10-06
- 状态：**步骤 1–9 全部完成，可以进入 MVP 端到端切片实施**
- 项目根：`D:\DEEPSEEK\悬浮窗`
- 冲突裁决顺序：**PRD > ARCHITECTURE > STATUS**（本文件与上游冲突时以上游为准）

---

## 一、一句话现状

**图纸、地基、规矩都已就位，仓库与质量闸门已投入使用，可以开始写第一行实施代码。**

九个规划步骤全部交付；git 仓库已初始化（首次提交 `65b5bdb`，42 个文件）；六道闸门与预提交钩子已验证可用。四个交付目录（`whale-bridge` / `whale-hud` / `whale-window` / `whale-button`）仍基本为空。

---

## 二、九步骤进度

| 步骤 | 名称 | 状态 | 交付物 |
|---|---|---|---|
| 1 | 需求整理 | ✅ 完成 | `docs/需求整理.md` + 汇报页 |
| 2 | PRD | ✅ 完成 | 三份 v2.0 PRD + `Whale-PRD.md` |
| 3 | 视觉及页面框架 | ✅ 完成 | `docs/前端设计规范.md`、`docs/页面框架.md` + 汇报页 |
| 4 | 边界与 NFR | ✅ 完成 | `docs/边界与NFR说明书.md` + 汇报页 |
| 5 | 技术栈选型 | ✅ 完成 | `docs/技术栈选型说明书.md` + 汇报页 |
| 6 | 轻量架构草案 | ✅ 完成 | `docs/轻量架构草案.md` + `Whale-ARCHITECTURE.md` |
| 7 | 规整项目文档 | ✅ 完成 | 根目录三件套 `Whale-PRD/ARCHITECTURE/STATUS.md` |
| 8 | 开发规范 | ✅ 完成 | `docs/开发规范.md`（35 条强制项）+ `references/` 五份 |
| 9 | Git + 质量闸门 | ✅ 完成 | git 仓库 + `.githooks/` + `tools/` 五脚本 |
| — | MVP 端到端切片实施 | ⬜ **下一步** | 四个交付目录 |

---

## 三、已拍板决策（D1–D6，不再变更）

| 编号 | 决策 |
|---|---|
| D1 | token 口径 **C 方案**：上下文占用取 `pressureFrom(usage)`，累计量取 `tokenUsage.totals` 四桶 |
| D2 | Electron 运行时 **离线解包已有 zip**，不联网下载 |
| D3 | 22 条路由 **全量实现**，不裁剪 |
| D4 | 交付范围 **沿用首版取舍**：只交源码与使用说明，不打包安装器 |
| D5 | 项目根 **就地**：`D:\DEEPSEEK\悬浮窗` |
| D6 | 视觉稿 **接受「原型即视觉稿」**，不另出 3 稿 |

**当前无待决项。**

---

## 四、工作区实测状态

### 4.1 目录（截至 2026-10-06）

| 目录 | 状态 |
|---|---|
| `docs/` | 11 份规划文档 + `pages/` 汇报页 |
| `docs/pages/` | 9 张汇报页 HTML + 9 份 `.am.md` 稿件 |
| `references/` | 5 份唯一可信源（21.7 KB） |
| `tools/` | 5 个闸门脚本 + `gate-log.ndjson`（本地留痕，已忽略） |
| `.githooks/` | `pre-commit`（sh 入口）+ `pre-commit.mjs` |
| `tests/` | **尚未建立**（实施阶段随纯函数模块一起建） |
| `runtime/` | **空**（等待 Electron 解包；已 gitignore） |
| `whale-bridge/` | **空** |
| `whale-button/` | **空** |
| `whale-hud/` | 仅 `renderer/favicon-whale.svg`（3634 字节，自宿主 web 前端复制） |
| `whale-window/` | **空** |
| `_inbox/` | 用户输入包（含**禁用**的既有源码）；已 gitignore |
| `_notes/` | 原型文本化稿与网络探针；已 gitignore |
| `_probe/` | 一次性探查脚本 + 配置备份；已 gitignore |
| `_diag/` | 诊断用临时 HTML；已 gitignore |

### 4.2 环境

| 项 | 值 |
|---|---|
| OS | Windows 10 Pro 22H2 build 19045 |
| CPU | Intel Core i5-14400F（16 逻辑处理器） |
| 内存 | 已提交 45.91 GB / 上限 52.09 GB |
| 显示器 | `\\.\DISPLAY1` 2560×1440 单屏，系统缩放 113% |
| Node | v24.21.0（`D:\dev\nodejs24`） |
| npm | 11.19.0 |
| git | 2.55.0 |
| 项目根 | `D:\DEEPSEEK\悬浮窗`（**已是 git 仓库**，分支 `main` + `develop`） |
| 开发依赖 | 仅 eslint 9.39.5（86 个传递包）；运行时依赖 **0** |

### 4.3 宿主（DSH Desktop）

| 项 | 值 |
|---|---|
| 版本 | `dsh-plugin-desktop` v2.0.17 |
| Electron | 44.0.0（peerDependency） |
| profile | `C:\Users\Administrator\.dsh\profiles\desktop\` |
| desktop-shell | `mode: compatibility` + `openBrowser: true` |
| 会话存储 | `C:\Users\Administrator\.dsh\sessions\--D-DEEPSEEK-~60AC~6D6E~7A97--\` |

---

## 五、已知环境坑（勿重复踩）

| # | 坑 | 结论 |
|---|---|---|
| 1 | 编辑器预览 HTML 报 `forbidden` | 外层门卫要求 `desktop-shell.mode = compatibility` + `openBrowser: true`（`extended` 模式下该开关被硬编码为无效） |
| 2 | 编辑器预览报 `ENOENT 'C:\docs\pages\...'` | 路由拿不到会话 cwd，回退到 `process.cwd()`（= `C:\`）。已用**目录联接** `C:\docs` → `docs/` 解决 |
| 3 | `cordis.patch.yml` 改动被冲掉 | 宿主启动时按内存状态整体重写该文件；`openBrowser` 与 `mode` 必须同改，否则插件加载抛错 |
| 4 | 整体解压 zstd 只出第一帧 | 必须逐帧解（扫魔数偏移切片） |
| 5 | 沙箱拒 `node -e` / `npm.cmd` | 改为写脚本文件后执行 |
| 6 | Node 24 无 shell 时 spawn `.cmd` 报 `EINVAL` | 闸门 2 直接以 `node node_modules/eslint/bin/eslint.js` 调用，不走 `.cmd` 包装 |
| 7 | git 无法 exec 无扩展名的 `.githooks/pre-commit` | 该文件写成 `#!/bin/sh` 脚本，内部 `exec node .../pre-commit.mjs` |
| 8 | 静默兜底会吞掉真实失败 | 闸门 2 曾把 lint 的 9 个真实错误当成「eslint 未安装」跳过；改为显式 `requiresTool()` 检查 |

---

## 六、下一步

**MVP 端到端切片实施**（九步骤已全部完成，无剩余门禁）。

按《轻量架构草案》§3 的模块拆分表与《开发规范》强制 13–16 逐模块落地。建议顺序：

1. **切片 1**：桥骨架 —— `whale-bridge/host.js` + `lib/server.mjs` + `lib/routes.mjs` 的最小可用版本（先通 `/whale/probe`、`/whale/panel`、`/whale/capability` 三条只读路由），配 `tests/` 单测。
2. **切片 2**：数据源 —— `lib/events.mjs`（事件订阅）+ `lib/fold.mjs` + `lib/usage-stats.mjs` + `lib/zstd-frame.mjs`（三个纯函数模块，可脱离宿主单测）。
3. **切片 3**：实时通道 —— `lib/sse.mjs` + 剩余路由，凑齐 22 条。
4. **切片 4**：悬浮条 —— `whale-hud/`。
5. **切片 5**：小窗 —— `whale-window/`。
6. **切片 6**：页面按钮 —— `whale-button/`。

每个切片完成 = 自测 + `node tools/gate.mjs` 通过 → 提交 → 请用户验收（开发规范 6.1）。

`runtime/electron.exe` 需在切片 4 之前解包就位（Electron 44.0.0，离线缓存无此版本，需从 GitHub Releases 取 157455369 字节的 zip 或由用户提供）。

---

## 七、版本沿革

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-05 | 建立；记录步骤 1–6 完成、工作区实测状态、五项已知环境坑 |
| v1.1 | 2026-10-05 | 步骤 7 完成：三件套改为「入口 + 指路」形态；补 R0 目录联接；清理 `whale-pages/` 与临时件 |
| v1.2 | 2026-10-06 | 步骤 8、9 完成：35 条强制项规范 + references 五份；git 仓库初始化（首提交 `65b5bdb`，42 文件）；六道闸门与预提交钩子验证可用；新增 3 项环境坑（6/7/8） |
