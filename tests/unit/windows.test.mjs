/**
 * windows 单测
 *
 * 用注入的假 spawn 驱动，把「参数对不对」与「进程能不能真起」分开验证。
 * 真实 spawn 在受限沙箱里可能被拒，所以这里**绝不真起 Electron**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  createWindowManager,
  ELECTRON_RELATIVE,
  WINDOW_ENTRY,
} from "../../whale-bridge/lib/windows.mjs";

const ROOT = "D:\\repo";

/** 造一个假子进程。 */
function fakeChild(pid = 100) {
  const listeners = new Map();
  return {
    pid,
    killed: false,
    kill() {
      this.killed = true;
      // 真实进程被 kill 后会触发 exit
      const cb = listeners.get("exit");
      if (cb) cb(0, "SIGTERM");
    },
    once(event, cb) {
      listeners.set(event, cb);
    },
    emit(event, ...args) {
      const cb = listeners.get(event);
      if (cb) cb(...args);
    },
  };
}

/** 造一个记录调用的假 spawn。 */
function recordingSpawn(pid = 100) {
  const calls = [];
  const child = fakeChild(pid);
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return child;
  };
  fn.calls = calls;
  fn.child = child;
  return fn;
}

/** 文件都存在。 */
const allExist = () => true;

test("open：参数完全符合 PRD F6 与验收要求", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  mgr.open({ sessionId: "s1", port: 19387 });

  assert.equal(spawnFn.calls.length, 1);
  const call = spawnFn.calls[0];

  assert.equal(call.cmd, path.join(ROOT, ELECTRON_RELATIVE));
  assert.equal(call.args[0], "--no-sandbox", "必须带 --no-sandbox（PRD 小窗 5.1）");
  assert.equal(call.args[1], WINDOW_ENTRY);
  assert.equal(call.opts.cwd, path.join(ROOT, "whale-window"));
});

test("open：环境里必须没有 ELECTRON_RUN_AS_NODE", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    mgr.open({ port: 19387 });
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }

  const env = spawnFn.calls[0].opts.env;
  assert.ok(
    !Object.prototype.hasOwnProperty.call(env, "ELECTRON_RUN_AS_NODE"),
    "必须真正删掉这个键，而不是设成空串",
  );
  assert.equal(env.WHALE_BRIDGE_PORT, "19387");
});

test("open：不改动宿主自己的 process.env（不污染宿主）", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  process.env.ELECTRON_RUN_AS_NODE = "1";
  try {
    mgr.open({});
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1", "宿主进程环境不能被就地改掉");
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }
});

test("open：已有存活小窗时复用，不拉新进程（C8）", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  const first = mgr.open({});
  const second = mgr.open({});

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.pid);
  assert.equal(spawnFn.calls.length, 1, "只 spawn 了一次");
  assert.equal(mgr.stats.reused, 1);
});

test("open：Electron 缺失时明确报错，不尝试 spawn", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({
    repoRoot: ROOT,
    spawnFn,
    existsFn: (p) => !p.includes("electron.exe"),
  });

  const out = mgr.open({});
  assert.equal(out.ok, false);
  assert.equal(out.code, "electron-missing");
  assert.equal(spawnFn.calls.length, 0, "提前检查失败就不该走到 spawn");
});

test("open：小窗入口缺失时明确报错", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({
    repoRoot: ROOT,
    spawnFn,
    existsFn: (p) => !p.includes("main.cjs"),
  });

  const out = mgr.open({});
  assert.equal(out.ok, false);
  assert.equal(out.code, "entry-missing");
  assert.equal(spawnFn.calls.length, 0);
});

test("open：spawn 抛错被转成可读错误，不炸调用方", () => {
  const mgr = createWindowManager({
    repoRoot: ROOT,
    existsFn: allExist,
    spawnFn: () => {
      throw new Error("EPERM: 沙箱拒绝");
    },
  });

  const out = mgr.open({});
  assert.equal(out.ok, false);
  assert.equal(out.code, "spawn-failed");
  assert.ok(out.message.includes("沙箱"));
});

