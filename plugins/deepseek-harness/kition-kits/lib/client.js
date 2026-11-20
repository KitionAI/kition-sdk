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
  state = { ready: false, title: null, kit: null, status: null, dirty: false, draft: null };
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
        Object.assign(this.state, { title: message.title, kit: message.kit, status: message.status, dirty: message.dirty, progress: message.progress, detail: message.detail });
        break;
      case "draft":
        this.state.draft = message.draft;
        break;
      case "reviewed":
        this.state.draft = null;
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
  dispose() {
    window.removeEventListener("message", this.listener);
  }
}
const NAMESPACE = "kitionKits";
const en = {
  openWith: "Kition {kit}",
  starting: "Starting Kition…",
  startingDetail: "Kition is starting for this folder.",
  missingTitle: "Kition is not installed",
  missingDetail: "Install Kition, then restart DeepSeek Harness:",
  missingOr: "or",
  unreachableTitle: "Kition does not answer",
  unreachableDetail: "Kition could not open this file.",
  retry: "Try again",
  outsideTitle: "This file is outside the session’s folder",
  outsideDetail: "Kition opens files inside the folder this session works in.",
  noSession: "Open a session to edit this file with Kition.",
  closeDirty: "{name} has unsaved changes in Kition. Close it and lose them?",
  draft: "Draft",
  draftTitle: "An agent drafted changes to this file"
};
const zh = {
  openWith: "Kition {kit}",
  starting: "正在启动 Kition…",
  startingDetail: "Kition 正在为这个文件夹启动。",
  missingTitle: "没有安装 Kition",
  missingDetail: "安装 Kition，然后重启 DeepSeek Harness：",
  missingOr: "或",
  unreachableTitle: "Kition 没有响应",
  unreachableDetail: "Kition 无法打开这个文件。",
  retry: "重试",
  outsideTitle: "这个文件不在会话的文件夹里",
  outsideDetail: "Kition 只打开这个会话所在文件夹里的文件。",
  noSession: "打开一个会话，才能用 Kition 编辑这个文件。",
  closeDirty: "{name} 在 Kition 里有未保存的修改。关闭并丢弃这些修改吗？",
  draft: "草稿",
  draftTitle: "Agent 起草了对这个文件的修改"
};
const fill = (text, params = {}) => text.replace(/\{(\w+)\}/g, (whole, name2) => params[name2] ?? whole);
const table = { "docx": "doc", "dxf": "cad", "htm": "html", "html": "html", "kboard": "board", "kdesign": "design", "kfilm": "film", "klayout": "layout", "kmotion": "motion", "kphoto": "photo", "kscene": "scene", "kslide": "slide", "ktable": "table", "kvector": "vector", "markdown": "note", "md": "note", "pdf": "pdf", "pptx": "slide", "psb": "photo", "psd": "photo", "xlsm": "sheet", "xlsx": "sheet" };
const KIT_EXTENSIONS = table;
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
const h = React__namespace.createElement;
const name = "@kition/dsh-kits";
const inject = ["slots"];
const TAB_TYPE = "kition";
const previewId = (kit) => `kition/${kit}`;
class Environment {
  listeners = /* @__PURE__ */ new Set();
  scheme = "light";
  language = "en";
  translate = null;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(changes) {
    Object.assign(this, changes);
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
const schemeOf = (snapshot) => snapshot?.active?.colorScheme === "dark" ? "dark" : "light";
const languageOf = (active) => typeof active === "string" && active.toLowerCase().startsWith("zh") ? "zh" : "en";
const route = (path) => new URL(path, document.baseURI).href;
async function open(sessionId, path) {
  try {
    const response = await fetch(route(`kition/api/open?${new URLSearchParams({ session: sessionId, path })}`), { credentials: "same-origin", cache: "no-store" });
    const answer = await response.json().catch(() => ({}));
    if (response.ok && typeof answer.page === "string") return { phase: "open", page: answer.page };
    return { phase: "failed", error: String(answer.error ?? `http-${response.status}`), message: String(answer.message ?? response.statusText) };
  } catch (error) {
    return { phase: "failed", error: "unreachable", message: error.message };
  }
}
function forwardShortcut(key) {
  const init = { key: key.key, code: key.code, metaKey: !!key.meta, ctrlKey: !!key.ctrl, shiftKey: !!key.shift, altKey: !!key.alt, bubbles: true, cancelable: true };
  document.body.dispatchEvent(new KeyboardEvent("keydown", init));
  document.body.dispatchEvent(new KeyboardEvent("keyup", init));
}
function useEnvironment() {
  React__namespace.useSyncExternalStore(environment.subscribe, () => `${environment.scheme}:${environment.language}`);
  return environment;
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
const code = (text) => h("code", { style: { userSelect: "all", padding: "6px 8px", borderRadius: "4px", background: "rgba(127,127,127,0.15)", fontSize: "12px", overflowWrap: "anywhere" } }, text);
function KitionView(props) {
  const env = useEnvironment();
  const parsed = parseFileAddress(props.address);
  const sessionId = parsed?.scope === "session" ? parsed.sessionId : props.sessionId;
  const path = parsed?.path ?? "";
  const fileName = baseName(path);
  const [attempt, setAttempt] = React__namespace.useState(0);
  const [opened, setOpened] = React__namespace.useState({ phase: "opening" });
  const host = React__namespace.useRef(null);
  const frameRef = React__namespace.useRef(null);
  const latest = React__namespace.useRef(props);
  latest.current = props;
  React__namespace.useEffect(() => {
    if (!sessionId || !path) return;
    let current = true;
    setOpened({ phase: "opening" });
    void open(sessionId, path).then((result) => current && setOpened(result));
    return () => {
      current = false;
    };
  }, [sessionId, path, attempt]);
  React__namespace.useEffect(() => {
    if (opened.phase !== "open" || !host.current) return;
    const url = new URL(opened.page, document.baseURI);
    url.searchParams.set("theme", environment.scheme);
    url.searchParams.set("locale", environment.language);
    const frame = makeFrame(props.tabId, url.href, `Kition ${fileName}`);
    const page = new PageFrame(
      frame,
      {
        change: (state) => {
          setPage(props.tabId, { ...state, name: fileName });
          if (state.status === "open") latest.current.onOpen?.();
        },
        shortcut: forwardShortcut,
        requestClose: (dirty) => {
          if (latest.current.guardClose && dirty && !window.confirm(environment.t("closeDirty", { name: fileName }))) return;
          latest.current.close?.();
        }
      },
      environment.scheme,
      environment.language
    );
    frameRef.current = page;
    setPage(props.tabId, { ...page.state, name: fileName });
    const stop = environment.subscribe(() => {
      page.setTheme(environment.scheme);
      page.setLanguage(environment.language);
    });
    host.current.replaceChildren(frame);
    return () => {
      stop();
      page.dispose();
      frameRef.current = null;
      frame.remove();
      setPage(props.tabId, null);
    };
  }, [opened, props.tabId, fileName]);
  if (!sessionId || !path) return h(Panel, { state: "no-session", title: env.t("noSession") });
  if (opened.phase === "opening") return h(Panel, { state: "starting", title: env.t("starting"), detail: env.t("startingDetail") });
  if (opened.phase === "failed") {
    const retry = () => setAttempt((n) => n + 1);
    if (opened.error === "kition-missing" || opened.error === "kition-invalid")
      return h(
        Panel,
        { state: "kition-missing", title: env.t("missingTitle"), detail: env.t("missingDetail"), onRetry: retry },
        code("npm install -g @kition/cli"),
        h("div", { style: { opacity: 0.8 } }, env.t("missingOr")),
        code("curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh"),
        opened.error === "kition-invalid" ? h("div", { style: { opacity: 0.7, fontSize: "12px" } }, opened.message) : null
      );
    if (opened.error === "outside-workspace") return h(Panel, { state: "outside-workspace", title: env.t("outsideTitle"), detail: env.t("outsideDetail") });
    return h(Panel, { state: "unreachable", title: env.t("unreachableTitle"), detail: env.t("unreachableDetail"), onRetry: retry }, h("div", { style: { opacity: 0.7, fontSize: "12px" } }, opened.message));
  }
  return h("div", { ref: host, "data-kition-view": "", style: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, WebkitAppRegion: "no-drag" } });
}
function TabBody(props) {
  const info = props.useTabInfo();
  return h(KitionView, { address: info.tab.contentId, sessionId: props.sessionId, tabId: info.tab.id, close: () => info.tab.actions?.close?.(), guardClose: false });
}
function TabTitle(props) {
  const env = useEnvironment();
  const info = props.useTabInfo();
  React__namespace.useSyncExternalStore(subscribePages, () => pages.get(info.tab.id));
  const page = pages.get(info.tab.id);
  return h(
    React__namespace.Fragment,
    null,
    info.tab.title,
    page?.dirty ? h("span", { "data-kition-dirty": "", "aria-label": "unsaved", style: { marginLeft: "4px" } }, "●") : null,
    page?.draft ? h("span", { "data-kition-draft": page.draft.state, title: env.t("draftTitle"), style: { marginLeft: "6px", fontSize: "10px", padding: "0 4px", borderRadius: "6px", whiteSpace: "nowrap", background: "rgba(255,170,0,0.25)" } }, env.t("draft")) : null
  );
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
    guardClose: true,
    onOpen: () => {
      if (loaded.current || content?.kind !== "renderer") return;
      loaded.current = true;
      content.loaded(String(content.revision));
    }
  });
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
          return parsed !== null && extensionOf(parsed.path) in KIT_EXTENSIONS;
        },
        title: (address) => baseName(parseFileAddress(address)?.path ?? address)
      });
      return () => {
        disposeType();
        disposeTitle();
        disposeBody();
      };
    }, "kition: sidebar tab type");
  });
  ctx.inject(["sidebarRight"], (inner) => {
    if (typeof inner.sidebarRight.registerCloseHandler !== "function") return;
    inner.effect(
      () => inner.sidebarRight.registerCloseHandler(TAB_TYPE, (_session, tab) => {
        const page = pages.get(tab.id);
        if (page?.dirty && !window.confirm(environment.t("closeDirty", { name: page.name }))) throw new Error("Kition: the tab keeps its unsaved edits");
      }),
      "kition: close guard"
    );
  });
  ctx.inject(["documentPreviews"], (inner) => {
    for (const [kit, extensions] of Object.entries(PREVIEW_EXTENSIONS)) {
      const id = previewId(kit);
      inner.effect(
        () => inner.documentPreviews.register({
          id,
          extensions,
          priority: "builtin",
          loading: "renderer",
          title: () => environment.t("openWith", { kit: kitName(kit) })
        }),
        `kition: ${kit} preview`
      );
      inner.effect(() => inner.slots.inject("sidebar.right.tab.document", () => inner.slots.register({ name: "sidebar.right.tab.document", key: id }, PreviewBody)), `kition: ${kit} preview body`);
    }
  });
}
exports.TAB_TYPE = TAB_TYPE;
exports.apply = apply;
exports.inject = inject;
exports.name = name;
    return module.exports;
  }
});
