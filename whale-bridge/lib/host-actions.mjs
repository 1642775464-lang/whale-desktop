/**
 * 宿主写操作封装
 *
 * 职责：把「向会话发消息 / 中断 / 执行命令 / 切模型」这些**改宿主状态**的动作
 *       包成薄封装，并严格对齐宿主自身的通路与守卫。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么必须严格对齐宿主（而不是自己发明一套）：
 *   《references/host-interfaces.md》记录的通路来自宿主已发布代码，
 *   桥与宿主 UI 走同一条路，才能保证行为一致——尤其是 `cancel` 的
 *   `keepInbox: true`：宿主自己的「停止」按钮就是这个语义
 *   （`dsh-api-session-controller/lib/index.js:994-1000`）。
 *   若桥改成 `keepInbox: false`，会顺手清空用户的待发队列——用户没让我停队列。
 *
 * 铁律 A-1：本模块**不 require 任何 `@deepseek-ai/` 包**。
 *   构造用户消息所需的形状已在《host-interfaces》中探明：
 *   `createUserMessage` 只是 `createMessage({...input, role:"user"})`，
 *   而 `createMessage` 等于 `deepFreeze(structuredClone({...input, id: randomUUID()}))`。
 *   故桥自行构造等价对象即可，无需 import 宿主包。
 */

import { randomUUID } from "node:crypto";

/**
 * 构造一条用户消息，形状对齐宿主 `createUserMessage`。
 *
 * @param {Array<object>} content 内容块数组
 * @param {object} [source] 来源标记
 * @returns {object}
 */
export function createUserMessage(content, source = { kind: "user" }) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content,
    source,
  });
}

/**
 * 把纯文本包成内容块数组。
 *
 * @param {string} text
 * @returns {Array<{type: string, text: string}>}
 */
export function textContent(text) {
  return [{ type: "text", text }];
}

/**
 * 建立宿主写操作封装。
 *
 * 每个动作都返回 `{ok, ...}` 而不抛错——由调用方（处理器）决定 HTTP 状态。
 * 但**参数错误与宿主守卫拦截会带 `code`**，处理器据此区分 400/404/409。
 *
 * @param {object} deps
 * @param {object} deps.host host-ctx.mjs 建立的宿主访问封装
 * @returns {object} 写操作集合
 */
