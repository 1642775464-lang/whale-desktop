/**
 * 切片 7 端到端冒烟：模型目录、模型切换、权限档位
 *
 * 职责：验证桥接上宿主的 `sessionController` 与 `permissionPresets`
 *       之后，模型目录与档位清单真的能读出来、切换真的能落到宿主。
 * 所属层：测试（tests/）
 *
 * 为什么从 smoke-slice3 拆出来：
 *   一是**单一职责**——那一片测的是 SSE 与路由接线，与模型目录无关；
 *   二是文件涨到 587 行超了规范上限（强制 14），该拆就得拆，不放宽限制。
 *
 * 与 smoke-slice3 的关系：那边用**没提供**这两个服务的假 ctx，
 * 只覆盖降级分支；这里显式提供，覆盖真路径。两组都在才完整。
 *
 * ⚠️ 端口：本文件两个 test 各用各的端口。`apply()` 起的是模块级单例服务，
 * 顶层 test 并发跑，共用端口会互相掐断（STATUS 环境坑 18/19）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, dispose } from "../whale-bridge/host.js";
import { createFakeCtx, createHttpTools, sessionRef } from "./helpers/slice3-fixtures.mjs";
/**
 * 模型目录 / 权限档位：宿主**提供了**这两个可选服务时的真路径。
 *
 * 上面那一组用假 ctx（没提供 service），只测到降级分支；
 * 这一组显式提供 sessionController 与 permissionPresets，测真路径。
 * 两组都要在——只测降级会漏掉「拿到了却解析错」，只测真路径会漏掉降级。
 *
 * ⚠️ **必须用自己的端口**：`apply()` 起的是模块级单例服务，
 * 同一文件的多个顶层 test 是并发跑的——与主块共用 PORT 会互相掐断
 * （表现为随机的 ECONNRESET / 端口占用，见 STATUS 环境坑 18/19）。
 */
const SLICE7_PORT = 19393;
const slice7Http = createHttpTools(SLICE7_PORT);

test("切片 7：模型目录与权限档位走宿主服务", async (t) => {
  const SELECTED = { provider: "workbuddy-ai", model: "glm-5.3-flash", reasoningEffort: "high" };
  const CATALOG = {
    default: { provider: "workbuddy-ai", model: "glm-5.3-flash" },
    routableProviders: ["workbuddy-ai"],
    groups: [
      {
        id: "workbuddy-ai",
        name: "WorkBuddy AI",
        models: [
          {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            reasoning: { efforts: [{ id: "high", name: "高" }], defaultEffort: "high" },
          },
        ],
      },
    ],
    failures: [],
  };

  const selections = [];
  const ctx = createFakeCtx({
    services: {
      sessionController: {
        modelCatalog: async () => CATALOG,
        selectModel: async (request) => {
          selections.push(request);
          return { selected: SELECTED };
        },
      },
      permissionPresets: {
        get names() {
          return ["read-only", "workspace-write", "danger-full-access", "auto"];
        },
        current: () => "workspace-write",
      },
    },
  });

  await apply(ctx, { port: SLICE7_PORT });

  try {
    await t.test("GET /whale/models：给宿主的真目录（含各模型的推理档位）", async () => {
      const { status, json } = await slice7Http.getJson("/whale/models");
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.groups), "应给出 provider 分组的目录");
      assert.equal(json.groups.length, 1);
      assert.equal(json.groups[0].id, "workbuddy-ai");
      assert.equal(json.groups[0].models[0].id, "glm-5.3-flash");
      assert.deepEqual(
        json.groups[0].models[0].reasoning.efforts.map((e) => e.id),
        ["high"],
        "推理档位必须带出来——小窗要靠它渲染 effort 选项",
      );
      assert.deepEqual(json.default, CATALOG.default, "默认选择也要给");
    });

    await t.test("GET /whale/models：兼容旧的扁平 models 字段（小窗当前读它）", async () => {
      const { json } = await slice7Http.getJson("/whale/models");
      assert.ok(Array.isArray(json.models), "扁平列表要保留，避免破坏既有客户端");
      assert.equal(json.models.length, 1);
      assert.equal(json.models[0].provider, "workbuddy-ai");
      assert.equal(json.models[0].model, "glm-5.3-flash");
    });

    await t.test("GET /whale/presets：档位清单以宿主为准（含 auto）", async () => {
      const { status, json } = await slice7Http.getJson("/whale/presets?sessionId=s-live");
      assert.equal(status, 200);
      assert.deepEqual(
        json.options,
        ["read-only", "workspace-write", "danger-full-access", "auto"],
        "必须列全 4 档——小窗原先硬编码 3 档，auto 选不到",
      );
      assert.equal(json.current, "workspace-write");
    });

    await t.test("POST /whale/model：切换交给宿主，形状对齐 SessionSelectModelRequest", async () => {
      const { status, json } = await slice7Http.postJson("/whale/model", {
        sessionId: "s-live",
        provider: "workbuddy-ai",
        model: "glm-5.3-flash",
        reasoningEffort: "high",
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.deepEqual(selections[0], {
        sessionId: "s-live",
        provider: "workbuddy-ai",
        model: "glm-5.3-flash",
        reasoningEffort: "high",
      });
    });

    await t.test("POST /whale/model：缺 provider/model → 400（不落到宿主才报错）", async () => {
      const { status, json } = await slice7Http.postJson("/whale/model", {
        sessionId: "s-live", model: "x",
      });
      assert.equal(status, 400);
      assert.equal(json.error.code, "bad-request");
    });
  } finally {
    await dispose();
  }
});

