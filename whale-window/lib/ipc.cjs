/**
 * 小窗 IPC 路由
 *
 * 职责：把渲染层的请求（窗口动作、拖动、日志、退出前补写状态）
 *       翻译成对窗口与状态存储的动作。
 * 所属层：小窗（whale-window/lib）
 *
 * 为什么单独成文件：这是**受控通道的守门人**。渲染层只能做这几件事，
 * 别的渠道一个都不开——所以「允许做什么」必须集中在一处看得见，
 * 散落在 main.cjs 里最容易被顺手加一条。
 *
 * 通道清单与 preload 暴露的方法**一一对应**，由契约测试钉死：
 * preload 多暴露一个而这里没注册，调用就是永远挂起的 Promise。
 */

"use strict";

/** 通道名常量：preload 与主进程共用同一份字面量。 */
const CHANNEL = Object.freeze({
  READY: "whale:ready",
  WINDOW: "whale:window",
  DRAG: "whale:drag",
  LOG: "whale:log",
  FLUSH_STATE: "whale:flush-state",
  // 右侧附带窗（顶栏「打开右侧边栏」按钮）
  SIDE: "whale:side",
});

/**
 * 允许渲染层调用的右侧窗动作。
 *
 * 同样用白名单：渲染层只能开关/查询，不能拿它做别的事。
 */
const SIDE_ACTIONS = Object.freeze(["open", "close", "toggle", "state"]);

/**
 * 允许渲染层调用的窗口动作。
 *
 * 白名单而不是「转发任意 action」：渲染层是沙箱里跑网页的地方，
 * 让它能调任意主进程动作等于把整个主进程开放出去。
 */
const WINDOW_ACTIONS = Object.freeze(["minimize", "hide", "close", "toggle-pin", "summon"]);

/**
 * 注册 IPC。
 *
 * @param {object} deps
 * @param {object} deps.ipcMain
 * @param {object} deps.win 窗口封装（window.cjs 产出）
 * @param {object} [deps.store] 状态存储器（persist.cjs 产出），用于补写
 * @param {object} deps.log
 * @param {number} [deps.port] 桥端口
 * @param {string} [deps.version]
 * @returns {{dispose: () => void, channels: string[]}}
 */
function registerIpc(deps) {
  const { ipcMain, win, log } = deps;
  const store = deps.store;

  const registered = [];

  /**
   * 注册一个通道并记下，便于卸载时逐个摘掉。
   *
   * @param {string} channel
   * @param {(payload: unknown) => unknown} handler
   */
  function on(channel, handler) {
    ipcMain.handle(channel, async (_event, payload) => handler(payload));
    registered.push(channel);
  }

  on(CHANNEL.READY, () => {
    const bounds = win.bounds();
    return {
      ok: true,
      port: deps.port ?? null,
      version: deps.version ?? null,
      bounds,
      content: win.contentSize(),
      pinned: win.win.isDestroyed() ? null : win.win.isAlwaysOnTop(),
    };
  });

  on(CHANNEL.WINDOW, (payload) => {
    const action = payload?.action;
    if (!WINDOW_ACTIONS.includes(action)) {
      // 未知动作明确拒绝：静默忽略会让渲染层以为做成了
      return { ok: false, code: "bad-action", message: `不认识的窗口动作：${String(action)}` };
    }
    if (action === "minimize") {
      win.minimize();
      return { ok: true, action };
    }
    if (action === "hide") {
      win.hide();
      return { ok: true, action };
    }
    if (action === "close") {
      win.close();
      return { ok: true, action };
    }
    if (action === "summon") {
      /**
       * 唤起：把窗口拿到用户面前。
       *
       * 用户报「已重启，但是点击无法唤起」——桥的复用分支只回 reused:true，
       * 从不把已存在的窗口显示出来（被压住时看着就是「点了没反应」）。
       * 三步都要做：还原（可能被最小化）→ 显示 → 聚焦并抬到最前。
       */
      const raw = win.win;
      if (raw !== undefined && typeof raw.isDestroyed === "function" && raw.isDestroyed()) {
        return { ok: false, code: "window-destroyed" };
      }
      if (raw !== undefined && typeof raw.isMinimized === "function" && raw.isMinimized()) {
        raw.restore();
      }
      win.show();
      if (raw !== undefined && typeof raw.focus === "function") raw.focus();
      // moveTop 兜底：无边框窗口在部分环境里 focus() 不足以压过别的前台窗口
      if (raw !== undefined && typeof raw.moveTop === "function") raw.moveTop();
      return { ok: true, action };
    }
    // toggle-pin
    const pinned = win.togglePin();
    return { ok: true, action, pinned };
  });

  on(CHANNEL.DRAG, (payload) => {
    const dx = payload?.dx;
    const dy = payload?.dy;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return { ok: false, code: "bad-delta" };
    }
    const b = win.bounds();
    if (b === null) return { ok: false, code: "no-window" };
    win.win.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
    return { ok: true };
  });

  on(CHANNEL.LOG, (payload) => {
    const message = payload?.message;
    if (typeof message === "string" && message !== "") log.info(`[渲染] ${message}`);
    return { ok: true };
  });

  on(CHANNEL.FLUSH_STATE, () => {
    if (store === undefined) return { ok: false, code: "no-store" };
    const wrote = store.flush();
    return { ok: true, wrote };
  });

  /*
   * 右侧附带窗：开 / 关 / 切换 / 查状态。
   *
   * 侧窗实例由 boot 传入（延迟创建 —— 不点按钮不占资源）；
   * 这里只做「白名单 + 转发」，不关心窗口怎么建。
   */
  on(CHANNEL.SIDE, (payload) => {
    const action = payload?.action;
    if (!SIDE_ACTIONS.includes(action)) {
      return { ok: false, code: "bad-action", message: `不认识的侧窗动作：${String(action)}` };
    }
    const side = deps.side;
    if (side === undefined || side === null) {
      return { ok: false, code: "side-unavailable", message: "侧窗未装配" };
    }
    if (action === "state") return { ok: true, ...side.state() };
    if (action === "open") return { ok: true, ...side.open() };
    if (action === "close") return { ok: true, ...side.close() };
    return { ok: true, ...side.toggle() };
  });

  return {
    channels: [...registered],
    dispose() {
      for (const channel of registered) ipcMain.removeHandler(channel);
      registered.length = 0;
    },
  };
}

module.exports = { CHANNEL, SIDE_ACTIONS, WINDOW_ACTIONS, registerIpc };
