import { useEffect, useState } from "react";
import { LayoutGridIcon as LayoutGrid, TableIcon as Table, PaletteIcon as Palette, ChartAreaIcon as AreaChart, ChartColumnIcon as BarChart3, ChartColumnIcon as ChartColumn, ChartColumnStackedIcon as ChartColumnStacked, ChartLineIcon as ChartLine, ChartPieIcon as ChartPie, ChartScatterIcon as ChartScatter, Grid3x3Icon as Grid3x3, HashIcon as Hash, HeadingIcon as Heading, PenLineIcon as PenLine, RulerIcon as Ruler, TagIcon as Tag, RadarIcon as Radar, Table2Icon as Table2, TrendingUpIcon as TrendingUp, TypeIcon as Type, type IconComponent } from "@kition/tessera-icons/react";
import {
  Button,
  Dialog,
  MenuItem,
  MenuSeparator,
  RibbonButton,
  RibbonGroup,
  RibbonStack,
} from "@kition/tessera-ui";
import { Checkbox, Choice } from "@kition/tessera-ui";
import { RibbonMenu, useKitEditor } from "./editor";

/**
 * Ribbon controls for charts, shared by every kit that implements `KitDrawing 1.1`'s charts
 * (`drawing.insert` of kind `chart`, `drawing.chart`, `drawing.describe`'s `chart` member). Like
 * the shape controls they hold no model: they read the chart's description and run commands, so
 * the person's edit and an agent's are the same change.
 */

/** An axis's scale and labels (`AxisSpec`); members left out are automatic. */
export type ChartAxis = {
  min?: number;
  max?: number;
  major?: number;
  numberFormat?: string;
  hidden?: boolean;
};

/** A chart's description (`ChartSpec`, `KitDrawing 1.1` DR15). */
export type ChartSpec = {
  kind: string | { other: string };
  title?: string;
  categories: string[];
  series: Array<{
    name: string;
    values: Array<number | null>;
    color?: unknown;
    kind?: string | { other: string };
    lineWidth?: number;
    marker?: string;
    smooth?: boolean;
    trendline?: { kind: string; order?: number; period?: number; forward?: number; backward?: number };
    errorBars?: { kind: string; value?: number };
    secondary?: boolean;
  }>;
  legend?: string;
  dataLabels: boolean;
  gridlines: boolean;
  xTitle?: string;
  yTitle?: string;
  xAxis?: ChartAxis;
  yAxis?: ChartAxis;
  dataLabelPosition?: string;
};

/** The formatting a kit's charts take through `drawing.chart` (Chart Design › Format). */
export type ChartFormat =
  | "axes"
  | "labelPosition"
  | "lineWidth"
  | "marker"
  | "smooth"
  | "trends"
  | "combo";

export const CHART_FORMATS: readonly ChartFormat[] = [
  "axes",
  "labelPosition",
  "lineWidth",
  "marker",
  "smooth",
  "trends",
  "combo",
];

/** The types a series of a combination takes (Format Series › Chart Type). */
export const COMBO_KINDS = ["column", "stackedColumn", "line", "lineMarkers", "area"] as const;

/** Chart Elements › Trendline: Office's quick choices (DrawingML `ST_TrendlineType`). */
export const CHART_TRENDLINES: ReadonlyArray<{ id: string; label: string; trendline: { kind: string; forward?: number; period?: number } }> = [
  { id: "linear", label: "chartTrendLinear", trendline: { kind: "linear" } },
  { id: "exp", label: "chartTrendExp", trendline: { kind: "exp" } },
  { id: "forecast", label: "chartTrendForecast", trendline: { kind: "linear", forward: 2 } },
  { id: "movingAvg", label: "chartTrendMovingAvg", trendline: { kind: "movingAvg", period: 2 } },
];

