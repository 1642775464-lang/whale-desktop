/**
 * 宿主目录类能力：模型目录与切换、权限档位、附件上传
 *
 * 职责：把「读宿主的模型目录 / 切换模型 / 读权限档位 / 上传附件」
 *       封装成与宿主形状一致的薄接口。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么从 host-ctx 拆出来（强制 14）：host-ctx 是「宿主访问封装」的总入口，
 * 加上模型目录与上传后超过 500 行。模型/档位/上传是**一个业务域**
 * （输入框的选择与附件），与 host-ctx 里其余的会话访问是两类改动原因，
 * 所以按域拆出，而不是放宽行数限制。
 *
 * 三条统一纪律：
 *
 *   1. **可选服务一律走 ctx.get() 且延迟解析**，绝不放进 inject、
 *      绝不在构造时缓存——这两条都真实踩过（见 STATUS 环境坑 21/35）。
 *   2. **桥不自己改宿主状态**：切模型交给 sessionController.selectModel
 *      （宿主 UI 的正规通路），桥只转交参数。
 *   3. 取不到/失败一律返回结构化结果（ok + code + message），
 *      由 HTTP 层映射状态码——不抛错冒泡，也不假装成功。
 */

/**
 * 读取一个可选服务（不经过 inject 守卫，取不到返回 undefined）。
 *
 * 与 host-ctx 里的同名函数同语义；这里复制一份是因为两个模块
 * 各自独立导入宿主 ctx，共享会引入双向依赖。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {object | undefined}
 */
