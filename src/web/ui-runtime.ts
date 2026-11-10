import { isDisplaySchema, isLocalUiToolCall, isRenderToolCall, panelRegistry, type BuiltinWindow, type UiAction, type UiEvent } from "./ui-contracts.js";

import type { ModelTool } from "../runtime/AgentOperation.js";

export const builtinWindows = Object.keys(panelRegistry).filter(
  (panel): panel is BuiltinWindow => panel !== "display" && panel !== "generated",
);
export const uiTools: readonly Omit<ModelTool, "prepare">[] = [
  ...["ui.openWindow", "ui.closeWindow"].map((name) => ({
    name, description: `${name}: built-in panels ${JSON.stringify(builtinWindows.map(id => ({ id, title: panelRegistry[id] })))}.`,
    example: { name, arguments: { component: "settings" } },
    accepts: (value: unknown) => isLocalUiToolCall(value) && value.name === name,
  })),
  { name: "ui.switchMode", description: "Switch to workspace (main interface with conversation and sessions) or focus (central ring).",
    example: { name: "ui.switchMode", arguments: { mode: "workspace" } },
    accepts: (value) => isLocalUiToolCall(value) && value.name === "ui.switchMode" },
  { name: "ui.resetLayout", description: "Reset the layout to Focus, closing the current panel.",
    example: { name: "ui.resetLayout", arguments: {} },
    accepts: (value) => isLocalUiToolCall(value) && value.name === "ui.resetLayout" },
  { name: "ui.render", description: "Create, reopen or revise a visual component via AgentRenderer. Arguments: brief, optional key (slug), display (DisplaySchema), revise (boolean). Interactive components support Counter and Toggle; arbitrary code and network are unavailable.",
    example: { name: "ui.render", arguments: { brief: "User's interface request", key: "component-key" } }, accepts: isRenderToolCall },
];

export interface UiCommand { response: string; action?: UiAction }

const panels: ReadonlyArray<[RegExp, BuiltinWindow | "display"]> = [
  [/^(?:configuracoes|ajustes|settings)$/, "settings"],
  [/^(?:uso(?: e limites)?|consumo|telemetria|limites)$/, "usage"],
  [/^(?:sessoes|arquivo de sessoes|historico de sessoes)$/, "sessions"],
  [/^(?:operacoes|execucoes|painel de execucoes)$/, "operations"],
  [/^(?:visualizacao|painel dinamico)$/, "display"],
];

function normalize(message: string): string {
  return message.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .trim().replace(/[.!?]+$/, "").replace(/[,:]/g, " ").replace(/\s+/g, " ")
    .trim().replace(/^(?:void |por favor )+/, "").replace(/ por favor$/, "");
}

export class UiRuntimeService {
  private readonly events = new Map<string, UiEvent>();

  command(message: string): UiCommand | undefined {
    const json = /^(?:visualizar|exibir|atualizar painel)\s+([\s\S]+)$/i.exec(message);
    if (json?.[1]?.startsWith("{")) {
      let data: unknown;
      try { data = JSON.parse(json[1]); } catch { /* Report the same error as an invalid schema. */ }
      return isDisplaySchema(data)
        ? { response: "Visualização aberta.", action: { type: "update_panel", panel: "display", schema: data } }
        : { response: "A visualização precisa de um JSON válido com título e blocos compatíveis." };
    }

    const normalized = normalize(message);
    if (/^(?:resetar|restaurar|redefinir|reiniciar) (?:o )?layout$/.test(normalized)) {
      return { response: "Layout restaurado.", action: { type: "reset_layout" } };
    }

    const mode = /^(?:(?:ative|ativar|abra|abrir|quero(?: o)?|entre no|entrar no|mude (?:para|pro)|volt(?:e|ar|a) (?:ao|para(?: o)?|pro)|ir para(?: o)?) )?(?:modo )?(workspace|focus|foco)$/.exec(normalized);
    if (mode) {
      return mode[1] === "workspace"
        ? { response: "Modo Workspace ativado.", action: { type: "switch_mode", mode: "workspace" } }
        : { response: "Modo Focus ativado.", action: { type: "switch_mode", mode: "focus" } };
    }

    const target = /^(?:(?:voce pode|pode|quero(?: que voce)?) )?(?:(mostre|mostrar|mostra|abra|abrir|abre|exiba|exibir|exibe|ver|feche|fechar|fecha|oculte|ocultar) )?(?:(?:o|os|a|as) )?(?:(?:painel|janela) (?:(?:de|do|da|das|dos) )?)?(.+)$/.exec(normalized);
    const panel = target && panels.find(([pattern]) => pattern.test(target[2] ?? ""))?.[1];
    if (!panel) return;
    const close = /^(?:feche|fechar|fecha|oculte|ocultar)$/.test(target[1] ?? "");
    if (panel !== "display") return this.call({ name: close ? "ui.closeWindow" : "ui.openWindow", arguments: { component: panel } });
    return { response: close ? "Painel dispensado." : panelRegistry[panel] + " na tela.",
      action: { type: close ? "close_panel" : "open_panel", panel } };
  }

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
