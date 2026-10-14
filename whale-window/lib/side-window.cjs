/**
 * 右侧附带窗
 *
 * 职责：管理「贴在小窗右侧」的附加窗口 —— 创建、贴靠跟随、抽屉拉开/收起。
 * 所属层：小窗（whale-window/lib）
 *
 * ## 为什么是独立窗口而不是窗内面板
 *
 * 用户初始说法是「小窗内的右侧面板」，但随即更正为「拉出然后贴在小窗右侧」。
 * 独立窗口才能真正**不影响小窗尺寸**，也才谈得上「抽屉拉开」——
 * 窗内面板要么盖住对话、要么把小窗撑宽，两者都与「不影响小窗」冲突。
 *
 * ## 尺寸与贴合
 *
 * 与小窗**等宽等高**（用户要求「大小和现有小窗窗口一致」）；
 * 位置由 `side-geometry.cjs` 算（纯函数、可单测）：两个窗口的**可见区**边缘相接。
 *
 * ## 抽屉动画
 *
 * 用户要求「类似抽屉拉开的匀速拉开」。窗口动画由主进程逐帧 `setBounds` 完成
 * （CSS 做不到移动整个窗口），按 `drawerFrame` 的匀速插值给每一帧位置。
 *
 * ## ⚠️ 安全口径（经用户明确授权放宽，仅此窗口）
 *
 * 本项目窗口的安全口径是 `contextIsolation 开 / nodeIntegration 关 /
 * sandbox 开 / webviewTag 关`，`window.cjs` 的注释写明「不得放宽」。
 * 本轮用户明确要求「浏览器按钮要真在窗内渲染网页」，因此**仅在本窗口**
 * 开启 `webviewTag`，其余三项保持不变，且：
 *   · 主小窗的 `webviewTag` 仍为关（不放宽它的口径）；
 *   · 本窗口没有 IPC 通道（不注册任何 `ipcMain.handle`）；
 *   · `<webview>` 只用于展示网页，不允许它访问本窗口的 preload 能力。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const sideGeometry = require("./side-geometry.cjs");
const geometry = require("./geometry.cjs");
const { HIDE_SCROLLBAR_CSS } = require("./side-web-style.cjs");

/** 等页面加载的上限（与 window.cjs 同因：漏了会让等待者永久挂住）。 */
const LOAD_TIMEOUT_MS = 8000;

/** 小窗所在目录（本文件在 lib/ 下，往上一层）。 */
const WINDOW_DIR = path.resolve(__dirname, "..");

/**
 * 建右侧附带窗管理器。
 *
 * @param {object} deps
 * @param {object} deps.BrowserWindow Electron 的 BrowserWindow 构造器
 * @param {object} deps.screen Electron 的 screen
 * @param {object} deps.log
 * @param {() => object|null} deps.mainBounds 取小窗当前窗口矩形
 * @param {() => string|null} [deps.currentSessionId] 当前展示的会话（传给页面）
 * @param {() => string|null} [deps.workspacePath] 工作区根绝对路径（传给页面）
 * @param {string} [deps.userAgent] webview 用的 UA（平板口径，见 lib/side-ua.cjs）
 * @param {(joined: boolean) => void} [deps.onJoinedChange]
 *        贴住状态变化回调：**主窗据此去掉右侧圆角与阴影**，
 *        两块看起来才是「一个连着的面板」（用户报「中间像两个图层」）。
 * @param {number} [deps.port] 桥端口（传给页面，侧窗也要连桥读数据）
 * @param {string} [deps.rendererFile] 页面路径（默认 renderer/side.html）
 * @param {string} [deps.preloadFile] preload 路径
 * @returns {object} 管理器
 */
