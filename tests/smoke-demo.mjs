/**
 * 冒烟演示脚本
 *
 * 职责：用假宿主 ctx 起真实桥服务，打印 4 条路由的真实响应，
 *       供人工验收与截图留痕。跑完自动退出。
 * 所属层：测试（tests/）
 *
 * 用法：node tests/smoke-demo.mjs
 */

import { createHostAccess } from "../whale-bridge/lib/host-ctx.mjs";
import { registerSliceOneRoutes } from "../whale-bridge/lib/handlers-slice1.mjs";
import { createBridgeServer, listen, close } from "../whale-bridge/lib/server.mjs";

const PORT = 19387;
const BASE = `http://127.0.0.1:${PORT}`;

/** 假宿主 ctx：两个会话、agents 与 commands 都提供。 */
function fakeCtx() {
  const sessions = new Map();
  sessions.set("session-demo-0001", {
    id: "session-demo-0001",
    header: {
      id: "session-demo-0001",
      cwd: "D:\\DEEPSEEK\\悬浮窗",
      createdAt: 1791221001152,
      title: "从PRD与原型重新实施项目",
    },
  });
  sessions.set("session-demo-0002", {
    id: "session-demo-0002",
    header: { id: "session-demo-0002", cwd: "D:\\DEEPSEEK\\悬浮窗", createdAt: 1791221009999 },
  });

  return {
    sessions: { list: () => [...sessions.values()], get: (id) => sessions.get(id) },
    agents: { get: () => ({ status: "idle" }) },
    commands: { list: () => [{ name: "permission", description: "切换权限档位" }] },
    logger: { info: () => {} },
  };
}

async function show(label, path, method = "GET", body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  console.log(`\n${"─".repeat(70)}`);
  console.log(`${method} ${path}   →   HTTP ${res.status}`);
  console.log("─".repeat(70));
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

registerSliceOneRoutes();

const host = createHostAccess(fakeCtx());
const server = createBridgeServer({ host, log: (m) => console.log(m) });
await listen(server, { port: PORT, host: "127.0.0.1" });

console.log(`\n桥已启动：${BASE}/whale`);
console.log(`宿主服务探测：${JSON.stringify(host.available)}`);

await show("概览", "/whale");
await show("运行时探测", "/whale/probe");
await show("能力探测", "/whale/capability");
await show("面板（有效会话）", "/whale/panel?sessionId=session-demo-0001");
await show("面板（缺参数）", "/whale/panel");
await show("面板（未知会话）", "/whale/panel?sessionId=nope");
await show("未知路由", "/whale/nope");

await close(server);
console.log(`\n${"─".repeat(70)}`);
console.log("桥已关闭，端口释放。");
