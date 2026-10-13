/*
 * 侧边栏装配
 *
 * 职责：把「左侧边栏」与「技能中心页面」接到客户端与 DOM 上
 *       （点会话 → 切换/唤醒；点新会话 → 宿主建会话；点技能中心 → 拉目录）。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么从 app.js 拆出来（强制 14）：app.js 是总装配层，加上这两个
 * 入口后超过 500 行上限。侧边栏是**一个业务域**（导航 + 会话切换 + 技能入口），
 * 与 app.js 里其余的装配（输入框、命令面板、浮层）不是一类改动原因，
 * 所以按域拆出，而不是放宽行数限制。
 *
 * 三条纪律：
 *   1. 会话切换的**副作用**要说清：「可切换」直接切，「历史」先唤醒成功才切。
 *   2. 新建会话是**写操作**（宿主会真的建一个）—— 连点必须挡住。
 *   3. 读不到数据要**显示原因**，不给空列表 —— 「读不到」与「真的没有」
 *      含义不同，混成一个会让用户以为数据丢了。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSidebarMount。
 */

(function attachSidebarMount(global) {
  "use strict";

  /**
   * 装配侧边栏与技能中心页面。
   *
   * @param {object} deps
   * @param {object} deps.dom {stream, btnSideLeft, sidebar, sbClose, sbNew, sbSkills,
   *                          sbSessions, skillsView, svBack, svCount, svSearch, svList}
   * @param {object} deps.client 桥客户端（activate / resume / createSession / skills）
   * @param {(msg: string) => void} [deps.notify] 如实提示
   * @returns {object} {sidebar, skillsView}
   */
  function mount(deps) {
    const dom = deps.dom;
    const client = deps.client;
    const notify = typeof deps.notify === "function" ? deps.notify : function () {};

    /**
     * 技能中心页面（侧边栏「技能中心」进入）。
     *
     * 与消息流**并列**：进入时只隐藏消息流，不动输入区 ——
     * 用户随时还能说话，返回时消息流的滚动位置也不丢。
     */
    const skillsView = global.WhaleSkillsView.createSkillsView({
      dom: {
        view: dom.skillsView,
        svBack: dom.svBack,
        svCount: dom.svCount,
        svSearch: dom.svSearch,
        svList: dom.svList,
      },
      onBack() {
        dom.stream.hidden = false;
      },
      onNotify: notify,
    });

    /**
     * 工作区文件列表页面（顶栏「文件夹」图标进入）。
     *
     * 与技能中心同一模式：与消息流并列、切换只改 hidden。
     * 「打开」走桥到宿主（小窗没有 shell 权限，也不需要）。
     */
    const filesView = global.WhaleFilesView.createFilesView({
      dom: {
        view: dom.filesView,
        fvBack: dom.fvBack,
        fvCrumb: dom.fvCrumb,
        fvCount: dom.fvCount,
        fvList: dom.fvList,
      },
      fetchFiles: (dir) => client.workspaceFiles(dir),
      openPath: (path) => client.openWorkspacePath(path),
      onBack() {
        dom.stream.hidden = false;
      },
      onNotify: notify,
    });

    /**
     * 侧边栏底部的账号信息 + 充值余额。
     *
     * 只在**侧边栏打开时**刷新（余额是低频信息，没必要常驻轮询 ——
     * 那会每 5 秒敲一次宿主账号接口）。
     */
    const accountPanel = global.WhaleAccountPanel.createAccountPanel({
      dom: {
        avatar: dom.sbAccAvatar,
        name: dom.sbAccName,
        sub: dom.sbAccSub,
        balance: dom.sbAccBalance,
      },
      fetchAccount: () => client.account().then((out) => {
        if (!out.ok) return { ok: false, code: out.code };
        // data 是整个响应体（含 profile / balance / 各自的 Code）
        return Object.assign({ ok: true }, out.data);
      }),
    });

    const sidebar = global.WhaleSidebar.createSidebar({
      dom: {
        sidebar: dom.sidebar,
        sbClose: dom.sbClose,
        sbNew: dom.sbNew,
        sbSkills: dom.sbSkills,
        sbSessions: dom.sbSessions,
      },
      /*
       * ⚠️ 会话清单**自己拉**，不读 `state.sessions`。
       *
       * `state.sessions` 来自 `/whale/hud`，只有折叠器里那几条、
       * 且**没有工作区字段**；而侧边栏要按工作区分组、要列出全部会话。
       *
       * 但 `session/list` 可能**整体失败**：实测宿主报
       * `SESSION_QUERY_SOURCE_CONFLICT`（它自己两条观察的 header 不一致，
       * 属于宿主侧的数据状态问题）。那时**回退到 hud 里那份** ——
       * 虽然只有部分会话、缺标题与工作区，但至少能看、能切，
       * 比整块空白强（降级原则：宁可局部失效不整体崩溃）。
       * 回退要**标记降级**，让界面说明原因，不假装数据完整。
       */
      fetchSessions: () => client.sessionList().then((out) => {
        if (out.ok) return out;
        const fallback = client.getState().sessions ?? [];
        if (fallback.length > 0) {
          /*
           * ⚠️ archivedKnown 必须为 **false**：hud 那份数据没有归档标记，
           * 若报 true 会把所有会话当成「已归档判据已拿到」而按字段隐藏 ——
           * 而那些字段根本不存在，等于没隐藏；更糟的是语义上撒谎。
           */
          return { ok: true, sessions: fallback, degraded: out.code, archivedKnown: false };
        }
        return out;   // 回退也没数据：如实报错
      }),
      getCurrentId: () => client.getState().sessionId,
      onSwitch(sessionId) {
        client.activate(sessionId).then((out) => {
          if (!out.ok) {
            global.console.warn(`切换失败：${out.code}`);
            notify(`切换会话失败（${out.code}）`);
            return;
          }
          /*
           * ⚠️ activate 只挪了桥的活跃指针；小窗的标题/内容要等下一次
           * 轮询（5 秒）才更新。用户报「点了没反应」正是这一秒的差距。
           * 切完**主动刷新**，标题和面板立刻跟过去。
           */
          client.refresh();
        });
      },
      onResume(sessionId) {
        client.resume(sessionId).then((out) => {
          if (out.ok) {
            sidebar.markWoke(sessionId);
            client.activate(sessionId).then((act) => {
              // 同 onSwitch：唤醒并激活后主动刷新，别让标题等下一轮
              if (!act.ok) {
                global.console.warn(`激活失败：${act.code}`);
                notify(`激活会话失败（${act.code}）`);
                return;
              }
              client.refresh();
            });
            return;
          }
          sidebar.markWakeFailed(sessionId);
          global.console.warn(`唤醒失败：${out.code}`);
          notify(`唤醒会话失败（${out.code}）`);
        });
      },
      onNewSession() {
        /*
         * 建会话是**写操作**。侧边栏那边已挡住连点，
         * 这里只负责把结果规整成 {ok, sessionId}。
         */
        return client.createSession().then((out) => {
          if (!out.ok) return { ok: false, code: out.code };
          return { ok: true, sessionId: out.raw?.sessionId ?? null };
        });
      },
      onOpenSkills() {
        const sessionId = client.getState().sessionId;
        if (typeof sessionId !== "string" || sessionId === "") {
          skillsView.showFailure("还没有会话，读不到技能目录");
          dom.stream.hidden = true;
          return;
        }
        client.skills(sessionId).then((out) => {
          dom.stream.hidden = true;
          if (out.ok) {
            skillsView.show(out.data?.skills ?? []);
            return;
          }
          // 读不到就是读不到 —— 显示原因，不显示空列表（会让用户以为技能丢了）
          skillsView.showFailure(`读不到技能目录：${out.code}`);
        });
      },
      onNotify: notify,
    });

    // 顶栏「打开左侧边栏」按钮
    dom.btnSideLeft.addEventListener("click", () => {
      sidebar.toggle();
      /*
       * 打开时才刷新账号与余额（低频信息，不常驻轮询）。
       * 失败也让面板自己显示「—」与原因，这里不打断。
       */
      if (sidebar.isOpen()) void accountPanel.refresh();
    });

    /*
     * 顶栏「文件夹」按钮 → 工作区文件列表。
     *
     * 与技能中心**互斥**：两个页面占同一块主区（都与消息流并列），
     * 同时显示会叠在一起。进文件页时把技能页收起来，反之亦然。
     */
    dom.btnFolder.addEventListener("click", () => {
      if (filesView.isVisible()) {
        filesView.hide();
        dom.stream.hidden = false;
        return;
      }
      skillsView.hide();
      dom.stream.hidden = true;
      void filesView.show();
    });

    /*
     * 顶栏「打开右侧边栏」按钮 → 右侧附带窗（独立窗口，见 lib/side-window.cjs）。
     *
     * 走主进程：窗口的位移与抽屉拉开动画只能由主进程做。
     * 失败要如实提示 —— 否则用户以为「点了没反应」。
     */
    if (dom.btnSideRight !== null && dom.btnSideRight !== undefined) {
      dom.btnSideRight.addEventListener("click", () => {
        const api = global.whale;
        if (api === undefined || typeof api.sideAction !== "function") {
          notify("打开右侧边栏失败：主进程通道未接通");
          return;
        }
        api.sideAction("toggle").then((out) => {
          if (out !== null && out !== undefined && out.ok === true) return;
          notify(`打开右侧边栏失败（${out?.code ?? "unknown"}）`);
        });
      });
    }

    /*
     * 侧窗贴住时，小窗右侧「切开」—— 去掉圆角、描边与阴影，两块连成一条面板。
     *
     * 用户报「中间不要像现在这样显示两个不在一个图层」。状态由**主进程推**
     * （跟着窗口动画走），不在这里轮询 —— 轮询会晚一拍，表现为「面板已经贴上了，
     * 小窗右边还带着圆角」。
     */
    if (global.whale !== undefined && typeof global.whale.onSideJoined === "function") {
      global.whale.onSideJoined((joined) => {
        const box = global.document.getElementById("win");
        if (box !== null) box.classList.toggle("side-joined", joined === true);
      });
    }

    return { accountPanel, filesView, sidebar, skillsView };
  }

  global.WhaleSidebarMount = { mount };
})(typeof window !== "undefined" ? window : globalThis);
