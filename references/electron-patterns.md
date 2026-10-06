# references · Electron 模式

> 唯一可信源片段。来源：宿主 `C:\Program Files\DSH Desktop\resources\app\` 实测代码 + Electron 官方文档。
> Electron 版本：**44.0.0**（与宿主 peerDependency 对齐）。

---

## 一、窗口安全基线（强制 31）

宿主所有 `BrowserWindow` 统一使用以下口径（`lib/electron-runtime-C_4WapB_.js:142`、`:1744`）：

```js
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    spellcheck: false,
  },
});
```

**本项目照此对齐，不得放宽。**

---

## 二、无边框透明窗口（悬浮条）

```js
new BrowserWindow({
  frame: false,
  transparent: true,
  resizable: false,
  skipTaskbar: true,
  alwaysOnTop: true,
  hasShadow: false,
  webPreferences: { /* 见上 */ },
});
```

置顶层级：

```js
win.setAlwaysOnTop(true, "screen-saver");
```

---

## 三、物理像素几何（**关键**）

### 问题

系统缩放 113% 时，`window.devicePixelRatio` 在本机实测**报 1**，但实际缩放是 1.13。用 `devicePixelRatio` 算尺寸会错。

### 正确做法

**物理像素走 HWND + `GetWindowRect`**，不用 `devicePixelRatio`。

```js
// 主进程侧
const hwnd = win.getNativeWindowHandle();   // Buffer
// 通过原生调用读取物理矩形，再按需换算
```

判定显示器物理边界时，读主屏 `\\.\DISPLAY1` 的真实分辨率（本机 2560×1440），而**不是** `screen.getPrimaryDisplay().size` 的逻辑值。

---

## 四、崩溃自愈（F11/F13）

```js
let crashCount = 0;

win.webContents.on("render-process-gone", () => {
  crashCount += 1;
  if (crashCount <= 2) {
    win.webContents.reload();
  } else {
    win.loadFile("renderer/crashed.html");   // 兜底页，提供「重新加载」按钮
  }
});

win.webContents.on("did-finish-load", () => {
  crashCount = 0;
});
```

状态机：

```
运行 ──render-process-gone──→ 计数+1
                                │
                   计数 ≤ 2 ────┴──── 计数 > 2
                     │                    │
                  reload()            加载 crashed.html
                     │                    │
                  成功 → 计数清零      提供"重新加载"按钮
```

---

## 五、preload 白名单（强制 32）

```js
// preload.cjs
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("whale", {
  open: (payload) => ipcRenderer.invoke("whale:open", payload),
  close: () => ipcRenderer.invoke("whale:close"),
  // ❌ 不得暴露 ipcRenderer 本体或任意 channel 转发
});
```

---

## 六、拉窗复用（F6）

```js
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;                    // 必须

spawn(electronExe, ["--no-sandbox", entryPath], {
  env,
  stdio: "ignore",
});
```

**不做孤儿防护**（F6 明确）：不跟踪 PID、不自动清理残留进程。

---

## 七、运行时可执行文件位置（D2 决策）

```
<项目根>/runtime/electron.exe          ← 从离线 zip 解包，四个客户端共享
```

来源：`%LOCALAPPDATA%\electron\Cache` 中已有的官方 zip，**不联网下载**。

---

## 八、来源

| 项 | 来源 |
|---|---|
| webPreferences 口径 | 宿主 `lib/electron-runtime-C_4WapB_.js:142`、`:1744` |
| 窗口结构不可复用 | 宿主用两个 `WebContentsView` 叠加（chromeView + content），自绘 36px 标题栏 |
| 独立进程结论 | 悬浮窗/小窗必须是独立 Electron 进程，不挂进宿主窗口 |
