/**
 * 输入区浮层的行为测试
 *
 * 职责：真的把 overlays.js 跑起来，喂假客户端，断言界面上渲染了什么、
 *       点击之后调了什么。所属层：测试（tests/unit）
 *
 * ## 为什么必须补这一层
 *
 * `overlays.js` 是小窗里最大的文件（473 行），装着权限 / 模型 / 用量 /
 * 上传四个浮层。而它原先**只被源码扫描型测试引用** —— 那种测试只能证明
 * 「文件里出现过某个字符串」。
 *
 * 用户报过的问题有一大半出在这里：
 *   ·「权限切换，切换为完全权限，但是输入框还是显示工作区内修改」
 *   ·「点了没反应」
 * 全是「源码测试全绿、界面不对」。
 *
 * 对比 `render.js` 与 `rich-input.js`：它们有真行为测试，
 * 同类问题都是最早被发现的。**差距不在代码质量，在有没有真跑起来验。**
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadOverlays,
  rowsOf,
  groupsOf,
  notesOf,
  labelOf,
  descOf,
  findRow,
} from "../helpers/overlays-double.mjs";

/** 造一个假客户端，记录被调用的方法。 */
function fakeClient(overrides = {}) {
  const calls = { command: [], presets: 0, setModel: [] };
  const client = {
    calls,
    permissionPresets: () => {
      calls.presets += 1;
      return Promise.resolve({
        options: ["read-only", "workspace-write", "danger-full-access"],
        current: "workspace-write",
      });
    },
    command: (line) => {
      calls.command.push(line);
      return Promise.resolve({ ok: true });
    },
    modelCatalog: () => Promise.resolve({ groups: [], default: null, failures: [] }),
    setModel: (sel) => {
      calls.setModel.push(sel);
      return Promise.resolve({ ok: true });
    },
    uploadFiles: () => Promise.resolve({ ok: true, references: [] }),
    uploadImages: () => Promise.resolve({ ok: true, references: [] }),
    ...overrides,
  };
  return client;
}

/** 等微任务队列排空（产品的渲染在 .then 里做）。 */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * 打开某个浮层并等它渲染完。
 *
 * ⚠️ 两步都不能少：
 *   1. 先 `toggle(name)` —— 产品的异步渲染开头有
 *      `if (current !== "permission") return`，current 还是 null 时会静默
 *      早退（所以直接调 render 会得到「什么都没渲染」的假象，容易误判成
 *      产品坏了）；
 *   2. 再调对应的 `render…()` —— `toggle` 只负责设 current 与显示容器，
 *      **不负责渲染内容**（渲染是由 app.js 的按钮处理各自调用的）。
 */
async function openOverlay(overlays, name, render) {
  overlays.toggle(name);
  render();
  await settle();
}

// ─────────────────────────────────────────────────────────────
// 一、权限浮层
// ─────────────────────────────────────────────────────────────

test("权限浮层列出宿主给的全部档位，并显示中文文案", async () => {
  const { dom, overlays } = loadOverlays({ client: fakeClient() });

  await openOverlay(overlays, "permission", overlays.renderPermission);

  assert.deepEqual(
    rowsOf(dom).map(labelOf),
    ["仅可查看", "工作区内修改", "完全权限"],
    "档位来自宿主，文案按 PRESET_LABEL 显示中文",
  );
});

test("当前档位被标出来（右侧写「当前」且有 on 类）", async () => {
  const { dom, overlays } = loadOverlays({ client: fakeClient() });

  await openOverlay(overlays, "permission", overlays.renderPermission);

  const current = rowsOf(dom).filter((r) => descOf(r) === "当前");
  assert.equal(current.length, 1, "只该有一个当前档");
  assert.equal(labelOf(current[0]), "工作区内修改");
  assert.match(String(current[0].className), /on/, "当前档要有 on 类（高亮）");
});

