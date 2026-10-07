/**
 * 宿主访问封装
 *
 * 职责：把「宿主有哪些服务可用」探测清楚，并对每个服务提供薄封装。
 * 所属层：桥（whale-bridge/lib）
 *
 * 设计原则（《边界与 NFR》四条降级原则之一：宁可局部失效不整体崩溃）：
 * 任何宿主服务缺失都**不抛错**，只标记为不可用，由处理器决定降级方式。
 */

/**
 * 探测一个宿主服务是否可用。
 *
 * **必须区分两种「取不到」**：
 *   1. 服务确实不存在 → 返回 undefined，桥走降级（正常情况）
 *   2. 服务存在但插件没在 `inject` 里声明 → Cordis 会抛
 *      `cannot get property "X" without inject`
 *
 * 第 2 种**不能吞**。原先这里一律 catch 成 undefined，把「你没声明依赖」
 * 伪装成「宿主没提供这个服务」——装进真实宿主后表现是
 * `/whale/probe` 报 sessions/agents/commands 全 false，
 * 而事件照样收得到，极具迷惑性（真实踩过，排查花了很久）。
 * 所以第 2 种要把原因显式记下来，供 probe 报告。
 *
 * @param {object} ctx
 * @param {string} name
 * @param {{ missingInject?: string[] }} [diag] 诊断收集器
 * @returns {object | undefined}
 */
function serviceOf(ctx, name, diag = undefined) {
  if (ctx === null || ctx === undefined) return undefined;
  try {
    const svc = ctx[name];
    return svc === null || svc === undefined ? undefined : svc;
  } catch (err) {
    const message = String(err?.message ?? err);
    // 没声明 inject 的情况要留下证据，不要静默降级
    if (message.includes("without inject") && Array.isArray(diag?.missingInject)) {
      diag.missingInject.push(name);
    }
    return undefined;
  }
}

/**
 * 建立宿主访问封装。
 *
 * @param {object} ctx 宿主插件上下文
 * @returns {{
 *   raw: object,
 *   sessions: object | undefined,
 *   agents: object | undefined,
 *   commands: object | undefined,
 *   projections: object | undefined,
 *   attachments: object | undefined,
 *   available: Record<string, boolean>,
 *   listSessions: () => Array<object>,
 *   getSession: (id: string) => object | undefined,
 *   getAgent: (id: string) => object | undefined,
 *   listCommands: (agent: object) => Array<object>,
 *   listModels: () => Promise<Array<object>>,
 *   probe: () => object,
 * }}
 */
/**
 * 读取一个**可选**服务（不经过 inject 守卫）。
 *
 * 宿主自己的代码就是这么读的，例如 `dsh-headless/lib/index.js`：
 *   const agents = ctx.get("agents");
 *   const sessions = ctx.get("sessions");
 *
 * `ctx.get()` 不要求 inject 声明，取不到就返回 undefined。
 * 而 `ctx[name]` 会走 Cordis 的 Proxy 守卫，未声明就抛
 * `cannot get property "X" without inject`。
 *
 * 可选服务必须走这条路：把它们放进 inject 会让 Cordis **等待**它们就绪，
 * 而一个不存在的服务名会导致插件**永远不被启动**（真实踩过：加了
 * `projections`/`models` 之后，桥连端口都不监听了）。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {object | undefined}
 */
function optionalServiceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined;
  try {
    if (typeof ctx.get === "function") return ctx.get(name) ?? undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

export function createHostAccess(ctx) {
  /** 诊断：哪些服务是因为「插件没声明 inject」而取不到的。 */
  const diag = { missingInject: [] };

  // 必需服务：已在 host.js 的 inject 里声明，Cordis 会等它们就绪后再 apply。
  const sessions = serviceOf(ctx, "sessions", diag);
  const agents = serviceOf(ctx, "agents", diag);
  const commands = serviceOf(ctx, "commands", diag);
  const projections = serviceOf(ctx, "sessionProjections", diag);

  // 可选服务：一律走 ctx.get()，绝不放进 inject——
  // 不存在的服务名会让插件永远不启动。
  const attachments = optionalServiceOf(ctx, "attachments");

  /**
   * 模型目录与切换、权限档位所需的两个宿主服务。
   *
   * 都走可选读取（ctx.get）而不是 inject：
   *   - `sessionController` 由 dsh-api-session-controller 提供，
   *     宿主 UI 的模型选择器就走它（`modelCatalog()` 内部包着 buildModelCatalog）
   *   - `permissionPresets` 由 dsh-permission-presets 提供，
   *     档位清单以它为准（内含配置项 + 运行期注册的 auto）
   * 取不到时降级并如实说明原因，而不是让插件不启动。
   */
  const sessionController = optionalServiceOf(ctx, "sessionController");
  const permissionPresetsService = optionalServiceOf(ctx, "permissionPresets");

  /** 安全调用：异常一律吞掉并返回兜底值（宁可局部失效不整体崩溃）。 */
  function safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  /**
   * 列出全部会话。
   *
   * 宿主 sessions 服务的 list() 返回会话对象数组；不同版本可能返回
   * 带 header 的对象或裸 header。这里统一归一化为 `{id, cwd, createdAt, ...}`。
   */
  function listSessions() {
    if (sessions === undefined) return [];
    return safe(() => {
      const raw = sessions.list();
      if (!Array.isArray(raw)) return [];
      return raw.map((item) => {
        const header = item?.header ?? item;
        return {
          id: item?.id ?? header?.id,
          cwd: header?.cwd,
          createdAt: header?.createdAt,
          agentPreset: header?.agentPreset,
          title: header?.title,
        };
      });
    }, []);
  }

  /** 取某会话对象。 */
  function getSession(id) {
    if (sessions === undefined) return undefined;
    return safe(() => sessions.get(id), undefined);
  }

  /** 取某会话的 agent 实例。 */
  function getAgent(id) {
    if (agents === undefined) return undefined;
    return safe(() => agents.get(id), undefined);
  }

  /**
   * 从会话投影里读标题。
   *
   * **标题不在 header 里，也不靠 `session/title` 事件推给桥。**
   * 实测（宿主已发布代码）：
   *   - `dsh-api-session-controller` 的 `listFields(header)` 只返回
   *     `parentSessionId / origin / cwd`，**不含 title**
   *   - 标题由 `dsh-session-title` 注册成 **key = "title" 的会话投影**
   *     （`titleProjectionDefinition`）
   *   - 读法是 `sessionProjections.snapshot(session, keys)` → `{asOfSeq, values}`，
   *     `values.title` 即标题 —— 宿主自己的控制器就是这么读的
   *
   * 桥原先只等 `session/title` 事件，而那个事件只在**标题被写入**时产生；
   * 对「会话早就有了标题、桥后挂上来」的情形永远等不到，
   * 表现就是**悬浮条与小窗都识别不到会话标题**（用户报过一次）。
   *
   * @param {object} session 宿主会话对象
   * @returns {string | null} 标题；取不到给 null（不编造）
   */
  function titleOf(session) {
    if (projections === undefined || session === undefined || session === null) return null;
    return safe(() => {
      const snap = projections.snapshot(session, ["title"]);
      const value = snap?.values?.title;
      // 投影可能给 null（尚无标题）；只接受非空字符串
      return typeof value === "string" && value !== "" ? value : null;
    }, null);
  }

  /**
   * 列出某 agent 可见的斜杠命令。
   *
   * 形状对齐宿主 `commands.list()` 的 descriptor（dsh-commands:175）：
   * `{ definitionId?, name, description, input? }`，其中 `input.hint` 是参数的占位提示
   * （例如 permission 的 `<preset>`）。
   *
   * `input.hint` 必须带上：命令面板要显示「还要填什么」，
   * 缺了它用户不知道 `/permission` 后面该写什么。
   *
   * @param {object} agent
   * @returns {Array<{name: string, description: string, hint: string|null, definitionId: string|null}>}
   */
  function listCommands(agent) {
    if (commands === undefined || agent === undefined) return [];
    return safe(() => {
      const raw = commands.list(agent);
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((c) => typeof c?.name === "string" && c.name !== "")
        .map((c) => ({
          name: c.name,
          description: typeof c.description === "string" ? c.description : "",
          hint: typeof c?.input?.hint === "string" ? c.input.hint : null,
          definitionId: typeof c?.definitionId === "string" ? c.definitionId : null,
        }));
    }, []);
  }

  /**
   * 列出可用模型。
   *
   * 探测顺序（先可靠后推测）：
   *   1. 宿主若暴露 `models` 服务，直接问它
   *   2. 否则从已加载会话里收集实际出现过的 provider/model 组合
   *   3. 都没有 → 返回空数组，由 `/whale/models` 说明原因
   *
   * **不硬编码模型名**：桥不认识 magpie 之外还有哪些 provider，
   * 编出来的列表会让用户照着切到一个不存在的模型上。
   *
   * @returns {Array<{provider: string, model: string}>}
   */
  function listModels() {
    // 途径 1：宿主模型目录服务（可选，走 ctx.get 不经过 inject 守卫）
    const modelsService = optionalServiceOf(ctx, "models");
    if (modelsService !== undefined && typeof modelsService.list === "function") {
      const direct = safe(() => modelsService.list(), undefined);
      const normalized = normalizeModels(direct);
      if (normalized.length > 0) return normalized;
    }

    // 途径 2：从会话的 request/context 事件里收集（桥看得见的真实组合）
    return collectModelsFromSessions();
  }

  /**
   * 归一化宿主模型目录的返回形状。
   * 宿主不同版本可能返回字符串数组或对象数组，这里统一成 `{provider, model}`。
   * @param {unknown} raw
   * @returns {Array<{provider: string, model: string}>}
   */
  function normalizeModels(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
      if (typeof item === "string" && item !== "") {
        out.push({ provider: null, model: item });
        continue;
      }
      const provider = item?.provider;
      const model = item?.model ?? item?.id ?? item?.name;
      if (typeof model === "string" && model !== "") {
        out.push({
          provider: typeof provider === "string" ? provider : null,
          model,
        });
      }
    }
    return dedupeModels(out);
  }

  /**
   * 从宿主会话里收集出现过的模型。
   *
   * 宿主会话对象的形状随版本变化，这里只做「有就用、没有就跳过」的宽松探测，
   * 不做任何猜测性补全。
   * @returns {Array<{provider: string, model: string}>}
   */
  function collectModelsFromSessions() {
    if (sessions === undefined) return [];
    return safe(() => {
      const raw = sessions.list();
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        const header = item?.header ?? item;
        const provider = header?.model?.provider ?? header?.provider;
        const model = header?.model?.model ?? header?.model;
        if (typeof model === "string" && model !== "") {
          out.push({
            provider: typeof provider === "string" ? provider : null,
            model,
          });
        }
      }
      return dedupeModels(out);
    }, []);
  }

  /** 按 provider+model 去重，保持首次出现顺序。 */
  function dedupeModels(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = `${item.provider ?? ""}|${item.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  /**
   * 读宿主的模型目录（含各模型的可选推理档位）。
   *
   * **走 `sessionController.modelCatalog()`，不自己拼。**
   * 宿主 UI 的模型选择器就是读它（内部是 buildModelCatalog：
   * listProviders → listModels → resolveModelInfo 取 reasoning.efforts）。
   * 桥复刻一遍等于维护第二份逻辑，宿主一改就悄悄不一致。
   *
   * 返回形状（宿主已 detach，可直接序列化）：
   *   `{ default, routableProviders, groups, failures }`，其中
   *   `groups[].models[].reasoning.efforts` 是各模型的可选推理档位。
   *
   * 取不到一律返回 null（由 `/whale/models` 给出 reason），不抛错——
   * 「读不到目录」不该让整个接口 500。
   *
   * @returns {Promise<object | null>}
   */
  async function modelCatalog() {
    if (sessionController === undefined) return null;
    if (typeof sessionController.modelCatalog !== "function") return null;
    try {
      const catalog = await sessionController.modelCatalog();
      return catalog === null || typeof catalog !== "object" ? null : catalog;
    } catch {
      return null;
    }
  }

  /**
   * 切换某会话的模型 / 推理档位。
   *
   * 走 `sessionController.selectModel({sessionId, provider, model, reasoningEffort})`
   * —— 宿主 UI 切模型的正规通路（它会 resolveAgent 恢复冷会话、
   * 用 resolveCallConfig 校验能力、并把选择存成默认）。
   *
   * **桥不自己改 agent 状态**：那会绕过宿主的校验与持久化。
   *
   * @param {{sessionId?: string, provider?: string, model?: string, reasoningEffort?: string}} input
   * @returns {Promise<{ok: boolean, code?: string, message?: string, selected?: object}>}
   */
  async function selectModel(input) {
    const sessionId = input?.sessionId;
    const provider = input?.provider;
    const model = input?.model;

    if (typeof sessionId !== "string" || sessionId === "") {
      return { ok: false, code: "bad-request", message: "缺少 sessionId" };
    }
    if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
      return { ok: false, code: "bad-request", message: "缺少 provider 或 model" };
    }
    if (sessionController === undefined || typeof sessionController.selectModel !== "function") {
      return {
        ok: false,
        code: "model-switch-unavailable",
        message: "宿主未提供 sessionController，桥不代为修改模型",
      };
    }

    // 形状对齐宿主的 SessionSelectModelRequest：**没给 effort 就不带这个键**
    // （宿主用 `...request.reasoningEffort === void 0 ? {} : {...}` 的口径）
    const request = { sessionId, provider, model };
    if (typeof input?.reasoningEffort === "string" && input.reasoningEffort !== "") {
      request.reasoningEffort = input.reasoningEffort;
    }

    try {
      const value = await sessionController.selectModel(request);
      return { ok: true, selected: value?.selected ?? null };
    } catch (err) {
      return {
        ok: false,
        code: err?.code ?? "model-switch-failed",
        message: err?.message ?? "切换模型失败",
      };
    }
  }

  /**
   * 读权限档位清单与当前档位。
   *
   * 档位以宿主的 `permissionPresets` 为准（`names` 是配置项 + 运行期注册的 auto）。
   * 小窗原先硬编码三档，而宿主实际还有 `auto` —— 硬编码必然漏档位。
   *
   * 取不到返回 null，由调用方如实说明，**不编造档位**。
   *
   * 它是**同步**的：宿主的 names 是 getter、current() 也是同步方法，
   * 没有需要 await 的东西。写成 async 会让调用方多一层无意义的 Promise，
   * 也会触发 `require-await` 规则。
   *
   * @param {string} sessionId
   * @returns {{options: Array<string>, current: string | null} | null}
   */
  function permissionPresets(sessionId) {
    if (permissionPresetsService === undefined) return null;
    try {
      const names = permissionPresetsService.names;
      if (!Array.isArray(names) || names.length === 0) return null;

      let current = null;
      if (typeof permissionPresetsService.current === "function") {
        const session = getSession(sessionId);
        if (session !== undefined) {
          current = safe(() => permissionPresetsService.current(session), null);
        }
      }
      return { options: names.map(String), current: typeof current === "string" ? current : null };
    } catch {
      return null;
    }
  }

  /**
   * 运行时探测（对应 `/whale/probe`）。
   *
   * 只报告「有没有」，不报告「能不能用」——后者需要实际调用，代价过大。
   * @returns {object}
   */
  function probe() {
    return {
      sessions: sessions !== undefined,
      agents: agents !== undefined,
      commands: commands !== undefined,
      projections: projections !== undefined,
      attachments: attachments !== undefined,
      // 切片 7 第二批新增的两个可选服务：模型目录/切换、权限档位清单
      sessionController: sessionController !== undefined,
      permissionPresets: permissionPresetsService !== undefined,
      sessionCount: listSessions().length,
      // 把「为什么取不到」一并报出来：这是区分「宿主没这个服务」
      // 与「插件没声明依赖」的唯一线索（两者表现完全一样）
      missingInject: diag.missingInject,
    };
  }

  return {
    raw: ctx,
    sessions,
    agents,
    commands,
    projections,
    attachments,
    sessionController,
    available: {
      sessions: sessions !== undefined,
      agents: agents !== undefined,
      commands: commands !== undefined,
      projections: projections !== undefined,
      attachments: attachments !== undefined,
      sessionController: sessionController !== undefined,
      permissionPresets: permissionPresetsService !== undefined,
    },
    listSessions,
    getSession,
    getAgent,
    listCommands,
    listModels,
    modelCatalog,
    permissionPresets,
    probe,
    selectModel,
    titleOf,
  };
}
