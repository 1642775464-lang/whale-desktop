/**
 * 窗口唤起：点鲸鱼时已存在的窗口要被拿到面前
 *
 * 职责：钉住「复用不等于唤起」这条行为——桥知道窗口在哪，还必须把它抬出来。
 * 所属层：测试（tests/unit）
 *
 * 真实事故（用户报「已重启，但是点击无法唤起」）：
 *   现象看着像「点了没反应」，实测证据是桥返回
 *   `{"ok":true,"pid":36288,"reused":true}`——**窗口认对了、也活着**，
 *   但桥的复用分支只回一个 reused:true 就结束了，**从不把窗口显示出来**。
 *   于是两种情形下用户什么都看不到：
 *     · 悬浮条已被收成球（88×88）
 *     · 小窗被别的窗口压住
 *
 * 用户裁定：收成球时点鲸鱼 → **展开成条**（「我看不出反应的窗口等于没响应」）。
 * 两个窗口都要这个行为（鲸鱼是同时拉起它们两个的）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// ⚠️ 必须用 fileURLToPath：工作区路径含中文，
// 直接对 URL 做字符串切片会拿到 %E6%82%AC… 这种百分号编码，
// require 会报「找不到模块」，而报错完全看不出是路径编码的问题。
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const winIpc = require(join(ROOT, "whale-window", "lib", "ipc.cjs"));
const hudIpc = require(join(ROOT, "whale-hud", "lib", "ipc.cjs"));

test("小窗的动作白名单里有 summon", () => {
  assert.ok(
    winIpc.WINDOW_ACTIONS.includes("summon"),
    "小窗要能被唤起（显示 + 聚焦 + 抬到最前）",
  );
});

test("悬浮条暴露了 summon 通道（它原先没有任何窗口动作通道）", () => {
  // 悬浮条的 IPC 契约与小窗**不同**：它导出 CHANNELS（复数），
  // 且原先只有菜单，没有任何「窗口动作」通道。唤起能力必须新增，
  // 不能假设它已存在（我第一版就是这么假设的，测试当场报 undefined）。
  assert.equal(typeof hudIpc.CHANNELS, "object", "悬浮条导出的是 CHANNELS（复数）");
  assert.ok(
    typeof hudIpc.CHANNELS.SUMMON === "string" && hudIpc.CHANNELS.SUMMON !== "",
    "悬浮条要有 summon 通道，否则桥的唤起请求无处可去",
  );
});

test("两个窗口都保留原有动作/通道（不是替换）", () => {
  for (const action of ["minimize", "hide", "close", "toggle-pin"]) {
    assert.ok(winIpc.WINDOW_ACTIONS.includes(action), `小窗不该丢掉原有动作 ${action}`);
  }
  for (const ch of ["FORM", "HOVER", "HIDE", "QUIT", "RELOAD", "READY"]) {
    assert.ok(typeof hudIpc.CHANNELS[ch] === "string", `悬浮条不该丢掉原有通道 ${ch}`);
  }
});

test("小窗的 summon 处理器会调 show 与焦点（不是空转）", async () => {
  const calls = [];
  const fakeWin = {
    win: {
      isDestroyed: () => false,
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
      moveTop: () => calls.push("moveTop"),
      restore: () => calls.push("restore"),
      isMinimized: () => false,
    },
    bounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    contentSize: () => ({ width: 1, height: 1 }),
    minimize: () => calls.push("minimize"),
    hide: () => calls.push("hide"),
    focus: () => calls.push("focus"),
    show: () => calls.push("show"),
  };
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  winIpc.registerIpc({ ipcMain, win: fakeWin, log: { info: () => {}, warn: () => {}, error: () => {} } });

  const handler = handlers.get(winIpc.CHANNEL.WINDOW);
  assert.ok(handler !== undefined, "窗口动作通道必须注册");
  // ⚠️ registerIpc 的 on() 用 async 包装，调用返回 Promise —— 必须 await，
  // 否则 JSON 序列化成 {}、断言全错，而报错完全指不出原因。
  // ⚠️ 而且真实调用由 Electron 传 (event, payload)；直调必须补上 event 位，
  // 否则 {action} 被当成 event、payload 是 undefined（报 bad-action，同样指不出原因）。
  const result = await handler({}, { action: "summon" });

  assert.equal(result.ok, true, "summon 要被接受");
  assert.ok(calls.includes("show"), "必须真的显示出来（用户看不见等于没响应）");
  assert.ok(calls.includes("focus"), "必须聚焦，否则还在别的窗口后面");
});

test("悬浮条的 summon 会显示并展开成条（用户裁定）", async () => {
  const calls = [];
  const fakeHudWindow = {
    win: {
      isDestroyed: () => false,
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
      moveTop: () => calls.push("moveTop"),
    },
    show: () => calls.push("show"),
  };
  // 形态的真相源是主进程 state（渲染层经 hud:form 请求切换）
  const fakeState = {
    form: () => "ball",
    expand: () => calls.push("expand"),
    collapse: () => calls.push("collapse"),
  };
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

  hudIpc.registerIpc({
    ipcMain,
    state: fakeState,
    hudWindow: fakeHudWindow,
    app: { quit: () => {} },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const handler = handlers.get(hudIpc.CHANNELS.SUMMON);
  assert.ok(handler !== undefined, "悬浮条必须有 summon 通道处理器");

  const result = await handler({}, {});
  assert.equal(result.ok, true);
  assert.ok(calls.includes("show"), "必须显示");
  assert.ok(
    calls.includes("expand"),
    "收成球时要展开成条——用户明说「我看不出反应的窗口等于没响应」",
  );
});

/**
 * 桥侧：复用分支必须留下「唤起请求」，且取一次就消费掉。
 *
 * 为什么要有这一段：桥**没法主动推**给窗口（窗口是独立进程，
 * 只靠环境变量拿到桥端口后自己来连）。所以机制是「桥留标记、
 * 窗口用已有轮询来取」。标记必须能取走、能过期，
 * 否则窗口重启后会翻出旧请求、莫名跳出来。
 */
