/*
 * 工作区文件列表页面
 *
 * 职责：小窗主区内显示当前工作区的文件与文件夹（顶栏「文件夹」图标进入），
 *       可逐层点进目录、可返回上级、点文件用系统默认程序打开。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：它是一个**页面**（面包屑 + 列表 + 返回 + 下钻状态），
 * 与会话列表、技能中心都不是一类东西；混进 sidebar.js 或 app.js
 * 会把那两个文件顶过 500 行上限（强制 14），且职责不同。
 *
 * ## 数据来自哪
 *
 *   · 列表：桥 `GET /whale/workspace/files?sessionId=&dir=`（桥复用宿主的
 *     `fileReferences`，实测「传目录前缀」即「列该目录」）；
 *   · 打开：桥 `POST /whale/workspace/open`（桥走宿主
 *     `session/openWorkspacePath`，用系统默认程序打开）。
 *
 * **打开不是小窗自己开**：小窗没有也不需要 shell 权限，宿主才是
 * 工作区边界的持有者（详见桥侧 handlers-workspace.mjs）。
 *
 * ## 降级纪律
 *
 * 读不到就显示**原因**，不显示空列表 ——「这个目录是空的」与
 * 「读不到文件」含义完全不同。宿主那条路需要活 agent，
 * 拿不到时要如实说，否则用户会以为工作区里什么都没有。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleFilesView。
 */

(function attachFilesView(global) {
  "use strict";

  /**
   * 建文件列表页面控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {view, fvBack, fvCrumb, fvCount, fvList}
   * @param {(dir: string) => Promise<object>} deps.fetchFiles 拉某目录的条目
   * @param {(path: string) => Promise<object>} deps.openPath 用系统默认程序打开
   * @param {() => void} deps.onBack 返回消息流
   * @param {(msg: string) => void} [deps.onNotify] 如实提示
   * @returns {object} 控制器
   */
  function createFilesView(deps) {
    const dom = deps.dom;
    const onNotify = typeof deps.onNotify === "function" ? deps.onNotify : function () {};

    /** 当前目录前缀（空串 = 工作区根）。 */
    let dir = "";
    /** 当前目录的条目（渲染用）。 */
    let entries = [];
    let visible = false;

    /** 取路径末段（显示用；与桥侧 baseName 同口径）。 */
    function baseName(path) {
      const parts = String(path).split("/").filter(function (s) { return s !== ""; });
      return parts.length > 0 ? parts[parts.length - 1] : String(path);
    }

    /** 渲染面包屑：根 / a / b，每段可点。 */
    function renderCrumb() {
      dom.fvCrumb.innerHTML = "";
      const parts = dir === "" ? [] : dir.split("/").filter(function (s) { return s !== ""; });

      /** 造一段可点的面包屑。 */
      function segment(label, targetDir, isLast) {
        const el = global.document.createElement("span");
        el.className = isLast ? "fv-crumb-seg fv-crumb-cur" : "fv-crumb-seg";
        el.textContent = label;
        if (!isLast) {
          el.addEventListener("click", function () { void gotoDir(targetDir); });
        }
        dom.fvCrumb.appendChild(el);
      }

      segment("工作区", "", parts.length === 0);
      parts.forEach(function (name, i) {
        const sep = global.document.createElement("span");
        sep.className = "fv-crumb-sep";
        sep.textContent = "/";
        dom.fvCrumb.appendChild(sep);
        segment(name, `${parts.slice(0, i + 1).join("/")}/`, i === parts.length - 1);
      });
    }

    /**
     * 渲染条目列表。
     *
     * @param {string|null} [emptyReason] 空清单时的**说明**（宿主给的原因）。
     *   给了它就说原因，没给才说「这个目录是空的」——
     *   两者含义不同：一个是「做不到」，一个是「真没有」。
     */
    function render(emptyReason) {
      renderCrumb();
      dom.fvCount.textContent = String(entries.length);
      dom.fvList.innerHTML = "";

      if (entries.length === 0) {
        const none = global.document.createElement("div");
        none.className = "fv-empty";
        none.textContent = typeof emptyReason === "string" && emptyReason !== ""
          ? emptyReason
          : "这个目录是空的";
        dom.fvList.appendChild(none);
        return;
      }

      entries.forEach(function (e) {
        const row = global.document.createElement("div");
        row.className = `fv-row fv-${e.kind}`;

        const icon = global.document.createElement("span");
        icon.className = "fv-icon";
        icon.textContent = e.kind === "directory" ? "▸" : "·";
        row.appendChild(icon);

        const name = global.document.createElement("span");
        name.className = "fv-name";
        name.textContent = e.name;
        name.title = e.path;
        row.appendChild(name);

        row.addEventListener("click", function () {
          if (e.kind === "directory") {
            void gotoDir(`${e.path}/`);
            return;
          }
          void openEntry(e.path);
        });

        dom.fvList.appendChild(row);
      });
    }

    /** 显示失败（与「空目录」区分开）。 */
    function showFailure(message) {
      dir = "";
      entries = [];
      visible = true;
      dom.view.hidden = false;
      renderCrumb();
      dom.fvCount.textContent = "–";
      dom.fvList.innerHTML = "";
      const err = global.document.createElement("div");
      err.className = "fv-empty";
      err.textContent = message;
      dom.fvList.appendChild(err);
      onNotify(message);
    }

    /** 切到某目录并渲染。 */
    function gotoDir(next) {
      return Promise.resolve(deps.fetchFiles(next)).then(function (out) {
        if (out === null || out === undefined || out.ok !== true) {
          // 读不到就显示原因，不把旧目录的条目留在屏幕上冒充新目录
          showFailure(`读不到这个目录：${out?.code ?? "unknown"}`);
          return out;
        }
        dir = typeof out.dir === "string" ? out.dir : "";
        entries = Array.isArray(out.entries) ? out.entries : [];
        visible = true;
        dom.view.hidden = false;
        /*
         * 宿主有条路「需要活 agent」——那种情况它给空清单 + reason。
         * 那不是空目录，要把原因交给渲染（否则会显示成「这个目录是空的」）。
         */
        render(typeof out.reason === "string" ? out.reason : null);
        return out;
      });
    }

    /** 用系统默认程序打开一个文件。 */
    function openEntry(path) {
      return Promise.resolve(deps.openPath(path)).then(function (out) {
        if (out !== null && out !== undefined && out.ok === true) return out;
        const code = out?.code ?? "unknown";
        global.console.warn(`打开失败：${code}`);
        onNotify(`打开失败（${code}）`);
        return out;
      });
    }

    /** 进入页面（从工作区根开始）。 */
    function show() {
      visible = true;
      dom.view.hidden = false;
      return gotoDir("");
    }

    /** 隐藏。 */
    function hide() {
      visible = false;
      dom.view.hidden = true;
    }

    function isVisible() {
      return visible;
    }

    dom.fvBack.addEventListener("click", function () {
      hide();
      deps.onBack();
    });

    return { baseName, gotoDir, hide, isVisible, show, showFailure };
  }

  global.WhaleFilesView = { createFilesView };
})(typeof window !== "undefined" ? window : globalThis);
