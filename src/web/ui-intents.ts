import type { BuiltinWindow, LocalUiToolCall } from "./ui-contracts.js";

/**
 * Plain interface commands the host can run by itself: "abre o workspace", "volta pro anel", "abre as
 * configurações". Reaching the main interface must not depend on a free model emitting a well-formed tool call; with
 * a real model it answered in text, and sometimes claimed it had opened what it had not.
 *
 * This is a safety net, not a gate. Every message still goes to the model first, with the same operations offered
 * as tools; MainAgent runs the command recognized here only when the turn would end without the interface action.
 * Only a whole message that is nothing but the command matches. Anything longer, negated, hypothetical or about
 * something else returns undefined and is left entirely to the model.
 */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

const open = "(?:abr[aei]r?|abrir|mostr[ae]r?|exib[aei]r?|ativ[ae]r?|entr[ae]r?|vai|ir|volt[ae]r?|mud[ae]r?|troc[ae]r?|me lev[ae]|quero(?: ver| ir| abrir| entrar)?)";
const close = "(?:fech[ae]r?|dispens[ae]r?|escond[ae]r?|ocult[ae]r?|sai[ar]?|sair)";
const article = "(?:(?:pr[ao]s?|para|para [oa]s?|n[oa]s?|a?[oa]s?|em|d[oa]s?|de|meu|minha|meus|minhas|painel|janela|tela|modo|a tela d[eoa]|o painel d[eoa]|a janela d[eoa]s?)\\s+)*";

const panels: readonly (readonly [BuiltinWindow, string])[] = [
  ["settings", "(?:configuracoes|configuracao|config|ajustes|preferencias|settings)"],
  ["usage", "(?:uso|uso e limites|limites|consumo|cotas?)"],
  ["sessions", "(?:sessoes|conversas|historico)"],
  ["operations", "(?:operacoes|execucoes|atividade dos agentes)"],
];

const whole = (body: string) => new RegExp("^" + body + "$");
const workspace = whole(`(?:${open}\\s+)?${article}workspace`);
// "foco" and "anel" are ordinary words, so going back to the ring needs a verb or "modo" in front.
const focus = whole(`(?:${open}\\s+${article}|modo\\s+)(?:focus|foco|anel)`);
const reset = whole("(?:restaur[ae]r?|reset[ae]r?|reinici[ae]r?)\\s+(?:o\\s+|a\\s+)?(?:layout|disposicao(?: inicial)?|tela(?: inicial)?)");

/** The interface operation a message asks for, when the message is only that. */
export function interfaceCommand(message: string): LocalUiToolCall | undefined {
  if (message.length > 80) return undefined;
  let text = fold(message).replace(/\s+/g, " ").trim();
  // A polite question is still a request ("pode abrir o workspace?"); any other question is not.
  const polite = /^(?:void[,!.]?\s+)?(?:voce\s+)?(?:pode|poderia|consegue|da pra|da para|tem como)\s+/.test(text);
  if (text.endsWith("?") && !polite) return undefined;
  text = text.replace(/^void[,!.]?\s+/, "").replace(/^(?:voce\s+)?(?:pode|poderia|consegue|da pra|da para|tem como)\s+/, "")
    .replace(/^(?:por favor|pfv|pf)[,]?\s+/, "").replace(/[,]?\s+(?:por favor|pfv|pf)(?=[\s.!?]*$)/, "")
    .replace(/[\s.!?]+$/, "").replace(/\s+(?:ai|agora|pra mim|para mim)$/, "");
  // No separate check for negation: every pattern below must match the whole message, so "não abre o workspace"
  // and "se eu abrir o workspace" already fall through to the model.
  if (workspace.test(text)) return { name: "ui.switchMode", arguments: { mode: "workspace" } };
  if (focus.test(text)) return { name: "ui.switchMode", arguments: { mode: "focus" } };
  if (reset.test(text)) return { name: "ui.resetLayout", arguments: {} };
  for (const [component, names] of panels) {
    if (whole(`${open}\\s+${article}${names}`).test(text)) return { name: "ui.openWindow", arguments: { component } };
    if (whole(`${close}\\s+${article}${names}`).test(text)) return { name: "ui.closeWindow", arguments: { component } };
  }
  return undefined;
}
