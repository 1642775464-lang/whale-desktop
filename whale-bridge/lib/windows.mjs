/**
 * 小窗进程管理
 *
 * 职责：按需拉起小窗（Electron 子进程）、复用已存活的小窗、关闭小窗、
 *       并维护进程表供 `/whale/windows` 查询。
 * 所属层：桥（whale-bridge/lib）
 *
 * 三条硬性纪律（PRD F6 + 小窗 PRD 5.1/5.2/5.3，每条都有实测代价）：
 *
 *   1. `delete ELECTRON_RUN_AS_NODE`
 *      宿主的 DSH CLI 会在环境里设这个变量。带着它启动 electron.exe，
 *      Electron 会退化成纯 Node 运行（不起 GUI），表现为「进程活着但没窗口」。
 *     必须在 env 上真正删掉这个键，而不只是设成空串——
 *     空串在某些实现里仍被视作「已设置」。
 *
 *   2. 必须带 `--no-sandbox`
 *      实测不带会崩在 GUI 初始化（`0x80000003`，进程只活 15~20ms）。
 *
 *   3. 不做孤儿防护
 *      PRD 明确移除：宿主重启会让小窗集体自杀，且实测出现误杀。
 *      **务必不要加回来**（小窗 PRD 5.6）。
 *
 * 可注入 `spawnFn`：真实 spawn 在受限沙箱里可能被拒，
 * 注入假 spawn 才能把「参数对不对」和「进程能不能起」两件事分开测。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** 小窗主进程入口（相对仓库根）。 */
export const WINDOW_ENTRY = path.join("whale-window", "main.cjs");

/** Electron 可执行文件（相对仓库根，PRD K-7：运行时共享）。 */
export const ELECTRON_RELATIVE = path.join("runtime", "electron.exe");

/**
 * 建立小窗管理器。
 *
 * @param {object} deps
 * @param {string} deps.repoRoot 仓库根绝对路径
 * @param {(msg: string) => void} [deps.log]
 * @param {Function} [deps.spawnFn] 注入的 spawn（测试用）
 * @param {(p: string) => boolean} [deps.existsFn] 注入的存在性检查（测试用）
 * @param {() => number} [deps.now]
 * @returns {object} 小窗管理器
 */
export function createWindowManager(deps) {
  const repoRoot = deps.repoRoot;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const spawnFn = typeof deps.spawnFn === "function" ? deps.spawnFn : nodeSpawn;
  const existsFn = typeof deps.existsFn === "function" ? deps.existsFn : existsSync;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  /** @type {Map<number, object>} 键为 pid */
  const windows = new Map();
  const stats = { opened: 0, reused: 0, closed: 0, spawnFailed: 0, exitObserved: 0 };

  /**
   * 拉起或复用一个小窗。
   *
   * @param {{sessionId?: string, reason?: string}} [options]
   * @returns {{ok: boolean, code?: string, message?: string, pid?: number, reused?: boolean}}
   */
  function open(options = {}) {
    // 复用：已有存活小窗就直接返回，不拉新的（C8）
    const alive = findAlive();
    if (alive !== undefined) {
      stats.reused += 1;
      return { ok: true, pid: alive.pid, reused: true };
    }

    const electronPath = path.join(repoRoot, ELECTRON_RELATIVE);
    const entryPath = path.join(repoRoot, WINDOW_ENTRY);

    // 启动前先确认两个文件在——缺文件时 spawn 会以晦涩的系统错误失败，
    // 提前检查能给出可读得多的报错
    if (!existsFn(electronPath)) {
      stats.spawnFailed += 1;
      return {
        ok: false,
        code: "electron-missing",
        message: `未找到 Electron 运行时：${electronPath}`,
      };
    }
    if (!existsFn(entryPath)) {
      stats.spawnFailed += 1;
      return { ok: false, code: "entry-missing", message: `未找到小窗入口：${entryPath}` };
    }

    const env = buildEnv(options);
    let child;
    try {
      child = spawnFn(electronPath, ["--no-sandbox", WINDOW_ENTRY], {
        cwd: path.join(repoRoot, "whale-window"),
        env,
        detached: false,
        stdio: "ignore",
        windowsHide: false,
      });
    } catch (err) {
      stats.spawnFailed += 1;
      return { ok: false, code: "spawn-failed", message: err?.message ?? "无法启动小窗进程" };
    }

    const pid = child.pid;
    if (typeof pid !== "number") {
      stats.spawnFailed += 1;
      return { ok: false, code: "spawn-failed", message: "小窗进程未返回 pid" };
    }

    const entry = {
      pid,
      sessionId: options.sessionId ?? null,
      reason: options.reason ?? "user",
      startedAt: now(),
      child,
    };
    windows.set(pid, entry);
    stats.opened += 1;

    // 进程退出要摘掉，否则会一直「复用」一个死 pid
    if (typeof child.once === "function") {
      child.once("exit", (code, signal) => {
        stats.exitObserved += 1;
        windows.delete(pid);
        log(`[桥] 小窗进程 ${pid} 已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`);
      });
    }

    log(`[桥] 已拉起小窗 pid=${pid}`);
    return { ok: true, pid, reused: false };
  }

  /**
   * 构造子进程环境：在宿主环境基础上删掉 `ELECTRON_RUN_AS_NODE`。
   *
   * 复制而不是就地改 `process.env`——就地改会污染宿主自身进程，
   * 让宿主后续 spawn 的其它 Electron 也失去 GUI。
   *
   * @param {object} options
   * @returns {Record<string, string>}
   */
  function buildEnv(options) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // 小窗需要知道往哪个端口的桥回报
    if (options.port !== undefined) env.WHALE_BRIDGE_PORT = String(options.port);
    return env;
  }

  /**
   * 关闭小窗。
   *
   * @param {{pid?: number, all?: boolean}} [options]
   * @returns {{ok: boolean, code?: string, message?: string, closed?: number}}
   */
  function close(options = {}) {
    const targets = options.all === true
      ? [...windows.values()]
      : [...windows.values()].filter((w) => w.pid === options.pid);

    if (targets.length === 0) {
      return { ok: true, closed: 0 };
    }

    let closed = 0;
    for (const entry of targets) {
      try {
        entry.child.kill();
        closed += 1;
      } catch (err) {
        log(`[桥] 关闭小窗 ${entry.pid} 失败：${err?.message ?? err}`);
      }
      windows.delete(entry.pid);
      stats.closed += 1;
    }
    return { ok: true, closed };
  }

  /**
   * 关闭全部小窗（卸载时调用，PRD F3：先关小窗再关服务）。
   *
   * @returns {{ok: boolean, closed: number}}
   */
  function closeAll() {
    return close({ all: true });
  }

  /**
   * 列出小窗进程。
   * @returns {Array<object>}
   */
  function list() {
    const out = [];
    for (const entry of windows.values()) {
      out.push({
        pid: entry.pid,
        sessionId: entry.sessionId,
        reason: entry.reason,
        startedAt: entry.startedAt,
        ageMs: Math.max(0, now() - entry.startedAt),
      });
    }
    return out;
  }

  /** 找一个存活的小窗（取最早启动的那个，行为稳定可预期）。 */
  function findAlive() {
    let oldest;
    for (const entry of windows.values()) {
      if (oldest === undefined || entry.startedAt < oldest.startedAt) oldest = entry;
    }
    return oldest;
  }

  /** 当前存活小窗数。 */
  function count() {
    return windows.size;
  }

  return {
    open,
    close,
    closeAll,
    list,
    count,
    stats,
    /** 仅测试用：直接看进程表的 pid 集合 */
    pids: () => [...windows.keys()],
  };
}
