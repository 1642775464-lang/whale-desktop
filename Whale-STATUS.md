# Whale Desktop · STATUS

- 文档版本：v2.1
- 日期：2026-10-07
- 状态：**全部完成——一期六片 + 切片 7 第一批已交付并验收通过；插件装在宿主里日用中**
- 项目根：`D:\DEEPSEEK\悬浮窗`
- 冲突裁决顺序：**PRD > ARCHITECTURE > STATUS**（本文件与上游冲突时以上游为准）

---

## 一、一句话现状

**插件已装进真实宿主长期保留，日用中。六片全部交付（悬浮条、小窗、页面按钮 + 桥），520 个测试与七道闸门全绿。**

九个规划步骤全部交付；分支 `main` + `develop`；七道闸门与预提交钩子验证可用。

**装进真实宿主后共暴露并修掉 7 个缺陷**，全部是假环境测不出来的：
- 切片 5 验收时 3 个：`inject` 缺失 / `inject` 含幽灵服务名 / `async` admission 被当同步用
- 切片 6 验收时 1 个：图标照抄源 svg 的 `fill="none"` → 看着透明
- 用户日用时报出 3 个：点鲸鱼只唤起不收起（PRD 是切换语义）/ 关窗时 `target` 被静默丢掉（返回成功但一个都没关）/ 标题在会话投影里而桥只等事件 → 识别不到标题

后 3 个由**用户在使用中发现**，且都过了「用户逐项验收通过」。前 6 个装完即卸、宿主已还原；第 7 片（切片 6）按用户要求**装回并长期保留**。

**下一步没有待办**：六片做完，日用中。若还要往前，是二期范围（侧边工作台、语音、`/whale/models` 真目录等），需另行立片。

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
| 切片 6 | 页面按钮 | ✅ 完成（`aadf93a`） | `whale-bridge/lib/client.js`（挂 `shell.overlay`）+ 桥支持按目标拉起；真宿主验收 E1–E6 全过；502 测试 |

**六片全部完成。** 三件套（悬浮条 / 小窗 / 页面按钮）+ 桥均已交付并通过真机验收。

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
| 24 | `install_bundle` 与手写配置**写的是不同文件** | 正规通道写 `package.json` 的 `dsh.profile.bundles`（不是 `cordis.patch.yml`）。查「装没装上」时只看后者会误判成「没装上」——我这么误报过一次 |
| 25 | `remove_bundle` 不删 `node_modules/` 下的符号链接 | 依赖与 bundles 都清了，但链接留着。不影响功能（宿主下次启动按 bundles 加载），但目录里会留个悬空链接，需手动删 |
| 26 | 插件卸载后**进程态残留到重启** | `dispose` 会执行（端口逻辑上已放），但宿主起的 Node 服务进程仍占着端口。此时重新安装会报「端口 19387 已被占用」而被判为激活失败。**重启即可**，不要试图杀那个进程——它属于宿主 |
| 27 | **会话标题不在 header 里，也不靠事件推给桥** | 标题是 `dsh-session-title` 注册的 `key="title"` **会话投影**；读法 `sessionProjections.snapshot(session, keys) → values.title`。只等 `session/title` 事件的话，对「会话早有标题、桥后挂上来」永远等不到 → **识别不到标题** |
| 28 | HTTP 处理器与底层实现**要一起改** | 只在 `windows.close` 里实现了按 `target` 关，处理器却只读 `pid`/`all` → 参数被静默丢掉 → 返回 `{ok:true, closed:0}`：**看着成功、一个都没关**。这类返回比报错难查得多 |
| 29 | 源 svg 的 `fill="none"` 靠 CSS 补色，**换个宿主就没有那条 CSS** | 悬浮条有 `.whale svg path{fill:var(--ink)}`；客户端插件没有样式表，照抄 `fill="none"` 会画成空心 = 看着透明。跨宿主复用图标时**填充要显式给** |
| 30 | `align-items: baseline` 的行盒**贴着容器顶**排 | flex 行高 = 内容高，容器高出来的部分全在下方。`.seg.mono` 是 `height:36px` + 内容高 24.75px → 文字中心偏上 **6px**。修法：行盒 `line-height` 撑满容器高 |
| 35 | **可选服务被 apply 时刻的快照定死** | sessionController 的注册时机在桥之后；在 createHostAccess 里 `ctx.get` 一次存进 const 就永远是 undefined（`/whale/models` 恒 0、probe 恒 false），而稳态下服务确实存在。修法：**每次调用现取**，`available` 等结论也要 getter |
| 31 | **重启宿主不会重建已存在的小窗/悬浮条** | 它们是独立 Electron 进程。改了渲染层代码后，只重启宿主 → 老窗口进程仍带着旧状态在跑，表现是「改了没生效」。**必须关掉窗口重新拉起**（`POST /whale/close {all:true}` 再 `open`）。现场为此排查了很久 |
| 32 | `URLSearchParams` 只能用 `.get()` 取 | 写成 `query?.sessionId`（属性访问）恒为 `undefined`，接口永远回「缺少 sessionId」而调用方明明传了。桥的既有约定，slice1/slice2 都标了这条注释 |
| 33 | 宿主 `commands.execute` 的**第 3、4 参都没有空值保护** | 第 3 参 `submittedAttachments` 会被读 `.length`，第 4 参 `signal` 会被读 `.aborted`。传 `undefined` 分别抛 `reading 'length'` / `reading 'aborted'`。**修一个会立刻撞上另一个**，必须一起给（空数组 + 真 AbortSignal） |
| 34 | **「改了没生效」要先分辨：是代码没生效，还是进程是旧的** | 判断方法：查进程启动时间 vs 提交时间；更硬的办法是**起一个全新进程连真桥**验证（新增 `tools/window-diag.cjs`）。本次就是靠它证明「代码是好的、只是窗口进程旧」 |

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
| **B6** 排队语义 | 回合运行中发送 → `{"ok":true,"queued":true,"mode":"queue"}`；**且标记文本「验收B6-165204」在下一回合真的送达**（用户贴回原样文本，端到端坐实） |
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
4. **切片 4** ✅ 悬浮条（`02e729c`）—— `whale-hud/`。
5. **切片 5** ✅ 小窗（`c4e8c91` / `6592e42` / `9b0f237`）—— `whale-window/`（已回补 C7/C8/C12）。
6. **切片 6** ✅ 页面按钮（`aadf93a`）—— `whale-bridge/lib/client.js`。