function createSideWindow(deps) {
  const { BrowserWindow, screen, log } = deps;
  const rendererFile = deps.rendererFile ?? path.join(WINDOW_DIR, "renderer", "side.html");
  const preloadFile = deps.preloadFile ?? path.join(WINDOW_DIR, "preload.cjs");

  if (!fs.existsSync(rendererFile)) {
    // 入口缺失时 Electron 只会留个白窗口（window.cjs 也为此显式检查）
    throw new Error(`侧窗渲染层入口不存在：${rendererFile}`);
  }

  /** 侧窗实例；null 表示尚未创建。 */
  let win = null;
  /** 是否已拉开（用于幂等切换）。 */
  let opened = false;
  /** 动画定时器，null 表示当前没有动画。 */
  let animTimer = null;

  /** 小窗矩形；拿不到时给 null（调用方据此跳过跟随）。 */
  function mainBounds() {
    const b = typeof deps.mainBounds === "function" ? deps.mainBounds() : null;
    return b === null || typeof b !== "object" ? null : b;
  }

  /** 侧窗应有多宽（与小窗窗口矩形等宽）。 */
  function sideWidth() {
    const m = mainBounds();
    return m === null ? geometry.toWindowSize(geometry.defaultContentSize()).width : m.width;
  }

  /** 本机工作区（用于「贴到屏外时回退」）。 */
  function workArea() {
    try {
      return screen.getPrimaryDisplay().workArea;
    } catch {
      return undefined;
    }
  }

  /** 停掉正在播放的动画。 */
  function stopAnim() {
    if (animTimer !== null) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }

  /**
   * 确保窗口存在（延迟创建：不点按钮就不占资源）。
   *
   * @returns {object} BrowserWindow 实例
   */
  function ensure() {
    if (win !== null && !win.isDestroyed()) return win;
    const m = mainBounds();
    const width = sideWidth();
    const height = m === null ? geometry.toWindowSize(geometry.defaultContentSize()).height : m.height;
    const docked = m === null
      ? { x: 0, y: 0 }
      : sideGeometry.dockedPosition(m, width, workArea());

    win = new BrowserWindow({
      show: false,
      x: docked.x,
      y: docked.y,
      width,
      height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      roundedCorners: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 与小窗同一层级，互相之间不抢前台
      alwaysOnTop: true,
      webPreferences: {
        preload: preloadFile,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        /*
         * ⚠️ 经用户明确授权放宽（见文件头「安全口径」）：
         * 只有本窗口开 webviewTag；主小窗仍为关。
         */
        webviewTag: true,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setSkipTaskbar(true);

    /*
     * 页面地址带三个查询参数（渲染层据此工作）：
     *   · `port`      —— 桥端口（发请求用）
     *   · `sessionId` —— 当前小窗展示的会话（侧边对话「继承上下文」的默认项）
     *   · `workspace` —— 工作区根绝对路径（html 预览要拼 file:// 地址）
     */
    const query = { port: String(deps.port ?? 19387) };
    if (typeof deps.currentSessionId === "function") {
      const sid = deps.currentSessionId();
      if (typeof sid === "string" && sid !== "") query.sessionId = sid;
    }
    if (typeof deps.workspacePath === "function") {
      const ws = deps.workspacePath();
      if (typeof ws === "string" && ws !== "") query.workspace = ws;
    }
    win.loadFile(rendererFile, { query });

    /*
     * `<webview>` 里的页面用**手机 UA**（实测百度不把 iPad 当移动设备，
     * 会返回桌面版 —— 见 lib/side-ua.cjs 的对比表）。
     *
     * 同时把「无感滚动」的样式**注入到网页内部** ——
     * ⚠️ 这是必须的：webview 里是另一个独立文档，侧窗自己 CSS 的那条
     * `::-webkit-scrollbar` **管不到它**。
     *
     * ⚠️ **注入时机 + 不要管 key**（这两点都踩过）：
     *   · 只在 `did-attach-webview` 注入一次**不够** —— 那一刻 `src`（写在
     *     HTML 里）已经开始加载，注入多半落在旧文档上、导航后失效；
     *   · 于是改成每个文档就绪都注入（`dom-ready` + `did-finish-load` 兜底）；
     *   · **但不要用 `removeInsertedCSS(key)` 去重** —— 那个 key 在导航后
     *     已经失效，remove 会失败或异步很慢，反而把后续的 insert 拖掉，
     *     表现为「导航之后滚动条又出现了」（探针实测抓到 15px）。
     *     重复注入同一条规则没有任何副作用，比「精确去重」可靠得多。
     */
    const ua = deps.userAgent;
    win.webContents.on("did-attach-webview", (_e, wc) => {
      if (wc === null || wc === undefined) return;
      if (typeof ua === "string" && ua !== "" && typeof wc.setUserAgent === "function") {
        wc.setUserAgent(ua);
      }
      if (typeof wc.insertCSS !== "function") return;

      /** 往**当前文档**插一条隐藏滚动条的规则。 */
      const injectHideScrollbar = () => {
        wc.insertCSS(HIDE_SCROLLBAR_CSS).catch(() => {
          // 注入失败不致命：最多滚动条还在，不该影响页面本身能打开
          log.warn("向 webview 注入隐藏滚动条样式失败");
        });
      };

      injectHideScrollbar();                          // 当前文档先试一次
      wc.on("dom-ready", injectHideScrollbar);        // 每次导航：DOM 就绪即注入
      wc.on("did-finish-load", injectHideScrollbar);  // 兜底
    });

    /*
     * 等页面加载（带超时兜底，与 window.cjs 同因）：
     * loadFile 漏了或路径写错时，窗口会**建出来但是空的** ——
     * 外面看到「窗口在、一片白」，且没有任何报错，极难归因。
     */
    win.webContents.once("did-finish-load", () => {
      log.info("侧窗界面已加载");
    });
    const loadTimer = setTimeout(() => {
      if (!win.isDestroyed()) log.warn(`侧窗界面加载超时（${LOAD_TIMEOUT_MS}ms）`);
    }, LOAD_TIMEOUT_MS);
    if (typeof loadTimer.unref === "function") loadTimer.unref();

    win.on("closed", () => {
      stopAnim();
      win = null;
      opened = false;
    });
    log.info(`侧窗已创建 ${width}x${height} @ (${docked.x}, ${docked.y})`);
    return win;
  }

  /**
   * 把小窗当前的贴靠位置算出来。
   *
   * @returns {{x:number,y:number}|null}
   */
  function wantDocked() {
    const m = mainBounds();
    if (m === null) return null;
    return sideGeometry.dockedPosition(m, m.width, workArea());
  }

  /** 立刻把侧窗摆到贴靠位（无动画）。 */
  function snap() {
    if (win === null || win.isDestroyed()) return null;
    const m = mainBounds();
    const pos = wantDocked();
    if (pos === null || m === null) return null;
    win.setBounds({ x: pos.x, y: pos.y, width: m.width, height: m.height });
    return pos;
  }

  /**
   * 通知外部「贴住状态变了」。
   *
   * 用途：主窗要据此去掉它右侧的圆角/阴影，两块才看起来是**连在一起的
   * 一个面板**（用户报「中间不要显示成两个图层」）。
   *
   * @param {boolean} joined
   */
  function emitJoined(joined) {
    if (typeof deps.onJoinedChange === "function") deps.onJoinedChange(joined);
  }

  /**
   * 播放展开动画到目标进度（**匀速、往右长出**）。
   *
   * ⚠️ 做法是**宽度插值**而不是整体平移（用户要求：「从小窗的右边框往右拉出」）：
   *   左边缘固定在小窗的右边框上，只有宽度从 1px 长到全宽 ——
   *   观感是面板从边框里被抽出来，而不是「旁边滑来一个窗口」。
   *
   * @param {0|1} target 1 = 展开，0 = 收起（收回边框里）
   * @param {(opened: boolean) => void} [done] 结束回调
   */
  function animateTo(target, done) {
    stopAnim();
    const w = ensure();
    const m = mainBounds();
    if (m === null) {
      if (typeof done === "function") done(target === 1);
      return;
    }

    const width = m.width;
    const total = sideGeometry.DRAWER_MS;
    const stepMs = 16;                     // ≈60fps
    const steps = Math.max(1, Math.round(total / stepMs));
    let i = 0;
    const from = opened ? 1 : 0;
    const span = target - from;

    if (span === 0) {
      // 已经在目标态：直接摆好，不动画（避免无意义闪烁）
      const r = sideGeometry.expandFrame(m, width, target === 1 ? 1 : 0, workArea());
      w.setBounds({ x: r.x, y: r.y, width: r.width, height: m.height });
      if (typeof done === "function") done(target === 1);
      return;
    }

    animTimer = setInterval(() => {
      if (w.isDestroyed()) {
        stopAnim();
        return;
      }
      i += 1;
      const t = i / steps;
      const progress = from + span * t;
      const r = sideGeometry.expandFrame(m, width, progress, workArea());
      w.setBounds({ x: r.x, y: r.y, width: r.width, height: m.height });
      if (i >= steps) {
        stopAnim();
        opened = target === 1;
        if (typeof done === "function") done(opened);
      }
    }, stepMs);

    // 先显示：宽度从 1px 开始长，用户看到的是「从边框里抽出来」
    w.showInactive();
  }

  /** 展开（幂等）。 */
  function open() {
    if (opened && win !== null && !win.isDestroyed()) return { ok: true, opened: true, already: true };
    // 展开**一开始**就告诉主窗「要连在一起了」—— 等动画结束再切，
    // 中间那 200ms 会看到主窗右侧还带着圆角与阴影（正是用户报的现象）
    emitJoined(true);
    animateTo(1);
    return { ok: true, opened: true };
  }

  /** 收起（幂等）。 */
  function close() {
    if (!opened || win === null || win.isDestroyed()) {
      opened = false;
      emitJoined(false);
      return { ok: true, opened: false, already: true };
    }
    /*
     * 收起时**等收完再恢复**主窗的圆角/阴影：
     * 一开始就恢复的话，面板还在收回途中主窗右边就出现圆角，看着像裂开。
     */
    animateTo(0, () => {
      if (win !== null && !win.isDestroyed()) win.hide();
      emitJoined(false);
    });
    return { ok: true, opened: false };
  }

  /**
   * **立刻**收起（不播动画），用于小窗正在关闭这类「等不到动画结束」的场合。
   *
   * 为什么要单独一个：
   *   `close()` 的 `opened` 是在**动画结束后**才置 false 的 —— 而关小窗是
   *   「马上退出」，动画根本没机会跑完，于是状态永远停在 opened:true
   *   （用户报「关闭或者最小化小窗，侧边栏不会跟着一起关闭」，探针也复现了：
   *   `close` 事件里读到的 `opened` 仍是 true）。
   *
   *   这种场合观众看不到「收起动画」（小窗都没了），所以直接隐藏 + 归位
   *   才是对的：留下一个孤零零的侧栏比「没有动画」糟得多。
   *
   * @returns {{ok: boolean, opened: boolean}}
   */
  function closeNow() {
    stopAnim();
    opened = false;
    if (win !== null && !win.isDestroyed()) win.hide();
    emitJoined(false);
    return { ok: true, opened: false };
  }

  /** 切换。 */
  function toggle() {
    return opened ? close() : open();
  }

  /**
   * 小窗移动/缩放后跟随（只在**已拉开**时跟随；收起态不该跟着跑）。
   *
   * @returns {boolean} 是否真的调整了位置
   */
  function follow() {
    if (!opened || win === null || win.isDestroyed()) return false;
    const b = win.getBounds();
    const want = wantDocked();
    if (want === null) return false;
    const m = mainBounds();
    const need = Math.abs(b.x - want.x) > 1
      || Math.abs(b.y - want.y) > 1
      || (m !== null && Math.abs(b.width - m.width) > 1)
      || (m !== null && Math.abs(b.height - m.height) > 1);
    if (!need) return false;
    win.setBounds({
      x: want.x,
      y: want.y,
      width: m === null ? b.width : m.width,
      height: m === null ? b.height : m.height,
    });
    return true;
  }

  /** 当前状态（供 IPC 回读）。 */
  function state() {
    return {
      exists: win !== null && !win.isDestroyed(),
      opened,
      bounds: win !== null && !win.isDestroyed() ? win.getBounds() : null,
    };
  }

  /** 释放（应用退出时）。 */
  function dispose() {
    stopAnim();
    if (win !== null && !win.isDestroyed()) win.destroy();
    win = null;
    opened = false;
  }

  return { close, closeNow, dispose, ensure, follow, hide: close, open, snap, state, toggle };
}

module.exports = { createSideWindow };
