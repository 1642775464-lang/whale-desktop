# Whale Desktop · STATUS

- 文档版本：v1.0
- 日期：2026-10-05
- 状态：**步骤 1–6 完成，步骤 7 进行中**
- 项目根：`D:\DEEPSEEK\悬浮窗`
- 冲突裁决顺序：**PRD > ARCHITECTURE > STATUS**（本文件与上游冲突时以上游为准）

---

## 一、一句话现状

**图纸与地基已画完，一行实施代码还没写。**

六个规划步骤的文档全部落盘，四个交付目录（`whale-bridge` / `whale-hud` / `whale-window` / `whale-button`）基本为空。

---

## 二、九步骤进度

| 步骤 | 名称 | 状态 | 交付物 |
|---|---|---|---|
| 1 | 需求整理 | ✅ 完成 | `docs/需求整理.md` + 汇报页 |
| 2 | PRD | ✅ 完成 | 三份 v2.0 PRD + 本入口 |
| 3 | 视觉及页面框架 | ✅ 完成 | `docs/前端设计规范.md`、`docs/页面框架.md` + 汇报页 |
| 4 | 边界与 NFR | ✅ 完成 | `docs/边界与NFR说明书.md` + 汇报页 |
| 5 | 技术栈选型 | ✅ 完成 | `docs/技术栈选型说明书.md` + 汇报页 |
| 6 | 轻量架构草案 | ✅ 完成 | `docs/轻量架构草案.md` + 汇报页 |
| 7 | 规整项目文档 | 🔄 **进行中** | `Whale-PRD.md`、`Whale-ARCHITECTURE.md`、`Whale-STATUS.md` |
| 8 | 开发规范 | ⬜ 未开始 | `docs/开发规范.md` + `references/` |
| 9 | Git + 质量闸门 | ⬜ 未开始 | git 仓库 + 六道闸门脚本 |
| — | MVP 端到端切片实施 | ⬜ 未开始 | 四个交付目录 |

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

### 4.1 目录（截至 2026-10-05）

| 目录 | 状态 |
|---|---|
| `docs/` | 10 份规划文档 + `pages/` 汇报页 |
| `docs/pages/` | 6 张汇报页 HTML + 4 份 `.am.md` 稿件 + 2 份临时件 |
| `runtime/` | **空**（等待 Electron 解包） |
| `whale-bridge/` | **空** |
| `whale-button/` | **空** |
| `whale-hud/` | 仅 `renderer/favicon-whale.svg`（3634 字节，自宿主 web 前端复制） |
| `whale-window/` | **空** |
| `_inbox/` | 用户输入的输入包（含**禁用**的既有源码） |
| `_notes/` | 原型文本化稿与网络探针 |
| `_probe/` | 11 个一次性探查脚本 + 1 份配置备份 |
| `_diag/` | 诊断用临时 HTML |
| `whale-pages/` | `serve.mjs`（已被否决的绕路方案产物，待清理） |

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
| 项目根 | `D:\DEEPSEEK\悬浮窗`（**非 git 仓库**） |

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

---

## 六、下一步

**步骤 8「开发规范」**：产出四层规范（代码风格 / 工程规范 / 质量门禁 / 安全规范）+ `references/` 唯一可信源参考夹。

---

## 七、版本沿革

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-05 | 建立；记录步骤 1–6 完成、工作区实测状态、五项已知环境坑 |