/** Chart Elements › Error Bars: Office's quick choices (DrawingML `ST_ErrValType`). */
export const CHART_ERROR_BARS: ReadonlyArray<{ id: string; label: string; errorBars: { kind: string; value?: number } }> = [
  { id: "stdErr", label: "chartErrStdErr", errorBars: { kind: "stdErr" } },
  { id: "percentage", label: "chartErrPercent", errorBars: { kind: "percentage", value: 5 } },
  { id: "stdDev", label: "chartErrStdDev", errorBars: { kind: "stdDev", value: 1 } },
];

/** Series markers (DrawingML `ST_MarkerStyle`). */
export const CHART_MARKERS = [
  "none",
  "auto",
  "circle",
  "dash",
  "diamond",
  "dot",
  "plus",
  "square",
  "star",
  "triangle",
  "x",
] as const;

/** Where a type's data labels may sit, as Office offers them. */
export function labelPositions(kind: ChartSpec["kind"] | undefined): string[] {
  switch (kind) {
    case "pie":
      return ["bestFit", "ctr", "inEnd", "outEnd"];
    case "doughnut":
      return [];
    case "column":
    case "bar":
      return ["ctr", "inBase", "inEnd", "outEnd"];
    case "stackedColumn":
    case "percentColumn":
    case "stackedBar":
    case "percentBar":
      return ["ctr", "inBase", "inEnd"];
    case "line":
    case "lineMarkers":
    case "stackedLine":
    case "scatter":
      return ["ctr", "l", "r", "t", "b"];
    default:
      return [];
  }
}

/** Whether a type draws its series as lines, which take markers and smoothing. */
export function linesOf(kind: ChartSpec["kind"] | undefined): boolean {
  return (
    kind === "line" ||
    kind === "lineMarkers" ||
    kind === "stackedLine" ||
    kind === "scatter" ||
    kind === "radar"
  );
}

/** The chart types the controls offer, by `KitDrawing` name. */
export const CHART_KINDS: ReadonlyArray<{
  kind: string;
  icon: IconComponent;
  label: string;
}> = [
  { kind: "column", icon: ChartColumn, label: "chartColumn" },
  {
    kind: "stackedColumn",
    icon: ChartColumnStacked,
    label: "chartStackedColumn",
  },
  { kind: "bar", icon: BarChart3, label: "chartBar" },
  { kind: "line", icon: ChartLine, label: "chartLine" },
  { kind: "lineMarkers", icon: ChartLine, label: "chartLineMarkers" },
  { kind: "area", icon: AreaChart, label: "chartArea" },
  { kind: "pie", icon: ChartPie, label: "chartPie" },
  { kind: "doughnut", icon: ChartPie, label: "chartDoughnut" },
  { kind: "scatter", icon: ChartScatter, label: "chartScatter" },
  { kind: "radar", icon: Radar, label: "chartRadar" },
];

const LEGENDS = ["top", "bottom", "left", "right"] as const;

/** Insert › Chart: a new chart of a type at the kit's default place, selected. */
export function ChartInsertMenu({
  testId = "chart",
  size = "large",
  primary,
}: {
  testId?: string;
  size?: "large" | "small";
  primary?: boolean;
}) {
  const editor = useKitEditor();
  const { t } = editor;
  return (
    <RibbonMenu
      icon={ChartColumn}
      label={t("chartInsert")}
      size={size}
      disabled={!editor.enabled("drawing.insert")}
      testId={`${testId}-insert`}
      primary={primary}
    >
      {CHART_KINDS.map((k) => (
        <MenuItem
          key={k.kind}
          icon={k.icon}
          label={t(k.label)}
          testId={`${testId}-insert-${k.kind}`}
          onSelect={() =>
            void editor.run("drawing.insert", {
              kind: "chart",
              chart: { kind: k.kind },
            })
          }
        />
      ))}
    </RibbonMenu>
  );
}

