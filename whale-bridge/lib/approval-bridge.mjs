/**
 * 审批桥
 *
 * 职责：挂上宿主的 `approval/request` 瀑布监听器，让悬浮窗/小窗能应答安全确认；
 *       并提供「待确认请求」清单给 `/whale/approval`。
 * 所属层：桥（whale-bridge/lib）
 *
 * 语义：**无人应答时才接管**（S3-D2）。
 *
 * 宿主机制不是「查询 + 应答」，而是**瀑布式拦截**：
 *   `ctx.waterfall(target, "approval/request", req, fallback)`
 * 监听器拿到 `(request, next)`，返回 Promise。参照实现见
 * `dsh-api-remotes/lib/index.js:147-157` 的 `forwardWaterfall`。
 *
 * 关键纪律：**不抢宿主 UI 的答**。
 * 宿主主界面自己能弹确认框，那是用户最习惯的入口。桥只做「宿主 UI 不在场时」
 * 的那条备用通道，所以必须先 `next()` 把决定权交出去，只有在明确无人应答
 * 时才补一个答案。若反过来（桥先答），用户会发现自己点的按钮没反应——
 * 因为他根本看不到那个框，桥已经替他答了。
 *
 * 超时上限 30 秒：超过就不等了，返回 `unavailable` 让宿主走它自己的兜底。
 * 桥宁可「答不上」，也不要挂住宿主的回合。
 */

/** 审批请求的等待上限（毫秒）。超时即放弃，不挂住宿主回合。 */
export const APPROVAL_TIMEOUT_MS = 30000;

/** 合法应答取值，对齐宿主 `OUTCOMES`（dsh-user-approval/lib/index.js:30-35）。 */
export const APPROVAL_OUTCOMES = ["allowed-once", "rejected", "cancelled", "unavailable"];

/**
 * 建立审批桥。
 *
 * @param {object} deps
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.timeoutMs] 等待上限（测试可缩短）
 * @param {() => number} [deps.now]
 * @returns {object} 审批桥
 */
