/**
 * The honesty lock: a reply must not say something was saved, forgotten, opened or closed when nothing of the kind
 * happened in the turn. Small models write "Anotei." or "Workspace aberto." as a matter of style. The host knows
 * what actually happened, so it removes the claim and says so.
 */
const boundary = "(?![\\p{L}\\p{N}])";
const start = "(?<![\\p{L}\\p{N}])";

const memoryClaim = new RegExp(start + "(?:anotei|anotad[oa]|salvei|salv[oa] na mem[óo]ria|guardei|guardad[oa]|gravei|gravad[oa]|memorizei|registrei|registrad[oa]|" +
  "lembrei|vou (?:me )?lembrar|vou guardar|ficou (?:anotado|salvo|guardado|registrado|gravado)|atualizei|atualizad[oa] na mem[óo]ria|" +
  "esqueci|apaguei|removi da mem[óo]ria|j[áa] esqueci)" + boundary, "iu");

const interfaceVerb = new RegExp(start + "(?:abri|abrindo|abert[oa]s?|fechei|fechando|fechad[oa]s?|troquei|mudei|ativei|ativad[oa]|restaurei|restaurad[oa]|" +
  "(?:est[áa]|est[ãa]o|t[áa]|t[ãa]o|ficou|ficaram) na tela)" + boundary, "iu");
const interfaceNoun = new RegExp(start + "(?:workspace|painel|pain[ée]is|janela|configura[çc][õo]es|sess[õo]es|opera[çc][õo]es|focus|anel|layout|interface|tela|modo)" + boundary, "iu");

const sentences = (reply: string) => reply.split(/(?<=[.!?…])\s+/);

/** True when the reply says something was saved, updated or forgotten in the memory. */
export const claimsMemoryChange = (reply: string) => memoryClaim.test(reply);

/** True when the reply says something on the screen was opened, closed or switched. */
export const claimsInterfaceChange = (reply: string) =>
  sentences(reply).some((sentence) => interfaceVerb.test(sentence) && interfaceNoun.test(sentence));

/** The reply without the sentences that make the claim, opened by a short true statement of what happened. */
export function honestReply(reply: string, claims: (sentence: string) => boolean, truth: string): string {
  const kept = sentences(reply).filter((sentence) => !claims(sentence)).join(" ").trim();
  return kept ? truth + " " + kept : truth;
}

export const honesty = Object.freeze({
  memory: "Não consegui gravar isso na memória.",
  secret: "Não guardo esse tipo de dado na memória.",
  interface: "Não consegui fazer isso na interface.",
});