/** The description of chart `id`, read again after every change to the document. */
export function useChartSpec(id: string | null): ChartSpec | null {
  const editor = useKitEditor();
  const revision =
    (editor.session as { change?: { revision?: number } }).change?.revision ??
    editor.session.doc?.info?.revision;
  const [spec, setSpec] = useState<ChartSpec | null>(null);
  useEffect(() => {
    if (!id) {
      setSpec(null);
      return undefined;
    }
    let stale = false;
    void editor
      .query<{ objects?: Array<{ chart?: ChartSpec }> }>("drawing.describe", {
        ids: [id],
      })
      .then((answer) => {
        if (!stale) setSpec(answer?.objects?.[0]?.chart ?? null);
      });
    return () => {
      stale = true;
    };
  }, [editor, id, revision]);
  return spec;
}

/**
 * Chart Design for chart `id`: its type, its elements (title, legend, data labels, gridlines,
 * axis titles), its formatting (axes, label position, series looks) and its data.
 * `dataEditable` false (a spreadsheet, whose charts show its cells) leaves the data to the kit;
 * `formats` names the formatting the kit's charts take (all by default).
 */
export function ChartDesignGroups({
  id,
  testId = "chart",
  dataEditable = true,
  formats = CHART_FORMATS,
}: {
  id: string;
  testId?: string;
  dataEditable?: boolean;
  formats?: readonly ChartFormat[];
}) {
  const editor = useKitEditor();
  const { t } = editor;
  const spec = useChartSpec(id);
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<"axis" | "series" | null>(null);
  const disabled = !spec || !editor.enabled("drawing.chart");
  const change = (params: Record<string, unknown>) =>
    void editor.run("drawing.chart", { id, ...params });
  const fixedType = typeof spec?.kind === "object";
  const pie = spec?.kind === "pie" || spec?.kind === "doughnut";
  // Pies, doughnuts, radar and the types the description does not edit take neither.
  const noTrends = pie || spec?.kind === "radar" || fixedType;
  // A trendline or error bars, as Office's Chart Elements add them: on every series.
  const everySeries = (look: Record<string, unknown>) =>
    change({ seriesFormat: (spec?.series ?? []).map((_, index) => ({ index, ...look })) });
  return (
    <>
      <RibbonGroup label={t("chartType")} icon={ChartColumn}>
        <RibbonMenu
          icon={ChartColumn}
          label={t("chartChangeType")}
          size="large"
          disabled={disabled || fixedType}
          testId={`${testId}-type`}
          primary
        >
          {CHART_KINDS.map((k) => (
            <MenuItem
              key={k.kind}
              icon={k.icon}
              label={t(k.label)}
              checked={spec?.kind === k.kind}
              testId={`${testId}-type-${k.kind}`}
              onSelect={() =>
                change(
                  k.kind === "pie" || k.kind === "doughnut"
                    ? pieOf(spec, k.kind)
                    : { kind: k.kind },
                )
              }
            />
          ))}
        </RibbonMenu>
      </RibbonGroup>
      <RibbonGroup label={t("chartElements")} icon={LayoutGrid}>
        <RibbonStack>
          <RibbonButton
            icon={Heading}
            label={t("chartTitle")}
            pressed={spec?.title != null}
            disabled={disabled}
            onClick={() =>
              change({
                title: spec?.title != null ? null : t("chartTitleText"),
              })
            }
            data-testid={`${testId}-title`}
            primary
          />
          <RibbonMenu
            icon={Type}
            label={t("chartLegend")}
            disabled={disabled}
            testId={`${testId}-legend`}
            primary
          >
            {LEGENDS.map((pos) => (
              <MenuItem
                key={pos}
                label={t(`chartLegend_${pos}`)}
                checked={spec?.legend === pos}
                testId={`${testId}-legend-${pos}`}
                onSelect={() => change({ legend: pos })}
              />
            ))}
            <MenuSeparator />
            <MenuItem
              label={t("chartLegendNone")}
              checked={spec != null && spec.legend == null}
              testId={`${testId}-legend-none`}
              onSelect={() => change({ legend: null })}
            />
          </RibbonMenu>
          <RibbonButton
            icon={Hash}
            label={t("chartDataLabels")}
            pressed={spec?.dataLabels ?? false}
            disabled={disabled}
            onClick={() => change({ dataLabels: !spec?.dataLabels })}
            data-testid={`${testId}-data-labels`}
            primary
          />
        </RibbonStack>
        <RibbonStack>
          <RibbonButton
            icon={Grid3x3}
            label={t("chartGridlines")}
            pressed={spec?.gridlines ?? false}
            disabled={disabled || pie}
            onClick={() => change({ gridlines: !spec?.gridlines })}
            data-testid={`${testId}-gridlines`}
          />
          {formats.includes("trends") ? (
            <>
              <RibbonMenu icon={TrendingUp} label={t("chartTrendline")} disabled={disabled || noTrends} testId={`${testId}-trendline`}>
                {CHART_TRENDLINES.map((tl) => (
                  <MenuItem key={tl.id} label={t(tl.label)} testId={`${testId}-trendline-${tl.id}`} onSelect={() => everySeries({ trendline: tl.trendline })} />
                ))}
                <MenuSeparator />
                <MenuItem label={t("chartNone")} testId={`${testId}-trendline-none`} onSelect={() => everySeries({ trendline: null })} />
              </RibbonMenu>
              <RibbonMenu icon={Ruler} label={t("chartErrorBars")} disabled={disabled || noTrends} testId={`${testId}-error-bars`}>
                {CHART_ERROR_BARS.map((eb) => (
                  <MenuItem key={eb.id} label={t(eb.label)} testId={`${testId}-error-bars-${eb.id}`} onSelect={() => everySeries({ errorBars: eb.errorBars })} />
                ))}
                <MenuSeparator />
                <MenuItem label={t("chartNone")} testId={`${testId}-error-bars-none`} onSelect={() => everySeries({ errorBars: null })} />
              </RibbonMenu>
            </>
          ) : null}
          <RibbonButton
            icon={Type}
            label={t("chartAxisTitles")}
            pressed={spec?.xTitle != null || spec?.yTitle != null}
            disabled={disabled || pie}
            onClick={() =>
              spec?.xTitle != null || spec?.yTitle != null
                ? change({ xTitle: null, yTitle: null })
                : change({
                    xTitle: t("chartAxisTitleText"),
                    yTitle: t("chartAxisTitleText"),
                  })
            }
            data-testid={`${testId}-axis-titles`}
          />
        </RibbonStack>
      </RibbonGroup>
      <ChartFormatGroup
        spec={spec}
        disabled={disabled}
        formats={formats}
        testId={testId}
        onChange={change}
        onDialog={setDialog}
      />
      {dataEditable ? (
        <RibbonGroup label={t("chartData")} icon={Table}>
          <RibbonButton
            icon={Table2}
            label={t("chartEditData")}
            size="large"
            disabled={disabled}
            onClick={() => setEditing(true)}
            data-testid={`${testId}-edit-data`}
            primary
          />
        </RibbonGroup>
      ) : null}
      {editing && spec ? (
        <ChartDataDialog
          spec={spec}
          testId={testId}
          onClose={() => setEditing(false)}
          onApply={(data) => change(data)}
        />
      ) : null}
      {dialog === "axis" && spec ? (
        <ChartAxisDialog
          spec={spec}
          testId={testId}
          onClose={() => setDialog(null)}
          onApply={change}
        />
      ) : null}
      {dialog === "series" && spec ? (
        <ChartSeriesDialog
          spec={spec}
          formats={formats}
          testId={testId}
          onClose={() => setDialog(null)}
          onApply={change}
        />
      ) : null}
    </>
  );
}

