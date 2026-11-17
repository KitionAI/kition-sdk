// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartDesignGroups, ChartInsertMenu, type ChartSpec } from "./chart";
import { KitEditorProvider, createKitStrings, type KitEditor } from "./editor";
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

const SPEC: ChartSpec = {
  kind: "column",
  title: "Sales",
  categories: ["Q1", "Q2"],
  series: [
    { name: "East", values: [1, 2] },
    { name: "West", values: [3, null] },
  ],
  legend: "bottom",
  dataLabels: false,
  gridlines: true,
};

function fakeEditor(spec: ChartSpec | null = SPEC, locale = "en-US") {
  const ui = createUiStore(EMPTY_UI_CONFIG, null, () => undefined);
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
    run: vi.fn(async () => null),
    ask: vi.fn(),
    query: vi.fn(async () => ({
      objects: spec ? [{ id: "c1", kind: "chart", chart: spec }] : [],
    })),
    save: vi.fn(async () => undefined),
    dialog: null,
    setDialog: vi.fn(),
    t: createKitStrings({}, locale),
    phrase: (english: string) => english,
    testId: "k",
  } as unknown as KitEditor;
}

async function render(editor: KitEditor, node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<KitEditorProvider editor={editor}>{node}</KitEditorProvider>),
  );
}