test("点非当前档位：发出切换命令，并**重读**档位", async () => {
  /*
   * 用户原话：「权限切换，切换为完全权限，但是输入框还是显示工作区内修改」。
   *
   * 根因两层：标签读的是写死的常量（已修），以及**切完不重读** ——
   * 不重读的话标签要等下一次轮询才知道变了，用户会觉得「切了没反应」。
   * 所以两件事都要断言：命令发出去 + 重读发生了。
   */
  const client = fakeClient();
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "permission", overlays.renderPermission);
  const presetsBefore = client.calls.presets;

  findRow(dom, "完全权限").click();
  await settle();

  assert.deepEqual(client.calls.command, ["/permission danger-full-access"],
    "应当执行切换命令，参数用宿主的英文档位名");
  assert.ok(client.calls.presets > presetsBefore,
    "切完必须重读档位 —— 否则输入框那个标签要等下一次轮询才更新（用户报的就是这个）");
});

test("点当前档位：不重复切换，只关闭浮层", async () => {
  const client = fakeClient();
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "permission", overlays.renderPermission);

  findRow(dom, "工作区内修改").click();
  await settle();

  assert.deepEqual(client.calls.command, [], "点当前档不该再发一次命令");
  assert.equal(dom.overlay.hidden, true, "应当关掉浮层");
});

test("读不到档位时如实说明，不编造", async () => {
  const client = fakeClient({ permissionPresets: () => Promise.resolve(null) });
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "permission", overlays.renderPermission);

  assert.equal(rowsOf(dom).length, 0, "没有档位就不该有行");
  assert.equal(notesOf(dom).length, 1, "要给一个空态说明");
  assert.match(notesOf(dom)[0].textContent, /读不到|未提供/, "如实说读不到，不编造");
});

test("档位清单为空数组时同样如实说明", async () => {
  const client = fakeClient({
    permissionPresets: () => Promise.resolve({ options: [], current: null }),
  });
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "permission", overlays.renderPermission);

  assert.equal(notesOf(dom).length, 1, "空清单也要有说明");
});

test("切换失败时如实提示，不假装成功", async () => {
  const client = fakeClient({
    command: () => Promise.resolve({ ok: false, code: "bad-request" }),
  });
  const { dom, overlays, notifyCalls } = loadOverlays({ client });

  await openOverlay(overlays, "permission", overlays.renderPermission);

  findRow(dom, "完全权限").click();
  await settle();

  assert.equal(notifyCalls.length, 1, "失败要提示用户");
  assert.match(notifyCalls[0], /失败/, "提示里要说明是失败");
  assert.match(notifyCalls[0], /bad-request/, "带上错误码，便于排查");
});

test("切到别的浮层后，迟到的档位结果不再渲染（防止串画面）", async () => {
  /*
   * 权限数据是异步来的。用户在等待期间点了别的按钮时，
   * 迟到的结果不能把当前浮层的内容覆盖掉 —— 否则「打开模型浮层，
   * 却看到权限档位」。
   */
  let release;
  const client = fakeClient({
    permissionPresets: () => new Promise((r) => { release = r; }),
  });
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "permission", overlays.renderPermission);

  overlays.toggle("model");        // 用户切走了
  release({ options: ["read-only"], current: "read-only" });
  await settle();

  assert.equal(
    rowsOf(dom).filter((r) => labelOf(r) === "仅可查看").length,
    0,
    "已经切走了，迟到的权限结果不该渲染出来",
  );
});

// ─────────────────────────────────────────────────────────────
// 二、浮层互斥与开关
// ─────────────────────────────────────────────────────────────

test("打开一个浮层会关掉别的（同一容器）", async () => {
  const { dom, overlays } = loadOverlays({ client: fakeClient() });

  overlays.toggle("permission");
  await settle();
  assert.equal(dom.overlay.hidden, false);
  assert.equal(overlays.current(), "permission");

  overlays.toggle("model");
  await settle();
  assert.equal(overlays.current(), "model", "应当切到模型浮层");
  assert.equal(dom.overlay.hidden, false, "仍处于打开状态");
});

test("再点同一个键就是关闭（toggle 语义）", async () => {
  const { dom, overlays } = loadOverlays({ client: fakeClient() });

  overlays.toggle("permission");
  await settle();
  assert.equal(overlays.isOpen(), true);

  overlays.toggle("permission");
  await settle();
  assert.equal(overlays.isOpen(), false, "同一个键再点一次应当关闭");
  assert.equal(dom.overlay.hidden, true);
});

