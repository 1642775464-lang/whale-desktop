/*
 * 侧窗的三个面板
 *
 * 职责：浏览器 / 文件 / 侧边对话三块内容各自的渲染与交互。
 * 所属层：小窗（whale-window/renderer）
 *
 * ## 三块为什么放在一起
 *
 * 它们是同一个「侧窗内容区」的三个实现，共享同一套外框与切换方式
 * （同一时刻只显示一块、都带「返回」回首页）。拆成三个文件会让
 * 「切换」这个唯一的共同逻辑散到三处，各写一遍显示/隐藏。
 *
 * ## 三块各自的要点
 *
 *   · **浏览器**：用 `<webview>` 真在窗内渲染（经用户明确授权，
 *     仅本窗口开启了 webviewTag）。地址栏只做「补协议 + 交给 webview」，
 *     不自己发请求。
 *   · **文件**：复用主小窗那套数据结构（桥的 workspace/files），
 *     逐层点进去、点文件调系统打开。
 *   · **侧边对话**：**新建一个真会话**（宿主体内真建），然后在这个
 *     面板里与它对话；与主窗的会话互相独立。
 *
 * 降级纪律同主窗：读不到就显示**原因**，不显示空列表。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSidePanels。
 */

(function attachSidePanels(global) {
  "use strict";

  /**
   * 补全用户输入的网址（缺协议时按 https 处理）。
   *
   * 只处理「看起来像域名/IP」的输入；其它一律当成 https 补。
   * 不自己发请求 —— 交给 webview，失败由它显示。
   *
   * @param {string} raw
   * @returns {string} 可用于 webview 的 URL；空串表示没输入
   */
  function normalizeUrl(raw) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (s === "") return "";
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
    // about:blank 这类 Scheme 也放行（不带 //）
    if (/^(about|data|file|chrome):/i.test(s)) return s;
    return `https://${s}`;
  }

  /**
   * 建三个面板。
   *
   * @param {object} deps
   * @param {object} deps.dom 元素引用
   * @param {object} deps.client 侧窗桥客户端
   * @param {(name: string) => void} deps.onHome 回到首页
   * @param {(msg: string) => void} [deps.onNotify]
   * @returns {object} 控制器
   */
  function createSidePanels(deps) {
    const dom = deps.dom;
    const client = deps.client;
    const onNotify = typeof deps.onNotify === "function" ? deps.onNotify : function () {};

    /** 侧边对话的会话 id。 */
    let chatSessionId = null;
    /** 对话轮询句柄。 */
    let chatPoll = null;

    /** 造一个元素。 */
    function el(tag, cls, text) {
      const e = global.document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    // ── 浏览器 ──────────────────────────────────────

    /** 打开地址栏里的网址。 */
    function browse() {
      const url = normalizeUrl(dom.sbUrl.value);
      if (url === "") {
        onNotify("请先输入网址");
        return;
      }
      dom.sbUrl.value = url;
      if (dom.sbWeb !== null && dom.sbWeb !== undefined) {
        // webview 用 src 属性导航；setAttribute 比 property 赋值对 webview 更稳
        dom.sbWeb.setAttribute("src", url);
      }
    }

    dom.sbGo.addEventListener("click", browse);
    dom.sbUrl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") browse();
    });

    // ── 文件 ────────────────────────────────────────

    /** 渲染文件列表。 */
    function renderFiles(entries, reason) {
      dom.sfList.innerHTML = "";
      dom.sfCount.textContent = String(entries.length);

      if (entries.length === 0) {
        dom.sfList.appendChild(el("div", "sf-empty",
          typeof reason === "string" && reason !== "" ? reason : "这个目录是空的"));
        return;
      }
      entries.forEach(function (e) {
        const row = el("div", e.kind === "directory" ? "sf-row sf-dir" : "sf-row");
        row.appendChild(el("span", "sf-icon", e.kind === "directory" ? "▸" : "·"));
        const name = el("span", "sf-name", e.name);
        name.title = e.path;
        row.appendChild(name);
        row.addEventListener("click", function () {
          if (e.kind === "directory") {
            void gotoFiles(`${e.path}/`);
            return;
          }
          client.openWorkspacePath(e.path).then(function (out) {
            if (out.ok === true) return;
            onNotify(`打开失败（${out.code}）`);
          });
        });
        dom.sfList.appendChild(row);
      });
    }

    /** 切到某目录并渲染。 */
    function gotoFiles(dir) {
      return client.workspaceFiles(dir).then(function (out) {
        dom.sfCrumb.textContent = dir === "" ? "工作区" : `工作区 / ${dir.replace(/\/$/, "")}`;
        if (out.ok !== true) {
          // 读不到就显示原因，不把旧目录的条目留在屏幕上冒充新目录
          dom.sfCount.textContent = "–";
          dom.sfList.innerHTML = "";
          dom.sfList.appendChild(el("div", "sf-empty", `读不到这个目录：${out.code}`));
          return out;
        }
        renderFiles(out.entries, out.reason);
        return out;
      });
    }

    dom.sfBack.addEventListener("click", function () {
      deps.onHome("files");
    });

    // ── 侧边对话 ────────────────────────────────────

    /** 渲染对话消息（只留 user / assistant，与主窗同口径）。 */
    function renderChat(messages, running) {
      dom.scStream.innerHTML = "";
      const visible = messages.filter(function (m) {
        return m.kind === "user" || m.kind === "assistant";
      });
      dom.scState.textContent = running ? "回合运行中" : "";

      if (visible.length === 0) {
        dom.scStream.appendChild(el("div", "sc-empty",
          "这是与你主对话并行的新会话。\n说点什么开始吧。"));
        return;
      }
      visible.forEach(function (m) {
        const wrap = el("div", m.kind === "user" ? "sc-msg me" : "sc-msg");
        wrap.appendChild(el("div", "sc-role", m.kind === "user" ? "你" : "DSH"));
        wrap.appendChild(el("div", "sc-body", m.text ?? ""));
        dom.scStream.appendChild(wrap);
      });
      dom.scStream.scrollTop = dom.scStream.scrollHeight;
    }

    /** 拉一次对话内容。 */
    function refreshChat() {
      if (chatSessionId === null) return Promise.resolve(null);
      return client.panel(chatSessionId).then(function (out) {
        if (out.ok !== true) {
          dom.scState.textContent = `读不到（${out.code}）`;
          return out;
        }
        renderChat(out.messages, out.running);
        return out;
      });
    }

    /** 起对话轮询（只在对话面板显示时跑）。 */
    function startChatPoll() {
      if (chatPoll !== null) return;
      chatPoll = global.setInterval(function () {
        void refreshChat();
      }, 3000);
    }

    /** 停对话轮询。 */
    function stopChatPoll() {
      if (chatPoll !== null) {
        global.clearInterval(chatPoll);
        chatPoll = null;
      }
    }

    /** 进入侧边对话：没有会话就先建一个真会话。 */
    function openChat() {
      dom.scState.textContent = "";
      if (chatSessionId !== null) {
        startChatPoll();
        return refreshChat();
      }
      dom.scStream.innerHTML = "";
      dom.scStream.appendChild(el("div", "sc-empty", "正在新建会话…"));
      return client.createSession().then(function (out) {
        if (out.ok !== true) {
          dom.scStream.innerHTML = "";
          dom.scStream.appendChild(el("div", "sc-empty", `新建会话失败：${out.code}`));
          onNotify(`新建会话失败（${out.code}）`);
          return out;
        }
        chatSessionId = out.sessionId;
        startChatPoll();
        return refreshChat();
      });
    }

    /** 发一条消息。 */
    function sendChat() {
      const text = String(dom.scInput.value ?? "").trim();
      if (text === "") return Promise.resolve(null);
      if (chatSessionId === null) {
        onNotify("会话还没建好");
        return Promise.resolve(null);
      }
      dom.scInput.value = "";
      dom.scSend.disabled = true;
      return client.send(text).then(function (out) {
        dom.scSend.disabled = false;
        if (out.ok !== true) {
          onNotify(`发送失败（${out.code}）`);
          return out;
        }
        return refreshChat();
      });
    }

    dom.scSend.addEventListener("click", function () { void sendChat(); });
    dom.scInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") void sendChat();
    });
    dom.scBack.addEventListener("click", function () {
      deps.onHome("chat");
    });

    return {
      /** 面板显示时调用（起各自的拉取）。 */
      enter(name) {
        if (name === "browser") {
          // 地址栏留空：第一次由用户输入；不预加载任何站点（避免意外外联）
          dom.sbUrl.focus();
          return Promise.resolve(null);
        }
        if (name === "files") return gotoFiles("");
        if (name === "chat") return openChat();
        return Promise.resolve(null);
      },
      /** 面板隐藏时调用（停轮询，别让隐藏面板继续敲宿主）。 */
      leave(name) {
        if (name === "chat") stopChatPoll();
      },
    };
  }

  global.WhaleSidePanels = { createSidePanels, normalizeUrl };
})(typeof window !== "undefined" ? window : globalThis);