/** Chart Design › Format: the axes, where labels sit, and the series' looks. */
function ChartFormatGroup({
  spec,
  disabled,
  formats,
  testId,
  onChange,
  onDialog,
}: {
  spec: ChartSpec | null;
  disabled: boolean;
  formats: readonly ChartFormat[];
  testId: string;
  onChange: (params: Record<string, unknown>) => void;
  onDialog: (dialog: "axis" | "series") => void;
}) {
  const { t } = useKitEditor();
  const pie = spec?.kind === "pie" || spec?.kind === "doughnut";
  const fixedType = typeof spec?.kind === "object";
  const positions = labelPositions(spec?.kind);
  const seriesFormats = formats.filter(
    (f) => f === "lineWidth" || f === "marker" || f === "smooth" || f === "combo",
  );
  const seriesLook =
    seriesFormats.includes("lineWidth") ||
    (linesOf(spec?.kind) && seriesFormats.length > 0) ||
    (seriesFormats.includes("combo") &&
      typeof spec?.kind === "string" &&
      !["pie", "doughnut", "radar", "scatter"].includes(spec.kind));
  if (
    !formats.includes("axes") &&
    !formats.includes("labelPosition") &&
    seriesFormats.length === 0
  )
    return null;
  return (
    <RibbonGroup label={t("chartFormat")} icon={Palette}>
      <RibbonStack>
        {formats.includes("axes") ? (
          <RibbonButton
            icon={Ruler}
            label={t("chartFormatAxis")}
            disabled={disabled || pie || fixedType}
            onClick={() => onDialog("axis")}
            data-testid={`${testId}-format-axis`}
          />
        ) : null}
        {formats.includes("labelPosition") ? (
          <RibbonMenu
            icon={Tag}
            label={t("chartLabelPosition")}
            disabled={disabled || positions.length === 0}
            testId={`${testId}-label-position`}
          >
            {positions.map((pos) => (
              <MenuItem
                key={pos}
                label={t(`chartLabel_${pos}`)}
                checked={
                  spec?.dataLabels === true && spec.dataLabelPosition === pos
                }
                testId={`${testId}-label-position-${pos}`}
                onSelect={() =>
                  onChange({ dataLabels: true, dataLabelPosition: pos })
                }
              />
            ))}
          </RibbonMenu>
        ) : null}
        {seriesFormats.length > 0 ? (
          <RibbonButton
            icon={PenLine}
            label={t("chartFormatSeries")}
            disabled={disabled || fixedType || !seriesLook}
            onClick={() => onDialog("series")}
            data-testid={`${testId}-format-series`}
          />
        ) : null}
      </RibbonStack>
    </RibbonGroup>
  );
}