test("关闭时清掉内容，不留残影", async () => {
  const { dom, overlays } = loadOverlays({ client: fakeClient() });

  await openOverlay(overlays, "permission", overlays.renderPermission);
  assert.ok(rowsOf(dom).length > 0, "先确认有内容");

  overlays.close();
  assert.equal(dom.ovBody.children.length, 0, "关闭后不该还留着上次的行");
});

// ─────────────────────────────────────────────────────────────
// 三、模型浮层
// ─────────────────────────────────────────────────────────────

test("模型浮层按 provider 分组列出模型", async () => {
  const client = fakeClient({
    modelCatalog: () => Promise.resolve({
      groups: [
        { id: "p1", name: "厂商一", models: [{ id: "m1", name: "模型一" }] },
        { id: "p2", name: "厂商二", models: [{ id: "m2", name: "模型二" }] },
      ],
      default: null,
      failures: [],
    }),
  });
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "model", overlays.renderModel);

  /*
   * ⚠️ 厂商是**分组标题**（`ov-group`），不是选项行（`ov-row`）——
   * 第一版断言用 rowsOf 找厂商，只找到「模型一 / 模型二」，
   * 于是误判成产品没渲染分组。断言要按产品的真实结构写。
   */
  assert.deepEqual(groupsOf(dom), ["厂商一", "厂商二"], "要有两个 provider 的分组标题");
  assert.deepEqual(
    rowsOf(dom).map(labelOf),
    ["模型一", "模型二"],
    "组内列该 provider 的模型",
  );
});

test("读不到模型目录时如实说明，不编造模型名", async () => {
  const client = fakeClient({
    modelCatalog: () => Promise.resolve({ groups: [], default: null, failures: [] }),
  });
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "model", overlays.renderModel);

  assert.equal(rowsOf(dom).length, 0, "没有模型就不该有行");
  assert.equal(notesOf(dom).length, 1, "要有空态说明");
});

test("有模型时失败的来源会列出来", async () => {
  /*
   * ⚠️ 只在**至少有一个可用 provider** 时才会渲染 failures 行 ——
   * 产品的空态判断只看 `groups`，groups 为空就直接 return 了，
   * 于是「哪个 provider 读失败」这个更有用的信息反而不显示。
   *
   * 这是一个**已知边界**，不是本次要改的行为（改它属于行为变更，
   * 需要用户确认）。这里先按真实行为断言并注明，避免以后误以为已覆盖。
   */
  const client = fakeClient({
    modelCatalog: () => Promise.resolve({
      groups: [{ id: "p1", name: "好厂商", models: [{ id: "m1", name: "模型一" }] }],
      default: null,
      failures: [{ id: "p9", name: "坏掉的厂商" }],
    }),
  });
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "model", overlays.renderModel);

  const texts = rowsOf(dom).map(labelOf);
  assert.ok(
    texts.some((t) => t.includes("坏掉的厂商")),
    `失败的来源要显示出来（实际 ${texts.join(" / ")}）`,
  );
  // 失败行是灰的（不可点）
  const failed = rowsOf(dom).find((r) => labelOf(r).includes("坏掉的厂商"));
  assert.match(String(failed.className), /grey/, "失败行要标灰，不假装能用");
});

test("选没有推理档位的模型：直接切模型", async () => {
  const client = fakeClient({
    modelCatalog: () => Promise.resolve({
      groups: [{ id: "p1", name: "厂商", models: [{ id: "m1", name: "模型" }] }],
      default: { provider: "p1", model: "m1" },
      failures: [],
    }),
  });
  const { dom, overlays } = loadOverlays({ client });

  await openOverlay(overlays, "model", overlays.renderModel);

  findRow(dom, "模型").click();
  await settle();

  assert.equal(client.calls.setModel.length, 1, "应当切一次模型");
  /*
   * ⚠️ 断言关键字段而不是全等 —— 产品会带上 `reasoningEffort` 之类的
   * 附加字段（这里是 `reasoningEffort: undefined`）。写全等会在产品
   * 新增一个可选参数时无辜爆红，而那条红与本次要守的行为无关。
   */
  const sel = client.calls.setModel[0];
  assert.equal(sel.provider, "p1", "要带上 provider");
  assert.equal(sel.model, "m1", "要带上 model");
  assert.equal(
    sel.reasoningEffort ?? null,
    null,
    "没有推理档位时不该硬塞一个 effort（让宿主补默认）",
  );
});
