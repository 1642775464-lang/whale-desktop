/*
 * DOM 引用表
 *
 * 职责：按 id 取一次全窗口的元素，装配层各处共用同一份引用。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么从 app.js 拆出来（强制 14）：app.js 是总装配层，加上侧边栏与
 * 技能中心页面的引用后超过 500 行上限。DOM 引用表是**一份清单**
 * （「窗口里有哪些可操作的元素」），与 app.js 里的装配逻辑不是一类
 * 改动原因，所以按职责拆出，而不是放宽行数限制。
 *
 * 纪律：这里**只取引用，不做任何逻辑**。缺元素时给 null，由使用方
 * 自己判断（有些浮层在旧版 index.html 里不存在，是允许的降级）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleDomTable。
 */

(function attachDomTable(global) {
  "use strict";

  /**
   * 建立 DOM 引用表。
   *
   * @param {Document} [doc] 注入用（默认 window.document）
   * @returns {object} 引用表
   */
  function createDomTable(doc) {
    const $ = function (id) {
      return (doc ?? global.document).getElementById(id);
    };

    return {
      body: global.document.body,
      win: $("win"),
      topbar: $("topbar"),
      btnMin: $("btnMin"),
      btnPin: $("btnPin"),
      btnMenu: $("btnMenu"),
      tbTitle: $("tbTitle"),
      stream: $("stream"),
      status: $("status"),
      statusText: $("statusText"),
      dock: $("dock"),
      dockHead: $("dockHead"),
      dockProg: $("dockProg"),
      dockList: $("dockList"),
      input: $("input"),
      btnPerm: $("btnPerm"),
      btnSend: $("btnSend"),
      // 输入区其余按钮（切片 7 第二批的浮层接线要用）
      btnAdd: $("btnAdd"),
      btnUsage: $("btnUsage"),
      btnModel: $("btnModel"),
      urFg: $("urFg"),
      usagePct: $("usagePct"),
      btnInfo: $("btnInfo"),
      slashPanel: $("slashPanel"),
      slashQuery: $("slashQuery"),
      slashList: $("slashList"),
      menuBox: $("menuBox"),
      menuList: $("menuList"),
      sessList: $("sessList"),
      // 左侧边栏（新会话 / 技能中心 / 会话清单）
      sidebar: $("sidebar"),
      sbClose: $("sbClose"),
      sbNew: $("sbNew"),
      sbSkills: $("sbSkills"),
      sbSessions: $("sbSessions"),
      // 技能中心页面（主区内，与消息流并列）
      skillsView: $("skillsView"),
      svBack: $("svBack"),
      svCount: $("svCount"),
      svSearch: $("svSearch"),
      svList: $("svList"),
      // 切片 7 第二批：输入区浮层与待上传清单
      inputOverlay: $("inputOverlay"),
      ovTitle: $("ovTitle"),
      ovBody: $("ovBody"),
      ovClose: $("ovClose"),
      uplList: $("uplList"),
      infoDrawer: $("infoDrawer"),
      infoSession: $("infoSession"),
      infoBridge: $("infoBridge"),
      infoEvents: $("infoEvents"),
      // 侧边栏按钮（顶栏左侧边栏开关）
      btnSideLeft: $("btnSideLeft"),
    };
  }

  global.WhaleDomTable = { createDomTable };
})(typeof window !== "undefined" ? window : globalThis);
