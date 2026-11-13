import type { BuiltinWindow, LocalUiToolCall } from "./ui-contracts.js";

/**
 * Plain interface commands the host runs by itself, before and instead of the model: "abre o workspace", "volta pro
 * anel", "abre as configurações", "fecha o painel". Reaching the interface must not depend on a free model emitting a
 * well-formed tool call; with real models the answer was often text, sometimes claiming to have opened what it had
 * not, and once the wrong panel.
 *
 * Only a short, imperative message that is nothing but the command matches. A question, a longer sentence, a
 * negation or anything about something else returns undefined and goes to the model, which still has the same
 * operations as tools.
 */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

export const interfaceCommandWords = 8;

const open = "(?:abr[aei]r?|abrir|mostr[ae]r?|exib[aei]r?|ativ[ae]r?|entr[ae]r?|vai|ir|volt[ae]r?|mud[ae]r?|troc[ae]r?|me lev[ae]|quero(?: ver| ir| abrir| entrar)?)";
const close = "(?:fech[ae]r?|dispens[ae]r?|escond[ae]r?|ocult[ae]r?|sai[ar]?|sair)";
const article = "(?:(?:pr[ao]s?|para|para [oa]s?|n[oa]s?|a?[oa]s?|em|d[oa]s?|de|meu|minha|meus|minhas|painel|janela|tela|modo|a tela d[eoa]|o painel d[eoa]|a janela d[eoa]s?)\\s+)*";

const panels: readonly (readonly [BuiltinWindow, string])[] = [
  ["settings", "(?:configuracoes|configuracao|config|ajustes|preferencias|settings)"],
  ["usage", "(?:uso|uso e limites|limites|consumo|cotas?)"],
  ["sessions", "(?:sessoes|conversas|historico)"],
  ["operations", "(?:operacoes|execucoes|atividade dos agentes)"],
  ["memory", "(?:memoria|memorias|lembrancas)"],
];

const whole = (body: string) => new RegExp("^" + body + "$");
const workspace = whole(`(?:${open}\\s+)?${article}workspace`);
// "foco" and "anel" are ordinary words, so going back to the ring needs a verb or "modo" in front.
const focus = whole(`(?:${open}\\s+${article}|modo\\s+)(?:focus|foco|anel)`);
const reset = whole("(?:restaur[ae]r?|reset[ae]r?|reinici[ae]r?)\\s+(?:o\\s+|a\\s+)?(?:layout|disposicao(?: inicial)?|tela(?: inicial)?)");
// "fecha o painel", "fecha a janela", "fecha isso": whatever is open.
const closeCurrent = whole(`${close}\\s+(?:(?:o|a|esse|essa|este|esta)\\s+)?(?:painel|janela|isso|isto)`);

/** The interface operation a message asks for, when the message is only that. */
export function interfaceCommand(message: string): LocalUiToolCall | undefined {
  // A question is never a command, however polite: the question mark is not stripped below, so "pode abrir o
  // workspace?" matches no pattern and goes to the model.
  if (message.length > 80) return undefined;
  const text = fold(message).replace(/\s+/g, " ").trim()
    .replace(/^void[,!.]?\s+/, "").replace(/^(?:por favor|pfv|pf)[,]?\s+/, "").replace(/[,]?\s+(?:por favor|pfv|pf)(?=[\s.!]*$)/, "")
    .replace(/[\s.!]+$/, "").replace(/\s+(?:ai|agora|pra mim|para mim)$/, "");
  if (!text || text.split(" ").length > interfaceCommandWords) return undefined;
  // No separate check for negation: every pattern must match the whole message, so "não abre o workspace" and
  // "se eu abrir o workspace" already fall through to the model.
  if (workspace.test(text)) return { name: "ui.switchMode", arguments: { mode: "workspace" } };
  if (focus.test(text)) return { name: "ui.switchMode", arguments: { mode: "focus" } };
  if (reset.test(text)) return { name: "ui.resetLayout", arguments: {} };
  if (closeCurrent.test(text)) return { name: "ui.closeWindow", arguments: { component: "current" } };
  for (const [component, names] of panels) {
    if (whole(`${open}\\s+${article}${names}`).test(text)) return { name: "ui.openWindow", arguments: { component } };
    if (whole(`${close}\\s+${article}${names}`).test(text)) return { name: "ui.closeWindow", arguments: { component } };
  }
  return undefined;
}