const { createWindowManager } = await import("../../whale-bridge/lib/windows.mjs");

/**
 * 造一个「目标窗口已存活」的窗口管理器。
 *
 * 必须先 open 一次让它真的登记一个窗口（windows(Map) 只在拉起时写入），
 * 第二次 open 才会走「已有存活 → 复用」那条分支 —— 也就是用户点第二次鲸鱼时的路径。
 */
function aliveManager() {
  let clock = 1_000_000;
  const mgr = createWindowManager({
    repoRoot: ROOT,
    log: () => {},
    // 假 spawn 返回一个带 pid 的假子进程（够登记即可）
    spawnFn: () => ({ pid: 4242, on: () => {}, unref: () => {} }),
    existsFn: () => true,
    now: () => clock,
  });
  return { mgr, tick: (ms) => { clock += ms; } };
}

/** 造一个「该目标已存活」的管理器（内部先拉起一次）。 */
function withAlive(target) {
  const h = aliveManager();
  const first = h.mgr.open({ target });
  assert.equal(first.reused, false, "第一次是拉起（前置）");
  return h;
}

test("桥的复用分支要留唤起请求（reused 不等于拿到用户面前）", () => {
  const { mgr } = withAlive("hud");
  const out = mgr.open({ target: "hud" });

  assert.equal(out.reused, true, "已有存活窗口走复用");
  assert.equal(out.summoned, true, "复用必须同时留下唤起请求——否则点了没反应");
  assert.equal(mgr.takeSummon("hud").summon, true, "窗口来取时应该拿得到");
});

test("唤起请求取一次就消费掉（不能每轮都让窗口跳出来）", () => {
  const { mgr } = withAlive("window");
  mgr.open({ target: "window" });

  assert.equal(mgr.takeSummon("window").summon, true, "第一次取到");
  assert.equal(mgr.takeSummon("window").summon, false, "取过就该没了");
});

test("唤起请求会过期（窗口没在跑时，旧标记不能一直挂着）", () => {
  const { mgr, tick } = withAlive("hud");
  mgr.open({ target: "hud" });
  tick(11_000); // 超过 10 秒 TTL
  assert.equal(mgr.takeSummon("hud").summon, false, "过期标记当没有");
});

test("唤起按目标分开：唤起悬浮条不该让小窗也跳出来", () => {
  const { mgr } = withAlive("hud");
  mgr.open({ target: "hud" });

  assert.equal(mgr.takeSummon("hud").summon, true);
  assert.equal(mgr.takeSummon("window").summon, false, "另一个目标不受影响");
});

test("没有唤起请求时安静返回 false（窗口轮询不该被误触发）", () => {
  const { mgr } = aliveManager();
  assert.equal(mgr.takeSummon("hud").summon, false);
});