每个切片完成 = 自测 + `node tools/gate.mjs` 通过 → 提交 → 请用户验收（开发规范 6.1）。

## 六·三补、切片 6 真宿主验收记录（2026-10-06）

**这一次走的是正规安装通道**（`plugin_manager` 的 `install_bundle` / `remove_bundle`），
与切片 5 的手工安装形成对照。

### 验收结果（判据 E1–E6）

| 编号 | 判据 | 实测 |
|---|---|---|
| E1 | 按钮出现在页面右下角 | ✅ 用户目视确认 |
| E2 | 40×40 圆形 | ✅ 契约测试 + 目视 |
| E3 | 图标是那枚鲸鱼 | ✅ 与源 svg **逐字符一致**（3394 字符） |
| E4 | 单击真的拉起悬浮条 | ✅ 窗口表出现 `target="hud"` |
| E5 | 单击真的拉起小窗 | ✅ 窗口表出现 `target="window"` |
| **E6** | **能点动（不被穿透层吞掉）** | ✅ 用户点击成功 → 两个窗口都起了 |

**E4/E5 的证据来自用户**：窗口表里那两个进程的 `reason="button"`——
是用户点按钮点出来的，不是我脚本造的。这比我自己模拟点击更硬。

### 槽位注册（机器取证）

```
shell.overlay 的 occupants 末位：
  registrant: "mf"    id: "whale-button"    order: 90    active: true
```

### 安装通道对照（两次验收的差别）

| 对比 | 切片 5（手工） | 切片 6（正规） |
|---|---|---|
| 写 profile 配置 | 我手写 `package.json` + `cordis.patch.yml` | 工具代写 `dsh.profile.bundles` |
| 踩坑数 | 3 个（inject 缺失 / inject 含幽灵服务名 / 卸载方式） | **0 个** |
| 卸载 | 按行手删，要小心别碰用户设置 | `remove_bundle` 一步到位 |

> **教训**：上一片那三个坑，有一部分本可以由正规通道避免。
> `cordis-plugin-development` 明确写着「不要手写 profile 配置」——我当初没照做。

### 卸载核对（配置层全干净）

| 项 | 结果 |
|---|---|
| 依赖 | whale-bridge 已移除，总数回到 **12** |
| bundles | 已移除，总数回到 **17** |
| 符号链接 | pnpm remove 留下了链接，已手动删（**这是工具的一个小缺口**） |
| 桥端口 19387 | 进程仍在内存里跑，**随宿主重启回收**（dispose 已执行） |
| 既有插件 | 8 个抽查全部完好 |
| 用户主题设置 | ✅ 保留 |

