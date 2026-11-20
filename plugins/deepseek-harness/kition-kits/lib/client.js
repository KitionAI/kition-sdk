// @kition/dsh-kits: the Kition kits in DeepSeek Harness, the browser module. Built by build-client.mjs
// from src/client/; do not edit.
window.__ModuleLoader__.load({
  id: "@kition/dsh-kits",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const React = require("react");
function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const React__namespace = /* @__PURE__ */ _interopNamespace(React);
const PREFIX = "dsh-resource://file/";
function parseFileAddress(address) {
  if (typeof address !== "string" || !address.startsWith(PREFIX)) return null;
  const end = address.search(/[?#]/);
  const [scope, ...rest] = address.slice(PREFIX.length, end === -1 ? void 0 : end).split("/");
  try {
    if (scope === "session") {
      const [id, ...segments] = rest;
      if (!id || segments.length === 0) return null;
      const path = segments.map(decodeURIComponent).join("/");
      return path ? { scope: "session", sessionId: decodeURIComponent(id), path } : null;
    }
    if (scope === "absolute" && rest.length > 0) {
      const path = rest.map(decodeURIComponent).join("/");
      return { scope: "absolute", path: /^[A-Za-z]:/.test(path) ? path : `/${path}` };
    }
  } catch {
    return null;
  }
  return null;
}
const baseName = (path) => path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);
function extensionOf(path) {
  const name2 = baseName(path);
  const dot = name2.lastIndexOf(".");
  return dot > 0 ? name2.slice(dot + 1).toLowerCase() : "";
}
const GATEWAY_PAGE_PROTOCOL = 1;
function isGatewayPageMessage(data) {
  return typeof data === "object" && data !== null && data.kitionGatewayPage === GATEWAY_PAGE_PROTOCOL && typeof data.type === "string";
}
const frameName = (tabId) => `dsh-sidebar-html-${tabId}`;
function makeFrame(tabId, src, title) {
  const frame = document.createElement("iframe");
  frame.name = frameName(tabId);
  frame.setAttribute("data-html-preview", "");
  frame.setAttribute("data-kition-page", "");
  frame.title = title;
  frame.allow = "clipboard-read; clipboard-write; fullscreen";
  frame.style.cssText = "flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; border: 0; display: block; -webkit-app-region: no-drag";
  frame.src = src;
  return frame;
}
class PageFrame {
  constructor(frame, events, scheme, language) {
    this.frame = frame;
    this.events = events;
    this.scheme = scheme;
    this.language = language;
    this.listener = (event) => this.receive(event);
    window.addEventListener("message", this.listener);
  }
  state = { ready: false, title: null, kit: null, status: null, dirty: false, readOnly: false, draft: null };
  listener;
  /** The page's origin is the host's (a same-origin proxy): its messages come from there. */
  receive(event) {
    if (event.source !== this.frame.contentWindow) return;
    if (event.origin !== location.origin && !(event.origin === "null" || location.origin === "null")) return;
    if (!isGatewayPageMessage(event.data)) return;
    const message = event.data;
    switch (message.type) {
      case "ready":
        this.state.ready = true;
        this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: "theme", theme: this.scheme });
        this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: "locale", locale: this.language });
        break;
      case "state":
        Object.assign(this.state, { title: message.title, kit: message.kit, status: message.status, dirty: message.dirty, readOnly: message.readOnly === true, progress: message.progress, detail: message.detail });
        break;
      case "draft":
        this.state.draft = message.draft;
        break;
      case "reviewed":
        this.state.draft = null;
        this.events.reviewed?.(message.outcome);
        break;
      case "shortcut":
        if (!(message.key.code === "KeyW" && (message.key.meta || message.key.ctrl))) this.events.shortcut?.(message.key);
        return;
      case "request-close":
        this.events.requestClose?.(message.dirty);
        return;
      case "saved":
        this.events.saved?.(message.saved, message.error);
        return;
    }
    this.events.change?.({ ...this.state });
  }
  send(command) {
    const target = location.origin && location.origin !== "null" ? location.origin : "*";
    this.frame.contentWindow?.postMessage(command, target);
  }
  setTheme(scheme) {
    if (scheme === this.scheme) return;
    this.scheme = scheme;
    if (this.state.ready) this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: "theme", theme: scheme });
  }
  setLanguage(language) {
    if (language === this.language) return;
    this.language = language;
    if (this.state.ready) this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: "locale", locale: language });
  }
  save() {
    this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: "save" });
  }
  focus() {
    this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: "focus" });
  }
  /** Opens the review of the agent's draft in the page. */
  review() {
    this.send({ kitionGatewayPage: GATEWAY_PAGE_PROTOCOL, type: "review" });
  }
  dispose() {
    window.removeEventListener("message", this.listener);
  }
}
const route = (path) => new URL(path, document.baseURI).href;
async function openFile(sessionId, path) {
  try {
    const response = await fetch(route(`kition/api/open?${new URLSearchParams({ session: sessionId, path })}`), { credentials: "same-origin", cache: "no-store" });
    const answer = await response.json().catch(() => ({}));
    if (response.ok && typeof answer.page === "string") return { phase: "open", page: answer.page, key: answer.key, path: answer.path };
    return {
      phase: "failed",
      error: String(answer.error ?? `http-${response.status}`),
      message: String(answer.message ?? response.statusText),
      ...typeof answer.reason === "string" ? { reason: answer.reason } : {},
      ...typeof answer.platform === "string" ? { platform: answer.platform } : {}
    };
  } catch (error) {
    return { phase: "failed", error: "unreachable", message: error.message };
  }
}
class GatewayError extends Error {
  constructor(message, status, reason) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}
