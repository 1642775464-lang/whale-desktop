/**
 * 按会话解析「工作区根」
 *
 * 职责：给需要**绝对路径**的通路（读文件内容）提供工作区根，
 *       来源与侧边栏的会话清单保持一致。
 * 所属层：桥（whale-bridge/lib）
 *
 * ## 为什么不能直接用 `host.getSession().cwd`
 *
 * 用户报「文件区域还是能进文件列表但是打不开文件」，错误码 `no-workspace`。
 * 根因是**两条通路拿根的方式不一样**：
 *
 *   · 列目录（`/whale/workspace/files`）走 `host.getAgent()` +
 *     `host.fileReferences()` —— 完全不碰会话的工作区字段，所以**一直是好的**；
 *   · 读文件（`/whale/workspace/read`）走 `session.cwd ?? session.workspace`
 *     —— 而实测宿主 `getSession()` 返回的对象里这两个字段**都是空的**，
 *     于是永远报 `no-workspace`（列表能进、文件打不开，正是这个组合）。
 *
 * 所以这里按可靠性排序取根，**与会话清单同源**（那是界面上已经证明可用的来源）：
 *
 *   1. `getSession()` 的 `cwd` / `workspace`（宿主真给了就用，最直接）；
 *   2. `session/list`（Typert）里该会话的 `workspace` / `workspacePath`；
 *   3. 降级清单（注册表 + 投影缓存）里的同名字段。
 *
 * ⚠️ 都拿不到时返回空串，交由调用方**如实报错** —— 不猜、不编一个默认目录。
 */

"use strict";

import { fallbackSessionCatalog } from "./fallback-catalog.mjs";

/**
 * 取第一个非空字符串。
 *
 * @param {...(string|undefined|null)} values
 * @returns {string}
 */
function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

/**
 * 从一行清单记录里取工作区路径。
 *
 * `workspace` 是该会话的工作目录（SessionSummary 的 cwd），
 * `workspacePath` 是工作区根 —— 前者更贴切，优先。
 *
 * @param {object|undefined} row
 * @returns {string}
 */
function rootFromRow(row) {
  if (row === undefined || row === null) return "";
  return firstNonEmpty(row.workspace, row.workspacePath);
}

/**
 * 解析某会话的工作区根（绝对路径）。
 *
 * @param {object} deps
 * @param {object} deps.host
 * @param {string} deps.sessionId
 * @param {object} [deps.session] 已经取到的 `getSession()` 结果（避免重复取）
 * @param {() => object} [deps.catalogOf] 降级清单来源（测试可注入）
 * @returns {Promise<string>} 拿不到时给空串
 */
export async function resolveWorkspaceRoot({ host, sessionId, session, catalogOf = fallbackSessionCatalog }) {
  // 1) 宿主直接给的字段
  const direct = firstNonEmpty(session?.cwd, session?.workspace);
  if (direct !== "") return direct;

  // 2) 会话清单（Typert）—— 与侧边栏列表同一来源
  if (typeof host?.listSessionsViaTypert === "function") {
    try {
      const out = await host.listSessionsViaTypert();
      if (out?.ok === true) {
        const row = (out.sessions ?? []).filter((s) => s.sessionId === sessionId)[0];
        const v = rootFromRow(row);
        if (v !== "") return v;
      }
    } catch {
      // 这条路读不到就继续往下降级，不让它把整个请求打挂
    }
  }

  // 3) 降级清单（注册表 + 投影缓存）
  try {
    const cat = catalogOf();
    if (cat?.ok === true) {
      const row = (cat.sessions ?? []).filter((s) => s.sessionId === sessionId)[0];
      const v = rootFromRow(row);
      if (v !== "") return v;
    }
  } catch {
    // 同上：降级来源失败不该影响主流程
  }

  return "";
}
