/*
 * 技能中心页面
 *
 * 职责：小窗主区内显示宿主的技能目录（侧边栏「技能中心」点开后进入），
 *       支持按名字/描述/用途筛选。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：它是一个**页面**（有自己的头部、搜索、列表与返回），
 * 与会话列表、浮层都不是一类东西；混进 sidebar.js 或 app.js
 * 会把那两个文件顶过 500 行上限（强制 14）。
 *
 * 数据来自桥的 `GET /whale/skills`（桥走宿主的 Typert `skills/list`）——
 * 实测 214 条，与主窗口技能中心同源。
 *
 * 降级纪律：读不到就是读不到，**显示失败原因，不显示空列表**。「读不到」
 * 与「真的没有技能」含义不同，混成一个会让用户以为技能丢了。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSkillsView。
 */

(function attachSkillsView(global) {
  "use strict";

  /**
   * 建技能中心页面控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {view, svBack, svTitle, svCount, svSearch, svList}
   * @param {() => void} deps.onBack 返回消息流
   * @param {(msg: string) => void} [deps.onNotify]
   * @returns {object} 控制器
   */
  function createSkillsView(deps) {
    const dom = deps.dom;
    const onNotify = typeof deps.onNotify === "function" ? deps.onNotify : function () {};
    /** 当前持有的技能清单（搜索时在本地筛，不重复请求宿主）。 */
    let skills = [];
    let visible = false;

    /** 按关键字筛选。 */
    function filtered() {
      const q = (dom.svSearch.value ?? "").trim().toLowerCase();
      if (q === "") return skills;
      return skills.filter(function (s) {
        return [s.name, s.description, s.whenToUse ?? ""]
          .join(" ")
          .toLowerCase()
          .indexOf(q) !== -1;
      });
    }

    /** 渲染列表。 */
    function render() {
      const list = filtered();
      dom.svCount.textContent = `${list.length} / ${skills.length}`;
      dom.svList.innerHTML = "";

      if (list.length === 0) {
        const none = global.document.createElement("div");
        none.className = "sv-empty";
        none.textContent = skills.length === 0 ? "没有技能" : "没有匹配的技能";
        dom.svList.appendChild(none);
        return;
      }

      list.forEach(function (s) {
        const row = global.document.createElement("div");
        row.className = "sv-row";

        const name = global.document.createElement("span");
        name.className = "sv-name";
        name.textContent = s.name;
        row.appendChild(name);

        const tag = global.document.createElement("span");
        tag.className = "sv-tag";
        tag.textContent = s.modelInvocable ? "模型可调" : "仅用户";
        row.appendChild(tag);

        if (s.description !== "") {
          const desc = global.document.createElement("div");
          desc.className = "sv-desc";
          desc.textContent = s.description;
          row.appendChild(desc);
        }

        dom.svList.appendChild(row);
      });
    }

    /** 显示（传入技能清单）。 */
    function show(list) {
      skills = Array.isArray(list) ? list : [];
      visible = true;
      dom.view.hidden = false;
      dom.svSearch.value = "";
      render();
    }

    /** 显示失败（与「没有技能」区分开）。 */
    function showFailure(message) {
      skills = [];
      visible = true;
      dom.view.hidden = false;
      dom.svCount.textContent = "–";
      dom.svList.innerHTML = "";
      const err = global.document.createElement("div");
      err.className = "sv-empty";
      err.textContent = message;
      dom.svList.appendChild(err);
      onNotify(message);
    }

    /** 隐藏。 */
    function hide() {
      visible = false;
      dom.view.hidden = true;
    }

    function isVisible() {
      return visible;
    }

    dom.svBack.addEventListener("click", function () {
      hide();
      deps.onBack();
    });
    dom.svSearch.addEventListener("input", render);

    return { hide, isVisible, render, show, showFailure };
  }

  global.WhaleSkillsView = { createSkillsView };
})(typeof window !== "undefined" ? window : globalThis);