async function gatewayJson(key, path, init = {}) {
  let response;
  try {
    response = await fetch(route(`kition/w/${key}/${path}`), { credentials: "same-origin", cache: "no-store", ...init });
  } catch (error) {
    throw new GatewayError(error.message, 0, "unreachable");
  }
  const envelope = await response.json().catch(() => null);
  if (!response.ok) throw new GatewayError(envelope?.message ?? `the gateway answered ${response.status}`, response.status, envelope?.data?.reason ?? envelope?.error ?? null);
  return envelope?.data ?? null;
}
const post = (key, path, body, origin) => gatewayJson(key, path, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...origin ? { "Kition-Dsh-Session": origin.session, "Kition-Dsh-Turn": String(origin.turn) } : {} },
  body: JSON.stringify(body)
});
const compare = (key, path) => gatewayJson(key, `api/v1/kits/drafts/compare?${new URLSearchParams({ path, previews: "true" })}`);
const merge = (key, path, overwrite = false, origin) => post(key, "api/v1/kits/drafts/merge", { path, overwrite }, origin);
const discard = (key, path, origin) => post(key, "api/v1/kits/drafts/discard", { path }, origin);
async function exists(key, path) {
  const response = await fetch(route(`kition/w/${key}/kit-files/${path.split("/").map(encodeURIComponent).join("/")}`), { method: "HEAD", credentials: "same-origin", cache: "no-store" }).catch(() => null);
  return response ? response.status !== 404 : true;
}
class DraftsWatch {
  constructor(key) {
    this.key = key;
  }
  drafts = null;
  failed = null;
  listeners = /* @__PURE__ */ new Set();
  stream = null;
  timer = null;
  subscribe(listener) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }
  async refresh() {
    try {
      const listed = await gatewayJson(this.key, "api/v1/kits/drafts");
      this.drafts = new Map(listed.drafts.map((draft) => [draft.path, draft]));
      this.failed = null;
    } catch (error) {
      this.failed = error.message;
    }
    for (const listener of [...this.listeners]) listener();
  }
  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 1e4);
    this.stream = new AbortController();
    void this.listen(this.stream.signal);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.abort();
    this.stream = null;
  }
  /** The gateway's bridge stream, as a window with no editor: it hears the drafts change. */
  async listen(signal) {
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        const response = await fetch(route(`kition/w/${this.key}/api/v1/kits/bridge`), { credentials: "same-origin", headers: { Accept: "text/event-stream" }, signal });
        if (!response.ok || !response.body) throw new Error(String(response.status));
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let session = null;
        for (; ; ) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value.replace(/\r\n/g, "\n");
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
            if (!data) continue;
            let message;
            try {
              message = JSON.parse(data);
            } catch {
              continue;
            }
            attempt = 0;
            if (message.method === "bridge.ready") session = Number(message.params?.session);
            else if (message.id != null && session != null) {
              const answer = message.method === "kit/documents" ? { result: { documents: [] } } : { error: { code: -32e3, message: "no editor is open here" } };
              void fetch(route(`kition/w/${this.key}/api/v1/kits/bridge?session=${session}`), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer }) }).catch(() => void 0);
            } else if (message.method === "kit/draftsChanged") void this.refresh();
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1e4, 500 * 2 ** attempt)));
    }
  }
}
const watches = /* @__PURE__ */ new Map();
function draftsOf(key) {
  let watch = watches.get(key);
  if (!watch) watches.set(key, watch = new DraftsWatch(key));
  return watch;
}
class ReviewsWatch {
  constructor(sessionId) {
    this.sessionId = sessionId;
  }
  reviews = [];
  listeners = /* @__PURE__ */ new Set();
  asked = false;
  subscribe(listener) {
    this.listeners.add(listener);
    if (!this.asked) void this.refresh();
    return () => this.listeners.delete(listener);
  }
  async refresh() {
    this.asked = true;
    try {
      const response = await fetch(route(`kition/api/reviews?${new URLSearchParams({ session: this.sessionId })}`), { credentials: "same-origin", cache: "no-store" });
      const answer = await response.json();
      if (response.ok && Array.isArray(answer.reviews)) this.reviews = answer.reviews;
    } catch {
    }
    for (const listener of [...this.listeners]) listener();
  }
}
const reviewWatches = /* @__PURE__ */ new Map();
function reviewsOf(sessionId) {
  let watch = reviewWatches.get(sessionId);
  if (!watch) reviewWatches.set(sessionId, watch = new ReviewsWatch(sessionId));
  return watch;
}
const draftingTurns = /* @__PURE__ */ new Map();
const draftingListeners = /* @__PURE__ */ new Set();
let draftingVersion = 0;
function noteDraftingTurn(sessionId, path, turn, at) {
  const key = `${sessionId}:${path}`;
  let turns = draftingTurns.get(key);
  if (!turns) draftingTurns.set(key, turns = /* @__PURE__ */ new Map());
  if (turns.get(turn) === at) return;
  turns.set(turn, at);
  draftingVersion++;
  queueMicrotask(() => {
    for (const listener of [...draftingListeners]) listener();
  });
}
function subscribeDraftingTurns(listener) {
  draftingListeners.add(listener);
  return () => draftingListeners.delete(listener);
}
const draftingVersionNow = () => draftingVersion;
const draftingTurnsOf = (sessionId, path) => [...(draftingTurns.get(`${sessionId}:${path}`) ?? /* @__PURE__ */ new Map()).entries()];
const draftingTurnOf = (sessionId, path) => {
  const turns = draftingTurnsOf(sessionId, path).map(([turn]) => turn);
  return turns.length ? Math.max(...turns) : null;
};
const NAMESPACE = "kitionKits";
const en = {
  openWith: "Kition {kit}",
  starting: "Starting Kition…",
  startingDetail: "Kition is starting for this folder.",
  missingTitle: "Kition cannot run here",
  missingUnsupported: "The Kition program that comes with the plugin has no build for this computer ({platform}). Set KITION_BIN to a kition built for it, and restart DeepSeek Harness.",
  missingOmitted: "The plugin was installed without its optional dependencies, which bring the Kition program for this computer ({platform}). Add the plugin again without leaving them out.",
  missingCli: "The package that brings the Kition program (@kition/cli) is not installed beside the plugin. Add the plugin again.",
  missingFolder: "The plugin was added from a folder, which is linked without its dependencies, so the Kition program is not there. Run npm install --omit=dev in that folder, or add the plugin by name or from its .tgz.",
  missingOld: "The Kition program that came with the plugin is an older one ({platform}) without what the plugin needs. Add the plugin again, or install a newer kition (npm install -g @kition/cli), and restart DeepSeek Harness.",
  missingOption: "An option names a Kition program that cannot be used:",
  unreachableTitle: "Kition does not answer",
  unreachableDetail: "Kition could not open this file.",
  retry: "Try again",
  outsideTitle: "This file is outside the session’s folder",
  outsideDetail: "Kition opens files inside the folder this session works in.",
  noSession: "Open a session to edit this file with Kition.",
  closeDirty: "{name} has unsaved changes in Kition.",
  closeSave: "Save and close",
  closeDiscard: "Close without saving",
  closeKeep: "Keep editing",
  keepDraft: "Keep the draft",
  draft: "Draft",
  draftTitle: "An agent drafted changes to this file",
  readOnly: "Read-only",
  unsaved: "Unsaved changes",
  // The review cards at the end of an agent's turn.
  cardsLabel: "Kition files this turn",
  statePending: "The agent is editing…",
  stateFailed: "The agent’s edit failed",
  stateLive: "Edited live in the open editor",
  stateSaved: "Edited",
  stateCreated: "Created",
  stateDraftOpen: "Draft, for your review",
  stateDraftReady: "Draft ready for your review",
  stateStale: "Draft — the file changed since it began",
  stateMerged: "Merged",
  stateDiscarded: "Discarded",
  stateDraftGone: "The draft is no longer there",
  stateMissing: "The file was deleted",
  stateKitionMissing: "Kition cannot run here; open the file for why",
  stateGatewayDown: "Kition does not answer",
  actionOpen: "Open",
  actionReview: "Review",
  actionMerge: "Merge",
  actionDiscard: "Discard",
  actionOverwrite: "Merge and overwrite",
  confirmDiscard: "Discard the agent’s draft of {name}? The file stays as it is.",
  changes: "{created} created, {changed} changed, {deleted} deleted",
  failedAction: "Kition could not do that: {message}",
  settingsTitle: "Kition",
  settingLiveFloat: "Show an agent’s edit of a file that is not open in a floating window, as it happens",
  settingAutoOpen: "Open a file in the right sidebar after an agent’s first edit of it in a turn",
  settingOpenWith: "Open Markdown, HTML, PDF, Word, Excel, PowerPoint, CSV and SVG files first in",
  settingOpenWithDsh: "DeepSeek Harness’s preview",
  settingOpenWithKition: "the Kition editor",
  settingsUnavailable: "These settings need DeepSeek Harness’s settings service."
};
const zh = {
  openWith: "Kition {kit}",
  starting: "正在启动 Kition…",
  startingDetail: "Kition 正在为这个文件夹启动。",
  missingTitle: "Kition 无法在这里运行",
  missingUnsupported: "插件自带的 Kition 程序没有这台电脑（{platform}）的版本。请把 KITION_BIN 设为为它构建的 kition，然后重启 DeepSeek Harness。",
  missingOmitted: "安装插件时没有安装它的可选依赖，而这台电脑（{platform}）的 Kition 程序正是由可选依赖带来的。请重新添加插件，不要省略可选依赖。",
  missingCli: "带来 Kition 程序的包（@kition/cli）没有和插件一起安装。请重新添加插件。",
  missingFolder: "插件是从文件夹添加的，文件夹会被直接链接而不安装依赖，所以没有 Kition 程序。请在该文件夹里运行 npm install --omit=dev，或者按包名或 .tgz 添加插件。",
  missingOld: "插件带来的 Kition 程序（{platform}）是旧版本，缺少插件需要的功能。请重新添加插件，或安装较新的 kition（npm install -g @kition/cli），然后重启 DeepSeek Harness。",
  missingOption: "一个选项指定的 Kition 程序无法使用：",
  unreachableTitle: "Kition 没有响应",
  unreachableDetail: "Kition 无法打开这个文件。",
  retry: "重试",
  outsideTitle: "这个文件不在会话的文件夹里",
  outsideDetail: "Kition 只打开这个会话所在文件夹里的文件。",
  noSession: "打开一个会话，才能用 Kition 编辑这个文件。",
  closeDirty: "{name} 在 Kition 里有未保存的修改。",
  closeSave: "保存并关闭",
  closeDiscard: "不保存，关闭",
  closeKeep: "继续编辑",
  keepDraft: "保留草稿",
  draft: "草稿",
  draftTitle: "Agent 起草了对这个文件的修改",
  readOnly: "只读",
  unsaved: "有未保存的修改",
  cardsLabel: "本轮的 Kition 文件",
  statePending: "Agent 正在编辑…",
  stateFailed: "Agent 的修改失败了",
  stateLive: "已在打开的编辑器里实时修改",
  stateSaved: "已修改",
  stateCreated: "已创建",
  stateDraftOpen: "草稿，等你审阅",
  stateDraftReady: "草稿已就绪，等你审阅",
  stateStale: "草稿：文件在起草之后又改过",
  stateMerged: "已合入",
  stateDiscarded: "已丢弃",
  stateDraftGone: "草稿已经不在了",
  stateMissing: "文件已被删除",
  stateKitionMissing: "Kition 无法在这里运行；打开文件查看原因",
  stateGatewayDown: "Kition 没有响应",
  actionOpen: "打开",
  actionReview: "审阅",
  actionMerge: "合入",
  actionDiscard: "丢弃",
  actionOverwrite: "合入并覆盖",
  confirmDiscard: "丢弃 Agent 对 {name} 的草稿吗？文件保持不变。",
  changes: "新增 {created}，修改 {changed}，删除 {deleted}",
  failedAction: "Kition 没能完成：{message}",
  settingsTitle: "Kition",
  settingLiveFloat: "Agent 编辑一个没有打开的文件时，在浮动窗口里实时显示",
  settingAutoOpen: "Agent 在一轮里第一次编辑一个文件后，在右侧栏打开它",
  settingOpenWith: "Markdown、HTML、PDF、Word、Excel、PowerPoint、CSV 和 SVG 文件先用",
  settingOpenWithDsh: "DeepSeek Harness 的预览",
  settingOpenWithKition: "Kition 编辑器",
  settingsUnavailable: "这些设置需要 DeepSeek Harness 的设置服务。"
};
const fill = (text, params = {}) => text.replace(/\{(\w+)\}/g, (whole, name2) => params[name2] ?? whole);
const table = { "ai": { "kit": "vector", "view": true }, "csv": { "kit": "sheet", "view": true }, "docx": { "kit": "doc", "view": false }, "dxf": { "kit": "cad", "view": false }, "eps": { "kit": "vector", "view": true }, "et": { "kit": "sheet", "view": true }, "ett": { "kit": "sheet", "view": true }, "fig": { "kit": "design", "view": true }, "htm": { "kit": "html", "view": false }, "html": { "kit": "html", "view": false }, "idml": { "kit": "layout", "view": true }, "kboard": { "kit": "board", "view": false }, "kdesign": { "kit": "design", "view": false }, "kfilm": { "kit": "film", "view": false }, "klayout": { "kit": "layout", "view": false }, "kmotion": { "kit": "motion", "view": false }, "kphoto": { "kit": "photo", "view": false }, "kscene": { "kit": "scene", "view": false }, "kslide": { "kit": "slide", "view": false }, "ktable": { "kit": "table", "view": false }, "kvector": { "kit": "vector", "view": false }, "markdown": { "kit": "note", "view": false }, "md": { "kit": "note", "view": false }, "ods": { "kit": "sheet", "view": true }, "pdf": { "kit": "pdf", "view": false }, "pptx": { "kit": "slide", "view": false }, "psb": { "kit": "photo", "view": false }, "psd": { "kit": "photo", "view": false }, "sketch": { "kit": "design", "view": true }, "svg": { "kit": "vector", "view": true }, "xls": { "kit": "sheet", "view": true }, "xlsb": { "kit": "sheet", "view": true }, "xlsm": { "kit": "sheet", "view": false }, "xlsx": { "kit": "sheet", "view": false }, "xlt": { "kit": "sheet", "view": true }, "xltm": { "kit": "sheet", "view": true }, "xltx": { "kit": "sheet", "view": true } };
const KIT_FORMATS = table;
const KIT_EXTENSIONS = Object.fromEntries(Object.entries(table).map(([extension, entry]) => [extension, entry.kit]));
const DSH_PREVIEWS = /* @__PURE__ */ new Set([
  ...["md", "markdown", "html", "htm", "pdf", "doc", "docx", "ppt", "pptx", "xlsx", "xls", "csv", "tsv"],
  ...["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"],
  ..."ts tsx mts cts js jsx mjs cjs sh bash zsh fish json jsonc jsonl ndjson ipynb py pyw pyi rb rake gemspec go rs java c h cc cpp cxx hh hpp hxx cs kt kts swift php yaml yml toml ini conf cfg properties env log diff patch http mdx rst tex sty cls bib adoc xhtml css scss less sql xml xsd xsl xslt plist lua bat cmd ps1 psm1 psd1 r jl dart scala clj cljs edn erl hrl ex exs hs fs fsi fsx vb pl pm v sv svh graphql gql proto tf tfvars hcl nix vue svelte makefile mk cmake gradle groovy".split(" ")
]);
const TAB_EXTENSIONS = Object.keys(KIT_EXTENSIONS).filter((extension) => !DSH_PREVIEWS.has(extension));
const PREVIEW_EXTENSIONS = Object.entries(KIT_EXTENSIONS).filter(([extension]) => DSH_PREVIEWS.has(extension)).reduce((byKit, [extension, kit]) => {
  (byKit[kit] ??= []).push(extension);
  return byKit;
}, {});
const kitName = (kit) => kit === "html" || kit === "pdf" || kit === "cad" ? kit.toUpperCase() : kit.charAt(0).toUpperCase() + kit.slice(1);
const TOOL_PREFIX = "mcp__kition__";
const WRITES = /* @__PURE__ */ new Set(["run", "batch", "create", "draft_ready", "draft_reopen"]);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
function actionOf(name2) {
  if (typeof name2 !== "string" || !name2.startsWith(TOOL_PREFIX)) return null;
  const raw = name2.slice(TOOL_PREFIX.length);
  const at = raw.indexOf("_");
  return at > 0 ? raw.slice(at + 1) : null;
}
function argumentsOf(data) {
  const value = data.arguments;
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
const normalPath = (path) => path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
function withOperation(files, path, kit, operation) {
  const next = files.map((file) => ({ ...file, operations: file.operations.filter((entry) => entry.callId !== operation.callId) }));
  const at = next.findIndex((file) => file.path === path);
  if (at < 0) next.push({ path, kit, operations: [operation] });
  else next[at] = { path, kit: kit ?? next[at].kit, operations: [...next[at].operations, operation] };
  return next.filter((file) => file.operations.length > 0);
}
function addCall(state, data) {
  const action = actionOf(data.name);
  const args = argumentsOf(data);
  if (!action || typeof args.path !== "string" || !args.path || typeof data.callId !== "string") return state;
  const operation = { callId: data.callId, action, phase: "pending", writes: WRITES.has(action), live: false, draft: args.draft === true, created: action === "create" };
  return { ...state, files: withOperation(state.files, normalPath(args.path), null, operation) };
}
function outcome(data) {
  const meta = [data.meta, isRecord(data.message) ? data.message.meta : void 0, isRecord(data.result) ? data.result.meta : void 0].find((value) => isRecord(value) && value.kition === 1);
  if (isRecord(meta)) return { live: meta.live === true, draft: meta.draft === true, kit: typeof meta.kit === "string" ? meta.kit : null, path: typeof meta.path === "string" ? meta.path : null };
  const message = isRecord(data.message) ? data.message : {};
  const text = (Array.isArray(message.content) ? message.content : []).map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "").join("\n");
  if (!text) return null;
  return { live: /"live":true/.test(text), draft: /"draft":true/.test(text), kit: /"kit":"(kit\.[a-z0-9-]+)"/.exec(text)?.[1] ?? null, path: null };
}
function applyResult(state, data, time) {
  const message = isRecord(data.message) ? data.message : {};
  const callId = typeof message.toolCallId === "string" ? message.toolCallId : typeof data.callId === "string" ? data.callId : null;
  if (!callId) return state;
  const file = state.files.find((entry) => entry.operations.some((operation2) => operation2.callId === callId));
  if (!file) return state;
  const before = file.operations.find((operation2) => operation2.callId === callId);
  const failed = message.isError === true || data.error !== void 0;
  const said = failed ? null : outcome(data);
  const operation = { ...before, phase: failed ? "failed" : "done", live: said?.live ?? false, draft: said?.draft ?? before.draft, ...typeof time === "number" ? { time } : {} };
  return { ...state, files: withOperation(state.files, file.path, said?.kit ?? file.kit, operation) };
}
const kitTurnDefinition = {
  kind: "kitionTurn",
  match(event) {
    const turn = event.data?.turn;
    if (typeof turn !== "number") return null;
    if (event.type === "turn/start") return { id: String(turn), role: "start" };
    if (event.type === "tool/call" || event.type === "tool/result") return { id: String(turn), role: "update" };
    return null;
  },
  start(_context, match) {
    return { turn: Number(match.event.data?.turn), files: [] };
  },
  update(context, match) {
    const data = match.event.data ?? {};
    if (match.event.type === "tool/call") return addCall(context.state, data);
    if (match.event.type === "tool/result") return applyResult(context.state, data, match.event.time);
    return context.state;
  },
  buildLocationData(context, scope, previous) {
    const state = context.state;
    if (scope !== "turn" || !state || state.files.length === 0) return null;
    if (previous?.value && previous.value.files === state.files) return previous;
    return { kind: "turn", turn: state.turn, key: "kitionTurn", value: { files: state.files } };
  }
};
function draftedAt(file) {
  const times = file.operations.filter((operation) => operation.writes && operation.draft && operation.phase === "done" && typeof operation.time === "number").map((operation) => operation.time);
  return times.length ? Math.max(...times) : null;
}
function outcomeFor(reviews, sessionId, path, turn, drafts) {
  const own = reviews.filter((review) => review.path === path);
  const exact = own.find((review) => review.session === sessionId && review.turn === turn);
  if (exact) return exact;
  const at = drafts.find(([candidate]) => candidate === turn)?.[1];
  if (at == null) return null;
  const next = drafts.map(([, time]) => time).filter((time) => time != null && time > at).sort((a, b) => a - b)[0] ?? Infinity;
  return own.find((review) => review.turn === null && review.at >= at && review.at < next) ?? null;
}
function cardState(file, now) {
  const writes = file.operations.filter((operation) => operation.writes);
  if (writes.length === 0) return null;
  if (writes.some((operation) => operation.phase === "pending")) return "pending";
  const done = writes.filter((operation) => operation.phase === "done");
  if (done.length === 0) return "failed";
  if (done.some((operation) => operation.draft)) {
    if (now.draft) return now.draft.stale ? "stale" : now.draft.state === "ready" ? "draft-ready" : "draft-open";
    if (now.draft === void 0) return "draft-open";
    if (now.outcome) return now.outcome;
    return now.exists === false ? "missing" : "draft-gone";
  }
  if (now.exists === false) return "missing";
  if (done.some((operation) => operation.created)) return "created";
  return done.some((operation) => operation.live) ? "live" : "saved";
}
function cardActions(state) {
  switch (state) {
    case "draft-open":
    case "draft-ready":
      return ["open", "review", "merge", "discard"];
    case "stale":
      return ["open", "review", "overwrite", "discard"];
    case "missing":
    case "pending":
      return [];
    default:
      return ["open"];
  }
}
const STYLE_ID = "kition-kits-dialog-style";
const STYLE = `
.kition-dialog-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgb(0 0 0 / 0.35); }
.kition-dialog { max-width: min(440px, 100%); padding: 18px 20px; border-radius: 12px; background: Canvas; color: CanvasText; box-shadow: 0 10px 40px rgb(0 0 0 / 0.25); font: 14px/1.5 system-ui, sans-serif; }
.kition-dialog p { margin: 0 0 16px; }
.kition-dialog__actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.kition-dialog button { padding: 6px 14px; border-radius: 8px; border: 1px solid rgb(127 127 127 / 0.4); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.kition-dialog button[data-primary] { background: #5645d4; border-color: #5645d4; color: #fff; }
.kition-dialog button[data-danger] { color: #c0392b; border-color: rgb(192 57 43 / 0.5); }
`;
function ask(message, choices) {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.append(style);
  }
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "kition-dialog-backdrop";
    const box = document.createElement("div");
    box.className = "kition-dialog";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("data-kition-dialog", "");
    const text = document.createElement("p");
    text.textContent = message;
    const actions = document.createElement("div");
    actions.className = "kition-dialog__actions";
    const fallback = choices[choices.length - 1]?.id ?? "";
    const finish = (id) => {
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      previous?.focus?.({ preventScroll: true });
      resolve(id);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish(fallback);
    };
    for (const choice of choices) {
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.textContent = choice.label;
      button2.dataset.kitionDialogChoice = choice.id;
      if (choice.primary) button2.dataset.primary = "";
      if (choice.danger) button2.dataset.danger = "";
      button2.addEventListener("click", () => finish(choice.id));
      actions.append(button2);
    }
    box.append(text, actions);
    backdrop.append(box);
    document.body.append(backdrop);
    document.addEventListener("keydown", onKey, true);
    actions.querySelector("button[data-primary]")?.focus() ?? actions.querySelector("button")?.focus();
  });
}
const FLOAT_MIN = { width: 420, height: 360 };
function liveWindowRect(viewport, conversation) {
  const left = Math.round((conversation?.right ?? viewport.width) + 16);
  const width = Math.min(640, viewport.width - left - 16);
  const height = Math.min(760, viewport.height - 96 - 16);
  if (width < FLOAT_MIN.width || height < FLOAT_MIN.height) return null;
  return { x: left, y: 96, width, height };
}
const h = React__namespace.createElement;
const name = "@kition/dsh-kits";
const inject = ["slots"];
const TAB_TYPE = "kition";
const TEXT_TYPE = "@deepseek-ai/dsh-client-ui-sidebar-documentpreview";
const TEXT_KIND = "text";
const HOST_ENTRY = "kition-kits-host";
const previewId = (kit) => `kition/${kit}`;
const DEFAULTS = { liveFloat: true, openWith: "dsh", autoOpen: false };
class Environment {
  listeners = /* @__PURE__ */ new Set();
  scheme = "light";
  language = "en";
  settings = DEFAULTS;
  /** DeepSeek Harness's own shortcuts the editor hands back (the web UI's; Desktop routes them itself). */
  keys = [];
  translate = null;
  sidebar = null;
  version = 0;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(changes) {
    Object.assign(this, changes);
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
  t(key, params = {}) {
    const bound = this.translate?.(key, params);
    if (bound && bound !== key) return bound;
    return fill((this.language === "zh" ? zh : en)[key], params);
  }
}
const environment = new Environment();
const pages = /* @__PURE__ */ new Map();
const pageListeners = /* @__PURE__ */ new Set();
function setPage(tabId, state) {
  if (state) pages.set(tabId, state);
  else pages.delete(tabId);
  for (const listener of [...pageListeners]) listener();
}
const subscribePages = (listener) => {
  pageListeners.add(listener);
  return () => pageListeners.delete(listener);
};
const openPage = (sessionId, path) => [...pages.values()].find((page) => page.path === path && (page.sessionId === null || page.sessionId === sessionId));
const pendingReview = /* @__PURE__ */ new Set();
const schemeOf = (snapshot) => snapshot?.active?.colorScheme === "dark" ? "dark" : "light";
const languageOf = (active) => typeof active === "string" && active.toLowerCase().startsWith("zh") ? "zh" : "en";
function useEnvironment() {
  React__namespace.useSyncExternalStore(environment.subscribe, () => environment.version);
  return environment;
}
function fileAddress(sessionId, path) {
  const segment = (text) => encodeURIComponent(text).replace(/%3A/gi, ":");
  return `dsh-resource://file/session/${segment(sessionId)}/${path.split("/").map(segment).join("/")}`;
}
function openInSidebar(sessionId, path, destination = "sidebar") {
  const sidebar = environment.sidebar;
  if (typeof sidebar?.openResource !== "function") return false;
  const active = document.activeElement;
  const address = fileAddress(sessionId, path);
  const composer = document.querySelector("[data-composer-input]")?.closest('form, [class*="input"], [class*="Input"]') ?? document.querySelector("[data-composer-input]");
  const rect = destination === "live" ? liveWindowRect({ width: innerWidth, height: innerHeight }, composer?.getBoundingClientRect() ?? null) : null;
  const collapsed = typeof sidebar.isExpanded === "function" ? !sidebar.isExpanded() : false;
  try {
    sidebar.openResource(address, { kind: TAB_TYPE, revealIfOpened: true, ...destination === "live" ? { params: { live: true } } : {} });
    if (rect && typeof sidebar.float === "function" && typeof sidebar.tabsIn === "function") {
      const tab = sidebar.tabsIn(sessionId).find((record) => record.contentId === address && record.kind === TAB_TYPE);
      if (tab) {
        sidebar.float(tab.id, rect);
        if (collapsed && sidebar.isExpanded?.()) sidebar.toggleExpanded?.();
      }
    }
  } catch {
    return false;
  }
  if (destination === "live" && active && active !== document.body) requestAnimationFrame(() => active.focus({ preventScroll: true }));
  return true;
}
function forwardShortcut(key) {
  const init = { key: key.key, code: key.code, metaKey: !!key.meta, ctrlKey: !!key.ctrl, shiftKey: !!key.shift, altKey: !!key.alt, bubbles: true, cancelable: true };
  document.body.dispatchEvent(new KeyboardEvent("keydown", init));
  document.body.dispatchEvent(new KeyboardEvent("keyup", init));
}
function Panel(props) {
  const env = useEnvironment();
  return h(
    "div",
    { "data-kition-state": props.state, role: props.state === "starting" ? "status" : "alert", style: { padding: "24px", display: "flex", flexDirection: "column", gap: "10px", font: "inherit", color: "inherit", overflow: "auto" } },
    h("strong", { style: { fontSize: "14px" } }, props.title),
    props.detail ? h("div", { style: { opacity: 0.8 } }, props.detail) : null,
    props.children,
    props.onRetry ? h("button", { type: "button", onClick: props.onRetry, "data-kition-retry": "", style: { alignSelf: "flex-start", padding: "4px 12px", cursor: "pointer" } }, env.t("retry")) : null
  );
}
function KitionView(props) {
  const env = useEnvironment();
  const parsed = parseFileAddress(props.address);
  const sessionId = parsed?.scope === "session" ? parsed.sessionId : props.sessionId;
  const path = parsed?.path ?? "";
  const fileName = baseName(path);
  const [attempt, setAttempt] = React__namespace.useState(0);
  const [opened, setOpened] = React__namespace.useState({ phase: "opening" });
  const host = React__namespace.useRef(null);
  const latest = React__namespace.useRef(props);
  latest.current = props;
  React__namespace.useEffect(() => {
    if (!sessionId || !path) return;
    let current = true;
    setOpened({ phase: "opening" });
    void openFile(sessionId, path).then((result) => current && setOpened(result));
    return () => {
      current = false;
    };
  }, [sessionId, path, attempt]);
  React__namespace.useEffect(() => {
    if (opened.phase !== "open" || !host.current) return;
    const url = new URL(opened.page, document.baseURI);
    url.searchParams.set("theme", environment.scheme);
    url.searchParams.set("locale", environment.language);
    if (environment.keys.length) url.searchParams.set("keys", environment.keys.join(" "));
    if (props.watching) url.searchParams.set("focus", "no");
    url.searchParams.set("closing", "host");
    const frame = makeFrame(props.tabId, url.href, `Kition ${fileName}`);
    const reviewKey = `${sessionId}:${opened.path}`;
    const remember = (state) => setPage(props.tabId, { ...state, name: fileName, path: opened.path, sessionId: sessionId ?? null, frame: page, tabId: props.tabId, floating: latest.current.floating === true });
    const page = new PageFrame(
      frame,
      {
        change: (state) => {
          remember(state);
          if (state.status === "open") latest.current.onOpen?.();
          if (state.status === "open" && pendingReview.delete(reviewKey)) page.review();
          void draftsOf(opened.key).refresh();
        },
        shortcut: forwardShortcut,
        requestClose: (dirty) => {
          if (latest.current.guardClose() && dirty) void confirmClose(props.tabId, () => latest.current.close?.());
          else latest.current.close?.();
        },
        reviewed: () => {
          void draftsOf(opened.key).refresh();
          if (sessionId) void reviewsOf(sessionId).refresh();
        }
      },
      environment.scheme,
      environment.language
    );
    remember(page.state);
    const stop = environment.subscribe(() => {
      page.setTheme(environment.scheme);
      page.setLanguage(environment.language);
    });
    host.current.replaceChildren(frame);
    return () => {
      stop();
      page.dispose();
      frame.remove();
      setPage(props.tabId, null);
    };
  }, [opened, props.tabId, fileName]);
  if (!sessionId || !path) return h(Panel, { state: "no-session", title: env.t("noSession") });
  if (opened.phase === "opening") return h(Panel, { state: "starting", title: env.t("starting"), detail: env.t("startingDetail") });
  if (opened.phase === "failed") {
    const retry = () => setAttempt((n) => n + 1);
    if (opened.error === "kition-missing" || opened.error === "kition-invalid") {
      const why = opened.error === "kition-invalid" ? "missingOption" : opened.reason === "unsupported" ? "missingUnsupported" : opened.reason === "omitted" ? "missingOmitted" : opened.reason === "old-bundled" ? "missingOld" : opened.reason === "folder" ? "missingFolder" : "missingCli";
      return h(
        Panel,
        { state: "kition-missing", title: env.t("missingTitle"), detail: env.t(why, { platform: opened.platform ?? "" }), onRetry: retry },
        h("div", { "data-kition-missing-reason": opened.reason ?? opened.error, style: { opacity: 0.7, fontSize: "12px", overflowWrap: "anywhere" } }, opened.message)
      );
    }
    if (opened.error === "outside-workspace") return h(Panel, { state: "outside-workspace", title: env.t("outsideTitle"), detail: env.t("outsideDetail") });
    return h(Panel, { state: "unreachable", title: env.t("unreachableTitle"), detail: env.t("unreachableDetail"), onRetry: retry }, h("div", { style: { opacity: 0.7, fontSize: "12px" } }, opened.message));
  }
  return h("div", { ref: host, "data-kition-view": "", style: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, WebkitAppRegion: "no-drag" } });
}
function TabBody(props) {
  const info = props.useTabInfo();
  const params = info.tab.navigation?.params ?? {};
  return h(KitionView, {
    address: info.tab.contentId,
    sessionId: props.sessionId,
    tabId: info.tab.id,
    close: () => info.tab.actions?.close?.(),
    guardClose: () => !guards.kition,
    watching: params.live === true || params.float === true,
    floating: info.panel?.isFloating === true
  });
}
function titled(name2, page, env) {
  const mark = { flex: "none", fontSize: "10px", lineHeight: "14px", padding: "0 4px", borderRadius: "6px", whiteSpace: "nowrap" };
  return [
    page?.dirty ? h("span", { key: "dirty", "data-kition-dirty": "", "aria-label": env.t("unsaved"), title: env.t("unsaved"), style: { flex: "none" } }, "●") : null,
    page?.draft ? h("span", { key: "draft", "data-kition-draft": page.draft.state, title: env.t("draftTitle"), style: { ...mark, background: "rgba(255,170,0,0.25)" } }, env.t("draft")) : null,
    page?.readOnly ? h("span", { key: "ro", "data-kition-readonly": "", style: { ...mark, opacity: 0.75, border: "1px solid currentColor", lineHeight: "12px" } }, env.t("readOnly")) : null,
    h("span", { key: "name", style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, name2)
  ];
}
function TabTitle(props) {
  const env = useEnvironment();
  const info = props.useTabInfo();
  React__namespace.useSyncExternalStore(subscribePages, () => pages.get(info.tab.id));
  return h(React__namespace.Fragment, null, ...titled(info.tab.title, pages.get(info.tab.id), env));
}
function textTitle(primitives2) {
  return function TextTabTitle(props) {
    const env = useEnvironment();
    const info = props.useTabInfo();
    React__namespace.useSyncExternalStore(subscribePages, () => pages.get(info.tab.id));
    const icon = primitives2?.FileTypeIcon && primitives2.classifyFileType ? h(primitives2.FileTypeIcon, { kind: primitives2.classifyFileType(info.tab.title), size: 16, style: { flex: "none" } }) : null;
    return h(React__namespace.Fragment, null, icon, ...titled(info.tab.title, pages.get(info.tab.id), env));
  };
}
function PreviewBody(props) {
  const info = props.useTabInfo?.();
  const content = props.content;
  const loaded = React__namespace.useRef(false);
  React__namespace.useEffect(() => {
    loaded.current = false;
  }, [content?.revision]);
  return h(KitionView, {
    address: props.resourceAddress,
    sessionId: props.sessionId,
    tabId: info?.tab?.id ?? props.resourceAddress,
    close: () => info?.tab?.actions?.close?.(),
    guardClose: () => !guards.text,
    onOpen: () => {
      if (loaded.current || content?.kind !== "renderer") return;
      loaded.current = true;
      content.loaded(String(content.revision));
    }
  });
}
const guards = { kition: false, text: false };
const closing = /* @__PURE__ */ new Set();
async function confirmClose(tabId, close) {
  const page = pages.get(tabId);
  if (!page) return close();
  const choice = await ask(environment.t("closeDirty", { name: page.name }), [
    { id: "save", label: environment.t("closeSave"), primary: true },
    { id: "discard", label: environment.t("closeDiscard"), danger: true },
    { id: "keep", label: environment.t("closeKeep") }
  ]);
  if (choice === "save") {
    const saved = await new Promise((resolve) => {
      const stop = subscribePages(() => {
        const now = pages.get(tabId);
        if (!now || !now.dirty) {
          stop();
          resolve(true);
        }
      });
      page.frame.save();
      setTimeout(() => {
        stop();
        resolve(!pages.get(tabId)?.dirty);
      }, 15e3);
    });
    if (!saved) return;
  } else if (choice !== "discard") return;
  closing.add(tabId);
  close();
  setTimeout(() => closing.delete(tabId), 2e3);
}
function closeGuard(_session, tab) {
  const page = pages.get(tab.id);
  if (!page?.dirty || closing.has(tab.id)) return;
  void confirmClose(tab.id, () => environment.sidebar?.close?.(tab.id));
  throw new Error("Kition: the tab has unsaved edits; the person is asked");
}
const keys = /* @__PURE__ */ new Map();
function workspaceOf(sessionId, path) {
  const cached = keys.get(sessionId);
  if (cached) return cached;
  const asked = openFile(sessionId, path);
  keys.set(sessionId, asked);
  void asked.then((answer) => answer.phase !== "open" && keys.delete(sessionId));
  return asked;
}
function useWatch(subscribe, read) {
  const [, setTick] = React__namespace.useState(0);
  React__namespace.useEffect(() => subscribe ? subscribe(() => setTick((n) => n + 1)) : void 0, [subscribe]);
  return read();
}
const STATE_WORDS = {
  pending: "statePending",
  failed: "stateFailed",
  live: "stateLive",
  saved: "stateSaved",
  created: "stateCreated",
  "draft-open": "stateDraftOpen",
  "draft-ready": "stateDraftReady",
  stale: "stateStale",
  merged: "stateMerged",
  discarded: "stateDiscarded",
  "draft-gone": "stateDraftGone",
  missing: "stateMissing"
};
const button = (label, action, onClick, busy, primary = false) => h(
  "button",
  {
    key: action,
    type: "button",
    "data-kition-card-action": action,
    disabled: busy,
    onClick,
    style: { padding: "2px 10px", borderRadius: "6px", border: "1px solid rgba(127,127,127,0.35)", background: primary ? "rgba(80,90,255,0.12)" : "transparent", color: "inherit", cursor: busy ? "default" : "pointer", font: "inherit", fontSize: "12px" }
  },
  label
);
function FileCard(props) {
  const env = useEnvironment();
  const { sessionId, file, turn } = props;
  const [workspace, setWorkspace] = React__namespace.useState({ phase: "opening" });
  const [attempt, setAttempt] = React__namespace.useState(0);
  const [busy, setBusy] = React__namespace.useState(false);
  const [problem, setProblem] = React__namespace.useState(null);
  const [fileThere, setFileThere] = React__namespace.useState(void 0);
  const [comparison, setComparison] = React__namespace.useState(null);
  React__namespace.useEffect(() => {
    let current = true;
    void workspaceOf(sessionId, file.path).then((answer) => current && setWorkspace(answer));
    return () => {
      current = false;
    };
  }, [sessionId, file.path, attempt]);
  const key = workspace.phase === "open" ? workspace.key : null;
  const watch = React__namespace.useMemo(() => key ? draftsOf(key) : null, [key]);
  const subscribe = React__namespace.useMemo(() => watch ? (listener) => watch.subscribe(listener) : null, [watch]);
  const listed = useWatch(subscribe, () => watch?.drafts ? watch.drafts.get(file.path) ?? null : void 0);
  React__namespace.useSyncExternalStore(subscribePages, () => pages.size);
  const drafted = file.operations.some((operation) => operation.writes && operation.draft && operation.phase === "done");
  if (drafted) noteDraftingTurn(sessionId, file.path, turn, draftedAt(file));
  const reviews = React__namespace.useMemo(() => reviewsOf(sessionId), [sessionId]);
  const subscribeReviews = React__namespace.useMemo(() => (listener) => reviews.subscribe(listener), [reviews]);
  useWatch(subscribeReviews, () => reviews.reviews);
  React__namespace.useEffect(() => watch ? watch.subscribe(() => void reviews.refresh()) : void 0, [watch, reviews]);
  const listedKey = listed ? `${listed.state}:${listed.stale}:${listed.updated ?? ""}` : String(listed);
  React__namespace.useEffect(() => {
    if (!key) return;
    let current = true;
    void exists(key, file.path).then((there) => current && setFileThere(there));
    if (listed && drafted) void compare(key, file.path).then((answer) => current && setComparison(answer), () => current && setComparison(null));
    else setComparison(null);
    return () => {
      current = false;
    };
  }, [key, file.path, listedKey, drafted]);
  React__namespace.useSyncExternalStore(subscribeDraftingTurns, draftingVersionNow);
  const latest = draftingTurnOf(sessionId, file.path) === turn;
  const review = drafted ? outcomeFor(reviews.reviews, sessionId, file.path, turn, draftingTurnsOf(sessionId, file.path)) : null;
  const kept = review?.outcome ?? null;
  const state = cardState(file, { draft: kept ? null : watch?.drafts ? latest ? listed : null : void 0, outcome: kept, exists: fileThere });
  if (state === null) return null;
  const kit = file.kit?.replace(/^kit\./, "") ?? KIT_EXTENSIONS[extensionOf(file.path)] ?? null;
  let words = env.t(STATE_WORDS[state]);
  let shown = state;
  if (workspace.phase === "failed") {
    shown = workspace.error === "kition-missing" || workspace.error === "kition-invalid" ? "kition-missing" : "gateway-down";
    words = env.t(shown === "kition-missing" ? "stateKitionMissing" : "stateGatewayDown");
  }
  const origin = { session: sessionId, turn };
  const act = (run) => async () => {
    if (!key) return;
    setBusy(true);
    setProblem(null);
    try {
      await run();
    } catch (error) {
      setProblem(env.t("failedAction", { message: error.message }));
    } finally {
      setBusy(false);
      void watch?.refresh();
      void reviews.refresh();
    }
  };
  const actions = workspace.phase === "failed" ? [] : cardActions(state);
  const counts = comparison?.diff ? { created: String(comparison.diff.created?.length ?? 0), changed: String(comparison.diff.changed?.length ?? 0), deleted: String(comparison.diff.deleted?.length ?? 0) } : null;
  const picture = comparison?.previews?.draft;
  return h(
    "div",
    {
      "data-kition-card": file.path,
      "data-state": shown,
      style: { display: "flex", gap: "10px", alignItems: "flex-start", padding: "8px 10px", border: "1px solid rgba(127,127,127,0.25)", borderRadius: "8px", margin: "6px 0", fontSize: "13px" }
    },
    picture ? h("img", { src: `data:image/png;base64,${picture}`, alt: "", "data-kition-card-picture": "", style: { width: "64px", height: "48px", objectFit: "contain", borderRadius: "4px", background: "rgba(127,127,127,0.1)", flex: "none" } }) : null,
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0, flex: 1 } },
      h(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" } },
        h("strong", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: file.path }, baseName(file.path)),
        kit ? h("span", { style: { opacity: 0.7, fontSize: "12px" } }, `Kition ${kitName(kit)}`) : null,
        h("span", { "data-kition-card-state": shown, style: { fontSize: "12px", opacity: 0.85 } }, words)
      ),
      counts ? h("div", { "data-kition-card-changes": "", style: { fontSize: "12px", opacity: 0.75 } }, env.t("changes", counts)) : comparison?.diffUnavailable ? h("div", { style: { fontSize: "12px", opacity: 0.75 } }, comparison.diffUnavailable) : null,
      problem ? h("div", { role: "alert", style: { fontSize: "12px", color: "#c0392b" } }, problem) : null,
      workspace.phase === "failed" ? h("div", null, button(env.t("retry"), "retry", () => setAttempt((n) => n + 1), false)) : null,
      actions.length ? h(
        "div",
        { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
        ...actions.map((action) => {
          switch (action) {
            case "open":
              return button(env.t("actionOpen"), action, () => props.open(file.path), false);
            case "review":
              return button(env.t("actionReview"), action, () => reviewInSidebar(sessionId, file.path), false);
            case "merge":
              return button(env.t("actionMerge"), action, act(() => merge(key, file.path, false, origin)), busy, true);
            case "overwrite":
              return button(env.t("actionOverwrite"), action, act(() => merge(key, file.path, true, origin)), busy, true);
            case "discard":
              return button(env.t("actionDiscard"), action, () => {
                void ask(env.t("confirmDiscard", { name: baseName(file.path) }), [
                  { id: "discard", label: env.t("actionDiscard"), danger: true },
                  { id: "keep", label: env.t("keepDraft") }
                ]).then((choice) => {
                  if (choice === "discard") void act(() => discard(key, file.path, origin))();
                });
              }, busy);
          }
        })
      ) : null
    )
  );
}
function TurnCards(props) {
  const data = props.turn?.data?.get?.("kitionTurn");
  const sessionId = props.sessionId;
  if (!data || !sessionId) return null;
  const files = data.files.filter((file) => cardState(file, {}) !== null);
  if (files.length === 0) return null;
  const open = (path) => {
    if (!openInSidebar(sessionId, path)) props.openFile?.(path);
  };
  return h(
    "div",
    { "data-kition-cards": props.turn.turn, "aria-label": environment.t("cardsLabel") },
    ...files.map((file) => h(FileCard, { key: file.path, sessionId, turn: props.turn.turn, file, open }))
  );
}
function reviewInSidebar(sessionId, path) {
  const page = openPage(sessionId, path);
  if (page && page.status === "open" && !page.floating) return page.frame.review();
  const key = `${sessionId}:${path}`;
  pendingReview.add(key);
  openInSidebar(sessionId, path, "sidebar");
  setTimeout(() => {
    const now = openPage(sessionId, path);
    if (now && now.status === "open" && pendingReview.delete(key)) now.frame.review();
  }, 800);
}
function whenOpen(sessionId, path, ms) {
  return new Promise((resolve) => {
    const done = (value) => {
      stop();
      clearTimeout(timer);
      resolve(value);
    };
    const check = () => {
      if (openPage(sessionId, path)?.status === "open") done(true);
    };
    const stop = subscribePages(check);
    const timer = setTimeout(() => done(false), ms);
    check();
  });
}
function LiveWatcher(props) {
  const timeline = props.useChat?.((snapshot) => snapshot.timeline);
  useEnvironment();
  const seen = React__namespace.useRef(/* @__PURE__ */ new Set());
  const sessionId = props.sessionId;
  const current = React__namespace.useRef({ timeline });
  current.current.timeline = timeline;
  const runningTurn = () => {
    const now = current.current.timeline;
    for (const turnNumber of [...now?.turnOrder ?? []].reverse()) if (now.turns.get(turnNumber)?.status === "open") return turnNumber;
    return null;
  };
  const show = (path, turn) => {
    if (!sessionId) return false;
    const { liveFloat, autoOpen } = environment.settings;
    if (!(liveFloat || autoOpen) || !(extensionOf(path) in KIT_EXTENSIONS)) return false;
    const once = `${sessionId}:${turn ?? "now"}:${path}`;
    if (seen.current.has(once)) return false;
    seen.current.add(once);
    return openInSidebar(sessionId, path, autoOpen ? "sidebar" : "live");
  };
  React__namespace.useEffect(() => {
    if (!sessionId) return;
    const stop = new AbortController();
    const answerEditing = async (event) => {
      if (typeof event.id !== "string" || typeof event.path !== "string") return;
      const id = event.id;
      const answer = (state) => fetch(route("kition/api/live"), { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, state }) }).catch(() => void 0);
      const path = event.path.replace(/^(\.\/)+/, "");
      if (openPage(sessionId, path)?.status === "open") return void await answer("open");
      if (!show(path, runningTurn())) return void await answer("none");
      void answer("opening");
      const within = typeof event.openingMs === "number" && event.openingMs > 0 ? event.openingMs - 300 : 2700;
      await answer(await whenOpen(sessionId, path, within) ? "attached" : "none");
    };
    void (async () => {
      for (let attempt = 0; !stop.signal.aborted; attempt++) {
        try {
          const response = await fetch(route(`kition/api/live?${new URLSearchParams({ session: sessionId })}`), { credentials: "same-origin", headers: { Accept: "text/event-stream" }, signal: stop.signal });
          if (!response.ok || !response.body) throw new Error(String(response.status));
          attempt = 0;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (; ; ) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
              if (!data) continue;
              let event;
              try {
                event = JSON.parse(data);
              } catch {
                continue;
              }
              void answerEditing(event);
            }
          }
        } catch {
          if (stop.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(1e4, 500 * 2 ** attempt)));
      }
    })();
    return () => stop.abort();
  }, [sessionId]);
  React__namespace.useEffect(() => {
    if (!timeline || !sessionId) return;
    for (const turnNumber of timeline.turnOrder ?? []) {
      const turn = timeline.turns.get(turnNumber);
      if (!turn || turn.status !== "open") continue;
      const data = turn.data?.get?.("kitionTurn");
      for (const file of data?.files ?? []) {
        if (!file.operations.some((operation) => operation.writes && operation.phase !== "failed")) continue;
        if (openPage(sessionId, file.path)) {
          seen.current.add(`${sessionId}:${turnNumber}:${file.path}`);
          continue;
        }
        show(file.path, turnNumber);
      }
    }
  }, [timeline, sessionId, environment.version]);
  return null;
}
let settingsForm = null;
function SettingsCard() {
  const env = useEnvironment();
  const writable = settingsForm?.getSnapshot?.()?.writable === true;
  const set = (field, value) => void settingsForm?.set?.(field, value);
  const row = (children) => h("label", { style: { display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" } }, ...children);
  if (!settingsForm) return h("div", { "data-kition-settings": "unavailable" }, env.t("settingsUnavailable"));
  return h(
    "div",
    { "data-kition-settings": "", style: { display: "flex", flexDirection: "column", gap: "10px", padding: "8px 0" } },
    h("strong", null, env.t("settingsTitle")),
    row([h("input", { type: "checkbox", "data-kition-setting": "liveFloat", checked: env.settings.liveFloat, disabled: !writable, onChange: (event) => set("liveFloat", event.target.checked) }), env.t("settingLiveFloat")]),
    row([h("input", { type: "checkbox", "data-kition-setting": "autoOpen", checked: env.settings.autoOpen, disabled: !writable, onChange: (event) => set("autoOpen", event.target.checked) }), env.t("settingAutoOpen")]),
    row([
      env.t("settingOpenWith"),
      h(
        "select",
        { "data-kition-setting": "openWith", value: env.settings.openWith, disabled: !writable, onChange: (event) => set("openWith", event.target.value) },
        h("option", { value: "dsh" }, env.t("settingOpenWithDsh")),
        h("option", { value: "kition" }, env.t("settingOpenWithKition"))
      )
    ])
  );
}
function webKeys(shortcuts, mac) {
  if (shortcuts?.runtime !== "web") return [];
  const names = { Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Semicolon: ";", Quote: "'", Backquote: "`", Enter: "Enter", Backspace: "Backspace", Delete: "Delete" };
  const out = [];
  for (const entry of shortcuts.catalog?.getSnapshot?.() ?? []) {
    const binding = entry?.binding;
    if (!binding || binding.secondCode) continue;
    const key = /^Key[A-Z]$/.test(binding.code) ? binding.code.slice(3) : /^Digit[0-9]$/.test(binding.code) ? binding.code.slice(5) : /^F[0-9]{1,2}$/.test(binding.code) ? binding.code : names[binding.code];
    if (!key) continue;
    const modifiers = [];
    for (const modifier of binding.modifiers) {
      if (modifier === "meta") {
        if (!mac) modifiers.length = 0;
        modifiers.push("Cmd");
      } else if (modifier === "control") modifiers.push(mac ? "Ctrl" : "Cmd");
      else if (modifier === "alt") modifiers.push("Alt");
      else if (modifier === "shift") modifiers.push("Shift");
    }
    if (modifiers.some((modifier) => modifier === "Cmd" || modifier === "Ctrl" || modifier === "Alt")) out.push([...modifiers, key].join("+"));
  }
  return [...new Set(out)].slice(0, 32);
}
function apply(ctx) {
  ctx.inject(["theme"], (inner) => {
    const read = () => environment.set({ scheme: schemeOf(inner.theme.getTheme()) });
    read();
    inner.on("theme/change", read);
  });
  ctx.inject(["locale"], (inner) => {
    inner.effect(() => inner.locale.register(NAMESPACE, { en, zh }), "kition: words");
    const t = inner.locale.bind(NAMESPACE);
    environment.translate = (key, params) => t(key, params);
    const read = () => environment.set({ language: languageOf(inner.locale.getSnapshot()?.active) });
    read();
    inner.on("locale/change", read);
  });
  ctx.inject(["configForms"], (inner) => {
    const form = inner.configForms.get(HOST_ENTRY);
    settingsForm = form;
    const read = () => {
      const value = form?.getSnapshot?.()?.value ?? {};
      environment.set({
        settings: {
          liveFloat: typeof value.liveFloat === "boolean" ? value.liveFloat : DEFAULTS.liveFloat,
          openWith: value.openWith === "kition" ? "kition" : "dsh",
          autoOpen: typeof value.autoOpen === "boolean" ? value.autoOpen : DEFAULTS.autoOpen
        }
      });
    };
    read();
    if (typeof form?.subscribe === "function") inner.effect(() => form.subscribe(read), "kition: settings");
    inner.effect(() => inner.slots.inject("plugins.bundle.config", () => inner.slots.register({ name: "plugins.bundle.config", key: name }, SettingsCard)), "kition: settings card");
  });
  ctx.inject(["shortcuts"], (inner) => {
    const mac = /Mac|iPhone|iPad/i.test(navigator.platform);
    const read = () => environment.set({ keys: webKeys(inner.shortcuts, mac) });
    read();
    if (typeof inner.shortcuts.catalog?.subscribe === "function") inner.effect(() => inner.shortcuts.catalog.subscribe(read), "kition: shortcuts");
  });
  ctx.inject(["sidebarRightTabs"], (inner) => {
    inner.effect(() => {
      const disposeBody = inner.slots.inject("sidebar.right.pane.tab", () => inner.slots.register({ name: "sidebar.right.pane.tab", key: TAB_TYPE }, TabBody));
      const disposeTitle = inner.slots.inject("sidebar.right.pane.tab.title", () => inner.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_TYPE }, TabTitle));
      const disposeType = inner.sidebarRightTabs.register({
        id: TAB_TYPE,
        kind: TAB_TYPE,
        patterns: TAB_EXTENSIONS.map((extension) => `*.${extension}`),
        priority: "extension",
        canOpen: (address) => {
          const parsed = parseFileAddress(address);
          return parsed !== null && extensionOf(parsed.path) in KIT_FORMATS;
        },
        title: (address) => baseName(parseFileAddress(address)?.path ?? address)
      });
      return () => {
        disposeType();
        disposeTitle();
        disposeBody();
      };
    }, "kition: sidebar tab type");
    inner.effect(() => inner.slots.inject("sidebar.right.pane.tab.title", () => inner.slots.register({ name: "sidebar.right.pane.tab.title", key: TEXT_TYPE, priority: -10 }, textTitle(primitives()))), "kition: preview title");
  });
  ctx.inject(["sidebarRight"], (inner) => {
    environment.sidebar = inner.sidebarRight;
    if (typeof inner.sidebarRight.registerCloseHandler !== "function") return;
    for (const kind of [TAB_TYPE, TEXT_KIND]) {
      inner.effect(() => {
        try {
          const dispose = inner.sidebarRight.registerCloseHandler(kind, closeGuard);
          guards[kind === TAB_TYPE ? "kition" : "text"] = true;
          return () => {
            guards[kind === TAB_TYPE ? "kition" : "text"] = false;
            dispose();
          };
        } catch {
          return () => void 0;
        }
      }, `kition: close guard (${kind})`);
    }
  });
  if (location.protocol !== "dsh-app:") {
    const unloadGuard = (event) => {
      if (![...pages.values()].some((page) => page.dirty)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    ctx.effect(() => {
      window.addEventListener("beforeunload", unloadGuard);
      return () => window.removeEventListener("beforeunload", unloadGuard);
    }, "kition: unload guard");
  }
  ctx.inject(["documentPreviews"], (inner) => {
    for (const [kit, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
      const id = previewId(kit);
      inner.effect(() => inner.slots.inject("sidebar.right.tab.document", () => inner.slots.register({ name: "sidebar.right.tab.document", key: id }, PreviewBody)), `kition: ${kit} preview body`);
    }
    let registered = [];
    let priority = null;
    const register = () => {
      const next = environment.settings.openWith === "kition" ? "extension" : "builtin";
      if (next === priority) return;
      priority = next;
      for (const dispose of registered) dispose();
      registered = Object.entries(PREVIEW_EXTENSIONS).map(
        ([kit, extensions]) => inner.documentPreviews.register({ id: previewId(kit), extensions, priority: next, loading: "renderer", title: () => environment.t("openWith", { kit: kitName(kit) }) })
      );
    };
    register();
    inner.effect(() => {
      const stop = environment.subscribe(register);
      return () => {
        stop();
        for (const dispose of registered) dispose();
        registered = [];
        priority = null;
      };
    }, "kition: previews");
  });
  ctx.inject(["uiConversation"], (inner) => {
    try {
      inner.uiConversation.events.register(kitTurnDefinition);
    } catch (error) {
      if (!(error instanceof Error) || !/already registered/.test(error.message)) throw error;
    }
    inner.effect(() => inner.slots.inject("conversation.chat.turnTail", () => inner.slots.register({ name: "conversation.chat.turnTail", id: "kition-cards" }, TurnCards)), "kition: review cards");
    inner.effect(() => inner.slots.inject("conversation.input.dock", () => inner.slots.register({ name: "conversation.input.dock", id: "kition-live", order: 900 }, LiveWatcher)), "kition: live window");
  });
}
function primitives() {
  try {
    return require("@deepseek-ai/dsh-client-ui-primitives") ?? null;
  } catch {
    return null;
  }
}
exports.TAB_TYPE = TAB_TYPE;
exports.apply = apply;
exports.inject = inject;
exports.name = name;
    return module.exports;
  }
});
