import { isGeneratedWindow, type GeneratedWindow, type RenderRequest } from "./render-contracts.ts";

export const panelRegistry = {
  settings: "Configurações",
  usage: "Uso e limites",
  sessions: "Sessões",
  operations: "Operações",
  display: "Visualização",
  generated: "Componente",
} as const;

export type PanelId = keyof typeof panelRegistry;
export type BuiltinWindow = Exclude<PanelId, "display" | "generated">;
export type WindowToolCall = {
  name: "ui.openWindow" | "ui.closeWindow";
  arguments: { component: BuiltinWindow };
};

export interface RenderToolCall {
  name: "ui.render";
  arguments: RenderRequest;
}

export type UiMode = "focus" | "workspace";
export type Cell = string | number | null;
export type DisplayBlock =
  | { kind: "card"; title: string; value: string | number; detail?: string }
  | { kind: "table"; title: string; columns: string[]; rows: Cell[][] }
  | { kind: "bar_chart"; title: string; points: { label: string; value: number }[] };
export interface DisplaySchema { title: string; blocks: DisplayBlock[] }

export type UiAction =
  | { type: "switch_mode"; mode: UiMode }
  | { type: "open_panel" | "close_panel"; panel: PanelId }
  | { type: "update_panel"; panel: "display"; schema: DisplaySchema }
  | { type: "open_component"; window: GeneratedWindow }
  | { type: "reset_layout" };

export interface UiEvent { turnId: string; action: UiAction }
export interface UiLayout { mode: UiMode; panel: PanelId | null; display: DisplaySchema | null; generated: GeneratedWindow | null }

export const initialLayout: UiLayout = { mode: "focus", panel: null, display: null, generated: null };

export function applyUiAction(layout: UiLayout, action: UiAction): UiLayout {
  switch (action.type) {
    case "switch_mode": return { ...layout, mode: action.mode, panel: null };
    case "open_panel": return { ...layout, panel: action.panel };
    case "close_panel": return layout.panel === action.panel ? { ...layout, panel: null } : layout;
    case "update_panel": return { ...layout, panel: "display", display: action.schema };
    case "open_component": return { ...layout, panel: "generated", generated: action.window };
    case "reset_layout": return initialLayout;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, ...allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const label = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 120;
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e15;
const cell = (value: unknown): value is Cell => value === null || number(value) ||
  (typeof value === "string" && value.length <= 240);
const list = (value: unknown, max: number): value is unknown[] =>
  Array.isArray(value) && value.length > 0 && value.length <= max;

function block(value: unknown): value is DisplayBlock {
  if (!record(value) || !label(value.title)) return false;
  switch (value.kind) {
    case "card": return keys(value, "kind", "title", "value", "detail") &&
      (label(value.value) || number(value.value)) &&
      (value.detail === undefined || (typeof value.detail === "string" && value.detail.length <= 240));
    case "table": {
      const { columns, rows } = value;
      return keys(value, "kind", "title", "columns", "rows") && list(columns, 8) && columns.every(label) &&
        list(rows, 50) && rows.every((row) => Array.isArray(row) && row.length === columns.length && row.every(cell));
    }
    case "bar_chart": return keys(value, "kind", "title", "points") && list(value.points, 20) &&
      value.points.every((point) => record(point) && keys(point, "label", "value") &&
        label(point.label) && number(point.value));
    default: return false;
  }
}

export function isDisplaySchema(value: unknown): value is DisplaySchema {
  return record(value) && keys(value, "title", "blocks") && label(value.title) &&
    list(value.blocks, 8) && value.blocks.every(block);
}

function isPanel(value: unknown): value is PanelId {
  return typeof value === "string" && Object.hasOwn(panelRegistry, value);
}

export function isWindowToolCall(value: unknown): value is WindowToolCall {
  if (!record(value) || !keys(value, "name", "arguments") ||
      (value.name !== "ui.openWindow" && value.name !== "ui.closeWindow")) return false;
  const args = value.arguments;
  return record(args) && keys(args, "component") && isPanel(args.component) && args.component !== "display" && args.component !== "generated";
}

export function isRenderToolCall(value: unknown): value is RenderToolCall {
  if (!record(value) || !keys(value, "name", "arguments") || value.name !== "ui.render") return false;
  const args = value.arguments;
  return record(args) && keys(args, "brief", "key", "display", "revise") &&
    typeof args.brief === "string" && !!args.brief.trim() && args.brief.length <= 6_000 &&
    (args.key === undefined || (typeof args.key === "string" && /^[a-z0-9-]{1,64}$/.test(args.key))) &&
    (args.display === undefined || isDisplaySchema(args.display)) &&
    (args.revise === undefined || typeof args.revise === "boolean");
}

export function isUiAction(value: unknown): value is UiAction {
  if (!record(value)) return false;
  switch (value.type) {
    case "reset_layout": return keys(value, "type");
    case "switch_mode": return keys(value, "type", "mode") && (value.mode === "focus" || value.mode === "workspace");
    case "open_panel":
    case "close_panel": return keys(value, "type", "panel") && isPanel(value.panel);
    case "update_panel": return keys(value, "type", "panel", "schema") &&
      value.panel === "display" && isDisplaySchema(value.schema);
    case "open_component": return keys(value, "type", "window") && isGeneratedWindow(value.window);
    default: return false;
  }
}

export function isUiEvent(value: unknown): value is UiEvent {
  return record(value) && keys(value, "turnId", "action") &&
    typeof value.turnId === "string" && isUiAction(value.action);
}
