/**
 * 悬浮条 IPC 路由
 *
 * 职责：把渲染层的请求（切形态、悬停、隐藏、退出、重载、右键菜单）
 *       翻译成对状态机与窗口的动作。
 * 所属层：悬浮条（whale-hud/lib）
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
const CHANNELS = Object.freeze({
  FORM: "hud:form",
  HOVER: "hud:hover",
  HIDE: "hud:hide",
  QUIT: "hud:quit",
  RELOAD: "hud:reload",
  MENU: "hud:menu",
  READY: "hud:ready",
  DRAG_START: "hud:drag-start",
  DRAG_MOVE: "hud:drag-move",
  DRAG_END: "hud:drag-end",
  /** 唤起：显示 + 展开成条 + 聚焦（桥的复用分支留下唤起请求，渲染层来取） */
  SUMMON: "hud:summon",
});

/**
 * F7 右键菜单项。
 *
 * 顺序即用户看到的顺序，不随意调整：托盘已按用户要求移除，
 * 这三项是关掉悬浮条的**唯一途径**，位置固定才好肌肉记忆。
 */
const MENU_ITEMS = Object.freeze([
  { id: "reload", label: "重新加载界面" },
  { id: "hide", label: "隐藏悬浮条" },
  { id: "quit", label: "退出悬浮条" },
]);

/**
 * 构造右键菜单模板。
 *
 * 单独抽出来是为了能在没有 Electron 的环境里断言「三项齐全、id 没写错」——
 * 菜单项写错 id 的后果是点了没反应，属于最难受的一类 bug。
 *
 * @param {Record<string, () => void>} actions 按 id 索引的动作
 * @returns {Array<{id: string, label: string, click: Function}>}
 */
function createMenuTemplate(actions) {
  return MENU_ITEMS.map((item) => {
    const run = actions?.[item.id];
    return {
      id: item.id,
      label: item.label,
      click: typeof run === "function" ? run : () => {},
    };
  });
}

/**
 * 注册 IPC。
 *
 * @param {object} deps
 * @param {object} deps.ipcMain Electron 的 ipcMain
 * @param {object} deps.state 状态机（state.cjs 产出）
 * @param {object} deps.hudWindow 窗口封装（window.cjs 产出）
 * @param {object} deps.app Electron 的 app
 * @param {object} [deps.Menu] Electron 的 Menu（缺失时右键菜单降级为无操作）
 * @param {object} deps.log
 * @returns {{dispose: () => void, channels: string[]}}
 */
function registerIpc(deps) {
  const { ipcMain, state, hudWindow, app, log } = deps;
  const Menu = deps.Menu;

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

  /** F7 的三个动作，菜单与快捷键共用同一份实现。 */
  const actions = {
    reload: () => {
      log.info("右键菜单：重新加载界面");
      hudWindow.reload();
    },
    hide: () => {
      log.info("右键菜单：隐藏悬浮条（进程保留）");
      if (!hudWindow.win.isDestroyed()) hudWindow.win.hide();
    },
    quit: () => {
      log.info("右键菜单：退出悬浮条");
      app.quit();
    },
  };

  on(CHANNELS.READY, () => ({
    form: state.form(),
    port: deps.port ?? null,
    version: deps.version ?? null,
  }));

  /**
   * 唤起（切片 7 第三批）。
   *
   * 用户报「已重启，但是点击无法唤起」。真因是**复用 ≠ 唤起**：
   * 点鲸鱼时桥走复用分支只回 `{reused:true}`，从不把已存在的悬浮条显示出来。
   * 悬浮条一旦被收成球（或隐藏），再点就是「点了没反应」。
   *
   * 三步：显示 → 展开成条 → 聚焦。
   * **展开成条是用户明确裁定的**：「我看不出反应的窗口等于没响应」。
   */
  on(CHANNELS.SUMMON, () => {
    const raw = hudWindow.win;
    if (raw !== undefined && typeof raw.isDestroyed === "function" && raw.isDestroyed()) {
      return { ok: false, code: "window-destroyed" };
    }
    hudWindow.show();
    // 收成球时展开成条：只看球等于没有反馈（用户明确裁定）
    //
    // 形态的真相源是**主进程的 state**（渲染层通过 hud:form 通道请求切换，
    // 由 state.expand/collapse 落地）—— 所以这里调 state，不是窗口封装。
    if (state.form() === "ball") state.expand();
    if (raw !== undefined && typeof raw.focus === "function") raw.focus();
    if (raw !== undefined && typeof raw.moveTop === "function") raw.moveTop();
    return { ok: true, action: "summon", form: state.form() };
  });

  on(CHANNELS.FORM, (payload) => {
    const form = payload?.form;
    if (form === "ball") {
      state.collapse();
      return { ok: true, form: state.form() };
    }
    if (form === "bar") {
      state.expand();
      return { ok: true, form: state.form() };
    }
    // 未知形态明确拒绝：静默忽略会让渲染层以为收起了，实际窗口还张着
    return { ok: false, code: "bad-form", message: `不认识的形态：${String(form)}` };
  });

  on(CHANNELS.HOVER, (payload) => {
    if (payload?.entering === true) state.hoverEnter();
    else state.hoverLeave();
    return { ok: true, form: state.form() };
  });

  on(CHANNELS.HIDE, () => {
    actions.hide();
    return { ok: true };
  });

  on(CHANNELS.QUIT, () => {
    actions.quit();
    return { ok: true };
  });

  on(CHANNELS.RELOAD, () => {
    actions.reload();
    return { ok: true };
  });

  on(CHANNELS.MENU, () => {
    if (Menu === undefined) {
      log.warn("右键菜单不可用：Menu 模块未注入");
      return { ok: false, code: "menu-unavailable" };
    }
    Menu.buildFromTemplate(createMenuTemplate(actions)).popup({
      window: hudWindow.win,
    });
    return { ok: true };
  });

  // --- 球拖动（A10）---
  // 阈值 3px 由渲染层判：位移 ≤3px 算单击（唤起小窗），>3px 才算拖动。
  // 放在渲染层是因为只有它看得到鼠标事件的完整序列。

  on(CHANNELS.DRAG_START, () => ({ ok: hudWindow.dragStart() }));

  on(CHANNELS.DRAG_MOVE, (payload) => {
    const moved = hudWindow.dragMove(payload?.dx, payload?.dy);
    return moved ? { ok: true } : { ok: false, code: "not-dragging" };
  });

  on(CHANNELS.DRAG_END, () => {
    hudWindow.dragEnd(state.form());
    return { ok: true };
  });

  return {
    channels: [...registered],
    dispose() {
      for (const channel of registered) ipcMain.removeHandler(channel);
      registered.length = 0;
    },
  };
}

module.exports = { CHANNELS, MENU_ITEMS, createMenuTemplate, registerIpc };