test("open：spawn 没给 pid 时判失败", () => {
  const mgr = createWindowManager({
    repoRoot: ROOT,
    existsFn: allExist,
    spawnFn: () => ({ pid: undefined, once() {} }),
  });

  const out = mgr.open({});
  assert.equal(out.ok, false);
  assert.equal(out.code, "spawn-failed");
});

test("进程退出后自动摘表，不会复用死 pid", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  mgr.open({});
  assert.equal(mgr.count(), 1);

  // 模拟进程自己退出
  spawnFn.child.emit("exit", 1, null);

  assert.equal(mgr.count(), 0, "退出后应从表里摘掉");
  assert.equal(mgr.stats.exitObserved, 1);
});

test("退出后再 open 会拉新进程", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  mgr.open({});
  spawnFn.child.emit("exit", 0, null);
  const again = mgr.open({});

  assert.equal(again.reused, false, "旧进程已死，必须拉新的");
  assert.equal(spawnFn.calls.length, 2);
});

test("list：报告进程信息", () => {
  let clock = 1000;
  const spawnFn = recordingSpawn(4242);
  const mgr = createWindowManager({
    repoRoot: ROOT,
    spawnFn,
    existsFn: allExist,
    now: () => clock,
  });

  mgr.open({ sessionId: "s1", reason: "user" });
  clock = 1500;

  const list = mgr.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].pid, 4242);
  assert.equal(list[0].sessionId, "s1");
  assert.equal(list[0].reason, "user");
  assert.equal(list[0].ageMs, 500);
});

test("close：按 pid 关闭并摘表", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  const { pid } = mgr.open({});
  const out = mgr.close({ pid });

  assert.equal(out.closed, 1);
  assert.equal(mgr.count(), 0);
  assert.ok(spawnFn.child.killed, "子进程应被 kill");
});

test("close：pid 不存在时返回 0 而不是报错", () => {
  const mgr = createWindowManager({ repoRoot: ROOT, existsFn: allExist, spawnFn: recordingSpawn() });
  const out = mgr.close({ pid: 99999 });
  assert.equal(out.ok, true);
  assert.equal(out.closed, 0);
});

test("closeAll：关闭全部，供卸载时调用", () => {
  let n = 100;
  const mgr = createWindowManager({
    repoRoot: ROOT,
    existsFn: allExist,
    spawnFn: (_cmd, _args, _opts) => fakeChild((n += 1)),
  });

  mgr.open({});
  // 两次 open 会复用，所以手动把第一个摘掉再开一个，凑两个并存
  const first = mgr.pids()[0];
  mgr.close({ pid: first });
  mgr.open({});
  mgr.open({}); // 复用
  assert.equal(mgr.count(), 1);

  const out = mgr.closeAll();
  assert.equal(out.closed, 1);
  assert.equal(mgr.count(), 0);
});

test("kill 抛错时不中断整个关闭流程", () => {
  const mgr = createWindowManager({
    repoRoot: ROOT,
    existsFn: allExist,
    spawnFn: () => ({
      pid: 777,
      kill() {
        throw new Error("进程已消失");
      },
      once() {},
    }),
  });

  mgr.open({});
  assert.doesNotThrow(() => mgr.closeAll());
  assert.equal(mgr.count(), 0, "即使 kill 失败也要摘表");
});

test("不使用孤儿防护（PRD 小窗 5.6 明确移除）", () => {
  const spawnFn = recordingSpawn();
  const mgr = createWindowManager({ repoRoot: ROOT, spawnFn, existsFn: allExist });

  mgr.open({});

  const env = spawnFn.calls[0].opts.env;
  assert.equal(env.WHALE_PARENT_PID, undefined, "不得注入父进程 pid 探测");
  assert.equal(spawnFn.calls[0].opts.detached, false, "不做脱离父进程的处理");
});
