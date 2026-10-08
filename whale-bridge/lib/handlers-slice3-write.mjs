/**
 * 切片 3 写操作路由
 *
 * 职责：实现切片 3 的 9 条 POST 路由——拉窗、关窗、发消息、命令、
 *       切换活跃会话、切模型、中断、唤醒、审批应答、宿主动作。
 * 所属层：桥（whale-bridge/lib）
 *
 * 本模块只做「HTTP 外壳」：校验入参 → 调 host-actions / windows / approval-bridge
 * → 把结果转成状态码。**真正的宿主交互全在那三个模块里**，
 * 这样每个模块的职责单一，也便于各自单测。
 *
 * 状态码约定：
 *   200 成功
 *   400 参数不合法（bad-request）
 *   404 会话/资源不存在（session-not-found）
 *   409 状态冲突（无活跃回合、steer 不可用）——C11 要求
 *   503 依赖服务缺失（unavailable）
 */

import { register } from "./routes.mjs";

/**
 * 把动作结果转成 HTTP 响应。
 *
 * 动作返回 `{ok:true,...}` 或 `{ok:false, code, message, status?}`。
 * `status` 可由动作显式指定（如 abort 的 409），否则按 code 推断。
 *
 * @param {object} result
 * @returns {object}
 */
function toResponse(result) {
  if (result?.ok === true) {
    return { ok: true, ...stripInternal(result) };
  }

  const code = result?.code ?? "internal";
  const err = new Error(result?.message ?? "操作失败");
  err.code = code;
  err.status = result?.status ?? statusOf(code);
  throw err;
}

/** 去掉动作结果里的 ok 字段（响应体里统一由外层给）。 */
function stripInternal(result) {
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (k !== "ok") out[k] = v;
  }
  return out;
}

/**
 * 由错误 code 推断状态码。
 *
 * 这张表是「桥对外的状态码口径」的唯一事实源——
 * 加了新 code 忘了改这里，会退化成 500，很容易被发现。
 *
 * @param {string} code
 * @returns {number}
 */
export function statusOf(code) {
  if (code === "bad-request") return 400;
  if (code === "session-not-found" || code === "approval-not-found") return 404;
  if (code === "no-active-turn" || code === "session/steer-unavailable") return 409;
  if (code === "approval-not-pending") return 409;
  // 宿主拒绝这次模型选择（模型不存在/该 provider 不接受这个 effort）——
  // 这是**调用方的输入问题**，不是桥或宿主的故障，所以 400 而不是 500。
  if (code === "session/model-unavailable") return 400;
  // 宿主拒绝这次上传（非规范 base64 / 超出图片批量限制等）——
  // AttachmentError 的稳定 code 同样是调用方输入问题 → 400。
  if (code === "INVALID_FILE_BASE64" || code === "INVALID_IMAGE_BASE64") return 400;
  if (code === "ATTACHMENT_FILES_UNSUPPORTED" || code === "ATTACHMENT_IMAGES_UNSUPPORTED") return 501;
  // 宿主没这个上传能力是部署形态问题 → 503（与其它 unavailable 同口径）。
  if (code === "attachments-unavailable") return 503;
  if (
    code === "commands-unavailable" ||
    code === "sessions-unavailable" ||
    code === "approval-unavailable" ||
    code === "model-switch-unavailable" ||
    code === "resume-unavailable"
  ) {
    return 503;
  }
  return 500;
}

/** 校验并取出必需字符串参数。 */
function requireString(body, key) {
  const value = body?.[key];
  if (typeof value !== "string" || value === "") {
    const err = new Error(`缺少 ${key}`);
    err.code = "bad-request";
    err.status = 400;
    throw err;
  }
  return value;
}

/**
 * POST /whale/send —— 发消息到真会话。
 *
 * 语义见 host-actions.send（S3-D1）。返回 `queued` 告诉客户端
 * 这条消息是立刻执行还是排队等下一回合。
 */
async function send({ body, bridge }) {
  return toResponse(bridge.hostActions.send(body));
}

/** POST /whale/command —— 执行斜杠命令。 */
async function command({ body, bridge }) {
  return toResponse(await bridge.hostActions.command(body));
}

/** POST /whale/abort —— 中断当前回合（无活跃回合 → 409，C11）。 */
async function abort({ body, bridge }) {
  return toResponse(bridge.hostActions.abort(body));
}

/** POST /whale/activate —— 切会话时唤醒为活跃会话。 */
async function activate({ body, bridge }) {
  const result = bridge.hostActions.activate(body);
  if (result.ok === true) {
    // 活跃会话指针挪过去：SSE 与快照都以它为准
    bridge.foldSet.activeSessionId = result.sessionId;
    // ⚠️ 必须清掉「种子默认值」标记。
    // 这是**用户显式**的选择，要压过自动规则；不清的话，
    // 下一个产生事件的其他会话会把用户刚切过去的选择顶掉
    // —— 表现是「我明明切了它又跳回去」。
    bridge.foldSet.activeIsSeed = false;
  }
  return toResponse(result);
}

