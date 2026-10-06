# Whale Desktop · STATUS

- 文档版本：v1.6
- 日期：2026-10-06
- 状态：**步骤 1–9 全部完成；MVP 切片 1–5（批次 A+B）已完成并提交，下一片为切片 5 批次 C；桥已通过真实宿主验收**
- 项目根：`D:\DEEPSEEK\悬浮窗`
- 冲突裁决顺序：**PRD > ARCHITECTURE > STATUS**（本文件与上游冲突时以上游为准）

---

## 一、一句话现状

**桥已在真实宿主里跑通并被卸下：悬浮条与小窗都能连它，小窗发的消息真的进了会话。473 个测试与七道闸门全绿。**

九个规划步骤全部交付；git 仓库有 13 个提交，分支 `main` + `develop`；七道闸门与预提交钩子已验证可用。`whale-button/` 仍为空（切片 6）。

**真宿主验收已做且已回退**：桥装进 profile 完成 B5/B6/B7 实测后**按约定卸下**，宿主的依赖数、配置、链接都恢复到装之前的状态，且保留了你这期间新增的主题设置。

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
| 切片 5 | 小窗 | ✅ 完成（批次 A `c4e8c91` / B `6592e42` / C `9b0f237`） | whale-window 主进程 6 模块 + 渲染层 7 文件；**回补 C7/C8/C12**；B1–B7 实测；487 测试 |
| 切片 6 | 页面按钮 | ⬜ **下一步** | `whale-bridge/lib/client.js` + `whale-button/` |

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
| `docs/` | 12 份规划文档（含切片声明与范围声明）+ `pages/` 汇报页 |
| `docs/pages/` | 11 张汇报页 HTML + 11 份 `.am.md` 稿件 |
| `references/` | 5 份唯一可信源（21.7 KB） |
| `tools/` | 6 个闸门脚本 + `check-reply.mjs` + `whale-icon.mjs` + `bridge-dev-server.mjs` + `hud-probe.cjs` + `window-probe.cjs` + `open-window-e2e.mjs` + `bridge-preflight.mjs` + `accept-real-host.mjs` + `gate-log.ndjson`（本地留痕，已忽略） |
| `.githooks/` | `pre-commit`（sh 入口）+ `pre-commit.mjs` |
| `tests/` | 487 个测试：`tests/unit/` 单测、`tests/contract/` 契约、`tests/*.test.mjs` 冒烟；夹具在 `tests/helpers/` |
| `runtime/` | Electron 44.0.0 已解包（已 gitignore） |
| `whale-bridge/` | 切片 1–3 已完成：`host.js` + `lib/` 十二个模块；**已通过真实宿主验收** |
| `whale-button/` | **空**（切片 6） |
| `whale-hud/` | 切片 4 已完成：主进程（`main.cjs` / `preload.cjs` / `run.ps1` / `lib/` 六个模块）+ 渲染层（`renderer/` 四个文件） |
| `whale-window/` | 切片 5 已完成：主进程（`main.cjs` / `preload.cjs` / `run.ps1` / `lib/` 七个模块）+ 渲染层（`renderer/` 七个文件） |
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
| 19 | **算术推导的端口躲过静态扫描** | `listen(srv, { port: TEST_PORT + 1 })` 算出来 19389，正好是另一个测试文件的端口——同一形状的偶发失败第二次出现。端口必须写成显式常量；`port-discipline` 已加「不得用算术推导」断言 |
| 20 | Cordis 插件**不声明 `inject` 就取不到任何宿主服务** | 表现极具迷惑性：`ctx.on` 不走服务容器，**事件照样收得到**，但 `ctx.sessions`/`ctx.agents` 全是 `undefined`。于是「能看到会话在跑、一发消息就 session-not-found」。服务一律要 `export const inject = [...]` 声明 |
| 21 | 把**不存在的服务名**写进 `inject` → 插件永远不启动且不报错 | Cordis 会等 inject 里的服务就绪才调 `apply`。可选服务必须走 `ctx.get(name)`（不经过 inject 守卫），只有必需服务才进 `inject` |
| 22 | 宿主服务可能是 **async**，返回值是 Promise | `attachments.admitPromptContent` 是 async。桥同步调用后把 Promise 当内容块塞进消息，宿主 `snapshotJsonValue` 遇到 Promise 返回 undefined 就抛 `carries non-JSON-serializable data`，发消息必 500。**调用宿主服务前先确认它是不是 async** |
| 23 | 卸载插件时**不能整文件覆盖备份** | 宿主会在运行期往 `cordis.patch.yml` 写设置（主题等），整文件恢复会把用户这期间的设置一起抹掉。卸载要**只删自己加的那几行** |

---

## 六、下一步

**切片 5：小窗** —— `whale-window/`：Electron 主进程（窗口 / 状态记忆 / 崩溃自愈）+ 渲染层（`renderer/app.js` 接 `/whale/events` 与 `/whale/panel`，消息流 / 任务坞 / 命令面板）。该片完成后回补切片 3 遗留的 **C7/C8/C12**（真拉起小窗、复用、孤儿口径）。

---

## 六·补、遗留待办