function optionalService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined;
  try {
    if (typeof ctx.get === "function") return ctx.get(name) ?? undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 建立目录类能力的访问封装。
 *
 * @param {object} deps
 * @param {object} deps.ctx 宿主插件上下文（用 ctx.get 延迟读服务）
 * @param {(id: string) => object | undefined} deps.getSession 会话查找（权限当前档位要用）
 * @param {object | undefined} deps.attachments 附件存储（构造时已就绪的服务）
 * @returns {object} 目录类能力
 */
export function createHostCatalog({ ctx, getSession, attachments }) {
  // ⚠️ 两个服务必须**每次调用现取**（延迟解析）。
  // 它们由启动顺序在桥之后的插件提供，构造时缓存会把「还没就绪」
  // 定死成 undefined —— /whale/models 恒 0、probe 恒 false（真实踩过）。
  const sessionControllerOf = () => optionalService(ctx, "sessionController");
  const permissionPresetsOf = () => optionalService(ctx, "permissionPresets");
  /**
   * `@` 文件引用（切片 7 第四批）。同样是可选服务：
   * 塞进 inject 会让插件在「服务不存在」时**永远不启动**（环境坑 21）。
   */
  const fileReferencesOf = () => optionalService(ctx, "fileReferences");

  /**
   * 读宿主的模型目录（含各模型的可选推理档位）。
   *
   * **走 `sessionController.modelCatalog()`，不自己拼。**
   * 宿主 UI 的模型选择器就是读它（内部是 buildModelCatalog：
   * listProviders → listModels → resolveModelInfo 取 reasoning.efforts）。
   *
   * 取不到一律返回 null（由 `/whale/models` 给出 reason），不抛错——
   * 「读不到目录」不该让整个接口 500。
   *
   * @returns {Promise<object | null>}
   */
  async function modelCatalog() {
    const sessionController = sessionControllerOf();
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
    const sessionController = sessionControllerOf();
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
   * 它是**同步**的：宿主的 names 是 getter、current() 也是同步方法。
   *
   * @param {string} sessionId
   * @returns {{options: Array<string>, current: string | null} | null}
   */
  function permissionPresets(sessionId) {
    const service = permissionPresetsOf();
    if (service === undefined) return null;
    try {
      const names = service.names;
      if (!Array.isArray(names) || names.length === 0) return null;

      let current = null;
      if (typeof service.current === "function") {
        const session = getSession(sessionId);
        if (session !== undefined) {
          try {
            current = service.current(session);
          } catch {
            current = null;
          }
        }
      }
      return { options: names.map(String), current: typeof current === "string" ? current : null };
    } catch {
      return null;
    }
  }

  /**
   * 上传一个文件到宿主的 attachments 存储。
   *
   * 走 `attachments.saveFile({data, name?})` —— 宿主 admission 层标注的
   * "the shared entry for every RPC endpoint accepting browser uploads"。
   * `data` 必须是 **canonical base64**（宿主会解码并拒绝非规范形式）。
   * 返回内容寻址的持久引用，由调用方放进待发消息。
   *
   * @param {{name?: string, dataBase64: string}} input
   * @returns {Promise<{ok: boolean, code?: string, message?: string, reference?: object}>}
   */
  async function uploadFile(input) {
    if (attachments === undefined || typeof attachments.saveFile !== "function") {
      return { ok: false, code: "attachments-unavailable", message: "宿主未提供 attachments 服务" };
    }
    if (typeof input?.dataBase64 !== "string" || input.dataBase64 === "") {
      return { ok: false, code: "bad-request", message: "缺少 dataBase64" };
    }
    try {
      const request = { data: input.dataBase64 };
      if (typeof input?.name === "string" && input.name !== "") request.name = input.name;
      const reference = await attachments.saveFile(request);
      return { ok: true, reference: reference ?? null };
    } catch (err) {
      return { ok: false, code: err?.code ?? "upload-failed", message: err?.message ?? "上传失败" };
    }
  }

  /**
   * 批量上传图片到宿主的 attachments 存储。
   *
   * 走 `attachments.saveImages([...])`（与 uploadFile 同一条 admission 入口）。
   * 宿主按序返回持久引用；空批量在桥这边拦下，不空转调宿主。
   *
   * @param {{images: Array<{dataBase64: string, mediaType?: string, name?: string}>}} input
   * @returns {Promise<{ok: boolean, code?: string, message?: string, references?: Array<object>}>}
   */
  async function uploadImages(input) {
    if (attachments === undefined || typeof attachments.saveImages !== "function") {
      return { ok: false, code: "attachments-unavailable", message: "宿主未提供 attachments 服务" };
    }
    const images = Array.isArray(input?.images) ? input.images : [];
    if (images.length === 0) {
      return { ok: false, code: "bad-request", message: "images 不能为空" };
    }
    try {
      const requests = images.map((img) => {
        // saveImages 的 wire 输入是图片专用形状（data + 可选 mediaType/name）
        const request = { data: img?.dataBase64 };
        if (typeof img?.mediaType === "string" && img.mediaType !== "") request.mediaType = img.mediaType;
        if (typeof img?.name === "string" && img.name !== "") request.name = img.name;
        return request;
      });
      const references = await attachments.saveImages(requests);
      return { ok: true, references: Array.isArray(references) ? references : [] };
    } catch (err) {
      return { ok: false, code: err?.code ?? "upload-failed", message: err?.message ?? "上传失败" };
    }
  }

  /**
   * 读**所有可见会话**（含冷会话），按宿主给的顺序返回。
   *
   * 走 `sessionController.list(request, signal)` —— 宿主注释写明
   * "Read every visible attached and persisted Session **without activating an Agent**"，
   * 且内部 `items.sort((l, r) => r.updatedAt - l.updatedAt)`：
   * **第一项就是最近一次会话，桥不再自己排**（两处排序口径迟早不一致）。
   *
   * 为什么必须走这条而不是 `sessions.list()`：后者宿主注释是
   * "All **live** sessions"——重启后空闲的会话根本不在里面。
   * 这正是小窗启动后「没有会话、全都点不动」的根因。
   *
   * 归一化只做两件事：取 sessionId、从**投影**里取标题
   * （宿主 listFields 只给 parentSessionId/origin/cwd，**冷会话没有 title**）。
   *
   * @returns {Promise<Array<object>>} 取不到给空数组
   */
  async function recentSessions() {
    const sessionController = sessionControllerOf();
    if (sessionController === undefined || typeof sessionController.list !== "function") return [];
    try {
      // 宿主真实签名 list(_request, signal)：两参都要，第二个会被 throwIfAborted
      const value = await sessionController.list({}, new AbortController().signal);
      const items = Array.isArray(value?.items)
        ? value.items
        : (Array.isArray(value) ? value : []);

      const out = [];
      for (const item of items) {
        const sessionId = item?.sessionId ?? item?.id;
        if (typeof sessionId !== "string" || sessionId === "") continue;
        // 标题在投影里：projections.values.title（冷会话没有 title 事件）
        const raw = item?.title ?? item?.projections?.values?.title ?? null;
        out.push({
          sessionId,
          title: typeof raw === "string" && raw !== "" ? raw : null,
          cwd: typeof item?.cwd === "string" ? item.cwd : null,
          updatedAt: typeof item?.updatedAt === "number" ? item.updatedAt : null,
          running: item?.running === true,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 搜工作区的文件引用候选（`@` 引用，切片 7 第四批）。
   *
   * 走 `fileReferences.list(agent, query, signal)` —— 宿主给主窗口
   * `@` 补全用的就是这条。返回
   * `FileReferenceCandidate { path, kind: "file" | "directory" }[]`。
   *
   * **结果原样透传**：不改名、不补全。桥自己再造一份字段，
   * 将来宿主改名就对不上，而这类不一致的表现是「跑了、没数据、也不报错」。
   *
   * ⚠️ 必须传 agent：宿主要用它做作用域与鉴权。
   * 拿不到 agent 就**不去问宿主**——空敲一次没有意义（宿主那条路需要活 agent）。
   *
   * @param {string} query 查询串（可以为空串）
   * @param {object|undefined} agent 宿主 agent（宿主 fileReferences.list 的第一参）
   * @returns {Promise<Array<{path: string, kind: string}>>}
   */
  async function fileReferences(query, agent) {
    if (agent === undefined || agent === null) return [];
    const service = fileReferencesOf();
    if (service === undefined || typeof service.list !== "function") return [];
    try {
      const out = await service.list(agent, typeof query === "string" ? query : "", new AbortController().signal);
      return Array.isArray(out) ? out : [];
    } catch {
      return [];
    }
  }

  /**
   * 读某会话的**历史事件**（不激活 agent）。
   *
   * 走 `sessionController.inspect(sessionId, signal)`，返回
   * `{ meta, inheritedEventCount, events }`。
   *
   * ⚠️ **事件原样透传，不做任何形状转换。**
   * 持久层的事件本来就是 `{ seq, type, data }`，与折叠器吃的一字不差
   * （见宿主 dsh-session-query 的 `event.data.content` /
   * `event.data.message.content`）。桥这里再加一层「归一化」
   * 只会制造两个真相，以后哪边改了都不知道谁对。
   *
   * @param {string} sessionId
   * @returns {Promise<Array<object>>} 取不到给空数组
   */
  async function sessionEvents(sessionId) {
    const sessionController = sessionControllerOf();
    if (typeof sessionId !== "string" || sessionId === "") return [];
    if (sessionController === undefined || typeof sessionController.inspect !== "function") return [];
    try {
      const value = await sessionController.inspect(sessionId, new AbortController().signal);
      return Array.isArray(value?.events) ? value.events : [];
    } catch {
      return [];
    }
  }

  /** 服务当前是否可见（probe 用，实时读取）。 */
  function availability() {
    return {
      sessionController: sessionControllerOf() !== undefined,
      permissionPresets: permissionPresetsOf() !== undefined,
    };
  }

  /**
   * 读**已归档**的会话 id 清单。
   *
   * ⚠️ 为什么必须单独读它：`session/list`（Typert）返回的 `SessionSummary`
   * **不含归档状态**，所以它会连归档会话一起列出来 —— 用户报的
   * 「你把已归档的会话也读进去了」就是这个原因。
   *
   * 归档状态的权威来源是 Workspace registry：
   *   `ctx.workspaceRegistry.archivedSessionIds`
   * （见 `dsh-api-session-controller` 的 `archived-session-gate.js`：
   *  它就是用 `archived.includes(header.id)` 判定「这个会话被归档了」。）
   *
   * 取不到时返回**空数组**并带 `ok:false`：调用方据此**不要**隐藏任何会话
   * （宁可多列也不要把用户的会话凭空藏掉）。
   *
   * @returns {{ok: boolean, ids: string[]}}
   */
  function archivedSessionIds() {
    const registry = optionalService(ctx, "workspaceRegistry");
    if (registry === undefined) return { ok: false, ids: [] };
    try {
      const raw = registry.archivedSessionIds;
      if (!Array.isArray(raw)) return { ok: false, ids: [] };
      return {
        ok: true,
        ids: raw.filter((id) => typeof id === "string" && id !== ""),
      };
    } catch {
      return { ok: false, ids: [] };
    }
  }

  /**
   * 按名探测宿主服务是否可见。
   *
   * 为什么需要它：`availability()` 只报固定的几个 —— 而「桥能不能拿到
   * 某个功能的数据」是要**实测**才能回答的问题。没有这个能力时，
   * 每验一个服务名都得改一次代码再重启宿主。
   *
   * 只回答「在不在」，不读内容、不调用方法 —— 是只读诊断，
   * 不会因为探测而改变宿主状态。
   *
   * @param {Array<string>} names 要探测的服务名
   * @returns {Record<string, boolean>}
   */
  function serviceVisible(names) {
    /*
     * ⚠️ 输出对象必须用 `Object.create(null)`。
     *
     * 用普通对象时，给 `out["__proto__"]` 赋值会去**改原型**而不是建一个属性，
     * 于是「这个服务不存在」这个结论会丢掉 —— 而且这是个原型污染入口。
     * 测试（非法名一律报 false）抓到了这一点。
     */
    const out = Object.create(null);
    for (const name of Array.isArray(names) ? names : []) {
      if (typeof name !== "string" || name === "") continue;
      // 服务名只允许常规标识符：挡住把探测接口当成任意属性读取器用
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
        out[name] = false;
        continue;
      }
      out[name] = optionalService(ctx, name) !== undefined;
    }
    return out;
  }

  return {
    modelCatalog,
    fileReferences,
    recentSessions,
    selectModel,
    sessionEvents,
    permissionPresets,
    serviceVisible,
    archivedSessionIds,
    uploadFile,
    uploadImages,
    availability,
  };
}
