/**
 * 路由表
 *
 * 职责：声明 PRD F2 的全部 22 条路由，并把已实现的路由映射到处理器。
 * 所属层：桥（whale-bridge/lib）
 *
 * 设计要点：路由表是**唯一事实源**——`/whale` 概览路由直接读它，
 * 单测也读它校验完整性。未实现的处理器为 `null`，被调用时统一返回 501，
 * 避免「路由表里有、实际 404」的口径分裂。
 */

/**
 * @typedef {object} RouteDef
 * @property {string} method
 * @property {string} path
 * @property {string} purpose      用途（给 /whale 概览用）
 * @property {string} slice        交付切片（1/2/3），用于进度可见
 * @property {((ctx: object) => Promise<unknown>) | null} handler
 */

/** 已实现的处理器注册表；键为 `METHOD /path`。 */
const handlers = new Map();

/**
 * 注册一个已实现的路由处理器。
 * @param {string} method
 * @param {string} path
 * @param {(ctx: object) => Promise<unknown>} fn
 */
export function register(method, path, fn) {
  handlers.set(`${method} ${path}`, fn);
}

/**
 * 取某路由的处理器；未实现返回 undefined。
 * @param {string} method
 * @param {string} path
 * @returns {((ctx: object) => Promise<unknown>) | undefined}
 */
export function getHandler(method, path) {
  return handlers.get(`${method} ${path}`);
}

/** PRD F2 的 22 条路由定义（顺序与 PRD 表格一致）。 */
export const ROUTE_DEFS = [
  { method: "GET", path: "/whale", purpose: "概览：版本、路由表、插件名", slice: 1 },
  { method: "GET", path: "/whale/probe", purpose: "运行时探测：宿主服务是否可用", slice: 1 },
  { method: "GET", path: "/whale/events", purpose: "SSE 实时事件流", slice: 3 },
  { method: "GET", path: "/whale/panel", purpose: "面板数据源：消息流 + 任务 + 档位", slice: 1 },
  { method: "GET", path: "/whale/capability", purpose: "提交通路能力探测", slice: 1 },
  { method: "GET", path: "/whale/windows", purpose: "已拉起的窗口进程（含目标）", slice: 3 },
  { method: "GET", path: "/whale/fold", purpose: "增量折叠器状态", slice: 2 },
  { method: "GET", path: "/whale/follow", purpose: "主窗跟随 SSE", slice: 3 },
  { method: "GET", path: "/whale/models", purpose: "模型目录", slice: 3 },
  { method: "GET", path: "/whale/commands", purpose: "斜杠命令目录（宿主真命令）", slice: 7 },
  { method: "GET", path: "/whale/presets", purpose: "权限档位清单与当前档位", slice: 7 },
  { method: "GET", path: "/whale/summon", purpose: "取走唤起请求（复用窗口拿到面前）", slice: 7 },
  { method: "GET", path: "/whale/files", purpose: "@ 文件引用候选（工作区文件搜索）", slice: 7 },
  { method: "GET", path: "/whale/approval", purpose: "待确认权限请求", slice: 3 },
  { method: "POST", path: "/whale/open", purpose: "唤起小窗或悬浮条（target 可选）", slice: 3 },
  { method: "POST", path: "/whale/close", purpose: "关闭窗口进程", slice: 3 },
  { method: "POST", path: "/whale/send", purpose: "发消息到真会话", slice: 3 },
  { method: "POST", path: "/whale/command", purpose: "执行斜杠命令", slice: 3 },
  { method: "POST", path: "/whale/activate", purpose: "切会话时唤醒为活跃会话", slice: 3 },
  { method: "POST", path: "/whale/model", purpose: "切换模型 / 推理等级", slice: 3 },
  { method: "POST", path: "/whale/abort", purpose: "中断当前回合", slice: 3 },
  { method: "POST", path: "/whale/resume", purpose: "唤醒历史会话", slice: 3 },
  { method: "POST", path: "/whale/approval", purpose: "应答权限确认", slice: 3 },
  { method: "POST", path: "/whale/action", purpose: "宿主侧动作", slice: 3 },
  { method: "POST", path: "/whale/upload/file", purpose: "上传文件（base64 → 宿主 attachments）", slice: 7 },
  { method: "POST", path: "/whale/upload/images", purpose: "批量上传图片（base64 → 宿主 attachments）", slice: 7 },
  { method: "GET", path: "/whale/hud", purpose: "悬浮条数据：全量快照", slice: 3 },
  { method: "GET", path: "/whale/hud/events", purpose: "悬浮条 SSE 增量推送", slice: 3 },
];

/**
 * 校验路由表自身的一致性。
 * @returns {string[]} 问题列表，空数组表示无问题
 */
export function validateRouteTable() {
  const problems = [];
  const seen = new Set();

  for (const def of ROUTE_DEFS) {
    const key = `${def.method} ${def.path}`;
    if (seen.has(key)) problems.push(`路由重复：${key}`);
    seen.add(key);

    if (!def.path.startsWith("/whale")) {
      problems.push(`路由不在 /whale 基础路径下：${key}`);
    }
    if (def.method !== "GET" && def.method !== "POST") {
      problems.push(`路由方法不受支持：${key}`);
    }
  }

  return problems;
}

/**
 * 生成给 `/whale` 概览用的路由清单。
 * 只暴露方法、路径、用途与是否已实现，不泄漏处理器函数。
 * @returns {Array<{method: string, path: string, purpose: string, implemented: boolean}>}
 */
export function describeRoutes() {
  return ROUTE_DEFS.map((def) => ({
    method: def.method,
    path: def.path,
    purpose: def.purpose,
    implemented: getHandler(def.method, def.path) !== undefined,
  }));
}