/**
 * 宿主拒绝这次模型选择时，桥要把宿主的错误码原样带出来。
 *
 * 单独一个 test 而不是上面那组里的子测试：它需要**自己的 apply**
 * （换一个 sessionController 行为），而同一端口上 dispose→apply 会有竞态
 * （刚关的 server 还没完全释放，重连会 ECONNRESET）。
 */
const SLICE7_REJECT_PORT = 19394;
const slice7RejectHttp = createHttpTools(SLICE7_REJECT_PORT);

test("切片 7：宿主拒绝模型选择时按其错误码回", async () => {
  const ctx = createFakeCtx({
    services: {
      sessionController: {
        selectModel: async () => {
          const err = new Error("model not advertised");
          err.code = "session/model-unavailable";
          throw err;
        },
      },
    },
  });

  await apply(ctx, { port: SLICE7_REJECT_PORT });
  try {
    const { status, json } = await slice7RejectHttp.postJson("/whale/model", {
      sessionId: "s-live", provider: "p", model: "m",
    });
    // 400 而不是 500：这是**调用方的输入问题**（模型不存在/该 provider
    // 不接受这个 effort），不是桥或宿主的故障。
    assert.equal(status, 400);
    assert.equal(json.error.code, "session/model-unavailable");
  } finally {
    await dispose();
  }
});

/**
 * ＋ 真上传：把 base64 文件交给宿主的 attachments 存储。
 *
 * 宿主的 wire 契约（dsh-attachment admission，"the shared entry for every
 * RPC endpoint accepting browser uploads"）：
 *   attachments.saveFile({ data: <canonical base64>, name? })  → 内容寻址引用
 *   attachments.saveImages([...])                              → 图片批量
 *
 * 为什么是 base64：宿主的 admission 层会做 canonical base64 校验
 * （decodeCanonicalBase64 拒绝非规范形式），这是它的公开口径。
 */
const SLICE7_UPLOAD_PORT = 19395;
const slice7UploadHttp = createHttpTools(SLICE7_UPLOAD_PORT);