> 记一条：`remove_bundle` 清了依赖与 bundles，但**没删 `node_modules/` 下的符号链接**。
> 不影响功能（bundles 里已无该项，宿主下次启动不会加载），但目录里会留个悬空链接。

`runtime/electron.exe` **已就位**（Electron 44.0.0，157455369 字节，解包于 `runtime/`，`runtime/version` 为 `44.0.0`），切片 4 无需再准备。

---

## 六·四补、日用阶段的四个缺陷（用户报出，已修并验收通过）

**这一段值得单独记：缺陷不是测试发现的，是用户在日常使用中发现的。**
假环境（假 ctx、假桥、假数据）对这四个全都测不出来——
它们要么跨进程、要么依赖宿主的真实数据结构。

### 四个缺陷

| # | 现象（用户原话） | 真因 | 修法 |
|---|---|---|---|
| 1 | 点悬浮条鲸鱼收不起小窗 | PRD F2① 是**切换**语义（「已在跑时再点收起」），而实现函数名叫 toggle、里面只调了 open | 按真实运行态二选一；补上外圈绿环（它是「再点会收起」的唯一提示） |
| 2 | 右下角图标「就是个透明的」 | 源 svg 是 `fill="none"`，颜色本来由悬浮条的 CSS 补；客户端插件没有样式表，照抄 `fill="none"` 画成空心 | path 上显式给深色填充 |
| 3 | 同上（点鲸鱼无反应、绿环不灭） | 泛化桥时加了 `target` 支持，却**忘了在 HTTP 处理器里传下去** → `{target:"window"}` 被丢掉 → 落到「按 pid 匹配」→ 返回 `{ok:true, closed:0}`：**看着成功、一个都没关** | 处理器把 `target` 传下去 |
| 4 | token 流速与上下文不上下居中 | `.seg.mono` 的 `align-items: baseline`（刻意的）配了个只撑内容高的行盒，36px 盒子里少掉的 5.6px 全跑到下面 | 数字行盒撑满盒高，单位改紧行高 |

第 3 个最值得记：**「成功但什么都没做」的返回，比报错难查得多。**
悬浮条拿到 `ok` 就更新绿环、也不报错，用户只看到「点了没反应」。

### 三次「我以为」被证据纠正

这一段是方法论层面的收获，比修 bug 本身更值钱：

```kv
以为「图标透明」是 CSS 没生效 → 探针实测 fill 已是 rgb(31,36,48)、::after 正常
                              → 证明渲染层没问题，方向拨到桥的处理器
以为「绿环没灭」是没重启       → 查进程启动时间 18:26:12 > 提交时间 18:21:35
                              → 证明跑的就是新代码，是真 bug
以为「标题没渲染」是界面问题   → 查桥的返回：title = ''
                              → 证明桥根本没拿到标题，界面无过
```

三次都靠**先取证再改代码**避免了改错地方。

### 新增的四个验收工具

| 工具 | 用途 |
|---|---|
| `tools/hud-toggle-probe.cjs` | 进真窗口实测图标填充与绿环 `::after`，派发真鼠标序列点鲸鱼 |
| `tools/hud-align-probe.cjs` | 量每个元素的「文字视觉中心」与条中心的偏差（容差 ±1.5px） |
| `tools/bridge-preflight.mjs`（扩充） | 装前预检补**标题通路**：灌一条不含标题的事件，验两条接口能否从投影补出来 |
| `tools/verify-btn-icon.mjs` | 另写一套抽取逻辑复核图标，不依赖工具自己的比对 |

**为什么要专门写量测探针而不是目测改 CSS**：「看着不居中」至少有三种成因
（盒子没居中 / 盒居中但行高顶偏 / 基线与字形中心不一致），三者修法完全不同。
估着改会反复试错；量出数字（实测偏 6px）才能一次改对，也才能把
「改完真的居中了吗」变成可复核的判据。

### 一条自我纠正

第一版的居中契约断言是**空壳** —— 它只检查「方法名有没有出现过」，
我把代码改回错的样子做注入验证时它照样全绿。
改成检查**真实的条件分支结构**后再注入，立刻变红。
**凡是没做过注入验证的断言，都不能算防线。**

---

## 六·五补、切片 7 第一批：权限切换与命令面板（已验收通过）

### 修掉的真 bug

