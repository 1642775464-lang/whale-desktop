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

/**
 * 小窗主进程入口（相对仓库根）。
 *
 * @deprecated 用 TARGETS.window.entry。保留此导出是为了不破坏既有引用。
 */
export const WINDOW_ENTRY = path.join("whale-window", "main.cjs");

/**
 * 可拉起的窗口目标表。
 *
 * 为什么要泛化（切片 6）：页面按钮要「单击同时拉起悬浮条与小窗」，
 * 而此前本模块是小窗专用的——入口写死、复用也不分目标。
 *
 * 两个目标都通过 **环境变量 `WHALE_BRIDGE_PORT`** 接收桥端口
 * （whale-window/main.cjs:76、whale-hud/main.cjs:97 都是这么读的），
 * 所以传参机制不需要为悬浮条新增一套。
 */
export const TARGETS = {
  window: {
    entry: path.join("whale-window", "main.cjs"),
    cwd: "whale-window",
    label: "小窗",
  },
  hud: {
    entry: path.join("whale-hud", "main.cjs"),
    cwd: "whale-hud",
    label: "悬浮条",
  },
};

/** 默认目标：缺省仍是小窗，既有调用行为不变。 */
export const DEFAULT_TARGET = "window";

/** Electron 可执行文件（相对仓库根，PRD K-7：运行时共享）。 */
export const ELECTRON_RELATIVE = path.join("runtime", "electron.exe");

/**
 * 归一化目标名。
 *
 * 未知目标一律退回默认（小窗）——**不报错**。
 * 理由：调用方是客户端插件，它的版本可能比桥新；
 * 那里传了个桥不认识的目标时，拉起小窗总比整条按钮点不动好。
 *
 * @param {unknown} value
 * @returns {"window" | "hud"}
 */
export function normalizeTarget(value) {
  if (typeof value === "string" && Object.hasOwn(TARGETS, value)) {
    return value;
  }
  return DEFAULT_TARGET;
}

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
   * 拉起或复用某个目标的窗口。
   *
   * **复用按目标分开**：一个存活的悬浮条不该挡住拉起小窗，反之亦然。
   * 早先的写法是「任意存活就复用」，泛化后会变成「点按钮只起来一个」。
   *
   * @param {{sessionId?: string, reason?: string, target?: string, port?: number}} [options]
   * @returns {{ok: boolean, code?: string, message?: string, pid?: number, reused?: boolean, target?: string}}
   */
  function open(options = {}) {
    const target = normalizeTarget(options.target);
    const spec = TARGETS[target];

    // 复用：该目标已有存活窗口就直接返回，不拉新的（C8）
    const alive = findAlive(target);
    if (alive !== undefined) {
      stats.reused += 1;
      return { ok: true, pid: alive.pid, reused: true, target };
    }

    const electronPath = path.join(repoRoot, ELECTRON_RELATIVE);
    const entryPath = path.join(repoRoot, spec.entry);

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
      return { ok: false, code: "entry-missing", message: `未找到${spec.label}入口：${entryPath}` };
    }

    const env = buildEnv(options);
    let child;
    try {
      // 入口传**绝对路径**，不传相对路径。
      //
      // 曾经写的是相对路径 `whale-window/main.cjs`，而 cwd 已经是
      // `<仓库根>/whale-window`——两者一拼成 `<…>/whale-window/whale-window/main.cjs`，
      // 一个不可能存在的路径。表现为：小窗永远起不来，Electron 既不报错也不退，
      // 就那么挂着。
      //
      // 旧单测没抓到是因为它**分两句**断言「入口对不对」和「cwd 对不对」，
      // 两句各自都过，却没人验「两者组合后能不能找到文件」。
      // 现在入口给绝对路径，就不再依赖这两处之间的相对关系；
      // tests/unit/windows.test.mjs 另有一条断言直接检查「组合后存在」。
      child = spawnFn(electronPath, ["--no-sandbox", entryPath], {
        cwd: path.join(repoRoot, spec.cwd),
        env,
        detached: false,
        stdio: "ignore",
        windowsHide: false,
      });
    } catch (err) {
      stats.spawnFailed += 1;
      return { ok: false, code: "spawn-failed", message: err?.message ?? `无法启动${spec.label}进程` };
    }

    const pid = child.pid;
    if (typeof pid !== "number") {
      stats.spawnFailed += 1;
      return { ok: false, code: "spawn-failed", message: `${spec.label}进程未返回 pid` };
    }

    const entry = {
      pid,
      target,
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
        log(`[桥] ${spec.label}进程 ${pid} 已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`);
      });
    }

    log(`[桥] 已拉起${spec.label} pid=${pid}`);
    return { ok: true, pid, reused: false, target };
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
    // 两个目标都靠这个环境变量知道往哪个端口的桥回报
    // （whale-window/main.cjs 与 whale-hud/main.cjs 都是这么读的）
    if (options.port !== undefined) env.WHALE_BRIDGE_PORT = String(options.port);
    return env;
  }

  /**
   * 关闭窗口。
   *
   * 三种口径：
   *   - `{pid}`        → 只关那一个
   *   - `{target}`     → 只关该目标的
   *   - `{all: true}`  → 全关（卸载时用）
   *
   * @param {{pid?: number, target?: string, all?: boolean}} [options]
   * @returns {{ok: boolean, code?: string, message?: string, closed?: number}}
   */
  function close(options = {}) {
    const all = [...windows.values()];
    const targets = options.all === true
      ? all
      : options.target !== undefined
        ? all.filter((w) => w.target === normalizeTarget(options.target))
        : all.filter((w) => w.pid === options.pid);

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
   * 列出窗口进程。
   * @returns {Array<object>}
   */
  function list() {
    const out = [];
    for (const entry of windows.values()) {
      out.push({
        pid: entry.pid,
        // 带上目标：页面按钮拉起两个进程后，靠它区分谁是谁
        target: entry.target,
        sessionId: entry.sessionId,
        reason: entry.reason,
        startedAt: entry.startedAt,
        ageMs: Math.max(0, now() - entry.startedAt),
      });
    }
    return out;
  }

  /** 找一个存活的窗口（取最早启动的那个，行为稳定可预期）。 */
  function findAlive(target = undefined) {
    let oldest;
    for (const entry of windows.values()) {
      // 指定目标时只在该目标里找——否则存活的悬浮条会挡住拉起小窗
      if (target !== undefined && entry.target !== target) continue;
      if (oldest === undefined || entry.startedAt < oldest.startedAt) oldest = entry;
    }
    return oldest;
  }

  /** 当前存活窗口数。 */
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
    /** 仅测试用：按目标看 pid（验「两个目标各自复用」用） */
    pidsOf: (target) => [...windows.values()].filter((w) => w.target === target).map((w) => w.pid),
  };
}