test("切片 7：真上传——文件与图片都落进宿主的 attachments", async (t) => {
  const savedFiles = [];
  const savedImages = [];
  const ctx = createFakeCtx({
    services: {
      attachments: {
        saveFile: async (input) => {
          savedFiles.push(input);
          return { id: "file-1", name: input.name };
        },
        saveImages: async (inputs) => {
          savedImages.push(...inputs);
          return inputs.map((_, i) => ({ id: `img-${i}` }));
        },
      },
    },
  });

  await apply(ctx, { port: SLICE7_UPLOAD_PORT });

  try {
    await t.test("POST /whale/upload/file：base64 交给 saveFile，引用原样返回", async () => {
      const { status, json } = await slice7UploadHttp.postJson("/whale/upload/file", {
        name: "设计稿.pdf",
        dataBase64: "JVBERi0xLjQK",
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.deepEqual(json.reference, { id: "file-1", name: "设计稿.pdf" });
      assert.equal(savedFiles.length, 1);
      assert.equal(savedFiles[0].data, "JVBERi0xLjQK", "base64 必须原样交给宿主，不做二次编码");
      assert.equal(savedFiles[0].name, "设计稿.pdf", "显示名要带上");
    });

    await t.test("POST /whale/upload/file：缺 dataBase64 → 400", async () => {
      const { status, json } = await slice7UploadHttp.postJson("/whale/upload/file", { name: "x" });
      assert.equal(status, 400);
      assert.equal(json.error.code, "bad-request");
    });

    await t.test("POST /whale/upload/images：批量交给 saveImages，引用按序返回", async () => {
      const { status, json } = await slice7UploadHttp.postJson("/whale/upload/images", {
        images: [
          { dataBase64: "aGVsbG8=", mediaType: "image/png" },
          { dataBase64: "d29ybGQ=", mediaType: "image/jpeg" },
        ],
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.references.length, 2);
      assert.equal(json.references[0].id, "img-0");
      assert.equal(savedImages.length, 2);
      assert.equal(savedImages[0].data, "aGVsbG8=");
    });

    await t.test("POST /whale/upload/images：空批量 → 400（不空转调宿主）", async () => {
      const { status, json } = await slice7UploadHttp.postJson("/whale/upload/images", { images: [] });
      assert.equal(status, 400);
      assert.equal(json.error.code, "bad-request");
    });
  } finally {
    await dispose();
  }
});

/**
 * 宿主拒绝这次上传时，桥要把宿主的错误码原样带出来。
 *
 * 单独一个 test + 独立端口：它需要换一个会拒绝的 attachments 桩，
 * 而同一端口上 dispose→apply 有竞态（刚关的 server 未完全释放，
 * 重连会 ECONNRESET/500，把后面的兄弟用例一起拖垮——真实踩过）。
 */
const SLICE7_REFUSE_PORT = 19396;
const slice7RefuseHttp = createHttpTools(SLICE7_REFUSE_PORT);

test("切片 7：宿主拒绝上传时按其错误码回", async () => {
  const ctx = createFakeCtx({
    services: {
      attachments: {
        saveFile: async () => {
          const err = new Error("bad payload");
          err.code = "INVALID_FILE_BASE64";
          throw err;
        },
      },
    },
  });

  await apply(ctx, { port: SLICE7_REFUSE_PORT });
  try {
    const { status, json } = await slice7RefuseHttp.postJson("/whale/upload/file", {
      name: "x", dataBase64: "!!!",
    });
    // 400：AttachmentError 的稳定 code 是**调用方输入问题**（非规范 base64），
    // 不是桥或宿主的故障。
    assert.equal(status, 400);
    assert.equal(json.error.code, "INVALID_FILE_BASE64");
  } finally {
    await dispose();
  }
});

/**
 * attachments 缺失时 503。同样独立端口（理由同上）。
 */
const SLICE7_MISSING_PORT = 19397;
const slice7MissingHttp = createHttpTools(SLICE7_MISSING_PORT);

test("切片 7：attachments 缺失时 503，不假装成功", async () => {
  await apply(createFakeCtx(), { port: SLICE7_MISSING_PORT });
  try {
    const { status, json } = await slice7MissingHttp.postJson("/whale/upload/file", {
      name: "x", dataBase64: "aGk=",
    });
    assert.equal(status, 503);
    assert.equal(json.error.code, "attachments-unavailable");
  } finally {
    await dispose();
  }
});

/**
 * 冷会话种子：桥起来时一条事件都没收到，也要能把「最近一次会话」给小窗。
 *
 * 这是用户报「权限读不到档位清单、思考强度点了没反应」的真链路复现。
 * 单元测过了**不等于产品通了**（我在这上面犯过好几次）——
 * 这一组直接打 HTTP，按小窗真实会走的顺序问：
 *   /whale/hud 拿 sessionId → /whale/panel 拿消息 → 用这个 id 发命令。
 *
 * 夹具故意**不发任何 session/event**（模拟重启后空闲的会话），
 * 只给持久层（sessionController.list / inspect）。
 * 假 ctx 的 `sessions.list()` 返回 []、`sessions.get()` 认不出冷 id
 * —— 这正是宿主的真实行为（注释写明 "All **live** sessions"）。
 */
const SLICE7_SEED_PORT = 19398;
const slice7SeedHttp = createHttpTools(SLICE7_SEED_PORT);

/**
 * 持久层里那条冷会话的历史。
 * 形状逐字段对齐宿主：`{ seq, type, data, time }`，
 * user/message 取 data.content、assistant/message 取 data.message.content。
 */
const COLD_EVENTS = [
  { seq: 1, type: "session", data: { cwd: "D:\\proj" }, time: 1 },
  { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "重启前说的话" }] }, time: 2 },
  { seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "重启前的回复" }] } }, time: 3 },
  // 落盘停在 turn/start：上次进程被杀时回合没结束。折完不该点亮「回合运行中」
  { seq: 4, type: "turn/start", data: {}, time: 4 },
];