**`/whale/command` 的第 3、4 参都缺值。** 宿主 `commands.execute` 对这两个参数
都没有空值保护（第 353 行读 `.length`、第 332 行读 `.aborted`），传 `undefined`
会分别抛 `reading 'length'` 和 `reading 'aborted'`。

**修一个立刻撞上另一个** —— 我只修 `signal` 时错误从 `'aborted'` 变成 `'length'`，
还是 500。所以这两个参数写在同一段注释里，避免下次再只修一个。

**`query` 取法错误**：`query?.sessionId`（属性访问）恒为 undefined，
而 `query` 是 `URLSearchParams`，必须 `.get()`。接口因此永远回「缺少 sessionId」。

### 命令面板接上了宿主的真命令表

新增第 23 条路由 `GET /whale/commands`，读 `commands.list(agent)` 的 descriptor
（含 `hint`，用户才知道 `/permission` 后面要填什么）。
当前环境下可见 **8 条**：btw / compact / export / feedback / goal / mnemon /
permission / plan。

> 为什么是 8 条而不是原型图上的二十多条：命令按 **agent 可见性过滤**，
> 其余依赖对应插件是否已装。这是宿主的过滤结果，不是漏了。

### 最值钱的教训：两次「改了没生效」，一次是我猜错

```kv
第一次: 用户报「没实现」 → 查桥: 接口 500 → 是真 bug（参数缺失）
第二次: 用户报「还是不行」 → 查桥: 接口 200 正常 → 代码是对的
                          → 真因: 那个窗口是 08:05 起的**旧进程**
                          → 重启宿主不会重建已存在的小窗
```

第二次我一度猜成「sessionId 残留」，加了行清空代码；
查证后发现 `fetchActiveSessionId` **只在 sessionId 为空时才被调用**，
那行是空转、注释里的理由也是错的 → **已撤回**。不能留基于错误假设的代码。

**把我拉回正轨的是 `tools/window-diag.cjs`**：起一个全新窗口连真桥，
把渲染层的真实状态打出来。它给出的结果是：

```kv
标题: 从PRD与原型重新实施项目
副标题: 回合运行中
消息行: 40
自行取数: 面板标题与 40 条消息均正常
```

**一个新窗口一切正常 = 代码没问题，问题在旧进程**。没有这一步，
我大概会继续在根本没坏的代码里改。

### 顺带修的两处

- 撤回基于错误假设的 `sessionId = null`（保持代码干净）
- 诊断脚本用错 `bootWindow` 的返回：`booted.win` 是**窗口封装**，
  真 BrowserWindow 在 `booted.win.win` 上（boot.cjs:166 的用法）

### 状态

```kv
路由: 23 条（新增 /whale/commands，PRD v2.1 已同步）
测试: 527 全绿
闸门: 7 道全过
验收: 命令面板 8 条真命令 + 权限切换，用户验收通过
```

---

## 六·六补、切片 7 第二批：模型目录与档位、四个浮层、真上传

**起因**：用户拿宿主输入框的截图提出四条（权限切换没用 / 上下文不显示 /
不能切模型与思考强度 / ＋不能展开），要求全量复刻宿主交互。
经范围声明确认，拆成三批落地（A 桥侧数据 → B 上传通路 → C 渲染层浮层）。

### 三个真因（每个都实证过）

| # | 现象 | 真因 |
|---|---|---|
| 1 | 模型目录恒为 0 | 桥找的是 `models` 服务，**宿主根本没有它**——真目录在 `sessionController.modelCatalog()`（宿主 UI 也走它）。不是「宿主没暴露」，是找错了地方 |
| 2 | 权限只有三档 | 硬编码三档，而宿主是**配置项 + 运行期注册的 auto**，硬编码必然漏 |
| 3 | 改了数据源仍返回 0 | `ctx.get("sessionController")` 的结果**在 apply 时存进 const**——而该服务注册时机在桥之后，快照把「还没就绪」永久定死 |

第 3 个的对照证据：inspect 能给出 sessionController 的**完整契约**
（稳态下确实存在），但桥的 probe 报 false——**服务在，只是桥问得太早**。
修法是延迟解析（每次调用现取），`available` 也改成 getter
（对象字面量同样是一次性求值，测试抓到了这点）。

### 真宿主验收（A 部分，机器可判）

```kv
/whale/models:  total=30 groups=5（原先是 0）
推理档位:       30 个模型全部带（low/medium/high/xhigh/max 等）
/whale/presets: read-only/workspace-write/danger-full-access/auto，current 正确
切换模型:       200 且宿主实际切了过去（当前会话已在新模型上运行）
切换 effort:    200（high→max 均成功）
命令目录:       8 条（第一批），权限切回默认档 200
```

