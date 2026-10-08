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
import { createFakeCtx, createHttpTools } from "./helpers/slice3-fixtures.mjs";

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

