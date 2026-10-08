/**
 * 小窗：宿主能力请求（按业务域拆出）
 *
 * 职责：把「小窗向宿主/桥发起的各项能力请求」集中一处 ——
 *       唤起请求、权限档位、模型目录与切换、文件引用、附件上传。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么从 bridge-client 拆出来：
 *   1. 它们是**独立的业务域**：「小窗怎么接会话数据」（面板/事件流/会话切换）
 *      与「小窗向宿主请求某项能力」是两类改动原因。
 *   2. bridge-client 装不下它们了（500 行上限，强制 14）。
 *
 * 三条纪律：
 *   · 失败一律**降级成中性值**（空数组 / null / false），不抛到调用方——
 *     这些请求都在渲染路径上，抛了会让整块界面停在半截。
 *   · 读不到就如实说「读不到」，**不编造**（不硬编码模型名、不编造档位）。
 *   · 需要 sessionId 的请求在缺 id 时**直接返回**，不空敲一次桥
 *     （桥会回 400，白跑一趟还刷日志）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleCapabilities。
 */

(function attachCapabilities(global) {
  "use strict";

  /**
   * 建能力请求集合。
   *
   * @param {object} deps
   * @param {() => string} deps.base 桥地址
   * @param {object} deps.state 客户端本地快照（读 sessionId、写 permission）
   * @param {() => void} deps.onChange 状态变化回调（写了 state 要通知界面）
   * @param {(path: string, body: object) => Promise<object>} deps.post 发 POST
   * @returns {object} 能力集合
   */
  function createCapabilities(deps) {
    const base = deps.base;
    const state = deps.state;
    const onChange = deps.onChange;
    const post = deps.post;

    /** 有可用 sessionId 吗（多数请求都要它）。 */
    function hasSession() {
      return typeof state.sessionId === "string" && state.sessionId !== "";
    }

    /**
     * 取走「唤起请求」。
     *
     * 用户报「已重启，但是点击无法唤起」。真因是**复用 ≠ 唤起**：
     * 桥的复用分支只回 `{reused:true}`，从不把已存在的窗口显示出来。
     * 桥没法主动推给窗口（窗口是独立进程，自己来连桥），
     * 所以做成「桥留标记、窗口用**已有轮询**来取」。
     *
     * **取走即消费**（桥侧实现），所以只有拿到 true 才唤起。
     *
     * @returns {Promise<boolean>}
     */
    function takeSummon() {
      return global
        .fetch(`${base}/whale/summon?target=window`)
        .then(function (res) { return res.ok ? res.json() : {}; })
        .then(function (json) { return json?.summon === true; })
        .catch(function () { return false; });
    }

    /**
     * 权限档位清单与当前档位。
     *
     * **顺带把当前档位写进 state** —— 输入框上那个权限标签读的就是
     * `state.permission`，它是「宿主实际档位」在小窗里的唯一落点。
     *
     * 为什么必须走宿主：用户报过「切成完全权限了，输入框还是显示工作区内修改」。
     * 根因是那个标签原先读的是 app.js 里一个**写死的常量**，
     * 而桥的面板 permission 字段又恒为 null（处理器从没传过 gates）——
     * 真值从来没有来源。`/whale/presets` 的 `current` 是宿主
     * `permissionPresets.current(session)` 算出来的，唯一真相源。
     *
     * 读不到当前值时**保留上一次显示**，不退回硬编码档位
     * （那是把「读不到」伪装成「就是这个档位」）。
     *
     * @returns {Promise<{options: Array<string>, current: string|null} | null>}
     */
    function permissionPresets() {
      if (!hasSession()) return Promise.resolve(null);
      return global
        .fetch(`${base}/whale/presets?sessionId=${encodeURIComponent(state.sessionId)}`)
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (json) {
          if (!json || !Array.isArray(json.options) || json.options.length === 0) return null;
          const current = typeof json.current === "string" && json.current !== "" ? json.current : null;
          if (current !== null) {
            state.permission = current;
            onChange(state);
          }
          return { options: json.options, current };
        })
        .catch(function () { return null; });
    }

    /**
     * 模型目录。
     *
     * 形状：{default, groups:[{id, name, models:[{id, name, reasoning:{efforts}}]}], failures}
     * 失败返回 null —— 调用方要如实显示「读不到」，不退回硬编码模型表。
     *
     * @returns {Promise<object|null>}
     */
    function modelCatalog() {
      return global
        .fetch(`${base}/whale/models`)
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (json) {
          if (!json || !Array.isArray(json.groups) || json.groups.length === 0) return null;
          return json;
        })
        .catch(function () { return null; });
    }

    /**
     * 搜工作区文件引用候选（`@` 引用）。
     *
     * 走桥的 `/whale/files`（它再转宿主的 `fileReferences.list`）——
     * 主窗口 `@` 补全用的是同一条路。返回
     * `{path, kind: "file" | "directory"}[]`，**原样透传**。
     *
     * 失败/读不到一律给空数组：调用方要如实显示「没搜到」，
     * **不编造候选**（编出来的路径用户点了会拿到一个不存在的文件）。
     *
     * @param {string} [query]
     * @returns {Promise<Array<{path: string, kind: string}>>}
     */
    function fileReferences(query) {
      if (!hasSession()) return Promise.resolve([]);
      const q = typeof query === "string" ? query : "";
      return global
        .fetch(`${base}/whale/files?sessionId=${encodeURIComponent(state.sessionId)}&q=${encodeURIComponent(q)}`)
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (json) {
          return Array.isArray(json?.candidates) ? json.candidates : [];
        })
        .catch(function () { return []; });
    }

    /**
     * 切换模型 / 推理档位。
     *
     * @param {{provider: string, model: string, reasoningEffort?: string}} selection
     * @returns {Promise<{ok: boolean, code?: string, selected?: object}>}
     */
    function setModel(selection) {
      return post("/whale/model", {
        sessionId: state.sessionId,
        provider: selection?.provider,
        model: selection?.model,
        reasoningEffort: selection?.reasoningEffort,
      });
    }

    /**
     * 上传一批文件（＋ 真上传）。
     *
     * 桥的单文件路由一次收一个文件（{name, dataBase64}），
     * 这里逐个发并收集引用；某个失败不吞掉——如实带回它的 code。
     *
     * @param {Array<{name?: string, dataBase64: string}>} files
     * @returns {Promise<{ok: boolean, code?: string, references?: Array<object>}>}
     */
    function uploadFiles(files) {
      return Promise.all(files.map(function (f) {
        return post("/whale/upload/file", { name: f.name, dataBase64: f.dataBase64 })
          .then(function (out) {
            return out.ok ? { ok: true, reference: out.raw.reference } : out;
          });
      })).then(function (results) {
        const failed = results.filter(function (r) { return !r.ok; })[0];
        if (failed) return { ok: false, code: failed.code ?? "upload-failed" };
        return { ok: true, references: results.map(function (r) { return r.reference; }) };
      });
    }

    /**
     * 批量上传图片。
     *
     * @param {Array<{name?: string, dataBase64: string, mediaType?: string}>} images
     * @returns {Promise<{ok: boolean, code?: string, references?: Array<object>}>}
     */
    function uploadImages(images) {
      return post("/whale/upload/images", { images });
    }

    return {
      fileReferences,
      modelCatalog,
      permissionPresets,
      setModel,
      takeSummon,
      uploadFiles,
      uploadImages,
    };
  }

  global.WhaleCapabilities = { createCapabilities };
})(typeof window !== "undefined" ? window : globalThis);
