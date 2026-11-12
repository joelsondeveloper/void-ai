import { isLocalUiToolCall, isRenderToolCall, panelRegistry, type BuiltinWindow, type UiAction, type UiEvent } from "./ui-contracts.js";

import type { ModelTool } from "../runtime/AgentOperation.js";

export const builtinWindows = Object.keys(panelRegistry).filter(
  (panel): panel is BuiltinWindow => panel !== "display" && panel !== "generated",
);
export const uiTools: readonly Omit<ModelTool, "prepare">[] = [
  ...["ui.openWindow", "ui.closeWindow"].map((name) => ({
    name, description: `${name}: Open or close the named panel as indicated by the tool name. Settings contains preferences, voice and behavior. Panels ${JSON.stringify(builtinWindows.map(id => ({ id, title: panelRegistry[id] })))}.`,
    example: { name, arguments: { component: "settings" } },
    summary: name === "ui.openWindow"
      ? "Abre um painel da interface: configurações, uso e limites, sessões, operações ou memória (o que o VOID guarda sobre o usuário)."
      : "Fecha um painel da interface que esteja aberto. Use current para fechar o que estiver na tela.",
    parameters: { type: "object", additionalProperties: false, required: ["component"], properties: {
      component: { type: "string", enum: name === "ui.closeWindow" ? [...builtinWindows, "current"] : builtinWindows, description: "Painel: " +
        builtinWindows.map((id) => `${id} (${panelRegistry[id]})`).join(", ") + "." } } },
    accepts: (value: unknown) => isLocalUiToolCall(value) && value.name === name,
  })),
  { name: "ui.switchMode", description: "Switch to workspace (main interface with conversation and sessions) or focus (central ring).",
    example: { name: "ui.switchMode", arguments: { mode: "workspace" } },
    summary: "Troca o modo da tela. O workspace é a interface completa, com conversa, sessões, configurações e painel de uso. O focus mostra só o anel central.",
    parameters: { type: "object", additionalProperties: false, required: ["mode"], properties: {
      mode: { type: "string", enum: ["workspace", "focus"], description: "workspace abre a interface completa; focus volta ao anel." } } },
    accepts: (value) => isLocalUiToolCall(value) && value.name === "ui.switchMode" },
  { name: "ui.resetLayout", description: "Reset the layout to Focus, closing the current panel.",
    example: { name: "ui.resetLayout", arguments: {} },
    summary: "Restaura o layout inicial (modo focus), fechando o painel atual.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    accepts: (value) => isLocalUiToolCall(value) && value.name === "ui.resetLayout" },
  { name: "ui.render", description: "Create, reopen or revise a visual component via AgentRenderer. Arguments: brief, optional key (slug), display (DisplaySchema), revise (boolean). The renderer can request an isolated interactive React component. Network is unavailable.",
    example: { name: "ui.render", arguments: { brief: "User's interface request", key: "component-key" } },
    summary: "Cria, reabre ou revisa um componente visual (tabela, gráfico, formulário, tela) pedido pelo usuário.",
    parameters: { type: "object", additionalProperties: false, required: ["brief"], properties: {
      brief: { type: "string", maxLength: 6000, description: "O que o usuário quer ver, com os dados e detalhes necessários." },
      key: { type: "string", pattern: "^[a-z0-9-]{1,64}$", description: "Identificador (slug) para reabrir ou revisar o mesmo componente depois." },
      revise: { type: "boolean", description: "true para ajustar o componente existente com essa key." } } },
    accepts: isRenderToolCall },
];

export interface UiCommand { response: string; action?: UiAction }

export class UiRuntimeService {
  private readonly events = new Map<string, UiEvent>();

  call(value: unknown): UiCommand | undefined {
    if (!isLocalUiToolCall(value)) return;
    if (value.name === "ui.switchMode") return { response: `Modo ${value.arguments.mode === "workspace" ? "Workspace" : "Focus"} ativado.`,
      action: { type: "switch_mode", mode: value.arguments.mode } };
    if (value.name === "ui.resetLayout") return { response: "Layout restaurado.", action: { type: "reset_layout" } };
    if (value.name === "ui.openWindow") {
      const panel = value.arguments.component;
      return { response: panelRegistry[panel] + " na tela.", action: { type: "open_panel", panel } };
    }
    const panel = value.arguments.component;
    return { response: "Painel dispensado.", action: panel === "current" ? { type: "close_current" } : { type: "close_panel", panel } };
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
