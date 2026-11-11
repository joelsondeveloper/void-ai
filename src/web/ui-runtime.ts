import { isLocalUiToolCall, isRenderToolCall, panelRegistry, type BuiltinWindow, type UiAction, type UiEvent } from "./ui-contracts.js";

import type { ModelTool } from "../runtime/AgentOperation.js";

export const builtinWindows = Object.keys(panelRegistry).filter(
  (panel): panel is BuiltinWindow => panel !== "display" && panel !== "generated",
);
export const uiTools: readonly Omit<ModelTool, "prepare">[] = [
  ...["ui.openWindow", "ui.closeWindow"].map((name) => ({
    name, description: `${name}: Open or close the named panel as indicated by the tool name. Settings contains preferences, voice and behavior. Panels ${JSON.stringify(builtinWindows.map(id => ({ id, title: panelRegistry[id] })))}.`,
    example: { name, arguments: { component: "settings" } },
    accepts: (value: unknown) => isLocalUiToolCall(value) && value.name === name,
  })),
  { name: "ui.switchMode", description: "Switch to workspace (main interface with conversation and sessions) or focus (central ring).",
    example: { name: "ui.switchMode", arguments: { mode: "workspace" } },
    accepts: (value) => isLocalUiToolCall(value) && value.name === "ui.switchMode" },
  { name: "ui.resetLayout", description: "Reset the layout to Focus, closing the current panel.",
    example: { name: "ui.resetLayout", arguments: {} },
    accepts: (value) => isLocalUiToolCall(value) && value.name === "ui.resetLayout" },
  { name: "ui.render", description: "Create, reopen or revise a visual component via AgentRenderer. Arguments: brief, optional key (slug), display (DisplaySchema), revise (boolean). The renderer can request an isolated interactive React component. Network is unavailable.",
    example: { name: "ui.render", arguments: { brief: "User's interface request", key: "component-key" } }, accepts: isRenderToolCall },
];

export interface UiCommand { response: string; action?: UiAction }

export class UiRuntimeService {
  private readonly events = new Map<string, UiEvent>();

  call(value: unknown): UiCommand | undefined {
    if (!isLocalUiToolCall(value)) return;
    if (value.name === "ui.switchMode") return { response: `Modo ${value.arguments.mode === "workspace" ? "Workspace" : "Focus"} ativado.`,
      action: { type: "switch_mode", mode: value.arguments.mode } };
    if (value.name === "ui.resetLayout") return { response: "Layout restaurado.", action: { type: "reset_layout" } };
    const panel = value.arguments.component;
    return value.name === "ui.openWindow"
      ? { response: panelRegistry[panel] + " na tela.", action: { type: "open_panel", panel } }
      : { response: "Painel dispensado.", action: { type: "close_panel", panel } };
  }

  publish(sessionId: string, event: UiEvent): void {
    // Snapshots carry the latest action, including after a brief SSE disconnection.
    this.events.delete(sessionId);
    this.events.set(sessionId, event);
    if (this.events.size > 128) {
      const oldest = this.events.keys().next().value;
      if (oldest !== undefined) this.events.delete(oldest);
    }
  }

  latest(sessionId: string): UiEvent | undefined {
    return this.events.get(sessionId);
  }
}
