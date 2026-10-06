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
 * @param {object} ctx
 * @param {string} name
 * @returns {object | undefined}
 */
function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined;
  try {
    const svc = ctx[name];
    return svc === null || svc === undefined ? undefined : svc;
  } catch {
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
export function createHostAccess(ctx) {
  const sessions = serviceOf(ctx, "sessions");
  const agents = serviceOf(ctx, "agents");
  const commands = serviceOf(ctx, "commands");
  const projections = serviceOf(ctx, "sessionProjections") ?? serviceOf(ctx, "projections");
  const attachments = serviceOf(ctx, "attachments");

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

  /** 列出某 agent 可见的斜杠命令。 */
  function listCommands(agent) {
    if (commands === undefined || agent === undefined) return [];
    return safe(() => {
      const raw = commands.list(agent);
      if (!Array.isArray(raw)) return [];
      return raw.map((c) => ({
        name: c?.name,
        description: c?.description,
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
    // 途径 1：宿主模型目录服务
    const modelsService = serviceOf(ctx, "models");
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
      sessionCount: listSessions().length,
    };
  }

  return {
    raw: ctx,
    sessions,
    agents,
    commands,
    projections,
    attachments,
    available: {
      sessions: sessions !== undefined,
      agents: agents !== undefined,
      commands: commands !== undefined,
      projections: projections !== undefined,
      attachments: attachments !== undefined,
    },
    listSessions,
    getSession,
    getAgent,
    listCommands,
    listModels,
    probe,
  };
}
