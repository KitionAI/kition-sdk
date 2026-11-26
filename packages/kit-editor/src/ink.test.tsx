// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InkGroup, type DrawState } from "./ink";
import {
  KitEditorProvider,
  createKitStrings,
  type KitEditor,
  type KitTools,
} from "./editor";
import { EMPTY_UI_CONFIG } from "./uiConfig";
import { createUiStore } from "./uiStore";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
});

function fakeEditor(state: DrawState, locale = "en-US") {
  const ui = createUiStore(EMPTY_UI_CONFIG, null, () => undefined);
  let current = state;
  return {
    session: {
      doc: {
        info: { canUndo: false, canRedo: false, dirty: false, revision: 1 },
      },
      change: { revision: 1 },
      dirty: false,
      saving: false,
      editedBy: null,
    },
    host: {
      ui,
      init: { locale, capabilities: [], document: { path: "a" } },
      declaration: {},
      peer: { handle() {} },
      openAgent: vi.fn(),
    },
    commands: [],
    byId: new Map(),
    enabled: () => true,
    run: vi.fn(async (id: string, params: Record<string, unknown>) => {
      const tool = id.replace("ink.", "");
      current = {
        tool,
        color: (params.color as string) ?? current.color,
        width: (params.width as number) ?? current.width,
      };
      return null;
    }),
    ask: vi.fn(),
    query: vi.fn(async () => current),
    save: vi.fn(async () => undefined),
    dialog: null,
    setDialog: vi.fn(),
    t: createKitStrings({}, locale),
    phrase: (english: string) => english,
    testId: "k",
  } as unknown as KitEditor;
}

async function render(editor: KitEditor, tools: KitTools | null = null) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <KitEditorProvider editor={editor} tools={tools}>
        <InkGroup testId="i" />
      </KitEditorProvider>,
    ),
  );
}

const byTestId = (id: string) =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = async (element: Element | null) =>
  act(
    async () =>
      void element?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );

describe("ink controls", () => {
  it("pick pens through the draw commands and set the pen in hand", async () => {
    const editor = fakeEditor({ tool: "select", color: "#000000", width: 2 });
    await render(editor);
    expect(byTestId("i-select")?.getAttribute("aria-pressed")).toBe("true");
    expect((byTestId("i-color") as HTMLButtonElement).disabled).toBe(true);
    await click(byTestId("i-highlighter"));
    expect(editor.run).toHaveBeenLastCalledWith("ink.highlighter", {});
    expect(byTestId("i-highlighter")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    await click(byTestId("i-weight"));
    await click(byTestId("i-weight-6"));
    expect(editor.run).toHaveBeenLastCalledWith("ink.highlighter", {
      width: 6,
    });
    await click(byTestId("i-color"));
    await click(byTestId("i-colors")?.querySelector("button") ?? null);
    expect(editor.run).toHaveBeenLastCalledWith(
      "ink.highlighter",
      expect.objectContaining({ color: expect.stringMatching(/^#/) }),
    );
    await click(byTestId("i-eraser"));
    expect(editor.run).toHaveBeenLastCalledWith("ink.eraser", {});
  });

  it("switch an engine tool of the same id through the tools, and name the pens in Chinese", async () => {
    const editor = fakeEditor(
      { tool: "select", color: "#000000", width: 2 },
      "zh-CN",
    );
    const select = vi.fn();
    const tools = {
      tools: [{ id: "select" }, { id: "pen" }, { id: "eraser" }],
      active: "select",
      select,
    } as unknown as KitTools;
    await render(editor, tools);
    await click(byTestId("i-pen"));
    expect(select).toHaveBeenCalledWith("pen");
    expect(editor.run).not.toHaveBeenCalledWith("ink.pen", {});
    // A pen the engine has no tool for goes through its command.
    await click(byTestId("i-pencil"));
    expect(editor.run).toHaveBeenLastCalledWith("ink.pencil", {});
    expect(byTestId("i-highlighter")?.getAttribute("aria-label")).toBe(
      "荧光笔",
    );
  });
});