/** A number field's text as a change: blank is automatic (null). */
function numberOrAuto(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

const text = (n: number | undefined) => (n == null ? "" : String(n));

/** Format Axis: an axis's bounds, major unit, number format and whether it shows. */
export function ChartAxisDialog({
  spec,
  onApply,
  onClose,
  testId = "chart",
}: {
  spec: ChartSpec;
  onApply: (change: Record<string, unknown>) => void;
  onClose: () => void;
  testId?: string;
}) {
  const { t } = useKitEditor();
  const [which, setWhich] = useState<"yAxis" | "xAxis">("yAxis");
  const axisOf = (w: "yAxis" | "xAxis") => spec[w] ?? {};
  const [fields, setFields] = useState(() => fieldsOf(axisOf("yAxis")));
  // The category axis has a scale only on a scatter chart, whose X values are numbers.
  const scaled = which === "yAxis" || spec.kind === "scatter";
  const min = numberOrAuto(fields.min);
  const max = numberOrAuto(fields.max);
  const major = numberOrAuto(fields.major);
  const bad =
    (scaled &&
      (min === undefined ||
        max === undefined ||
        major === undefined ||
        (major != null && major <= 0) ||
        (min != null && max != null && min >= max))) ||
    fields.numberFormat.length > 255;
  const pick = (w: "yAxis" | "xAxis") => {
    setWhich(w);
    setFields(fieldsOf(axisOf(w)));
  };
  const apply = () => {
    const axis: Record<string, unknown> = {
      numberFormat: fields.numberFormat.trim() || null,
      hidden: !fields.shown,
    };
    if (scaled) Object.assign(axis, { min, max, major });
    onApply({ [which]: axis });
    onClose();
  };
  const field = (
    key: "min" | "max" | "major" | "numberFormat",
    label: string,
    numeric: boolean,
  ) => {
    const value = fields[key];
    const invalid =
      numeric && value.trim() !== "" && !Number.isFinite(Number(value));
    return [
      <label key={`${key}-label`} htmlFor={`chart-axis-${key}`}>
        {label}
      </label>,
      <input
        key={key}
        id={`chart-axis-${key}`}
        className="kui-field"
        inputMode={numeric ? "decimal" : undefined}
        placeholder={t("chartAxisAuto")}
        aria-invalid={invalid}
        value={value}
        onChange={(e) =>
          setFields((all) => ({ ...all, [key]: e.target.value }))
        }
        data-testid={`${testId}-axis-${key}`}
      />,
    ];
  };
  return (
    <Dialog
      title={t("chartFormatAxis")}
      onClose={onClose}
      testId={`${testId}-axis`}
      actions={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={bad}
            onClick={apply}
            data-testid={`${testId}-axis-ok`}
          >
            {t("chartOk")}
          </Button>
        </>
      }
    >
      <div className="kui-param-grid">
        <span>{t("chartAxis")}</span>
        <Choice
          label={t("chartAxis")}
          quiet
          value={which}
          choices={[
            ["yAxis", t("chartAxisValue")],
            ["xAxis", t("chartAxisCategory")],
          ]}
          onChange={pick}
          testId={`${testId}-axis-which`}
        />
        {scaled
          ? [
              ...field("min", t("chartAxisMin"), true),
              ...field("max", t("chartAxisMax"), true),
              ...field("major", t("chartAxisMajor"), true),
            ]
          : null}
        {field("numberFormat", t("chartAxisNumberFormat"), false)}
        <span />
        <Checkbox
          label={t("chartAxisShow")}
          checked={fields.shown}
          onChange={(shown) => setFields((all) => ({ ...all, shown }))}
          testId={`${testId}-axis-shown`}
        />
      </div>
    </Dialog>
  );
}

function fieldsOf(a: ChartAxis) {
  return {
    min: text(a.min),
    max: text(a.max),
    major: text(a.major),
    numberFormat: a.numberFormat ?? "",
    shown: !a.hidden,
  };
}

/** Format Series: a series' line width, marker and smoothing, as the kit takes them. */
export function ChartSeriesDialog({
  spec,
  formats = CHART_FORMATS,
  onApply,
  onClose,
  testId = "chart",
}: {
  spec: ChartSpec;
  formats?: readonly ChartFormat[];
  onApply: (change: Record<string, unknown>) => void;
  onClose: () => void;
  testId?: string;
}) {
  const { t } = useKitEditor();
  const lines = linesOf(spec.kind);
  // A combination: a series' own type and axis, where the chart's type mixes with others.
  const combo =
    formats.includes("combo") &&
    typeof spec.kind === "string" &&
    !["pie", "doughnut", "radar", "scatter"].includes(spec.kind);
  const [index, setIndex] = useState(0);
  const lookOf = (i: number) => {
    const s = spec.series[i];
    return {
      lineWidth: text(s?.lineWidth),
      marker: s?.marker ?? "",
      smooth: s?.smooth ?? false,
      kind: typeof s?.kind === "string" ? s.kind : "",
      secondary: s?.secondary ?? false,
    };
  };
  const [look, setLook] = useState(() => lookOf(0));
  const width = numberOrAuto(look.lineWidth);
  const bad = width === undefined || (width != null && (width < 0 || width > 100));
  const apply = () => {
    const format: Record<string, unknown> = { index };
    if (formats.includes("lineWidth")) format.lineWidth = width;
    if (lines && formats.includes("marker"))
      format.marker = look.marker === "" ? null : look.marker;
    if (lines && formats.includes("smooth")) format.smooth = look.smooth;
    if (combo) {
      format.kind = look.kind === "" ? null : look.kind;
      format.secondary = look.secondary;
    }
    onApply({ seriesFormat: [format] });
    onClose();
  };
  return (
    <Dialog
      title={t("chartFormatSeries")}
      onClose={onClose}
      testId={`${testId}-series`}
      actions={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={bad}
            onClick={apply}
            data-testid={`${testId}-series-ok`}
          >
            {t("chartOk")}
          </Button>
        </>
      }
    >
      <div className="kui-param-grid">
        <span>{t("chartSeries")}</span>
        <Choice
          label={t("chartSeries")}
          quiet
          value={String(index)}
          choices={spec.series.map((s, i) => [String(i), s.name] as const)}
          onChange={(v) => {
            setIndex(Number(v));
            setLook(lookOf(Number(v)));
          }}
          testId={`${testId}-series-which`}
        />
        {formats.includes("lineWidth")
          ? [
              <label key="w-label" htmlFor="chart-series-width">
                {t("chartLineWidth")}
              </label>,
              <input
                key="w"
                id="chart-series-width"
                className="kui-field"
                inputMode="decimal"
                placeholder={t("chartAxisAuto")}
                aria-invalid={bad}
                value={look.lineWidth}
                onChange={(e) =>
                  setLook((all) => ({ ...all, lineWidth: e.target.value }))
                }
                data-testid={`${testId}-series-width`}
              />,
            ]
          : null}
        {lines && formats.includes("marker")
          ? [
              <span key="m-label">{t("chartMarker")}</span>,
              <Choice
                key="m"
                label={t("chartMarker")}
                quiet
                value={look.marker}
                choices={[
                  ["", t("chartMarker_auto")] as const,
                  ...CHART_MARKERS.filter((m) => m !== "auto").map(
                    (m) => [m, t(`chartMarker_${m}`)] as const,
                  ),
                ]}
                onChange={(marker) => setLook((all) => ({ ...all, marker }))}
                testId={`${testId}-series-marker`}
              />,
            ]
          : null}
        {combo
          ? [
              <span key="k-label">{t("chartSeriesType")}</span>,
              <Choice
                key="k"
                label={t("chartSeriesType")}
                quiet
                value={look.kind}
                choices={[
                  ["", t("chartSeriesTypeChart")] as const,
                  ...COMBO_KINDS.map((k) => [k, t(CHART_KINDS.find((c) => c.kind === k)?.label ?? k)] as const),
                ]}
                onChange={(kind) => setLook((all) => ({ ...all, kind }))}
                testId={`${testId}-series-kind`}
              />,
              <span key="x-label" />,
              <Checkbox
                key="x"
                label={t("chartSecondaryAxis")}
                checked={look.secondary}
                onChange={(secondary) => setLook((all) => ({ ...all, secondary }))}
                testId={`${testId}-series-secondary`}
              />,
            ]
          : null}
        {lines && formats.includes("smooth")
          ? [
              <span key="s-label" />,
              <Checkbox
                key="s"
                label={t("chartSmooth")}
                checked={look.smooth}
                onChange={(smooth) => setLook((all) => ({ ...all, smooth }))}
                testId={`${testId}-series-smooth`}
              />,
            ]
          : null}
      </div>
    </Dialog>
  );
}

/** A pie or doughnut shows one series: the change keeps the first. */
function pieOf(spec: ChartSpec | null, kind: string): Record<string, unknown> {
  if (!spec || spec.series.length <= 1) return { kind };
  return {
    kind,
    series: [{ name: spec.series[0].name, values: spec.series[0].values }],
  };
}

/** The chart's data as a grid: categories down, series across. */
export function ChartDataDialog({
  spec,
  onApply,
  onClose,
  testId = "chart",
}: {
  spec: ChartSpec;
  onApply: (data: {
    categories: string[];
    series: Array<{ name: string; values: Array<number | null> }>;
  }) => void;
  onClose: () => void;
  testId?: string;
}) {
  const { t } = useKitEditor();
  const [categories, setCategories] = useState(spec.categories);
  const [names, setNames] = useState(spec.series.map((s) => s.name));
  const [cells, setCells] = useState(() =>
    spec.series.map((s) =>
      spec.categories.map((_, i) =>
        s.values[i] == null ? "" : String(s.values[i]),
      ),
    ),
  );
  const pie = spec.kind === "pie" || spec.kind === "doughnut";
  const bad = cells.some((column) =>
    column.some((v) => v.trim() !== "" && !Number.isFinite(Number(v))),
  );
  const apply = () => {
    onApply({
      categories,
      series: names.map((name, s) => ({
        name,
        values: cells[s].map((v) => (v.trim() === "" ? null : Number(v))),
      })),
    });
    onClose();
  };
  const setCell = (s: number, i: number, v: string) =>
    setCells((all) =>
      all.map((column, n) =>
        n === s ? column.map((x, m) => (m === i ? v : x)) : column,
      ),
    );
  return (
    <Dialog
      title={t("chartEditData")}
      onClose={onClose}
      testId={`${testId}-data`}
      actions={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            disabled={bad || names.length === 0}
            onClick={apply}
            data-testid={`${testId}-data-ok`}
          >
            {t("chartOk")}
          </Button>
        </>
      }
    >
      <div style={{ maxHeight: 360, overflow: "auto" }}>
        <table className="kui-chart-data">
          <thead>
            <tr>
              <th />
              {names.map((name, s) => (
                <th key={s}>
                  <input
                    aria-label={t("chartSeriesName", { n: s + 1 })}
                    value={name}
                    onChange={(e) =>
                      setNames((all) =>
                        all.map((x, n) => (n === s ? e.target.value : x)),
                      )
                    }
                    data-testid={`${testId}-data-series-${s}`}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((category, i) => (
              <tr key={i}>
                <th>
                  <input
                    aria-label={t("chartCategoryName", { n: i + 1 })}
                    value={category}
                    onChange={(e) =>
                      setCategories((all) =>
                        all.map((x, n) => (n === i ? e.target.value : x)),
                      )
                    }
                    data-testid={`${testId}-data-category-${i}`}
                  />
                </th>
                {names.map((_, s) => (
                  <td key={s}>
                    <input
                      inputMode="decimal"
                      aria-label={t("chartValue", {
                        series: names[s],
                        category,
                      })}
                      aria-invalid={
                        cells[s][i].trim() !== "" &&
                        !Number.isFinite(Number(cells[s][i]))
                      }
                      value={cells[s][i]}
                      onChange={(e) => setCell(s, i, e.target.value)}
                      data-testid={`${testId}-data-cell-${s}-${i}`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Button
          onClick={() => {
            setCategories((all) => [
              ...all,
              t("chartCategoryText", { n: all.length + 1 }),
            ]);
            setCells((all) => all.map((column) => [...column, ""]));
          }}
          data-testid={`${testId}-data-add-category`}
        >
          {t("chartAddCategory")}
        </Button>
        <Button
          disabled={pie}
          onClick={() => {
            setNames((all) => [
              ...all,
              t("chartSeriesText", { n: all.length + 1 }),
            ]);
            setCells((all) => [...all, categories.map(() => "")]);
          }}
          data-testid={`${testId}-data-add-series`}
        >
          {t("chartAddSeries")}
        </Button>
        <Button
          disabled={categories.length <= 1}
          onClick={() => {
            setCategories((all) => all.slice(0, -1));
            setCells((all) => all.map((column) => column.slice(0, -1)));
          }}
          data-testid={`${testId}-data-remove-category`}
        >
          {t("chartRemoveCategory")}
        </Button>
        <Button
          disabled={names.length <= 1}
          onClick={() => {
            setNames((all) => all.slice(0, -1));
            setCells((all) => all.slice(0, -1));
          }}
          data-testid={`${testId}-data-remove-series`}
        >
          {t("chartRemoveSeries")}
        </Button>
      </div>
    </Dialog>
  );
}