function coldOnlyCtx() {
  return createFakeCtx({
    services: {
      sessionController: {
        list: async () => ({
          items: [
            {
              sessionId: "s-cold",
              updatedAt: 900,
              cwd: "D:\\proj",
              running: false,
              projections: { values: { title: "从PRD重新实施" } },
            },
          ],
        }),
        inspect: async () => ({ meta: { id: "s-cold" }, inheritedEventCount: 0, events: COLD_EVENTS }),
      },
      permissionPresets: {
        get names() { return ["read-only", "workspace-write", "danger-full-access", "auto"]; },
        current: () => "workspace-write",
      },
    },
  });
}

test("切片 7：冷启动（无事件）时 hud 与 panel 仍能给出最近一次会话", async (t) => {
  await apply(coldOnlyCtx(), { port: SLICE7_SEED_PORT });

  try {
    await t.test("GET /whale/hud：折叠器为空也要列出持久层的会话并设活跃指针", async () => {
      const { status, json } = await slice7SeedHttp.getJson("/whale/hud");
      assert.equal(status, 200);
      // 这一条就是用户看到「没有会话的窗口」的地方：修复前 sessions 是空的
      assert.equal(json.sessions.length, 1, "冷启动时 hud 必须给出最近一次会话");
      assert.equal(json.activeSessionId, "s-cold", "不设活跃指针，小窗还是拿不到 sessionId");
      assert.equal(json.sessions[0].title, "从PRD重新实施", "冷会话没有 title 事件，标题要从投影带");
    });

    await t.test("GET /whale/panel：冷会话要回显历史消息，且不得 404", async () => {
      // 修复前这里会 404：面板先查 host.getSession()，而宿主只认活会话。
      // 「桥能从持久层读到」与「桥肯把它交给小窗」是两件事，都得测。
      const { status, json } = await slice7SeedHttp.getJson("/whale/panel?sessionId=s-cold");
      assert.equal(status, 200, `冷会话不该被当成不存在（实际 ${status}）`);
      const texts = json.messages.map((m) => m.text);
      assert.ok(texts.includes("重启前说的话"), `历史消息要能回显，实际：${JSON.stringify(texts)}`);
      assert.ok(texts.includes("重启前的回复"));
      assert.equal(json.title, "从PRD重新实施");
    });

    await t.test("冷会话落盘停在 turn/start 时不得点亮「回合运行中」", async () => {
      const { json } = await slice7SeedHttp.getJson("/whale/panel?sessionId=s-cold");
      // 上次进程被杀时回合没结束，照原样折会让小窗显示运行中、中断键点亮，
      // 而实际根本没有活的 agent 在跑。宿主的 running 字段才是事实。
      assert.equal(json.running, false);
    });

    await t.test("用 hud 给的 sessionId 读权限档位要成功（用户报的原始症状）", async () => {
      const hud = await slice7SeedHttp.getJson("/whale/hud");
      // 必须断言这个 id 是 hud **给的**——否则修复前 hud 回 null，
      // 这条测试会因为「sessionId=null」意外走通而变成假绿。
      assert.equal(hud.json.activeSessionId, "s-cold", "前置：hud 必须先给出可用 id");
      const { status, json } = await slice7SeedHttp.getJson(
        `/whale/presets?sessionId=${encodeURIComponent(hud.json.activeSessionId)}`,
      );
      assert.equal(status, 200);
      assert.equal(json.options.length, 4, "小窗靠这个 id 才读得到档位，这是原始症状之一");
      assert.ok(json.options.includes("auto"));
    });

    await t.test("用这个 sessionId 发命令不得再报 bad-request（另一个原始症状）", async () => {
      const { json } = await slice7SeedHttp.postJson("/whale/command", {
        sessionId: "s-cold", line: "/permission read-only",
      });
      // 夹具的 commands 服务只有 list（没 execute），所以可能报不可用，
      // 但**绝不能是 bad-request** —— 那意味着 sessionId 又丢了，症状就回来了。
      assert.notEqual(json.error?.code, "bad-request", `sessionId 又丢了：${JSON.stringify(json)}`);
    });

    await t.test("宿主持久层不认识的 sessionId 必须 404，不能静默给空面板", async () => {
      // ensureSeeded 若不校验清单，任意乱写的 id 也会被建出一个 fold，
      // 后果是把「会话不存在」与「会话是空的」混成一件——
      // 而这两件必须区分（本项目的降级纪律）。
      const { status, json } = await slice7SeedHttp.getJson("/whale/panel?sessionId=编的一个id");
      assert.equal(status, 404, `编造的 id 不该得到面板（实际 ${status}）`);
      assert.equal(json.error.code, "session-not-found");
    });
  } finally {
    await dispose();
  }
});

