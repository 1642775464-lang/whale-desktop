/**
 * 小窗：增量事件折成本地消息流
 *
 * 职责：把宿主增量流（`session/event`）的事件折进快照的
 *       `messages` / `running` / `steps` / `turns` / `toolName` / `contextWindow`。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：
 *   1. 这是**折叠规则**，与「怎么取数、怎么发请求」是两类改动原因；
 *      单独放出来，规则本身可以单测，不必搭一整套假 EventSource 环境。
 *   2. bridge-client.js 装不下它了（500 行上限，强制 14）。
 *
 * 纪律：
 *   - **纯函数**：不读时钟、不发请求，状态由参数 `state` 传入并原地改。
 *   - 事件形状归一到内部统一形状后再进 `state.messages`，
 *     渲染层只认一种形状（这是本项目反复强调的「单一真相源」）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleStream。
 */

(function attachStream(global) {
  "use strict";

  /** 小窗保留的消息条数上限（与渲染层一致）。 */
  const MESSAGE_LIMIT = 40;

  /**
   * 取事件里的文本。
   *
   * **两种封套都要兜住**（references/session-events.md 实测）：
   *   - `assistant/message` / `tool/result`：内容在 `data.message.content`
   *   - `user/message`：内容直接在 `data.content`，**没有 message 包裹**
   * 只认一种的话，另一种类型的消息会静默变成空文本被丢掉——
   * 表现是「用户发的消息在小窗里根本不出现」。
   *
   * @param {object} event
   * @returns {string}
   */
  function textOf(event) {
    const data = event.data;
    if (data === null || typeof data === "undefined") return "";
    const container = data.message ?? data;
    const content = container.content;
    if (Array.isArray(content)) {
      return content
        .filter(function (c) { return c && c.type === "text"; })
        .map(function (c) { return c.text; })
        .join("");
    }
    return "";
  }

  /**
   * 把一条宿主事件并进快照。
   *
   * **事件字段与面板字段不同**，必须归一到同一个内部形状：
   *   - 增量流给的是宿主原样事件：`{type, data:{message:{content:[...]}}}`
   *   - 面板给的是桥投影过的：`{kind:"user"|"assistant"|"tool", text, seq}`
   * 统一成 `{kind, text}` 之后，渲染层只认一种形状。
   * 曾经渲染层按 `role` 读，而桥给的是 `kind` —— 结果每条消息都渲染成「DSH」，
   * 用户的发言完全看不出来。
   *
   * @param {object} state 快照（原地改）
   * @param {object} event 宿主事件
   * @returns {boolean} 是否产生了可见变化
   */
  function applyEventTo(state, event) {
    if (event === null || typeof event !== "object") return false;
    const type = event.type;

    if (type === "user/message") {
      pushMessage(state, { kind: "user", text: textOf(event), seq: event.seq ?? null });
      return true;
    }
    if (type === "assistant/message") {
      pushMessage(state, { kind: "assistant", text: textOf(event), seq: event.seq ?? null });
      return true;
    }
    if (type === "turn/start") {
      state.running = true;
      state.turns += 1;
      return true;
    }
    if (type === "turn/end") {
      state.running = false;
      state.toolName = null;
      return true;
    }
    if (type === "step/start") {
      state.steps += 1;
      return true;
    }
    if (type === "tool/call") {
      const name = event.data && event.data.name ? event.data.name : null;
      state.toolName = name;
      pushMessage(state, { kind: "tool", name, text: "", seq: event.seq ?? null });
      return true;
    }
    if (type === "request/context") {
      if (event.data && typeof event.data.contextWindow === "number") {
        state.contextWindow = event.data.contextWindow;
        return true;
      }
      return false;
    }
    return false;
  }

  /** 推一条消息，超出上限丢最旧。 */
  function pushMessage(state, msg) {
    state.messages.push(msg);
    while (state.messages.length > MESSAGE_LIMIT) state.messages.shift();
  }

  global.WhaleStream = { MESSAGE_LIMIT, applyEventTo, pushMessage, textOf };
})(typeof window !== "undefined" ? window : globalThis);