### 渲染层（B/C 部分，待重启宿主后由用户验收）

| 浮层 | 内容 |
|---|---|
| 权限 | 列宿主全部档位（4 个），当前高亮，点击切换 |
| 模型与思考强度 | 按 provider 分组、右侧显示档位；点模型展开 effort 列表 |
| 用量 | 五行走 kv：上下文占用 / 累计输出 / 输入 / 缓存读 / 步数·回合 |
| ＋ 上传 | **三种入口**：点＋选文件、拖文件进小窗任意位置、输入框粘贴图片 |

上传按宿主 admission 层的两条浏览器入口走
（`saveFile` / `saveImages`，base64 原样透传）；
发送时**先上传后发消息**，失败如实提示并中止（内容与附件保留）。

### 新增模块与路由

```kv
whale-bridge/lib/host-catalog.mjs: 模型目录/切换、权限档位、上传（按业务域拆出）
GET  /whale/presets:              档位清单 + 当前档位（第 24 条）
POST /whale/upload/file:          单文件（第 25 条）
POST /whale/upload/images:        批量图片（第 26 条）
whale-window/renderer/overlays.js: 四个浮层 + 待上传清单状态机（438 行）
```

host-ctx 涨破 500 行 → 按职责拆出 host-catalog（247 行），不放宽限制。

### 测试

```kv
总数: 552 全绿
分层: smoke-slice7 提供服务测真路径 / smoke-slice3 不提供测降级——两层都要
独立端口: 上传的拒绝与缺失用例各用 19396/19397——
  同端口 dispose→apply 有竞态，会拖垮后面的兄弟用例（真实踩过）
```

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
| v1.8 | 2026-10-06 | **切片 6 完成，六片全部交付**（`aadf93a`）。页面右下角小鲸鱼按钮（挂 `shell.overlay`，单击并行拉起悬浮条与小窗）；桥侧按已确认的影响清单泛化 `windows.mjs`（TARGETS 表 + 复用按目标分开）。真宿主验收 E1–E6 全过，**走正规 `install_bundle` / `remove_bundle` 通道，0 个坑**（与切片 5 手工安装的 3 个坑形成对照）。图标改为机械注入（我第一版凭印象编了段鲸鱼 path，与真图标完全不同——PRD 早警告过「手抄会错」）。依赖扫描口径修正为「浏览器侧另算、但更严」（允许宿主模块表模块，禁止 node: 内置）。测试 502 全绿、七道闸门全过。卸载核对：依赖回 12、bundles 回 17、用户主题设置保留；记一条工具小缺口（`remove_bundle` 不删 `node_modules/` 下的符号链接） |
| v1.9 | 2026-10-06 | **插件装回并长期保留**（用户要求「装」），进入日用阶段。用户在日用中发现并报出 **4 个缺陷**，全部修复且**逐项验收通过**：① 点鲸鱼只唤起不收起（PRD F2① 是切换语义）② 图标照抄源 svg 的 `fill="none"` → 看着透明 ③ 关窗时 `target` 被 HTTP 处理器静默丢掉 → `{ok:true,closed:0}`「成功但一个都没关」④ `align-items:baseline` 的行盒贴顶 → 数字偏上 6px。四个都做了注入验证的防线。新增 3 个量测工具（切换/绿环探针、居中量测探针、图标独立复核），预检补标题通路。记录三次「我以为」被证据纠正的过程。新增 4 项环境坑（27–30）。测试 520 全绿 |
| v2.0 | 2026-10-07 | **切片 7 第一批完成并验收通过**（`28c1277` + `d253d8a`）：修掉 `/whale/command` 的第 3、4 参缺值真 bug（宿主两处都无空值保护，**修一个立刻撞上另一个**）、修 `query` 取法（必须 `.get()`）；新增第 23 条路由 `GET /whale/commands`，命令面板改走宿主真命令表（当前可见 8 条，按 agent 可见性过滤）。PRD 同步到 v2.1。**最值钱的教训：第二次报「还是不行」时，真因是那个窗口是旧进程——重启宿主不会重建已存在的小窗**。靠新增 `tools/window-diag.cjs`（起全新窗口连真桥打状态）证明「代码是好的」，从而避免在没坏的代码里乱改；我一度猜错并加了行空转代码，查证后**已撤回**。新增 4 项环境坑（31–34）。测试 527 全绿 |