export function createApprovalBridge(deps = {}) {
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const timeoutMs = Number.isInteger(deps.timeoutMs) ? deps.timeoutMs : APPROVAL_TIMEOUT_MS;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  /** @type {Map<string, object>} 挂起中的请求，键为请求 id */
  const pending = new Map();
  let nextId = 1;

  const stats = { requested: 0, delegated: 0, answered: 0, timedOut: 0, rejected: 0 };

  /**
   * 登记一条挂起请求。
   *
   * @param {object} request 宿主审批请求对象
   * @param {string} sessionId
   * @returns {{id: string, request: object, sessionId: string, at: number}}
   */
  function track(request, sessionId) {
    const id = `ap-${nextId}`;
    nextId += 1;
    const entry = { id, request, sessionId, at: now(), answer: undefined };
    pending.set(id, entry);
    stats.requested += 1;
    return entry;
  }

  /** 摘掉一条挂起请求（幂等）。 */
  function untrack(id) {
    pending.delete(id);
  }

  /**
   * 处理一条宿主审批请求。
   *
   * 这是挂在瀑布上的那个函数本体。`next` 由宿主注入。
   *
   * 流程：
   *   1. 先问 `next()` —— 交给宿主 UI 与其余监听器
   *   2. 若它们给出有效答案 → 原样返回（桥不介入）
   *   3. 若返回 `unavailable`（无人应答）→ 桥登记为挂起，等悬浮窗答
   *   4. 等到答案或超时 → 返回
   *
   * @param {object} request
   * @param {() => Promise<unknown>} next
   * @returns {Promise<string>}
   */
  async function onApprovalRequest(request, next) {
    const sessionId = sessionIdOf(request);

    let delegated;
    try {
      delegated = await next();
    } catch (err) {
      // 下游监听器抛错：桥顶上来，但只能给 unavailable，不能替用户做决定
      log(`[桥] 审批下游监听器异常：${err?.message ?? err}`);
      stats.rejected += 1;
      return "unavailable";
    }

    // 有人答了（allowed-once / rejected / cancelled）→ 尊重它，桥不插手
    if (typeof delegated === "string" && delegated !== "unavailable") {
      stats.delegated += 1;
      return delegated;
    }

    // 无人应答 → 桥接管
    const entry = track(request, sessionId);
    const answer = await waitFor(entry);

    if (answer === undefined) {
      stats.timedOut += 1;
      untrack(entry.id);
      return "unavailable";
    }

    stats.answered += 1;
    untrack(entry.id);
    return answer;
  }

  /**
   * 挂起等待某条请求被应答。
   *
   * 用可主动唤醒的 Promise 而不是轮询：轮询会让「应答到达」与「桥发现」
   * 之间产生最多一个轮询周期的延迟，而审批是用户手点的，延迟很明显。
   *
   * @param {object} entry
   * @returns {Promise<string | undefined>} 超时返回 undefined
   */
  function waitFor(entry) {
    return new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        entry.wake = undefined;
        resolve(undefined);
      }, timeoutMs);

      if (typeof timer.unref === "function") timer.unref();

      entry.wake = (answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };
    });
  }

  /**
   * 应答一条挂起请求（由 `POST /whale/approval` 调用）。
   *
   * @param {string} id
   * @param {string} outcome
   * @returns {{ok: boolean, code?: string, message?: string}}
   */
  function answer(id, outcome) {
    if (!APPROVAL_OUTCOMES.includes(outcome)) {
      return { ok: false, code: "bad-request", message: `outcome 必须是 ${APPROVAL_OUTCOMES.join(" / ")}` };
    }
    const entry = pending.get(id);
    if (entry === undefined) {
      return { ok: false, code: "approval-not-found", message: `审批请求 ${id} 不存在或已超时` };
    }
    if (typeof entry.wake !== "function") {
      return { ok: false, code: "approval-not-pending", message: `审批请求 ${id} 尚未就绪` };
    }
    entry.wake(outcome);
    return { ok: true, id, outcome };
  }

  /**
   * 列出挂起请求（供 `GET /whale/approval`）。
   *
   * 只暴露可安全外传的字段：请求对象本身可能含内部引用，不外泄。
   *
   * @returns {Array<object>}
   */
  function listPending() {
    const out = [];
    for (const entry of pending.values()) {
      out.push({
        id: entry.id,
        sessionId: entry.sessionId,
        at: entry.at,
        kind: entry.request?.kind ?? null,
        summary: entry.request?.summary ?? entry.request?.question ?? null,
      });
    }
    return out;
  }

  /**
   * 把审批桥挂到宿主 ctx 上，返回退订函数（可能为空数组）。
   *
   * 宿主通过 `ctx.on(event, listener)` 注册瀑布监听器；`ctx.waterfall` 是
   * 宿主内部发起瀑布的入口，桥只**消费**它（通过 on），不主动调用。
   *
   * @param {object} ctx
   * @returns {Array<() => void>}
   */
  function attach(ctx) {
    if (typeof ctx?.on !== "function") {
      log("[桥] 宿主 ctx 不支持 on()，审批桥未挂载（审批查询将返回空）");
      return [];
    }
    try {
      const off = ctx.on("approval/request", onApprovalRequest);
      return typeof off === "function" ? [off] : [];
    } catch (err) {
      log(`[桥] 订阅 approval/request 失败：${err?.message ?? err}`);
      return [];
    }
  }

  /** 当前是否有挂起请求。 */
  function hasPending() {
    return pending.size > 0;
  }

  /** 只读统计。 */
  function snapshot() {
    return { ...stats, pendingCount: pending.size };
  }

  return {
    attach,
    answer,
    listPending,
    hasPending,
    onApprovalRequest,
    snapshot,
    stats,
  };
}

/** 从审批请求里尽力取出会话 id。 */
function sessionIdOf(request) {
  const direct = request?.sessionId;
  if (typeof direct === "string" && direct !== "") return direct;
  const fromAgent = request?.agent?.session?.id ?? request?.agent?.id;
  if (typeof fromAgent === "string" && fromAgent !== "") return fromAgent;
  return "unknown-session";
}
