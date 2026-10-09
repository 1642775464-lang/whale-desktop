/**
 * 消息可见性：哪些消息该显示在对话流里
 *
 * 职责：从宿主事件里判定「这条消息是不是人看得见的对话内容」。
 * 所属层：桥的纯函数模块（whale-bridge/lib）
 *
 * 为什么单独成文件：
 *   1. 这里装的是**宿主事件形状的知识**（`source.kind` 有哪些取值、
 *      `stream` 里 finish 的语义），与「怎么折叠事件」是两回事 ——
 *      宿主改了事件形状，只动这个文件。
 *   2. fold.mjs 是纯函数模块（上限 300 行，比普通模块更严），装不下了。
 *
 * ## 两条判据都是查真实会话日志定下来的，不是从源码注释推的
 *
 * ### 用户消息：`source.kind === "user"` 才是人说的
 * 真实会话日志里 **386 条 user/message 每一条都有 source.kind**：
 *
 *     user 138 / time-context 126 / dsh-mnemon 45 / model-selection 36
 *     user-approval 13 / runtime-context 13 / skill-catalog 7 /
 *     compact-checkpoint 4 / whale-hud 3 / tool-jobs 1
 *
 * 我最初按「有没有 source 字段」判断，那会把用户说的每句话都吃掉 ——
 * 而单元测试当时全绿，因为夹具里的「真人消息」没有 source 字段。
 *
 * ### 助手消息：这一轮**说完了**才算回答
 * `stream` 里最后的 finish 是 `stop` → 说完了；`tool-calls` → 还要接着干活。
 * 真实分布：
 *
 *     纯文本        105 条 → stop
 *     文本 + 工具  2102 条 → tool-calls   ← 中间旁白
 *     纯工具       1907 条 → tool-calls
 *
 * 那 2102 条「文本 + 工具」混在一条消息里，只过滤「独立的工具消息」是漏的。
 */

/**
 * 取消息里的纯文本。
 *
 * 只认 `type === "text"` 的块：`tool-call` 块的 arguments 是一坨 JSON，
 * 混进小窗消息流会把界面冲垮。取不到返回空串，调用方据此决定不推送。
 *
 * @param {object} message 消息对象（`{ content: [...] }`）
 * @returns {string}
 */
export function textOfMessage(message) {
  if (message === null || typeof message !== "object") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  let out = "";
  for (const block of blocks) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      out += block.text;
    }
  }
  return out;
}

/**
 * 这条 user/message 是不是**人**说的。
 *
 * 判据是 `data.source.kind === "user"`；其余取值（time-context、
 * dsh-mnemon、model-selection…）都是系统注入的运行时上下文。
 *
 * 保守原则：`source` 缺失或形状不认识时**按真人处理** ——
 * 宁可多显示一条，也不能把用户的话静默吃掉。
 *
 * @param {object} data 事件的 data
 * @returns {boolean}
 */
export function isHumanMessage(data) {
  const kind = data?.source?.kind;
  if (typeof kind !== "string" || kind === "") return true;
  return kind === "user";
}

/**
 * 这条 assistant 消息是不是「干活的中间步骤」（而不是最终回答）。
 *
 * 两个判据任一命中即算中间步骤：
 *   1. **消息里带工具调用块** —— 带工具就说明还要接着干活；
 *   2. **`stream` 里最后的 finish 是 `tool-calls`** —— 宿主明说「这轮没完」。
 *
 * ⚠️ 判据 1 是必须的：真实日志里 2102 条「文本 + 工具」的消息中，
 * 有些的 stream 被截断、看不到 finish，只靠判据 2 会漏。
 *
 * 保守原则：两个判据都认不出时返回 false（按最终回答处理）——
 * 宁可多显示一条，也不能把助手的回答静默吃掉。
 *
 * @param {object} data 事件的 data
 * @returns {boolean}
 */
export function isIntermediateStep(data) {
  const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
  if (blocks.some((b) => b !== null && typeof b === "object" && b.type === "tool-call")) return true;

  const stream = Array.isArray(data?.stream) ? data.stream : [];
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i]?.chunk;
    if (chunk?.type !== "finish") continue;
    return chunk.reason?.kind !== "stop";
  }
  return false;
}
