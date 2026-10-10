/**
 * 工作区注册表（读宿主落盘）
 *
 * 职责：读 `~/.dsh/storages/workspace.json`，给出「工作区 → 会话 id」
 *       的归属关系与归档会话集合。
 * 所属层：桥（whale-bridge/lib）
 *
 * ## 为什么需要它（而不是按 cwd 反推）
 *
 * 用户报过：
 *
 * > 数目根本不对，宿主侧数量没有那么多，你自己看你多出来的都是一堆空壳
 *
 * 根因是**归属来源错了**。主窗口侧边栏的会话归属来自 Workspace registry ——
 * 注册表里每个工作区有一份**显式登记的** `sessionIds`：
 *
 *     "e582e548-...": { "path": "D:\\DEEPSEEK\\悬浮窗", "sessionIds": [3 条] }
 *
 * 而我原先按「会话的 cwd 等于该目录」反推 —— 于是把历史上所有在该目录
 * 跑过的会话（含空壳、含早已不属于该工作区的）全列了出来。
 * 这与主窗口的数目自然对不上。
 *
 * 归档集合（`archivedSessionIds`）与工作区归属在**同一份注册表**里，
 * 这也印证了它们是同一件事的两面（客户端的 baseline 就是这么下发的：
 * `installViews(baseline.items)` + `installArchived(baseline.archivedSessionIds)`）。
 *
 * ## 关于「读盘」这个选择
 *
 * 这是**绕过宿主服务直接读落盘**。之所以接受它：
 *
 *   · 那份 `sessionIds` 只能从这里拿到 —— `workspaceRegistry` 的
 *     `archivedSessionIds` 字段实测取到的是空，工作区成员也没有现成的
 *     Typert 端点可读（它走的是流式 baseline，要开流才能拿）；
 *   · 注册表是宿主自己维护的**权威持久化**（每次变更即写），
 *     不是「稍后才会落盘的缓存」。
 *
 * 读失败一律返回 `ok:false` 并给空数据 —— 调用方据此**不要**隐藏任何会话
 * （宁可多列，也不要把用户的会话凭空藏掉）。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 注册表落盘路径。
 *
 * 尊重 `DSH_HOME`（与宿主其它插件一致），否则用 `~/.dsh`。
 *
 * @param {object} [env]
 * @returns {string}
 */
export function registryPath(env = process.env) {
  const home = typeof env?.DSH_HOME === "string" && env.DSH_HOME !== ""
    ? env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "storages", "workspace.json");
}

/**
 * 读并归一化工作区注册表。
 *
 * @param {string} [file] 注册表路径（测试可注入）
 * @returns {{ok: boolean, workspaces: Array<object>, archivedIds: string[], pinnedIds: string[]}}
 *          `ok:false` 时其余字段为空 —— 调用方不要据此隐藏任何东西
 */
export function readWorkspaceRegistry(file = registryPath()) {
  const empty = { ok: false, workspaces: [], archivedIds: [], pinnedIds: [] };

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return empty;
  }

  const globals = raw?.global ?? {};
  const tables = raw?.tables?.workspaces ?? {};

  const strList = (value) => (Array.isArray(value)
    ? value.filter((id) => typeof id === "string" && id !== "")
    : []);

  const workspaces = [];
  for (const [id, ws] of Object.entries(tables)) {
    if (ws === null || typeof ws !== "object") continue;
    const path = typeof ws.path === "string" && ws.path !== "" ? ws.path : null;
    workspaces.push({
      id,
      // 标题取注册表的 title；没有就用路径最后一段（与界面的显示口径一致）
      title: typeof ws.title === "string" && ws.title !== ""
        ? ws.title
        : lastSegment(path),
      path,
      sessionIds: strList(ws.sessionIds),
      isDefault: id === globals.defaultWorkspaceId,
    });
  }

  return {
    ok: true,
    workspaces,
    archivedIds: strList(globals.archivedSessionIds),
    pinnedIds: strList(globals.pinnedSessionIds),
  };
}

/**
 * 取路径最后一段（`D:\a\b` → `b`）。
 *
 * @param {string|null} p
 * @returns {string|null}
 */
function lastSegment(p) {
  if (typeof p !== "string" || p === "") return null;
  const parts = p.split(/[\\/]/).filter((s) => s !== "");
  return parts.length > 0 ? parts[parts.length - 1] : null;
}
