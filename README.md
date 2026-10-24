# Whale Desktop

把 DSH Desktop 的会话搬到桌面一扇窄窗里 —— 小窗 + 左侧边栏（侧边对话 / 文件预览 / 内嵌浏览器）。

[![gates](https://img.shields.io/badge/gates-7%20passed-brightgreen)](tools/gate.mjs)
[![tests](https://img.shields.io/badge/tests-951%20passed-brightgreen)](tests/)
[![node](https://img.shields.io/badge/node-%3E%3D22.12-blue)](package.json)

---

## 这是什么

DSH Desktop 是一个能在里面干活的 AI 工作台，但它的界面占满整屏。**Whale Desktop**
把它拆成两件更轻的东西：

| 组件 | 作用 |
|---|---|
| **小窗** | 一扇 460px 宽的常驻窄窗：当前会话的消息流、输入框、权限档位、任务进度 |
| **左侧边栏** | 与会话相关的工作区：侧边对话、文件浏览与预览、内嵌浏览器 |
| **宿主桥** | 跑在 DSH 宿主进程内的插件，用 HTTP + SSE 把宿主能力暴露给小窗 |
| **悬浮按钮** | 页面内的小鲸鱼按钮，点击唤起小窗 |

小窗和侧边栏贴在一起看是**一条面板**：共用同一条分割线、同一套阴影与圆角，
顶栏高度也刻意对齐（差 1px 就会露出台阶）。

## 主要特性

- **消息实时同步** —— 宿主一有事件就推送（不是靠轮询等 5 秒）
- **侧边对话** —— 可选择继承哪条会话的上下文（按标题选，默认当前会话）
- **文件预览** —— md / js / txt / 图片 / 视频 / 音频窗内直接看；html 转内嵌浏览器；
  word 等交系统默认程序打开
- **内嵌浏览器** —— 移动端口径，窄宽度下页面自己走响应式，而不是把桌面版缩小
- **无感滚动** —— 全面隐藏滚动条，滚轮照常可用
- **权限档位与宿主一致** —— 真值只有一个来源（宿主的 `permissionPresets`），
  拿不到就显示 `—`，绝不编一个

## 目录结构

```
whale-window/     小窗与侧边栏（Electron 主进程 + 渲染层）
whale-bridge/     宿主桥插件（HTTP/SSE 服务，跑在 DSH 宿主进程内）
whale-hud/        桌面悬浮条
whale-button/     页面内悬浮按钮
docs/             需求、架构、开发规范、各步交付页
references/       唯一可信源（宿主 API 契约等）
tests/            单元 / 契约 / 冒烟测试
tools/            质量闸门与探针
```

分层纪律：**呈现层**（渲染层脚本，经 `<script src>` 加载）→ **桥**（宿主进程内的
Cordis 插件）→ **纯函数模块**（可单测，不碰 IO）。桥的改动需要**重启宿主**才生效，
渲染层的改动需要**重开窗口**。

## 快速开始

### 1. 环境

- Node.js **>= 22.12**
- Windows（当前主要支持平台；Electron 相关代码按 Windows 调过）
- 一个可用的 DSH Desktop 宿主
- **系统临时目录可写** —— 测试需要（见下方「质量闸门」里的提示）

### 2. 装依赖

```bash
npm install
```

### 3. 准备 Electron 运行时

仓库**不包含** Electron 二进制（约 200MB，`runtime/` 已在 `.gitignore` 中）。
把 Electron 解压/安装到仓库根的 `runtime/`：

```
runtime/electron.exe
```

### 4. 装桥插件到宿主

把 `whale-bridge/` 作为 Cordis 插件加载进 DSH 宿主（它通过 `cordis.patch.yml`
声明 bundle 与 client 入口）。**装完必须重启宿主** —— 桥的服务与路由在 `apply`
时装配、监听 19387 端口。

### 5. 起小窗

```bash
runtime/electron.exe whale-window
```

小窗会自己连上桥（端口从命令行/查询串取，默认 19387）。

## 质量闸门

项目用 **7 道机械闸门**兜住纪律（提交前由 pre-commit 钩子自动跑）：

```bash
npm run gate          # 全部 7 道
npm run gate:quick    # 快速档
npm test              # 951 个测试
npm run lint
npm run scan:secrets  # 凭证扫描
```

| 闸门 | 检查什么 |
|---|---|
| 1 语法 | 所有 JS/HTML 能解析 |
| 2 Lint | ESLint 无错 |
| 3 单测 | 测试全绿 |
| 4 密钥扫描 | 无硬编码凭证 |
| 5 依赖扫描 | 无多余/危险依赖 |
| 6 规范扫描 | 单文件 ≤ 500 行、模块拆分等强制项 |
| 7 正文守门 | 交付文本不得混入内部摘要 |

> **踩坑提示**：测试会往系统临时目录写东西。如果 `%TEMP%` 不可写
> （某些加固环境会锁），会看到一批 `EPERM mkdtemp` 失败 ——
> **不是代码坏了**，换个可写目录即可：
>
> ```bash
> # PowerShell
> $env:TEMP = "D:\path\to\writable"; $env:TMP = $env:TEMP
> npm test
> ```

## 文档

| 文档 | 内容 |
|---|---|
| [Whale-PRD.md](Whale-PRD.md) | 需求与验收标准 |
| [Whale-ARCHITECTURE.md](Whale-ARCHITECTURE.md) | 分层与模块边界 |
| [Whale-STATUS.md](Whale-STATUS.md) | 当前状态、版本沿革、**107 条环境坑** |
| [docs/](docs/) | 各步骤交付物与开发规范 |

`Whale-STATUS.md` 里的「环境坑」是一份踩坑清单 —— 每条都记了**现象、根因、
为什么当时判断错了**。如果你要改这个项目，先读它比读代码省时间。

## 已知边界

- 小窗与侧边栏是**两个独立窗口**，各自合成，所以阴影必须成对设置才能看着像一整块
- 侧边栏内嵌浏览器为安全考虑：只有这个窗口开了 `webviewTag`，
  主窗保持关闭，侧窗不注册任何 IPC handler
- 归档、文件读取等能力**需要宿主重启**才生效（桥在宿主进程内）

## License

未指定。若要开源发布，建议补一份 LICENSE（例如 MIT）。