/**
 * 有实时会话时种子必须让路。
 *
 * 这是「修复不能把原本正常的路径弄坏」的反向检查：
 * 实时会话是产品原先唯一可用的形态，种子若在它面前插一脚，
 * 就会抢走活跃指针或覆盖实时消息——那是把一个 bug 换成另一个。
 *
 * ⚠️ 端口必须与上面那组不同：同文件的顶层 test 是并发跑的，
 * 共用端口会互相掐断（见 STATUS 环境坑 18/19/37）。
 */
const SLICE7_LIVE_PORT = 19399;
const slice7LiveHttp = createHttpTools(SLICE7_LIVE_PORT);

test("切片 7：有实时会话时种子不插手", async () => {
  const ctx = coldOnlyCtx();
  await apply(ctx, { port: SLICE7_LIVE_PORT });
  try {
    // 事件流先填上一条实时会话（修复前一切正常的那条路径）
    ctx.emit("session/event", sessionRef("s-live"), {
      seq: 1, time: Date.now(), type: "user/message",
      data: { content: [{ type: "text", text: "实时消息" }] },
    });

    const { json } = await slice7LiveHttp.getJson("/whale/hud");
    const ids = json.sessions.map((s) => s.sessionId);
    assert.ok(ids.includes("s-live"), `实时会话必须还在，实际：${JSON.stringify(ids)}`);
    assert.equal(json.activeSessionId, "s-live", "活跃指针不能被种子的冷会话抢走");
    assert.ok(!ids.includes("s-cold"), "折叠器非空时不该再去读持久层");

    const panel = await slice7LiveHttp.getJson("/whale/panel?sessionId=s-live");
    assert.ok(
      panel.json.messages.map((m) => m.text).includes("实时消息"),
      "实时消息不能被覆盖",
    );
  } finally {
    await dispose();
  }
});