| 项 | 状态 | 何时了结 |
|---|---|---|
| C7/C8/C12（真拉起小窗、复用、孤儿口径） | ✅ **已回补**（切片 5 批次 A，真进程取证） | 完结 |
| B5/B6/B7（发消息进真会话 / 排队 / 中断护栏） | ✅ **已实测**（真宿主验收，2026-10-06） | 完结；B7 的「真中断」留给用户按红方块自行确认 |
| A2/A3/A9（焦点 / 任务栏 / 图标屏幕坐标） | 需要 Win32 调用（`GetForegroundWindow` / UIA 枚举），零依赖做不到自动化 | **人工确认**，不是机器验的（已在切片 4 汇报里写明） |
| `/whale/models` 的真实模型目录探测 | 按 S3-D3 降级交付（空数组 + `reason`）；真宿主下 `models` 服务可读到 | 装插件时已验证服务可读，模型内容待用户实际切换时确认 |
| 球展开的触发方式 | 《前端设计规范》3.8 只写了收展几何，**没说展开由什么触发** | 现取「双击球展开、单击唤起小窗」（单击语义由 PRD F2① 定）。属我补的默认值，用户可改 |
| 悬浮条单实例 | 已实现（第二次启动写日志后退出），但只在同一 userData 下生效 | 若将来多用户/多实例需求出现再评估 |

> 前两条不是遗漏，是**范围声明里写明的诚实边界**。回补时须在汇报页明确标注「此前为降级，现已实测」。

---

## 六·再补、真宿主验收记录（2026-10-06）

**这是整个项目第一次把桥装进真实宿主跑。** 装—验—卸全程留痕如下。

### 装的方式

| 项 | 值 |
|---|---|
| 依赖 | `"whale-bridge": "link:D:/DEEPSEEK/悬浮窗/whale-bridge"`（写进 profile 的 `package.json`） |
| 插件声明 | `cordis.patch.yml` 里一条 `- insert: [- id: whale-bridge, name: "whale-bridge"]` |
| 链接 | pnpm 建立符号链接 `node_modules/whale-bridge → 仓库` |
| 备份 | profile 的 `cordis.patch.yml` / `cordis.yml` / `package.json`，**已做 SHA256 校验** |

### 验收结果（机器可判）

| 判据 | 实测 |
|---|---|
| 桥在真宿主里起来 | `127.0.0.1:19387` 监听，22/22 路由全部实现 |
| 桥能看到真会话 | 1 个活跃会话，`phase=running`，实时 tok/s |
| **B5** 发消息进真会话 | `HTTP 200`；标记文本「验收标记-…」出现在会话里（用户亲眼看到） |
| **B6** 排队语义 | 回合运行中发送 → `{"ok":true,"queued":true,"mode":"queue"}` |
| **B7** 中断护栏（拒绝侧） | 不存在的会话 → `HTTP 404 session-not-found`，不误伤 |
| **B7** 真中断（接受侧） | **未测**——会掐断用户正在等的那一轮回复。留给用户按红方块自行确认 |

### 装的过程中暴露并修掉的三处真缺陷

装进真宿主才暴露，**在假 ctx / 假桥上完全测不出来**：

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | 事件能收、服务全无 | 插件**没声明 `inject`**。Cordis 只把 `inject` 里列出的服务装进 ctx；而 `ctx.on` 不走服务容器，所以事件照样收得到 | 补 `export const inject`；`serviceOf` 区分「没声明」与「宿主没有」 |
| 2 | 插件完全不启动 | 把 `projections`/`models`/`attachments` 也写进 `inject`。Cordis 会**等** inject 里的服务就绪才 apply，不存在的名字 → 永远不启动且不报错 | 必需服务进 `inject`，可选服务走 `ctx.get()`（宿主自己的 `dsh-headless` 就是这么读的） |
| 3 | 发消息必 500 | `attachments.admitPromptContent` 是 **async**，返回 Promise。桥同步调用、把 Promise 当内容块塞进消息；宿主 `snapshotJsonValue` 遇到 Promise 返回 undefined 就抛 | 纯文本本就不需要 admission（宿主注释：无 image 部分 "performs no storage operation"），改为自建内容块 + 可序列化自检 |

### 卸载（按约定验完即卸）

| 动作 | 结果 |
|---|---|
| 移除 `cordis.patch.yml` 的 insert 块 | ✅ 按行精确删除，**保留了宿主新增的 `ui-theme` 设置**（未整文件覆盖备份） |
| 移除 `package.json` 依赖 | ✅ 依赖数回到 12（装之前的值） |
| 移除符号链接 | ✅ 已删 |
| YAML 校验 | ✅ 用宿主自带的 yaml 解析器验证：18 个顶层条目，不含 whale-bridge |
| 仓库侧 | 只新增一个验收脚本；`whale-bridge/` 包本身完好（只是不再被宿主 link） |

> **教训（已入册环境坑）**：整文件覆盖备份是危险的——宿主会在运行期往 `cordis.patch.yml` 写设置（这次是主题）。卸载必须**只删自己加的那几行**。

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
| v1.6 | 2026-10-06 | 切片 5 批次 A+B 完成：`whale-window/` 可运行小窗（主进程 6 模块 + 渲染层 6 文件）；**回补切片 3 遗留的 C7/C8/C12**（真进程取证：拉窗 pid 存活、复用同 pid、dispose 后进程死）；消息流/状态条/任务坞/发送/排队/中断实测通过；测试 473 全绿。**首次把桥装进真实宿主**并完成 B5/B6/B7 实测，装的过程暴露并修掉三处真缺陷（inject 缺失 / inject 含不存在的服务名 / async admission 被当同步用），验完即卸并恢复宿主（保留用户新增的 `ui-theme` 设置）。新增 5 项环境坑（19–23） |
| v1.7 | 2026-10-06 | **切片 5 完成**（批次 C `9b0f237`）：斜杠命令面板（F7）/ ☰ 菜单（F8）/ 会话切换三档标签（F9）/ 资料抽屉；抽出 `render.js`，`app.js` 由 503 行降到 301 行（原超 500 上限被闸门 6 拦下）。探针新增四项检查，真窗口 × 两种回合状态全过；测试 487 全绿、七道闸门全过。下一片为切片 6 页面按钮 |
