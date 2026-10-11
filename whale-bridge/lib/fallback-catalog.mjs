/**
 * 会话清单的降级数据源（注册表 + 投影缓存）
 *
 * 职责：`session/list`（Typert）**整体失败**时，用宿主的持久层拼一份
 *       尽可能完整的清单 —— 工作区归属与归档来自注册表，标题与时间来自
 *       投影缓存（projcache）。
 * 所属层：桥（whale-bridge/lib）
 *
 * ## 为什么需要它
 *
 * 实测：宿主可能因为**一条**会话的 header 观察不一致（
 * `SESSION_QUERY_SOURCE_CONFLICT`）而让**整个** `session/list` 失败，
 * 而单会话的 resume / activate 却一切正常。于是侧边栏要么降级成
 * 折叠器里那两条（用户想切的会话根本不在列表里），要么整块空白。
 *
 * 与其让用户面对「列表缩水」，不如直接从宿主的**持久层**拼一份完整清单：
 *
 *   · 注册表（~/.dsh/storages/workspace.json）：
 *       工作区（id / 标题 / 路径 / **登记的**成员）+ 归档集合 + 置顶集合
 *       —— 归属与归档的权威来源（见 workspace-registry.mjs）；
 *   · 投影缓存（~/.dsh/storages/session_projcache/sessions/*.json）：
 *       每会话的标题（rows.title.val）、空壳标记
 *       （sessionListMetadata.val.blank）、最近活动
 *       （sessionListMetadata.val.lastPromptAt）。
 *
 * 实测覆盖：注册表 15 条里 14 条有 projcache、13 条有标题 —— 足够可用。
 *
 * ## 降级纪律
 *
 * 这份清单来自**持久层快照**，不是实时状态：
 *   · running / agentAvailable 未知 → 一律 false（界面显示「历史」，
 *     点击走 resume —— 单会话 resume 实测不受批量查询冲突影响）；
 *   · 读不到注册表 → 返回 ok:false，调用方如实报错，不编造清单。
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readWorkspaceRegistry } from "./workspace-registry.mjs";

/** 投影缓存目录（会话标题/空壳/最近活动的权威落盘）。 */
export function projcacheDir(env = process.env) {
  const home = typeof env?.DSH_HOME === "string" && env.DSH_HOME !== ""
    ? env.DSH_HOME
    : join(homedir(), ".dsh");
  return join(home, "storages", "session_projcache", "sessions");
}

/**
 * 读一份投影缓存。
 *
 * @param {string} dir 缓存目录
 * @param {string} sessionId 会话 id
 * @returns {{ title: string|null, blank: boolean, lastPromptAt: number|null,
 *             cwd: string|null } | null} 读不到给 null
 */
export function readProjection(dir, sessionId) {
  const file = join(dir, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const rows = json?.record?.rows ?? {};
  const identity = json?.record?.identity ?? {};
  const meta = rows?.sessionListMetadata?.val;
  const title = rows?.title?.val;
  return {
    title: typeof title === "string" && title !== "" ? title : null,
    blank: meta?.blank === true,
    lastPromptAt: typeof meta?.lastPromptAt === "number" ? meta.lastPromptAt : null,
    cwd: typeof identity?.cwd === "string" && identity.cwd !== "" ? identity.cwd : null,
  };
}

/**
 * 拼一份降级会话清单。
 *
 * @param {object} [opts]
 * @param {string} [opts.registryFile] 注册表路径（测试可注入）
 * @param {string} [opts.cacheDir] 投影缓存目录（测试可注入）
 * @returns {{ok: boolean, sessions?: Array<object>, archivedKnown?: boolean,
 *            registryKnown?: boolean, degraded?: string}}
 */
export function fallbackSessionCatalog(opts = {}) {
  const registry = readWorkspaceRegistry(opts.registryFile);
  if (registry.ok !== true) {
    // 注册表都读不到 → 不编造清单，如实报失败
    return { ok: false, code: "registry-unavailable" };
  }

  const dir = opts.cacheDir ?? projcacheDir();
  const sessions = [];

  for (const ws of registry.workspaces) {
    for (const sessionId of ws.sessionIds) {
      const proj = readProjection(dir, sessionId);
      const archived = registry.archivedIds.includes(sessionId);
      sessions.push({
        sessionId,
        title: proj?.title ?? null,
        workspace: proj?.cwd ?? ws.path ?? null,
        workspaceId: ws.id,
        workspaceTitle: ws.title,
        workspacePath: ws.path,
        isDefaultWorkspace: ws.isDefault === true,
        updatedAt: proj?.lastPromptAt ?? null,
        running: false,            // 持久层快照，不知道实时状态
        agentAvailable: false,     // 同上：界面按「历史」处理，点击走 resume
        blank: proj?.blank === true,
        archived,
        origin: null,
      });
    }
  }

  // 按最近活动倒序（null 排最后，与 fold-view 同口径）
  sessions.sort((l, r) => {
    if (l.updatedAt === null && r.updatedAt === null) return 0;
    if (l.updatedAt === null) return 1;
    if (r.updatedAt === null) return -1;
    return r.updatedAt - l.updatedAt;
  });

  return {
    ok: true,
    sessions,
    archivedKnown: true,
    registryKnown: true,
    /*
     * ⚠️ **不设 degraded**。
     *
     * 这份清单是完整的（归属/归档/标题都有），只是来源是持久层快照。
     * 用户明确要求过「过滤是正常行为，别报提示行」—— 从持久层列会话
     * 也是正常行为（主窗口的会话列表同样来自持久层），不该让界面显示
     * 「清单不完整」那类黄色提示（用户把它当「报错」）。
     *
     * `fallback: true` 只供调试与测试断言用，渲染层不消费它。
     */
    fallback: true,
  };
}
