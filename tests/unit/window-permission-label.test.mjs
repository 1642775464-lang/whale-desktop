/**
 * 小窗：权限档位的真值必须来自宿主
 *
 * 职责：钉住「输入框上那个权限按钮的文案 = 宿主里的实际档位」。
 * 所属层：测试（tests/unit）
 *
 * 真实事故（用户报）：
 *   「权限切换，切换为完全权限，但是输入框还是显示工作区内修改」
 *   切换**真的生效了**，只是那个标签从来没跟真值连上过：
 *     - app.js 里是一个写死的常量 `const permission = "workspace-write"`
 *     - 桥的面板 permission 字段恒为 null（处理器从没传过 gates）
 *   于是文案永远显示「工作区内修改」，与宿主实际档位无关。
 *
 * 修法：**以宿主为准**——`/whale/presets` 的 `current` 就是权威值
 * （它由宿主 `permissionPresets.current(session)` 算出来，是唯一真相源）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RENDERER = join(ROOT, "whale-window", "renderer");

/** 在沙箱里加载小窗客户端（含它依赖的两个模块）。 */
function loadClient(fetchImpl) {
  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.location = { search: "" };
  w.fetch = fetchImpl;
  w.setTimeout = setTimeout;
  w.clearTimeout = clearTimeout;
  w.setInterval = () => 0;
  w.clearInterval = () => {};
  w.URLSearchParams = URLSearchParams;
  w.Number = Number;
  w.Object = Object;
  w.Array = Array;
  w.JSON = JSON;
  w.Promise = Promise;
  w.console = sandbox.console;
  w.EventSource = function FakeEventSource() { this.close = () => {}; };

  createContext(sandbox);
  // 沙箱必须与真实页面同一份清单（环境坑 41）：
  // client 把能力请求委托给了 bridge-capabilities.js
  for (const f of ["bridge-capabilities.js", "follow.js", "stream.js", "bridge-client.js"]) {
    runInContext(readFileSync(join(RENDERER, f), "utf8"), sandbox, { filename: f });
  }
  return sandbox.window.WhaleBridge;
}

/** 假桥：hud 给一条会话，presets 给指定档位。 */
function fakeFetch(state) {
  return (url) => {
    const u = String(url);
    if (u.includes("/whale/hud")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        bridge: { version: "t" },
        sessions: [{ sessionId: "s1", title: "甲" }],
        activeSessionId: "s1",
      }) });
    }
    if (u.includes("/whale/presets")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        ok: true, options: ["read-only", "workspace-write", "danger-full-access", "auto"],
        current: state.current,
      }) });
    }
    if (u.includes("/whale/panel")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        sessionId: "s1", title: "甲", messages: [], todos: [],
        running: false, agentRunning: false,
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
}

test("permissionPresets 把宿主的当前档位读进 state（文案的真值）", async () => {
  const bridge = loadClient(fakeFetch({ current: "danger-full-access" }));
  const client = bridge.createClient({ port: 19387 });

  await client.refresh(); // 先拿到 sessionId（presets 需要它）
  const info = await client.permissionPresets();

  assert.equal(info.current, "danger-full-access", "宿主说当前是完全权限");
  assert.equal(
    client.getState().permission,
    "danger-full-access",
    "state.permission 必须跟着宿主走——输入框那个标签就是读它",
  );
});

test("档位在宿主里被改动后，下一次读要反映新值（不能缓存第一次的）", async () => {
  const state = { current: "workspace-write" };
  const bridge = loadClient(fakeFetch(state));
  const client = bridge.createClient({ port: 19387 });

  await client.refresh();
  await client.permissionPresets();
  assert.equal(client.getState().permission, "workspace-write");

  // 用户在浮层里切成了完全权限（浮层走 /whale/command 发 /permission 命令）
  state.current = "danger-full-access";
  await client.permissionPresets();

  assert.equal(
    client.getState().permission,
    "danger-full-access",
    "切完必须更新——否则输入框一直显示旧档位（用户报的就是这个）",
  );
});

test("宿主没给当前档位时：清单照给，但不瞎猜当前值", async () => {
  // 要区分两件事：
  //   「整块读不到」（服务不可用 → 返回 null，调用方提示读不到）
  //   「清单读到了、只是当前值给不出」（→ 照给清单，current 为 null）
  // 后者不该整块报「读不到档位清单」——那会让用户以为档位功能坏了。
  const state = { current: "read-only" };
  const bridge = loadClient(fakeFetch(state));
  const client = bridge.createClient({ port: 19387 });

  await client.refresh();
  await client.permissionPresets();
  assert.equal(client.getState().permission, "read-only");

  state.current = null;
  const info = await client.permissionPresets();

  assert.ok(info !== null, "清单读到了就该给出来，不该整块判为读不到");
  assert.equal(info.options.length, 4, "四个档位照给");
  assert.equal(info.current, null, "当前值给不出就如实 null，不编造");
  assert.equal(
    client.getState().permission,
    "read-only",
    "当前值读不到时保留上一次的显示，不能退回写死的默认档位",
  );
});