export function createHostActions({ host }) {
  return {
    send,
    abort,
    command,
    activate,
    setModel,
    resume,
    setApprovalPolicy,
    uploadFile: (input) => host.uploadFile(input ?? {}),
    uploadImages: (input) => host.uploadImages(input ?? {}),
  };

  /**
   * 发消息到会话。
   *
   * 语义（S3-D1）：
   *   - 空闲 → `followup`（开启新回合）
   *   - 运行中 + 未指定 mode → `followup`（等于排队下一回合）
   *   - 运行中 + `mode: "steer"` → `steer`（插入当前回合下一步）
   *   - 空闲 + `mode: "steer"` → 照宿主守卫拒绝（`session/steer-unavailable`）
   *
   * 返回 `queued` 表明这条消息是不是「排队等下一回合」。
   *
   * @param {{sessionId?: string, text?: string, mode?: string}} input
   * @returns {{ok: boolean, code?: string, message?: string, queued?: boolean, mode?: string}}
   */
  function send(input) {
    const sessionId = input?.sessionId;
    const text = input?.text;

    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "bad-request", message: "缺少 sessionId" };
    }
    if (typeof text !== "string" || text === "") {
      return { ok: false, code: "bad-request", message: "缺少 text" };
    }

    const agent = host.getAgent(sessionId);
    if (agent === undefined) {
      return { ok: false, code: "session-not-found", message: `会话 ${sessionId} 的 agent 不可用` };
    }

    const running = agent.status === "running";
    const wantSteer = input?.mode === "steer";

    // 对齐宿主守卫：非运行态不允许 steer
    if (wantSteer && !running) {
      return {
        ok: false,
        code: "session/steer-unavailable",
        message: "会话当前未运行，无法插入当前回合",
      };
    }

    const message = wrapContent(text, input);

    try {
      if (wantSteer) {
        agent.steer(message);
        return { ok: true, queued: false, mode: "steer" };
      }
      agent.followup(message);
      // 运行中的 followup 等于排队下一回合
      return { ok: true, queued: running, mode: "queue" };
    } catch (err) {
      return { ok: false, code: err?.code ?? "send-failed", message: err?.message ?? "发送失败" };
    }
  }

  /**
 * 判断一个值能否无损 JSON 序列化。
 *
 * 为什么桥要自己判：宿主在 `session.append` 里对事件 data 做
 * `snapshotJsonValue(data)`，返回 undefined 就抛
 * `session event "X" carries non-JSON-serializable data`。
 * 真实踩过：把 `attachments.admitPromptContent` 的返回值（一个 **Promise**）
 * 原样当内容块数组塞进消息，宿主一 append 就 500，表现为发消息必失败。
 *
 * 用 JSON 往返判定，不用 structuredClone（会破坏活对象语义）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
  function isSerializable(value) {
    try {
      const raw = JSON.stringify(value);
      if (typeof raw !== "string") return false;
      JSON.parse(raw);
      return true;
    } catch {
      return false;
    }
  }

  /**
 * 把文本包成宿主可接受的内容块。
 *
 * **纯文本不走 `attachments.admitPromptContent`**，两个理由：
 *
 *   1. 那个方法是 **async**（`dsh-attachment/lib/index.js:242`），返回 Promise。
 *      直接把返回值当内容块数组用，消息里就会被塞进一个 Promise —— 宿主
 *      `snapshotJsonValue` 遇到 Promise 返回 undefined，抛出
 *      `session event "agent/inbox/spliced" carries non-JSON-serializable data`。
 *      （真实踩过：装进真实宿主后，发一条消息就 500。）
 *   2. 宿主自己的注释写明：没有 image 部分的 prompt
 *      "performs no storage operation" —— 纯文本**不需要** admission。
 *      桥目前只发纯文本，自建内容块形状等价（见《host-interfaces》）。
 */
  function wrapContent(text, input) {
    const content = textContent(text);
    // 防线：宿主 append 事件时会强制 snapshotJsonValue。这里先自检一次，
    // 宁可退回最小文本块，也不能把坏值交给宿主让它抛。
    if (!isSerializable(content)) {
      return createUserMessage([{ type: "text", text: String(text ?? "") }], sourceOf(input));
    }
    return createUserMessage(content, sourceOf(input));
  }

  /** 来源标记：标明消息来自悬浮窗而非宿主主界面。 */
  function sourceOf(input) {
    return { kind: "whale-hud", mode: input?.mode === "steer" ? "steer" : "send" };
  }

  /**
   * 中断当前回合。
   *
   * **必须带 `keepInbox: true`**——对齐宿主自己的停止键
   * （`dsh-api-session-controller/lib/index.js:994-1000`）。
   * 不带它会把用户排队的消息一并清掉，那是越权。
   *
   * 无活跃回合时返回 409 语义（C11：不误伤）。
   *
   * @param {{sessionId?: string}} input
   * @returns {{ok: boolean, code?: string, message?: string, accepted?: boolean}}
   */
  function abort(input) {
    const sessionId = input?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "bad-request", message: "缺少 sessionId" };
    }

    const agent = host.getAgent(sessionId);
    if (agent === undefined) {
      return { ok: false, code: "session-not-found", message: `会话 ${sessionId} 的 agent 不可用` };
    }

    if (agent.status !== "running") {
      return { ok: false, code: "no-active-turn", message: "当前没有进行中的回合", status: 409 };
    }

    try {
      agent.cancel({ kind: "user" }, { keepInbox: true });
      return { ok: true, accepted: true };
    } catch (err) {
      return { ok: false, code: err?.code ?? "abort-failed", message: err?.message ?? "中断失败" };
    }
  }

  /**
   * 执行斜杠命令。
   *
   * 对齐宿主 commands 服务：`execute(agent, line, submittedAttachments, signal)`。
   *
   * ⚠️ **`submittedAttachments` 与 `signal` 都是必传的，不能给 `undefined`。**
   *
   * 宿主 `execute` 对这两个参数**都没有空值保护**：
   *   - 第 332 行无条件读 `signal.aborted`
   *   - 第 353 行无条件读 `submittedAttachments.length`
   * 传 undefined 会分别抛：
   *   `Cannot read properties of undefined (reading 'aborted')`
   *   `Cannot read properties of undefined (reading 'length')`
   *
   * 真实症状：**权限三档切换点了没反应** —— 桥把 500 吞成失败、
   * 界面只在 console 里 warn 一句，用户看不到任何反馈。
   *
   * 修掉第一个坑（signal）之后立刻撞上第二个（attachments）——
   * 所以这两个参数写在一起说明，避免下次只修一个。
   * `abortError(signal)` 还会读 `signal.reason`，所以要给真 AbortSignal。
   *
   * @param {{sessionId?: string, line?: string, attachments?: Array<object>, signal?: AbortSignal}} input
   * @returns {{ok: boolean, code?: string, message?: string}}
   */
  function command(input) {
    const sessionId = input?.sessionId;
    const line = input?.line;

    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "bad-request", message: "缺少 sessionId" };
    }
    if (typeof line !== "string" || line === "") {
      return { ok: false, code: "bad-request", message: "缺少 line" };
    }

    const agent = host.getAgent(sessionId);
    if (agent === undefined) {
      return { ok: false, code: "session-not-found", message: `会话 ${sessionId} 的 agent 不可用` };
    }

    const commands = host.commands;
    if (commands === undefined) {
      return { ok: false, code: "commands-unavailable", message: "宿主未提供 commands 服务" };
    }

    // 调用方给了就用它的（便于外部取消）；没给就现造一个不会中断的。
    // **不能省成 undefined** —— 见上面的注释。
    const signal = input?.signal instanceof AbortSignal ? input.signal : new AbortController().signal;

    // 空数组表示「这条命令没有附件」。宿主要读它的 .length，所以不能给 undefined。
    const attachments = Array.isArray(input?.attachments) ? input.attachments : [];

    try {
      const promise = commands.execute(agent, line, attachments, signal);
      // execute 可能同步返回结果，也可能返回 Promise；统一按 Promise 处理
      if (promise !== null && typeof promise?.then === "function") {
        return promise.then(
          (value) => ({ ok: true, result: value ?? null }),
          (err) => ({ ok: false, code: err?.code ?? "command-failed", message: err?.message ?? "命令执行失败" }),
        );
      }
      return { ok: true, result: promise ?? null };
    } catch (err) {
      return { ok: false, code: err?.code ?? "command-failed", message: err?.message ?? "命令执行失败" };
    }
  }

  /**
   * 把一个会话唤醒为活跃会话。
   *
   * 语义：宿主 `sessions.get(id)` 拿得到就说明会话是活跃的；
   * 拿不到则需要走 `resume`（从落盘恢复）。这里只负责把
   * 桥自身的「活跃会话」指针挪过去，真正的唤醒由 resume 负责。
   *
   * @param {{sessionId?: string}} input
   * @returns {{ok: boolean, code?: string, message?: string}}
   */
  function activate(input) {
    const sessionId = input?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "bad-request", message: "缺少 sessionId" };
    }
    const session = host.getSession(sessionId);
    if (session === undefined) {
      return { ok: false, code: "session-not-found", message: `会话 ${sessionId} 不存在` };
    }
    return { ok: true, sessionId };
  }

  /**
   * 切换模型 / 推理等级。
   *
   * 交给宿主的 `sessionController.selectModel`（宿主 UI 切模型的正规通路）：
   * 它自己会 resolveAgent 恢复冷会话、用 resolveCallConfig 校验模型能力、
   * 并把选择存成默认。**桥不自己改 agent 状态**——那会绕过校验与持久化。
   *
   * 注意：**不要求会话当前有活 agent**。原先这里先查 `getAgent`，
   * 但宿主那条路支持冷会话（自己恢复），先查 agent 会把可用的场景误判成不可用。
   *
   * 宿主未暴露该服务时明确拒绝，不假装成功（降级原则：宁可静止不假装能动）。
   *
   * @param {{sessionId?: string, provider?: string, model?: string, reasoningEffort?: string}} input
   * @returns {Promise<{ok: boolean, code?: string, message?: string, selected?: object}>}
   */
  function setModel(input) {
    return host.selectModel(input ?? {});
  }

  /**
   * 唤醒历史会话。
   *
   * 走宿主 sessions 服务：已加载的直接返回，未加载的交给宿主恢复。
   *
   * @param {{sessionId?: string}} input
   * @returns {{ok: boolean, code?: string, message?: string, loaded?: boolean}}
   */
  function resume(input) {
    const sessionId = input?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "bad-request", message: "缺少 sessionId" };
    }

    const existing = host.getSession(sessionId);
    if (existing !== undefined) {
      return { ok: true, loaded: true };
    }

    const sessions = host.sessions;
    if (sessions === undefined) {
      return { ok: false, code: "sessions-unavailable", message: "宿主未提供 sessions 服务" };
    }

    try {
      // 宿主 prepare/enter 是恢复历史会话的正规通路
      if (typeof sessions.prepare === "function") {
        const prepared = sessions.prepare(sessionId);
        if (prepared !== undefined && typeof sessions.enter === "function") {
          sessions.enter(prepared);
        }
        return { ok: true, loaded: true };
      }
      return { ok: false, code: "resume-unavailable", message: "宿主 sessions 服务不支持恢复" };
    } catch (err) {
      return { ok: false, code: err?.code ?? "resume-failed", message: err?.message ?? "恢复失败" };
    }
  }

  /**
   * 设置审批策略。
   *
   * @param {{sessionId?: string, policy?: string}} input
   * @returns {{ok: boolean, code?: string, message?: string}}
   */
  function setApprovalPolicy(input) {
    const sessionId = input?.sessionId;
    const policy = input?.policy;
    if (policy !== "ask" && policy !== "never") {
      return { ok: false, code: "bad-request", message: "policy 必须是 ask 或 never" };
    }
    const agent = host.getAgent(sessionId);
    if (agent === undefined) {
      return { ok: false, code: "session-not-found", message: `会话 ${sessionId} 的 agent 不可用` };
    }
    const approval = host.raw?.approval;
    if (approval === undefined || typeof approval.setPolicy !== "function") {
      return { ok: false, code: "approval-unavailable", message: "宿主未提供 approval 服务" };
    }
    try {
      approval.setPolicy(agent, policy);
      return { ok: true, policy };
    } catch (err) {
      return { ok: false, code: err?.code ?? "policy-failed", message: err?.message ?? "设置失败" };
    }
  }
}

