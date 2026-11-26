import { useCallback, useEffect, useState } from "react";
import { EraserIcon as Eraser, HighlighterIcon as Highlighter, MousePointer2Icon as MousePointer2, PaletteIcon as Palette, PenIcon as Pen, PencilIcon as Pencil, PenLineIcon as PenLine, type IconComponent } from "@kition/tessera-icons/react";
import {
  ColorGrid,
  MenuItem,
  RibbonButton,
  RibbonGroup,
  RibbonStack,
} from "@kition/tessera-ui";
import { RibbonMenu, useKitEditor, useKitTools } from "./editor";

/**
 * The Draw tab's pens, shared by every kit that implements `KitDrawing 1.2`'s ink. Each kit has
 * the same commands for them (`ink.select`, `ink.pen`, `ink.pencil`, `ink.highlighter`,
 * `ink.eraser`, each pen taking `{color?, width?}`, and `ink.state` answering `{tool, color,
 * width}`); a kit whose engine has a tool of the same id is switched through its tools, so its
 * tool rail and the ribbon agree. Drawing and erasing are the kit's pointer gestures, which run
 * `drawing.ink` and `drawing.erase`, as an agent does.
 */

/** What `ink.state` answers. */
export type DrawState = { tool: string; color: string; width: number };

/** The pens and tools, by command name. */
export const INK_TOOLS: ReadonlyArray<{
  tool: string;
  icon: IconComponent;
  label: string;
}> = [
  { tool: "select", icon: MousePointer2, label: "inkSelect" },
  { tool: "pen", icon: Pen, label: "inkPen" },
  { tool: "pencil", icon: Pencil, label: "inkPencil" },
  { tool: "highlighter", icon: Highlighter, label: "inkHighlighter" },
  { tool: "eraser", icon: Eraser, label: "inkEraser" },
];

/** Pen thicknesses in points. */
export const INK_WEIGHTS = [0.5, 1, 1.5, 2, 3, 4.5, 6, 12];

const PENS = ["pen", "pencil", "highlighter"];

export function InkGroup({ testId = "ink" }: { testId?: string }) {
  const editor = useKitEditor();
  const tools = useKitTools();
  const { t } = editor;
  const revision = (editor.session as { change?: { revision?: number } }).change
    ?.revision;
  const [state, setState] = useState<DrawState | null>(null);
  const refresh = useCallback(() => {
    void editor.query<DrawState>("ink.state").then((next) => {
      if (next) setState(next);
    });
  }, [editor]);
  // Again after a tool switch reaches the engine (it is sent once the tool rail has updated).
  useEffect(() => {
    refresh();
    const later = setTimeout(refresh, 60);
    return () => clearTimeout(later);
  }, [refresh, revision, tools?.active]);
  const engineTool = (tool: string) =>
    tools?.tools.some((item) => item.id === tool) ?? false;
  const pick = async (tool: string) => {
    if (engineTool(tool)) tools?.select(tool);
    else await editor.run(`ink.${tool}`, {});
    refresh();
  };
  const current =
    tools &&
    engineTool(state?.tool ?? "select") &&
    tools.tools.some((item) => item.id === tools.active)
      ? tools.active
      : state?.tool;
  const pen = state && PENS.includes(state.tool) ? state.tool : null;
  const set = async (params: Record<string, unknown>) => {
    if (!pen) return;
    await editor.run(`ink.${pen}`, params);
    refresh();
  };
  const disabled = !editor.enabled("ink.pen");
  return (
    <>
      <RibbonGroup label={t("inkTools")} icon={Pen}>
        {INK_TOOLS.map((item) => (
          <RibbonButton
            key={item.tool}
            icon={item.icon}
            label={t(item.label)}
            size="large"
            pressed={current === item.tool}
            disabled={disabled && item.tool !== "select"}
            onClick={() => void pick(item.tool)}
            data-testid={`${testId}-${item.tool}`}
            primary
          />
        ))}
      </RibbonGroup>
      <RibbonGroup label={t("inkPens")} icon={PenLine}>
        <RibbonStack>
          <RibbonMenu
            icon={Palette}
            label={t("inkColor")}
            disabled={!pen}
            swatch={pen ? state?.color : undefined}
            testId={`${testId}-color`}
            primary
          >
            <ColorGrid
              onPick={(color) => void set({ color })}
              testId={`${testId}-colors`}
            />
          </RibbonMenu>
          <RibbonMenu
            icon={PenLine}
            label={t("inkWeight")}
            disabled={!pen}
            testId={`${testId}-weight`}
            primary
          >
            {INK_WEIGHTS.map((width) => (
              <MenuItem
                key={width}
                label={t("drawingWeight", { value: width })}
                checked={state?.width === width}
                testId={`${testId}-weight-${width}`}
                onSelect={() => void set({ width })}
              />
            ))}
          </RibbonMenu>
        </RibbonStack>
      </RibbonGroup>
    </>
  );
}