/** POST /whale/model —— 切换模型 / 推理等级。 */
async function setModel({ body, bridge }) {
  // 必须 await：hostActions.setModel 现在是异步的（走宿主 sessionController），
  // 漏了 await 会把 Promise 当结果交给 toResponse，退化成 500。
  return toResponse(await bridge.hostActions.setModel(body));
}

/** POST /whale/resume —— 唤醒历史会话。 */
async function resume({ body, bridge }) {
  return toResponse(bridge.hostActions.resume(body));
}

/**
 * POST /whale/open —— 唤起小窗或悬浮条。
 *
 * 复用语义（C8）：**该目标**已有存活窗口则直接返回 `{reused:true}`，不拉新进程。
 * 复用按目标分开——存活的悬浮条不该挡住拉起小窗。
 *
 * `target` 可选（切片 6 新增）：
 *   - `"window"`（缺省）→ 小窗
 *   - `"hud"`            → 悬浮条
 * 缺省保持 window，既有调用行为不变。
 */
async function open({ body, bridge }) {
  const options = {
    sessionId: typeof body?.sessionId === "string" ? body.sessionId : undefined,
    reason: typeof body?.reason === "string" ? body.reason : "user",
    target: typeof body?.target === "string" ? body.target : undefined,
    port: bridge.port,
  };
  return toResponse(bridge.windows.open(options));
}

/**
 * POST /whale/close —— 关闭窗口。
 *
 * 三种口径（与 windows.close 一致）：
 *   - `{pid}`           → 只关那一个
 *   - `{target}`        → 只关该目标的（"window" / "hud"）
 *   - `{all: true}`     → 全关（卸载时用）
 *
 * ⚠️ `target` 必须在**这里**就传下去。
 * 曾经只在 windows.close 里实现了按 target 关，处理器却只读 pid/all——
 * 于是 `{target:"window"}` 被丢掉，close() 落到「按 pid 匹配」分支、
 * 匹配不到任何窗口，返回 `{ok:true, closed:0}`：
 * **看起来成功、实际一个都没关**。表现就是「点鲸鱼收不起小窗、绿环也不灭」。
 * 这类「成功但什么也没做」的返回比报错更难查，所以这条注释留在这里。
 */
async function closeWindows({ body, bridge }) {
  const pid = typeof body?.pid === "number" ? body.pid : undefined;
  const all = body?.all === true;
  const target = typeof body?.target === "string" ? body.target : undefined;
  return toResponse(bridge.windows.close({ pid, all, target }));
}

/**
 * POST /whale/approval —— 应答权限确认。
 *
 * 两种用法（S3-D2）：
 *   - `{id, outcome}` 应答某条挂起请求
 *   - `{policy: "ask"|"never", sessionId}` 改审批策略
 */
async function approval({ body, bridge }) {
  if (typeof body?.policy === "string") {
    return toResponse(bridge.hostActions.setApprovalPolicy(body));
  }
  const id = requireString(body, "id");
  const outcome = requireString(body, "outcome");
  return toResponse(bridge.approval.answer(id, outcome));
}

/**
 * POST /whale/action —— 宿主侧动作。
 *
 * 通用入口：`{action: "...", ...}` 转发到对应处理器。
 * 未识别的 action 明确报 400，**不静默忽略**
 * （静默忽略会让调用方以为动作成功了）。
 */
async function action({ body, bridge }) {
  const kind = requireString(body, "action");
  switch (kind) {
    case "abort":
      return toResponse(bridge.hostActions.abort(body));
    case "activate":
      return toResponse(bridge.hostActions.activate(body));
    case "resume":
      return toResponse(bridge.hostActions.resume(body));
    default: {
      const err = new Error(`未识别的 action：${kind}`);
      err.code = "bad-request";
      err.status = 400;
      throw err;
    }
  }
}

/**
 * POST /whale/upload/file —— 上传一个文件（base64 → 宿主 attachments）。
 *
 * 交给宿主 attachments.saveFile（admission 层标注的浏览器上传共享入口）。
 * 返回内容寻址引用；调用方（小窗）把它放进待发消息。
 */
async function uploadFile({ body, bridge }) {
  return toResponse(await bridge.hostActions.uploadFile(body));
}

/**
 * POST /whale/upload/images —— 批量上传图片（base64 → 宿主 attachments）。
 */
async function uploadImages({ body, bridge }) {
  return toResponse(await bridge.hostActions.uploadImages(body));
}

/** 注册本片全部写操作处理器。 */
export function registerSliceThreeWriteRoutes() {
  register("POST", "/whale/send", send);
  register("POST", "/whale/command", command);
  register("POST", "/whale/abort", abort);
  register("POST", "/whale/activate", activate);
  register("POST", "/whale/model", setModel);
  register("POST", "/whale/resume", resume);
  register("POST", "/whale/open", open);
  register("POST", "/whale/close", closeWindows);
  register("POST", "/whale/approval", approval);
  register("POST", "/whale/action", action);
  // 切片 7 第二批：＋ 真上传
  register("POST", "/whale/upload/file", uploadFile);
  register("POST", "/whale/upload/images", uploadImages);
}

/** 本片写操作路由条数。 */
export const SLICE_THREE_WRITE_ROUTES = 10;

/** 切片 7 新增的写操作路由条数（单测核对用）。 */
export const SLICE_SEVEN_WRITE_ROUTES = 2;
