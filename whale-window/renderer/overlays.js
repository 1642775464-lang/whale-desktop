/*
 * 输入区浮层：权限档位 / 模型与思考强度 / 上下文用量 / ＋上传
 *
 * 职责：四个按钮共用一个浮层容器，各自渲染自己的内容；
 *       并管理待上传清单（文件选择器、**拖拽**、**粘贴**三种入口）。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：这四个浮层共享「打开谁就关掉别的」的互斥逻辑、
 * 同一套「左名右描述」的行渲染，以及上传清单的状态机。
 * 混进 app.js 会把装配层顶破行数上限，也容易改一个浮层碰坏另一个。
 *
 * 数据来源（切片 7 第二批的桥侧）：
 *   GET /whale/presets → 权限档位清单（含 auto，不硬编码）
 *   GET /whale/models  → provider 分组目录 + 各模型推理档位
 *   POST /whale/upload/file|images → base64 交给宿主 attachments
 *
 * 纪律：档位与模型**以宿主为准**，取不到就如实显示，
 *       **不编造档位、不硬编码模型名**（错的列表比没有更糟）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleOverlays。
 */

(function attachOverlays(global) {
  "use strict";

  /** 权限档位的中文文案（显示用；选择值仍用宿主的英文名）。 */
  const PRESET_LABEL = {
    "read-only": "仅可查看",
    "workspace-write": "工作区内修改",
    "danger-full-access": "完全权限",
    auto: "自动",
    custom: "自定义",
  };

  /**
   * 建浮层控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {overlay, ovTitle, ovBody, ovClose, uplList}
   * @param {() => object} deps.getClient WhaleBridge 客户端（取状态与发请求）
   * @param {(msg: string) => void} [deps.onNotify] 需要如实提示时回调
   * @returns {object} 控制器
   */
  function createOverlays(deps) {
    const dom = deps.dom;
    /**
     * 取当前的桥客户端。
     *
     * ⚠️ `deps.getClient` 是**取值函数**，不是客户端本身。
     * 真实踩过：曾经把取值函数直接存成一个变量就当成客户端用了，
     * 于是 `deps.getClient().modelCatalog()` 被写成对函数取属性，
     * 报 "client.modelCatalog is not a function"——函数也是对象，
     * 所以报「不是函数」而不是「undefined」，看着像 client 缺方法，
     * 其实 client 本身就是那个函数。极具迷惑性。
     * 每次调用现取，顺带保证拿到最新引用。
     *
     * 契约测试（window-renderer）会检查这里：漏一处就是那个浮层点不动。
     *
     * @returns {object} 桥客户端
     */
    function clientOf() {
      return deps.getClient();
    }
    const onNotify = typeof deps.onNotify === "function" ? deps.onNotify : function () {};

    /** 当前打开的浮层名：null = 全关。 */
    let current = null;
    /** 待上传清单：{name, dataBase64, mediaType?, kind: "file"|"image"}。 */
    let pending = [];

    /** 打开指定浮层（互斥：先关掉其它的）。 */
    function open(name) {
      current = name;
      dom.overlay.hidden = false;
    }

    /** 关闭浮层。 */
    function close() {
      current = null;
      dom.overlay.hidden = true;
      dom.ovBody.innerHTML = "";
    }

    /** 切换：同一个键再点一次就是关。 */
    function toggle(name) {
      if (current === name) { close(); return; }
      open(name);
    }

    /** 渲染一行「左名右说明」。 */
    function row(label, desc, value, opts) {
      const o = opts ?? {};
      const el = global.document.createElement("div");
      el.className = o.className ?? "ov-row";
      const n = global.document.createElement("span");
      n.textContent = label;
      el.appendChild(n);
      if (desc) {
        const d = global.document.createElement("span");
        d.className = "v";
        d.textContent = desc;
        el.appendChild(d);
      } else if (value) {
        const v = global.document.createElement("span");
        v.className = "v";
        v.textContent = value;
        el.appendChild(v);
      }
      if (typeof o.onClick === "function") {
        el.addEventListener("click", o.onClick);
      }
      return el;
    }

    /** 渲染「空态/说明」行（灰，不可点）。 */
    function note(text) {
      const el = global.document.createElement("div");
      el.className = "ov-empty";
      el.textContent = text;
      return el;
    }

    // ── 权限档位 ──────────────────────────────────────

    /** 权限浮层：列宿主的全部档位，点击切换。 */
    function renderPermission() {
      dom.ovTitle.textContent = "权限档位";
      dom.ovBody.innerHTML = "";
      dom.ovBody.appendChild(note("读取中…"));

      clientOf().permissionPresets().then(function (info) {
        if (current !== "permission") return; // 用户已切到别的浮层
        dom.ovBody.innerHTML = "";
        if (info === null || !Array.isArray(info.options) || info.options.length === 0) {
          dom.ovBody.appendChild(note("读不到档位清单（宿主未提供）"));
          return;
        }
        info.options.forEach(function (name) {
          const label = PRESET_LABEL[name] ?? name;
          const isCurrent = name === info.current;
          dom.ovBody.appendChild(row(
            label,
            isCurrent ? "当前" : "",
            null,
            {
              className: `ov-row${  isCurrent ? " on" : ""}`,
              onClick () {
                if (isCurrent) { close(); return; }
                clientOf().command(`/permission ${  name}`).then(function (out) {
                  if (out.ok) {
                    // 切成功后**立刻重读宿主的档位**，让输入框那个标签即时更新。
                    // 不重读的话标签要等下一次轮询才知道变了，用户会觉得「切了没反应」
                    // ——他报过的原话就是「切为完全权限，输入框还是显示工作区内修改」。
                    clientOf().permissionPresets().then(function () { close(); });
                    return;
                  }
                  onNotify(`切换权限失败：${  out.code}`);
                  global.console.warn(`切权限失败：${  out.code}`);
                });
              },
            },
          ));
        });
      });
    }

    // ── 模型与思考强度 ────────────────────────────────

    /** 模型浮层：按 provider 分组列模型；组内再列该模型的推理档位。 */
    function renderModel() {
      dom.ovTitle.textContent = "模型与思考强度";
      dom.ovBody.innerHTML = "";
      dom.ovBody.appendChild(note("读取中…"));

      clientOf().modelCatalog().then(function (catalog) {
        if (current !== "model") return;
        dom.ovBody.innerHTML = "";

        if (catalog === null || !Array.isArray(catalog.groups) || catalog.groups.length === 0) {
          dom.ovBody.appendChild(note(catalog === null
            ? "读不到模型目录（宿主未提供）"
            : "模型目录为空（没有可用的 provider）"));
          return;
        }

        const def = catalog.default ?? {};

        catalog.groups.forEach(function (group) {
          const head = global.document.createElement("div");
          head.className = "ov-group";
          head.textContent = group.name ?? group.id;
          dom.ovBody.appendChild(head);

          (group.models ?? []).forEach(function (model) {
            const isDef = def.provider === group.id && def.model === model.id;
            let effortText = "";
            if (model.reasoning && Array.isArray(model.reasoning.efforts)) {
              effortText = model.reasoning.efforts.map(function (e) { return e.name ?? e.id; }).join("/");
            }
            dom.ovBody.appendChild(row(
              model.name ?? model.id,
              isDef ? "当前" : "",
              effortText,
              {
                className: `ov-row${  isDef ? " on" : ""}`,
                onClick () {
                  switchToEffort(group, model, def);
                },
              },
            ));
          });
        });

        (catalog.failures ?? []).forEach(function (f) {
          dom.ovBody.appendChild(row(f.name ?? f.id, "读取失败", null, { className: "ov-row grey" }));
        });
      });
    }

    /**
     * 选了某个模型后展开它的推理档位（第二次点击同模型 → 切 effort）。
     *
     * 交互对齐宿主：先选模型，再在模型下选 effort；
     * effort 可选值取决于模型，取不到就直接切（由宿主补默认值）。
     */
    function switchToEffort(group, model, def) {
      const provider = group.id;
      const modelId = model.id;
      const efforts = model.reasoning && Array.isArray(model.reasoning.efforts)
        ? model.reasoning.efforts
        : [];

      // 无可选档位：直接切模型，让宿主补默认 effort
      if (efforts.length === 0) {
        clientOf().setModel({ provider, model: modelId }).then(function (out) {
          if (out.ok) { close(); return; }
          onNotify(`切换模型失败：${  out.code}`);
          global.console.warn(`切模型失败：${  out.code}`);
        });
        return;
      }

      dom.ovTitle.textContent = `${model.name ?? modelId  } · 思考强度`;
      dom.ovBody.innerHTML = "";

      const back = row("‹ 返回模型列表", "", null, {
        onClick () { renderModel(); },
      });
      dom.ovBody.appendChild(back);

      efforts.forEach(function (e) {
        const isDef = def.provider === provider && def.model === modelId
          && (def.reasoningEffort ?? model.reasoning?.defaultEffort) === e.id;
        dom.ovBody.appendChild(row(
          e.name ?? e.id,
          e.description ?? "",
          isDef ? "当前" : "",
          {
            className: `ov-row${  isDef ? " on" : ""}`,
            onClick () {
              clientOf().setModel({ provider, model: modelId, reasoningEffort: e.id })
                .then(function (out) {
                  if (out.ok) { close(); return; }
                  onNotify(`切换失败：${  out.code}`);
                  global.console.warn(`切模型失败：${  out.code}`);
                });
            },
          },
        ));
      });
    }

    // ── 上下文用量 ────────────────────────────────────

    /** 用量浮层：五行走 kv（数据取自客户端状态，无新请求）。 */
    function renderUsage() {
      dom.ovTitle.textContent = "用量";
      dom.ovBody.innerHTML = "";
      const state = clientOf().getState();

      const kv = global.document.createElement("div");
      kv.className = "usage-kv";
      const rows = [
        ["上下文占用", state.contextUsed !== null && state.contextUsed !== undefined ? String(state.contextUsed) : "–"],
        ["累计输出", state.usageTotals && state.usageTotals.output !== null && state.usageTotals.output !== undefined ? String(state.usageTotals.output) : "–"],
        ["累计输入", state.usageTotals && state.usageTotals.input !== null && state.usageTotals.input !== undefined ? String(state.usageTotals.input) : "–"],
        ["累计缓存读", state.usageTotals && state.usageTotals.cacheRead !== null && state.usageTotals.cacheRead !== undefined ? String(state.usageTotals.cacheRead) : "–"],
        ["步数 / 回合", `${state.steps ?? "–"  } / ${  state.turns ?? "–"}`],
      ];
      rows.forEach(function (pair) {
        const k = global.document.createElement("span");
        k.className = "k";
        k.textContent = pair[0];
        const v = global.document.createElement("span");
        v.className = "v";
        v.textContent = pair[1];
        kv.appendChild(k);
        kv.appendChild(v);
      });
      dom.ovBody.appendChild(kv);
    }

    // ── 待上传清单 ────────────────────────────────────

    /** 渲染待上传清单。 */
    function renderPending() {
      dom.uplList.innerHTML = "";
      if (pending.length === 0) {
        dom.uplList.hidden = true;
        return;
      }
      dom.uplList.hidden = false;
      pending.forEach(function (item, index) {
        const el = global.document.createElement("div");
        el.className = "upl-item";
        const n = global.document.createElement("span");
        n.className = "n";
        n.textContent = `${item.name  }（${  Math.max(1, Math.round(item.size / 1024))  } KB）`;
        const rm = global.document.createElement("button");
        rm.className = "rm";
        rm.textContent = "×";
        rm.setAttribute("aria-label", `移除 ${  item.name}`);
        rm.addEventListener("click", function () {
          pending.splice(index, 1);
          renderPending();
        });
        el.appendChild(n);
        el.appendChild(rm);
        dom.uplList.appendChild(el);
      });
    }

    /**
     * 把用户挑的文件读成 base64 并加入待上传清单。
     *
     * 图片走 /whale/upload/images，其余走 /whale/upload/file
     * —— 与宿主 admission 的两条入口一一对应。
     *
     * @param {Array<File>} files
     */
    function addFiles(files) {
      files.forEach(function (file) {
        const reader = new global.FileReader();
        reader.onload = function () {
          // FileReader.result 是 data URL（data:xxx;base64,....），取逗号后的部分
          const dataUrl = String(reader.result ?? "");
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          pending.push({
            name: file.name,
            size: file.size,
            dataBase64: base64,
            mediaType: file.type ?? undefined,
            kind: file.type && file.type.startsWith("image/") ? "image" : "file",
          });
          renderPending();
        };
        reader.onerror = function () {
          onNotify(`读文件失败：${  file.name}`);
        };
        reader.readAsDataURL(file);
      });
    }

    /**
     * 把待上传清单真正发给宿主，返回可用于消息内容的引用块。
     *
     * 上传失败**不静默**：onNotify 如实报错，失败的文件不进消息。
     *
     * @returns {Promise<Array<{type:string, attachment?:object}>>}
     */
    function flushUploads() {
      if (pending.length === 0) return Promise.resolve([]);
      const images = pending.filter(function (p) { return p.kind === "image"; });
      const files = pending.filter(function (p) { return p.kind !== "image"; });
      const calls = [];
      if (files.length > 0) {
        calls.push(clientOf().uploadFiles(files.map(function (f) {
          return { name: f.name, dataBase64: f.dataBase64 };
        })).then(function (out) {
          if (!out.ok) { onNotify(`上传失败：${  out.code}`); return []; }
          return out.references ?? [];
        }));
      }
      if (images.length > 0) {
        calls.push(clientOf().uploadImages(images.map(function (f) {
          return { name: f.name, dataBase64: f.dataBase64, mediaType: f.mediaType };
        })).then(function (out) {
          if (!out.ok) { onNotify(`图片上传失败：${  out.code}`); return []; }
          return out.references ?? [];
        }));
      }
      return Promise.all(calls).then(function (groups) {
        const refs = groups.flat();
        if (refs.length > 0) {
          pending = [];
          renderPending();
        }
        return refs.map(function (r) { return { type: "file", attachment: r }; });
      });
    }

    /** 待上传清单是否非空（发送前判断用）。 */
    function hasPending() {
      return pending.length > 0;
    }

    /**
     * ＋ 菜单与文件搜索交给 add-menu.js（按业务域拆出去，500 行上限）。
     *
     * 这里保留同名入口，调用方（app.js 的浮层接线）不用改：
     * 装配时通过 `deps.getAddMenu()` 延迟取（两者互相依赖）。
     */
    function renderAdd() {
      const menu = typeof deps.getAddMenu === "function" ? deps.getAddMenu() : undefined;
      if (menu === undefined) {
        dom.ovTitle.textContent = "添加";
        dom.ovBody.innerHTML = "";
        dom.ovBody.appendChild(note("＋菜单未装配"));
        return Promise.resolve();
      }
      return menu.renderAdd();
    }

    function renderFileSearch(query) {
      const menu = typeof deps.getAddMenu === "function" ? deps.getAddMenu() : undefined;
      if (menu === undefined) return Promise.resolve();
      return menu.renderFileSearch(query);
    }

    return {
      addFiles,
      close,
      /** 当前打开的浮层名（add-menu 用来判断「用户是否切走了」）。 */
      current () { return current; },
      flushUploads,
      hasPending,
      isOpen () { return current !== null; },
      pendingCount () { return pending.length; },
      renderAdd,
      renderFileSearch,
      renderModel,
      renderPending,
      renderPermission,
      renderUsage,
      /** 把共享的两栏行 / 空态行借给 add-menu（同一套渲染，视觉才一致）。 */
      sharedNote: note,
      sharedRow: row,
      toggle,
    };
  }

  global.WhaleOverlays = {
    PRESET_LABEL,
    createOverlays,
  };
})(typeof window !== "undefined" ? window : globalThis);
