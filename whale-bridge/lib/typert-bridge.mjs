/**
 * Typert 远程调用：走宿主的 `ctx.typertGateway`
 *
 * 职责：让桥能调用 DSH 插件通过 Typert 协议暴露的远程方法
 *       （技能目录、任务看板、频道等的数据通路）。
 * 所属层：桥（whale-bridge/lib）
 *
 * ## 为什么需要它
 *
 * 用户要在小窗侧边栏里放「技能中心 / 任务看板 / 频道」。勘查结论是：
 *
 *   · `taskBoard` 服务**在**，但只暴露 `registerExtension` / `isExtensionEnabled`
 *     —— 它没有「列任务」的方法，是给别的插件注册扩展用的注册表；
 *   · `skills` 在，但它的类型定义写明是 *cold-readable skill catalog **Remote***；
 *   · 频道没有对外服务，只有 HTTP `/api/dsh-im-connect/*`。
 *
 * 而那两个 HTTP 端点实测要**浏览器会话凭证**（401 请先登录 DSH），
 * 桥是宿主进程内的插件，没有那个凭证 —— HTTP 路不通。
 *
 * 唯一通的这条路：宿主侧的 Typert 网关 `ctx.typertGateway`（探测为在）。
 *
 * ## 为什么不需要「生成的调用描述符」
 *
 * 网关的严格模式从 `ctx.typert.local` 读生成的描述符，但**找不到时会走 SRC 回退**
 * （`resolveSrcDescriptor`）：它遍历所有服务，找带 `typertRemote` 绑定、
 * namespace/method 匹配的那个 —— 于是桥不需要那份生成产物也能调用。
 *
 * 代价是 SRC 只解析**简单参数名**、且只允许能安全表示为 JSON 的值。
 * 这对我们要读的目录类数据（`{ sessionId }` 这类）足够。
 *
 * ## 调用形状
 *
 *     ctx.typertGateway.invoke({ namespace, method, args })
 *
 * ⚠️ `namespace` 与 `method` 是**分开的两个字段**，不是拼好的 `"a/b"`。
 * 网关内部自己拼 endpoint。传拼好的字符串会被当成 namespace 从而找不到端点。
 *
 * 实测契约（技能目录）：
 *
 *     namespace: 'skills', method: 'list'
 *     args: { request: { sessionId } }
 *     → { skills: [{ path?, name, description, whenToUse?, modelInvocable }] }
 */

/** 服务名只允许常规标识符（与 serviceVisible 同一套约束）。 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * 建立 Typert 调用封装。
 *
 * @param {object} deps
 * @param {object} deps.ctx 宿主插件上下文
 * @returns {object} Typert 调用能力
 */
