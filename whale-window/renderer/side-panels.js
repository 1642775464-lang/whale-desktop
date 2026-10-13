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
 * @param {() => string|null} [deps.currentSessionId] 当前小窗展示的会话（继承下拉的默认项）
 * @param {(path: string) => void} [deps.onOpenInBrowser] html 预览转给浏览器面板
 * @param {object} [deps.preview] 文件分类函数（file-preview.cjs 的导出）
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

    /*
     * 浏览器面板的「返回」。
     *
     * ⚠️ 用户报的 bug：「浏览器点击返回，侧边栏不会回到初始页面」——
     * 根因是**这个按钮当初根本没接事件**（文件与对话两个面板都接了，
     * 只有它漏了）。所以不是逻辑错，是漏接线。
     */
    dom.sbBack.addEventListener("click", function () {
      deps.onHome("browser");
    });

    /** 外部（html 预览）要求切到浏览器面板并打开某个地址。 */
    function openInBrowser(url) {
      dom.sbUrl.value = url;
      if (dom.sbWeb !== null && dom.sbWeb !== undefined) {
        dom.sbWeb.setAttribute("src", url);
      }
    }

    // ── 文件 ────────────────────────────────────────
    /*
     * 文件面板整体搬到了 `side-files.js`（列表 + 预览 + html 转浏览器）。
     *
     * 为什么搬走：这一段从「纯列表」长成了「列表 + 七种预览 + 转浏览器」，
     * 再留在本文件里会把它顶过 500 行上限（强制 14），
     * 而且它与浏览器/对话两块已经不是同一类东西了。
     *
     * 装配在下面 `createSideFiles` 处完成；本文件只持有它的引用并转发。
     */
    const files = global.WhaleSideFiles.createSideFiles({
      dom,
      client,
      preview: deps.preview,
      onOpenInBrowser: (path) => { deps.onOpenInBrowser(path); },
      /*
       * ⚠️ `onHome` 必须转发 —— 用户报「文件区点返回回不到侧边栏首页」，
       * 根因就是上一轮拆出文件面板时**漏传了这个依赖**：`deps.onHome(...)`
       * 在 `side-files.js` 里被调用时是 undefined，直接抛错、什么都不发生。
       *
       * 这类「漏传依赖」不会在启动时报错，只在用户点下去那一刻才暴露 ——
       * 所以新增/搬迁组件时，要对着它的 deps 签名逐个核对（见开发规范）。
       */
      onHome: (name) => { deps.onHome(name); },
      onNotify,
    });

    // 文件面板的「返回」由 side-files.js 自己接（它知道该回列表还是回首页）

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

    /**
     * 填充「继承上下文」下拉。
     *
     * 用户要求：「侧边对话需要支持选择继承的上下文的会话（按照标题选）、
     * 默认是继承当前小窗展示会话的上下文」。
     *
     * 所以：
     *   · 列表来自桥的会话清单（**全部工作区**，带工作区名便于区分同名标题）；
     *   · 默认选中**当前小窗展示的会话**（`deps.currentSessionId()`）；
     *   · 拿不到清单时保留一项「当前会话」，不让下拉变空 —— 空下拉比没得选更糟。
     */
    function fillInheritOptions() {
      if (dom.scInherit === null || dom.scInherit === undefined) return Promise.resolve(null);
      const current = typeof deps.currentSessionId === "function" ? deps.currentSessionId() : null;
      return client.sessionList().then(function (out) {
        dom.scInherit.innerHTML = "";
        const add = (value, label, selected) => {
          const opt = global.document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          if (selected) opt.selected = true;
          dom.scInherit.appendChild(opt);
        };

        if (out.ok !== true || out.sessions.length === 0) {
          // 清单读不到也要能用：至少列出「当前会话」
          add(current ?? "", current === null ? "当前会话（读不到清单）" : "当前会话", true);
          return out;
        }
        for (const s of out.sessions) {
          const ws = s.workspaceTitle !== "" ? `｜${s.workspaceTitle}` : "";
          add(s.sessionId, `${s.title}${ws}`, s.sessionId === current);
        }
        // 当前会话不在清单里时也补一项，避免「默认」落空
        if (current !== null && !out.sessions.some((s) => s.sessionId === current)) {
          add(current, "当前会话", true);
        }
        return out;
      });
    }

    /** 进入侧边对话：没有会话就先建一个真会话。 */
    function openChat() {
      dom.scState.textContent = "";
      void fillInheritOptions();
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
        // 文件面板整体交给 side-files.js（默认列当前工作区根）
        if (name === "files") return files.enter();
        if (name === "chat") return openChat();
        return Promise.resolve(null);
      },
      /** 由 html 预览转过来：切到浏览器面板并打开该地址。 */
      openInBrowser(url) {
        openInBrowser(url);
      },
      /** 面板隐藏时调用（停轮询，别让隐藏面板继续敲宿主）。 */
      leave(name) {
        if (name === "chat") stopChatPoll();
      },
    };
  }

  global.WhaleSidePanels = { createSidePanels, normalizeUrl };
})(typeof window !== "undefined" ? window : globalThis);
