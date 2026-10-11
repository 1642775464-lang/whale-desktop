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
 * 帐号接口要的客户端元数据里的 `version`。
 *
 * 宿主只把它当 `z.string()` 收下（不校验语义），给桥自己的标识即可 ——
 * 但**必须给**：`client` 是严格 codec 的必填参数，缺字段整条调用会被拒。
 */
const ACCOUNT_CLIENT_VERSION = "whale-desktop";

/**
 * 建立 Typert 调用封装。
 *
 * @param {object} deps
 * @param {object} deps.ctx 宿主插件上下文
 * @param {() => object} [deps.registryOf]
 *        取工作区注册表（含每个工作区**登记的** `sessionIds` 与归档集合）。
 *        `session/list` 只给会话行，**归属关系在注册表里** —— 按 cwd 反推
 *        会把历史上所有在该目录跑过的会话都列出来（用户报的「数目不对」）。
 * @param {() => object} [deps.fallbackOf]
 *        `session/list` **整体失败**时的降级清单（注册表 + 投影缓存）。
 *        宿主可能因一条会话的 header 冲突让整个批量查询 502，
 *        而单会话操作正常 —— 那时用持久层清单兜底（见 fallback-catalog.mjs）。
 * @returns {object} Typert 调用能力
 */
export function createTypertBridge({ ctx, registryOf, fallbackOf }) {
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
    if (!out.ok) {
      /*
       * ⚠️ `session/list` 可能**整体失败**：宿主因**一条**会话的 header
       * 观察不一致（SESSION_QUERY_SOURCE_CONFLICT）而让整个批量查询报 502，
       * 而单会话的 resume/activate 却一切正常（实测）。
       *
       * 那时**回退到持久层清单**（注册表 + 投影缓存）—— 否则侧边栏只剩
       * 折叠器里那一两条，用户想切的会话根本不在列表里。
       * 见 fallback-catalog.mjs 的头注释。
       *
       * 回退清单**完整**（归属/归档/标题都有），只是来源是持久层快照：
       * running/agentAvailable 未知 → 界面按「历史」处理，点击走 resume
       * （单会话 resume 不受批量查询冲突影响，实测可用）。
       */
      const fallback = typeof fallbackOf === "function" ? fallbackOf() : null;
      if (fallback !== null && fallback.ok === true) {
        return fallback;
      }
      // 回退也拿不到 → 如实报原始失败
      return out;
    }

    const raw = Array.isArray(out.value?.sessions)
      ? out.value.sessions
      : (Array.isArray(out.value?.items) ? out.value.items : []);

    /*
     * ⚠️ 字段名必须照 `SessionSummary` 的**真实声明**写。
     *
     * 实测声明（dsh-api-session-controller 的 typert.host.js）：
     *   { agentAvailable, sessionId, updatedAt, running, blank,
     *     parentSessionId?, origin?, cwd?, projections? }
     *
     * **它没有 `title`** —— 我第一版凭印象写了 `s.title`，
     * 结果 55 条会话标题全是 null、工作区也拿不到，界面上就是
     * 「会话列表没加载」。字段名对不上是**静默**故障：
     * 请求成功、结构正常、只是每个字段都是空的。
     *
     * 标题在 `projections` 里（SessionProjectionHints），工作区就是 `cwd`。
     */
    const sessions = raw
      .filter((s) => s !== null && typeof s === "object")
      .map((s) => {
        const proj = s.projections !== null && typeof s.projections === "object"
          ? s.projections
          : {};
        const values = proj.values !== null && typeof proj.values === "object"
          ? proj.values
          : {};
        const title = [s.title, values.title, proj.title]
          .find((v) => typeof v === "string" && v !== "");
        return {
          sessionId: typeof s.sessionId === "string" ? s.sessionId : null,
          title: title ?? null,
          // 工作区：SessionSummary 的字段名是 cwd（宿主 UI 也按它分组）
          workspace: typeof s.cwd === "string" && s.cwd !== "" ? s.cwd : null,
          updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : null,
          running: s.running === true,
          agentAvailable: s.agentAvailable === true,
          // blank 是「空会话」（刚建、还没内容），界面上要能区分
          blank: s.blank === true,
          origin: typeof s.origin === "string" ? s.origin : null,
        };
      })
      .filter((s) => s.sessionId !== null);

    /*
     * 工作区归属与归档集合**都以注册表为准**。
     *
     * 用户报过「数目根本不对…多出来一堆空壳」：我原先按「会话的 cwd 等于
     * 某目录」反推归属，于是把历史上所有在该目录跑过的会话都列了出来。
     * 而主窗口的归属来自 Workspace registry —— 每个工作区有一份**显式登记的**
     * `sessionIds`。两者数目自然对不上。
     *
     * 归档集合与工作区归属在同一份注册表里（客户端 baseline 也是这么下发的：
     * `installViews(baseline.items)` + `installArchived(baseline.archivedSessionIds)`）。
     */
    const registry = typeof registryOf === "function" ? registryOf() : null;
    const registryOk = registry !== null && registry.ok === true;

    /** sessionId → 所属工作区（登记为准，一个会话只归一个工作区）。 */
    const memberOf = new Map();
    if (registryOk) {
      for (const ws of registry.workspaces) {
        for (const id of ws.sessionIds) {
          if (!memberOf.has(id)) memberOf.set(id, ws);
        }
      }
    }

    /*
     * 注册表读到时**只列登记在册的会话**；读不到时**不裁剪**
     * （宁可多列，也不要把用户的会话凭空藏掉）。
     */
    const listed = registryOk
      ? sessions.filter((s) => memberOf.has(s.sessionId))
      : sessions;

    for (const s of listed) {
      const ws = memberOf.get(s.sessionId);
      // 工作区用登记的那份（含标题），而不是会话自己的 cwd
      s.workspaceId = ws !== undefined ? ws.id : null;
      s.workspaceTitle = ws !== undefined ? ws.title : null;
      s.workspacePath = ws !== undefined ? ws.path : (s.workspace ?? null);
      s.isDefaultWorkspace = ws !== undefined ? ws.isDefault === true : false;
    }

    const archivedSet = new Set(registryOk ? registry.archivedIds : []);
    for (const s of listed) {
      s.archived = archivedSet.has(s.sessionId);
    }

    // 按最近活动倒序：调用方（侧边栏）直接消费，不必自己再排
    listed.sort((l, r) => (r.updatedAt ?? 0) - (l.updatedAt ?? 0));
    return {
      ok: true,
      sessions: listed,
      // 两个「判据有没有拿到」的标记。拿不到时调用方**不该**据此隐藏：
      //   · archivedKnown 为 false → 不按归档隐藏
      //   · registryKnown 为 false → 列表未按登记裁剪（但仍是全部可见会话）
      archivedKnown: registryOk,
      registryKnown: registryOk,
    };
  }

  /**
   * 读账号信息与充值余额（侧边栏底部模块用）。
   *
   * 两个方法各自独立取值，**一个失败不影响另一个**（余额读不到时
   * 资料仍该显示）：各自返回 `status: "ready" | "failed"`。
   *
   * 契约（照 `dsh-api-account-controller` 的 typert.host.js 声明）：
   *
   *   account/getProfile  args:{client:{version,locale,timezoneOffsetSeconds}}
   *     → {status:"ready", value:{id, name, contact, avatarUrl?}} | {status:"failed"}
   *   account/getBalance  同上 args
   *     → {status:"ready", value:[{currency:"CNY"|"USD", balance}],
   *        bonusWallets:[{currency, balance}]} | {status:"failed"}
   *
   * ⚠️ `client` 参数是**必填**（客户端元数据），不给会被严格 codec 拒掉。
   *
   * @returns {Promise<{ok:boolean, profile?:object|null, balance?:object|null,
   *                    profileCode?:string, balanceCode?:string}>}
   */
  async function accountInfo() {
    const client = {
      version: ACCOUNT_CLIENT_VERSION,
      locale: "zh-CN",
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    };

    const call = (method) => invokeRemote({ namespace: "account", method, args: { client } });

    const [profileOut, balanceOut] = await Promise.all([
      call("getProfile"),
      call("getBalance"),
    ]);

    /** 把宿主给的 `{status, value}` 收成 `{ok, value}`（status 非 ready 即失败）。 */
    const unwrap = (out) => {
      if (out.ok !== true) return { ok: false, code: out.code ?? "typert/failed" };
      const v = out.value;
      if (v === null || typeof v !== "object" || v.status !== "ready") {
        return { ok: false, code: "account/not-ready" };
      }
      return { ok: true, value: v.value ?? null };
    };

    const profile = unwrap(profileOut);
    const balance = unwrap(balanceOut);

    return {
      ok: true,
      profile: profile.ok
        ? {
          name: typeof profile.value?.name === "string" ? profile.value.name : null,
          contact: typeof profile.value?.contact === "string" ? profile.value.contact : null,
          avatarUrl: typeof profile.value?.avatarUrl === "string" ? profile.value.avatarUrl : null,
        }
        : null,
      profileCode: profile.ok ? null : profile.code,
      balance: balance.ok
        ? {
          // 主钱包：取第一项；宿主给的是数组（多币种）
          wallets: Array.isArray(balance.value)
            ? balance.value.map((w) => ({
              currency: typeof w?.currency === "string" ? w.currency : null,
              balance: typeof w?.balance === "string" ? w.balance : null,
            }))
            : [],
          bonusWallets: Array.isArray(balanceOut.value?.bonusWallets)
            ? balanceOut.value.bonusWallets.map((w) => ({
              currency: typeof w?.currency === "string" ? w.currency : null,
              balance: typeof w?.balance === "string" ? w.balance : null,
            }))
            : [],
        }
        : null,
      balanceCode: balance.ok ? null : balance.code,
    };
  }

  return { accountInfo, available, invokeRemote, listSkills, createSession, listSessions };
}