const byTestId = (id: string) =>
  document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = (element: Element | null) =>
  act(
    () =>
      void element?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
function type(element: Element | null, value: string) {
  const input = element as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("chart controls", () => {
  it("insert a chart of a type through drawing.insert", async () => {
    const editor = fakeEditor();
    await render(editor, <ChartInsertMenu testId="c" />);
    click(byTestId("c-insert"));
    click(byTestId("c-insert-line"));
    expect(editor.run).toHaveBeenCalledWith("drawing.insert", {
      kind: "chart",
      chart: { kind: "line" },
    });
  });

  it("change the type and the elements of the chart through drawing.chart", async () => {
    const editor = fakeEditor();
    await render(editor, <ChartDesignGroups id="c1" testId="c" />);
    expect(editor.query).toHaveBeenCalledWith("drawing.describe", {
      ids: ["c1"],
    });
    expect(byTestId("c-title")?.getAttribute("aria-pressed")).toBe("true");
    click(byTestId("c-title"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      title: null,
    });
    click(byTestId("c-type"));
    click(byTestId("c-type-bar"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      kind: "bar",
    });
    // A pie shows one series: the change keeps the first.
    click(byTestId("c-type"));
    click(byTestId("c-type-pie"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      kind: "pie",
      series: [{ name: "East", values: [1, 2] }],
    });
    click(byTestId("c-legend"));
    click(byTestId("c-legend-none"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      legend: null,
    });
    click(byTestId("c-data-labels"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      dataLabels: true,
    });
    click(byTestId("c-axis-titles"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      xTitle: "Axis Title",
      yTitle: "Axis Title",
    });
  });

  it("add a trendline or error bars to every series, and leave them off pies and kits without them", async () => {
    const editor = fakeEditor();
    await render(editor, <ChartDesignGroups id="c1" testId="c" />);
    click(byTestId("c-trendline"));
    click(byTestId("c-trendline-forecast"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      seriesFormat: [
        { index: 0, trendline: { kind: "linear", forward: 2 } },
        { index: 1, trendline: { kind: "linear", forward: 2 } },
      ],
    });
    click(byTestId("c-error-bars"));
    click(byTestId("c-error-bars-none"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      seriesFormat: [
        { index: 0, errorBars: null },
        { index: 1, errorBars: null },
      ],
    });
    document.body.innerHTML = "";
    await render(fakeEditor({ ...SPEC, kind: "pie" }), <ChartDesignGroups id="c1" testId="p" />);
    expect((byTestId("p-trendline") as HTMLButtonElement).disabled).toBe(true);
    document.body.innerHTML = "";
    await render(fakeEditor(), <ChartDesignGroups id="c1" testId="s" formats={["smooth"]} />);
    expect(byTestId("s-trendline")).toBeNull();
  });

  it("edit the data in a grid, refusing what is not a number", async () => {
    const editor = fakeEditor();
    await render(editor, <ChartDesignGroups id="c1" testId="c" />);
    click(byTestId("c-edit-data"));
    expect((byTestId("c-data-cell-1-1") as HTMLInputElement).value).toBe("");
    type(byTestId("c-data-cell-0-1"), "x");
    expect((byTestId("c-data-ok") as HTMLButtonElement).disabled).toBe(true);
    type(byTestId("c-data-cell-0-1"), "2.5");
    type(byTestId("c-data-series-1"), "North");
    click(byTestId("c-data-add-category"));
    type(byTestId("c-data-cell-1-2"), "7");
    click(byTestId("c-data-ok"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      categories: ["Q1", "Q2", "Category 3"],
      series: [
        { name: "East", values: [1, 2.5, null] },
        { name: "North", values: [3, null, 7] },
      ],
    });
    expect(byTestId("c-data")).toBeNull();
  });

  it("leave data to a kit whose charts show its cells, and name every control in Chinese", async () => {
    const editor = fakeEditor(SPEC, "zh-CN");
    await render(
      editor,
      <ChartDesignGroups id="c1" testId="c" dataEditable={false} />,
    );
    expect(byTestId("c-edit-data")).toBeNull();
    expect(byTestId("c-gridlines")?.getAttribute("aria-label")).toBe("网格线");
  });

  it("format an axis: blank is automatic, a bad scale is refused", async () => {
    const editor = fakeEditor({ ...SPEC, yAxis: { max: 10 } });
    await render(editor, <ChartDesignGroups id="c1" testId="c" />);
    click(byTestId("c-format-axis"));
    expect((byTestId("c-axis-max") as HTMLInputElement).value).toBe("10");
    type(byTestId("c-axis-min"), "12");
    expect((byTestId("c-axis-ok") as HTMLButtonElement).disabled).toBe(true);
    type(byTestId("c-axis-min"), "0");
    type(byTestId("c-axis-major"), "2.5");
    type(byTestId("c-axis-numberFormat"), "0.0");
    click(byTestId("c-axis-ok"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      yAxis: { min: 0, max: 10, major: 2.5, numberFormat: "0.0", hidden: false },
    });
    // A column chart's category axis has no scale: it only shows or hides.
    click(byTestId("c-format-axis"));
    const which = byTestId("c-axis-which") as HTMLSelectElement;
    act(() => {
      which.value = "xAxis";
      which.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(byTestId("c-axis-min")).toBeNull();
    click(byTestId("c-axis-shown"));
    click(byTestId("c-axis-ok"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      xAxis: { numberFormat: null, hidden: true },
    });
  });

  it("place labels where the type allows, turning them on", async () => {
    const editor = fakeEditor();
    await render(editor, <ChartDesignGroups id="c1" testId="c" />);
    click(byTestId("c-label-position"));
    expect(byTestId("c-label-position-t")).toBeNull();
    click(byTestId("c-label-position-outEnd"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      dataLabels: true,
      dataLabelPosition: "outEnd",
    });
  });

  it("format a line series, and offer a kit only what its charts take", async () => {
    const line: ChartSpec = { ...SPEC, kind: "line" };
    line.series = [SPEC.series[0], { ...SPEC.series[1], lineWidth: 3, marker: "circle" }];
    const editor = fakeEditor(line);
    await render(editor, <ChartDesignGroups id="c1" testId="c" />);
    click(byTestId("c-format-series"));
    const which = byTestId("c-series-which") as HTMLSelectElement;
    act(() => {
      which.value = "1";
      which.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect((byTestId("c-series-width") as HTMLInputElement).value).toBe("3");
    expect((byTestId("c-series-marker") as HTMLSelectElement).value).toBe("circle");
    type(byTestId("c-series-width"), "");
    click(byTestId("c-series-smooth"));
    click(byTestId("c-series-ok"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      seriesFormat: [{ index: 1, lineWidth: null, marker: "circle", smooth: true, kind: null, secondary: false }],
    });

    document.body.innerHTML = "";
    const sheet = fakeEditor(line);
    await render(sheet, <ChartDesignGroups id="c1" testId="s" formats={["smooth"]} />);
    expect(byTestId("s-format-axis")).toBeNull();
    expect(byTestId("s-label-position")).toBeNull();
    click(byTestId("s-format-series"));
    expect(byTestId("s-series-width")).toBeNull();
    expect(byTestId("s-series-marker")).toBeNull();
    click(byTestId("s-series-smooth"));
    click(byTestId("s-series-ok"));
    expect(sheet.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      seriesFormat: [{ index: 0, smooth: true }],
    });
  });

  it("make a series a line on the secondary axis of a column chart", async () => {
    const editor = fakeEditor();
    await render(editor, <ChartDesignGroups id="c1" testId="c" />);
    click(byTestId("c-format-series"));
    const which = byTestId("c-series-which") as HTMLSelectElement;
    act(() => {
      which.value = "1";
      which.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const kind = byTestId("c-series-kind") as HTMLSelectElement;
    act(() => {
      kind.value = "line";
      kind.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click(byTestId("c-series-secondary"));
    click(byTestId("c-series-ok"));
    expect(editor.run).toHaveBeenLastCalledWith("drawing.chart", {
      id: "c1",
      seriesFormat: [{ index: 1, lineWidth: null, kind: "line", secondary: true }],
    });
  });
});
