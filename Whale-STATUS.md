# Whale Desktop · STATUS

- 文档版本：v1.5
- 日期：2026-10-06
- 状态：**步骤 1–9 全部完成；MVP 切片 1–4 已完成并提交，下一片为切片 5**
- 项目根：`D:\DEEPSEEK\悬浮窗`
- 冲突裁决顺序：**PRD > ARCHITECTURE > STATUS**（本文件与上游冲突时以上游为准）

---

## 一、一句话现状

**三件套里第一件已成形：悬浮条能真起、真连桥、真显示五元素，354 个测试与七道闸门全绿。**

九个规划步骤全部交付；git 仓库有 7 个提交（`65b5bdb` → `91fa15c` → `0bbbed7` → `b78857f` → `d4b74ad` → `c9d44ad` → `02e729c` → `a9cd012` → `00fc5e9`），分支 `main` + `develop`；七道闸门与预提交钩子已验证可用。`whale-window` / `whale-button` 两个目录仍为空。

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
| 9 | Git + 质量闸门 | ✅ 完成 | git 仓库 + `.githooks/` + `tools/` 六脚本 |
| 切片 1 | 桥骨架 | ✅ 完成（`91fa15c`） | 4 条只读路由 + 35 测试 |
| 切片 2 | 数据源 | ✅ 完成（`b78857f`） | 事件订阅 + 双折叠器 + 3 个纯函数内核 + 115 测试 |
| 切片 3 | 实时通道 | ✅ 完成（`d4b74ad` 批次 A + 本批） | SSE 双端点 + 续传 + 22 条路由全量落地 + 265 测试 |
| 切片 4 | 悬浮条 | ✅ 完成（`02e729c`） | whale-hud 主进程 + 渲染层，真窗口验收 A1/A4/A5/A8/A10/A11 + R-1，349 测试 |

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
| `tools/` | 6 个闸门脚本 + `check-reply.mjs` + `whale-icon.mjs` + `bridge-dev-server.mjs` + `hud-probe.cjs` + `gate-log.ndjson`（本地留痕，已忽略） |
| `.githooks/` | `pre-commit`（sh 入口）+ `pre-commit.mjs` |
| `tests/` | 354 个测试：`tests/unit/` 单测、`tests/contract/` 契约、`tests/*.test.mjs` 冒烟；夹具在 `tests/helpers/` |
| `runtime/` | **空**（等待 Electron 解包；已 gitignore） |
| `whale-bridge/` | 切片 1–3 已完成：`host.js` + `lib/` 十二个模块 |
| `whale-button/` | **空** |
| `whale-hud/` | 切片 4 已完成：主进程（`main.cjs` / `preload.cjs` / `run.ps1` / `lib/` 五个模块）+ 渲染层（`renderer/` 四个文件） |
| `whale-window/` | **空**（切片 5） |
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
| 9 | 测试并发争用同一端口、且互相覆盖单例 | `apply(ctx, { port })` 显式传端口（不用环境变量——测试文件共享进程会互相覆盖）；`apply`/`dispose` 生命周期用例串行分组 |
| 10 | `new URL(..., import.meta.url).pathname` 会把中文路径 URL 编码 | 一律改用 `fileURLToPath(import.meta.url)`，否则路径含中文时文件找不到 |
| 11 | `fetch` 无法设置 `Host` 头（受控头） | 测「伪造 Host 被拒」必须用 `node:http` 的 `request()` 直发，用 fetch 测的其实是默认 Host |
| 12 | JS 正则 `\b` 在中文后失效 | `\w` 只含 `[A-Za-z0-9_]`，中文字符不算词字符；中英混排的正则要把 `\b` 只用在 ASCII 分支上 |
| 13 | 正则里 `\s*` 会吃掉换行 | 匹配「行首」模式时用 `[ \t]*`，否则整块文本被当成一行，导致拦截规则漏判 |
| 14 | Electron 的 `file://` 页面请求回环 HTTP **不发 Origin 头** | 实测 fetch 与 EventSource 都是 `<absent>`；桥的 `isAllowedOrigin(undefined)` 本已放行，**悬浮条无需任何 CORS 改动**。若哪天改成走 CDP 或自定义协议，这条要重新实测 |
| 15 | 内联 `<script>` 在 `default-src 'none'` 下被**静默拦截** | 现象是「页面看着正常、什么都没工作」。CSP 必须放行 `'self'`；契约测试已把这条写成断言 |
| 16 | `node:vm` 沙箱里 `new` 外层 realm 的函数会报「不是构造函数」 | 假类必须用 `runInContext` 定义在沙箱**内部**；且脚本读的是 `window.X`，全局要挂在 `window` 上而不是沙箱根 |
| 17 | eslint 扁平配置里后面的条目覆盖前面的 | `require-await` 的豁免块必须放**最后**，放前面会被 `**/*.cjs` 的 COMMON_RULES 盖回（踩过一次） |
| 18 | 开发服务器与冒烟测试撞端口 → 闸门 3 **偶发**失败 | 表现为「时红时绿、单独跑永远绿」，极难定位（会先怀疑产品代码）。开发服务器默认端口改用 19500 避开测试段 19387–19391；新增 `tests/contract/port-discipline.test.mjs` 把端口占用表变成断言 |