export function createTypertBridge({ ctx }) {
  /** 网关服务**每次现取**（延迟解析；塞进 inject 会让插件在服务缺失时不启动）。 */
  function gatewayOf() {
    if (ctx === null || ctx === undefined) return undefined;
    try {
      if (typeof ctx.get !== "function") return undefined;
      return ctx.get("typertGateway") ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 网关是否可用（给 probe 用）。 */
  function available() {
    const gateway = gatewayOf();
    return gateway !== undefined && typeof gateway.invoke === "function";
  }

  /**
   * 调用一个 Typert 远程方法。
   *
   * @param {object} request
   * @param {string} request.namespace 远程命名空间（如 `skills`）
   * @param {string} request.method 方法名（如 `list`）
   * @param {object} [request.args] 具名参数（**必须与宿主声明的参数名精确匹配**）
   * @returns {Promise<object>} `{ok:true, value}` 或 `{ok:false, code, message}`
   */
  async function invokeRemote(request) {
    const namespace = request?.namespace;
    const method = request?.method;
    if (typeof namespace !== "string" || !NAME_RE.test(namespace)) {
      return { ok: false, code: "typert/bad-namespace", message: `命名空间不合法：${String(namespace)}` };
    }
    if (typeof method !== "string" || !NAME_RE.test(method)) {
      return { ok: false, code: "typert/bad-method", message: `方法名不合法：${String(method)}` };
    }

    const gateway = gatewayOf();
    if (gateway === undefined || typeof gateway.invoke !== "function") {
      return { ok: false, code: "typert/unavailable", message: "宿主未提供 typertGateway" };
    }

    const args = request?.args;
    try {
      /*
       * ⚠️ 只传 namespace / method / args 三个字段。
       * 多传 peer / uplink 之类会改变网关的调用语义（peer 代表操作者身份），
       * 桥不该替调用方声明身份。
       */
      const value = await gateway.invoke({
        namespace,
        method,
        args: args === undefined || args === null ? {} : args,
      });
      return { ok: true, value };
    } catch (err) {
      /*
       * 业务错误与网关错误都如实回传。
       * `code` 取网关自己给的（如 `gateway/invocation-unavailable`），
       * 便于调用方区分「端点不存在」与「业务拒绝」。
       */
      const code = typeof err?.code === "string" && err.code !== "" ? err.code : "typert/failed";
      return { ok: false, code, message: err?.message ?? String(err) };
    }
  }

  /**
   * 读技能目录（`skills/list`）。
   *
   * 实测契约：`args: { request: { sessionId } }`，
   * 返回 `{ skills: [{ path?, name, description, whenToUse?, modelInvocable }] }`。
   *
   * @param {string} sessionId
   * @returns {Promise<object>} `{ok, skills?}` 或 `{ok:false, code, message}`
   */
  async function listSkills(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "skills/bad-session", message: "缺少 sessionId" };
    }
    const out = await invokeRemote({
      namespace: "skills",
      method: "list",
      args: { request: { sessionId } },
    });
    if (!out.ok) return out;

    // 归一化：只取界面上真会用的字段，取不到给 null/空数组，不编造
    const raw = Array.isArray(out.value?.skills) ? out.value.skills : [];
    const skills = raw
      .filter((s) => s !== null && typeof s === "object" && typeof s.name === "string")
      .map((s) => ({
        name: s.name,
        description: typeof s.description === "string" ? s.description : "",
        whenToUse: typeof s.whenToUse === "string" ? s.whenToUse : null,
        path: typeof s.path === "string" ? s.path : null,
        modelInvocable: s.modelInvocable === true,
      }));
    return { ok: true, skills };
  }

  /**
   * 新建（或幂等收养）一个普通会话。
   *
   * 实测契约：`@Remote('create') create(request: SessionCreateRequest)`
   *   `SessionCreateRequest = { workspaceId?, cwd?, sessionId?, agentPreset? }`（全部可选）
   *   → `SessionCreateValue = { sessionId, agentPreset? }`
   *
   * ⚠️ 参数全可选，但**不能**把 `request` 传成 undefined ——
   * 网关会校验具名参数，缺 `request` 会报参数不匹配。至少给 `{}`。
   *
   * @param {object} [request] 创建请求（可空）
   * @returns {Promise<object>} `{ok, sessionId, agentPreset?}` 或失败
   */
  async function createSession(request) {
    const out = await invokeRemote({
      namespace: "session",
      method: "create",
      args: { request: request ?? {} },
    });
    if (!out.ok) return out;

    const sessionId = out.value?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      // 建成功了却没给 id —— 那不是能用的会话，如实报错而不是给个空壳
      return { ok: false, code: "session/create-no-id", message: "宿主建了会话但没给 sessionId" };
    }
    return {
      ok: true,
      sessionId,
      agentPreset: typeof out.value?.agentPreset === "string" ? out.value.agentPreset : null,
    };
  }

  /**
   * 读可见会话清单（`session/list`）。
   *
   * 实测契约：`@Remote('list') list(_request: SessionListRequest, signal)`
   * —— 宿主注释写明「Read all visible Session rows **without resuming an Agent**」，
   * 所以这条**不会唤醒冷会话**，适合侧边栏列清单。
   *
   * 与桥已有的 `recentSessions()`（走 `sessionController.list`）的区别：
   * 那条给的是「最近会话」投影；这条是 Typert 侧的完整可见行。
   *
   * @returns {Promise<object>} `{ok, sessions}` 或失败
   */
  async function listSessions() {
    const out = await invokeRemote({
      namespace: "session",
      method: "list",
      args: { _request: {} },
    });
    if (!out.ok) return out;

    const raw = Array.isArray(out.value?.sessions)
      ? out.value.sessions
      : (Array.isArray(out.value?.items) ? out.value.items : []);
    const sessions = raw
      .filter((s) => s !== null && typeof s === "object")
      .map((s) => ({
        sessionId: typeof s.sessionId === "string" ? s.sessionId : null,
        title: typeof s.title === "string" && s.title !== "" ? s.title : null,
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null,
      }))
      .filter((s) => s.sessionId !== null);
    return { ok: true, sessions };
  }

  return { available, invokeRemote, listSkills, createSession, listSessions };
}