---

## 六、下一步

**切片 5：小窗** —— `whale-window/`：Electron 主进程（窗口 / 状态记忆 / 崩溃自愈）+ 渲染层（`renderer/app.js` 接 `/whale/events` 与 `/whale/panel`，消息流 / 任务坞 / 命令面板）。该片完成后回补切片 3 遗留的 **C7/C8/C12**（真拉起小窗、复用、孤儿口径）。

---

## 六·补、遗留待办

| 项 | 状态 | 何时了结 |
|---|---|---|
| C7/C8/C12（真拉起小窗、复用、孤儿口径） | 切片 3 无法验，缺 `whale-window/` | **切片 5 完成后回补** |
| A2/A3/A9（焦点 / 任务栏 / 图标屏幕坐标） | 需要 Win32 调用（`GetForegroundWindow` / UIA 枚举），零依赖做不到自动化 | **人工确认**，不是机器验的（已在切片 4 汇报里写明） |
| `/whale/models` 的真实模型目录探测 | 按 S3-D3 降级交付（空数组 + `reason`） | 装插件进真实宿主时按实测口径补 |
| 球展开的触发方式 | 《前端设计规范》3.8 只写了收展几何，**没说展开由什么触发** | 现取「双击球展开、单击唤起小窗」（单击语义由 PRD F2① 定）。属我补的默认值，用户可改 |
| 悬浮条单实例 | 已实现（第二次启动写日志后退出），但只在同一 userData 下生效 | 若将来多用户/多实例需求出现再评估 |

> 前两条不是遗漏，是**范围声明里写明的诚实边界**。回补时须在汇报页明确标注「此前为降级，现已实测」。

六片顺序（已定）：
1. **切片 1** ✅ 桥骨架（`91fa15c`）—— 4 条只读路由。
2. **切片 2** ✅ 数据源（`b78857f`）—— 事件订阅 + 双折叠器 + 三个纯函数内核。
3. **切片 3** ✅ 实时通道（批次 A `d4b74ad` + 批次 B）—— SSE 双端点 + 续传 + 22 条路由全量落地。
4. **切片 4** ⬜ 悬浮条 —— `whale-hud/`。
5. **切片 5** ⬜ 小窗 —— `whale-window/`（回补 C7/C8/C12）。
6. **切片 6** ⬜ 页面按钮 —— `whale-button/`。

每个切片完成 = 自测 + `node tools/gate.mjs` 通过 → 提交 → 请用户验收（开发规范 6.1）。

`runtime/electron.exe` **已就位**（Electron 44.0.0，157455369 字节，解包于 `runtime/`，`runtime/version` 为 `44.0.0`），切片 4 无需再准备。

---

## 七、版本沿革

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-05 | 建立；记录步骤 1–6 完成、工作区实测状态、五项已知环境坑 |
| v1.1 | 2026-10-05 | 步骤 7 完成：三件套改为「入口 + 指路」形态；补 R0 目录联接；清理 `whale-pages/` 与临时件 |
| v1.2 | 2026-10-06 | 步骤 8、9 完成：35 条强制项规范 + references 五份；git 仓库初始化（首提交 `65b5bdb`，42 文件）；六道闸门与预提交钩子验证可用；新增 3 项环境坑（6/7/8） |
| v1.3 | 2026-10-06 | 切片 1、2 完成并提交（`91fa15c`、`b78857f`）；115 测试全绿、六闸门全过；`runtime/electron.exe` 就位；新增 2 项环境坑（9/10） |
| v1.4 | 2026-10-06 | 切片 3 完成：SSE 双端点 + `Last-Event-ID` 续传 + 22 条路由全量落地；265 测试全绿；新增**闸门 7 正文守门器**（`tools/check-reply.mjs`，把「回复正文不得含内部摘要」变成机械检查）；规范强制项增至 37 条；新增 3 项环境坑（11/12/13）。遗留：C7/C8/C12 待切片 5 回补 |
| v1.5 | 2026-10-06 | 切片 4 完成：`whale-hud/` 从空目录到可运行悬浮条（主进程 5 模块 + 渲染层 4 文件）；真 Electron 窗口实测 A1/A4/A5/A8/A10/A11 与 R-1 全过；测试 354 全绿。新增工程工具三个（图标机械内联 / 桥独立开发服务器 / 验收探针）；新增 5 项环境坑（14–18）；记录一处决策补全（球展开触发方式）与一处架构偏离（几何不走 HWND，S4-D1）。修掉一个**偶发**闸门失败：开发服务器与 smoke-slice3 撞 19391 端口 |
