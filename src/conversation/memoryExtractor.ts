import { searchTerms, type MemoryOrigin } from "./MemoryStore.js";
import type { MemoryTurn } from "./voidTools.js";

/**
 * Deterministic capture of durable facts from what the user wrote, with no model call. It exists because a model
 * cannot be trusted to call `remember`: a passing mention ("trabalho na Florarte, mas hoje tô cansado") must reach
 * the memory even when the model answers "Anotei." and calls nothing.
 *
 * Precision first. Each rule matches one affirmative, present-tense, first-person shape and rewrites it in the
 * third person. Questions, negations, plans and hypotheticals are left alone, and anything outside the rules still
 * depends on the model's `remember` tool.
 */
export interface ExtractedMemory {
  readonly kind: "profile" | "fact";
  /** Theme used to update instead of duplicating: "trabalho", "moradia", "gosta:cafe". */
  readonly topic: string;
  /** Short Portuguese sentence in the third person. */
  readonly text: string;
  /** explicit when the user asked to remember it ("lembra que..."), extracted when it was only mentioned. */
  readonly origin: Exclude<MemoryOrigin, "summary">;
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const slug = (text: string) => fold(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
const titleCase = (text: string) => text.split(/\s+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

// A captured phrase runs until punctuation, the end of the sentence, or a conjunction that starts another idea.
const until = "(?=\\s*(?:[,.;!?\\n]|$)|\\s+(?:mas|porém|porem|só que|so que|porque|pq|pois|quando|que|" +
  "e\\s+(?:eu\\s+|hoje\\s+|agora\\s+|também\\s+|tb\\s+)?(?:tô|to|estou|moro|trabalho|prefiro|gosto|adoro|amo|uso|sou|tenho|não|nao|hoje|agora))(?![\\p{L}\\p{N}]))";
const phrase = "(?<v>[^,.;!?\\n]+?)" + until;
const rule = (prefix: string, flags = "iu") => new RegExp(prefix + phrase, flags);

// Words that make the statement not a fact about now: negation, wish, plan, doubt, condition.
const hedge = /(?:^|[^\p{L}])(?:n[ãa]o|nunca|nem|se|caso|talvez|quase|queria|gostaria|quero|vou|iria|ia|pretendo|penso em|pensando em|acho que|imagina(?: que)?|e se|quando eu|antes eu|j[áa] n[ãa]o)\s+(?:eu\s+)?(?:at[ée]\s+|mais\s+|que\s+)?$/iu;
// Objects that name nothing by themselves.
const vague = /^(?:isso|isto|aquilo|disso|disto|dessa|desse|desta|deste|dela|dele|deles|delas|ela|ele|eles|elas|voc[êe]s?|vc|ti|mim|a gente|quando|que|como|assim|essa|esse|esta|este|esses|essas|tudo|nada|muito|demais|mais|menos|aqui|a[íi]|l[áa]|hoje|agora|sim|ok|bem|mal)(?![\p{L}\p{N}])/iu;

function clean(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").replace(/[\s.,;:!]+$/, "").trim()
    // "na Acme agora" is about the Acme, not about now.
    .replace(/\s+(?:agora|hoje|atualmente|no momento|ultimamente|hoje em dia|esses dias)$/iu, "")
    // Emphasis at the end of a spoken sentence is not part of the fact: "trabalho na Florarte sim".
    .replace(/(?:\s+(?:sim|mesmo|né|ne|viu|tá|ta|ok|aliás|alias|inclusive))+$/iu, "")
    .replace(/(?<![\p{L}\p{N}])minhas(?![\p{L}\p{N}])/giu, "suas").replace(/(?<![\p{L}\p{N}])meus(?![\p{L}\p{N}])/giu, "seus")
    .replace(/(?<![\p{L}\p{N}])minha(?![\p{L}\p{N}])/giu, "sua").replace(/(?<![\p{L}\p{N}])meu(?![\p{L}\p{N}])/giu, "seu");
  if (text.length < 2 || text.length > 100 || text.split(" ").length > 10 || vague.test(text)) return undefined;
  return text;
}

type Draft = Omit<ExtractedMemory, "origin">;
interface Rule {
  readonly pattern: RegExp;
  /** Rules about disliking carry their own negation, so the hedge check does not apply to them. */
  readonly allowsNegation?: boolean;
  build(groups: Record<string, string | undefined>): Draft | undefined;
}

const working = "(?:eu\\s+)?(?:trabalho|t[ôo]\\s+trabalhando|estou\\s+trabalhando)\\s+";
const professions = "(?:dev|desenvolvedor|programador|engenheir|designer|estudante|professor|m[ée]dic|advogad|analista|gerente|freelancer|" +
  "aut[ôo]nom|empres[áa]ri|motorista|vendedor|enfermeir|arquitet|contador|t[ée]cnic|cientista|pesquisador|consultor|jornalista|escritor|m[úu]sic)";
const relatives = "esposa|marido|namorada|namorado|noiva|noivo|filha|filho|mãe|mae|pai|irmã|irma|irmão|irmao|chefe|sócia|socia|sócio|socio|cachorra|cachorro|gata|gato";

const rules: readonly Rule[] = [
  { pattern: /(?<![\p{L}\p{N}])(?:meu nome (?:é|eh)|(?:eu )?me chamo|pode(?:m)? me chamar de)\s+(?<v>[\p{L}'’-]+(?:\s+(?!e\s|mas\s)[\p{L}'’-]+){0,2})/iu,
    build: ({ v }) => { const name = clean(v); return name ? { kind: "profile", topic: "nome", text: `O usuário se chama ${titleCase(name)}.` } : undefined; } },
  { pattern: rule("(?<![\\p{L}\\p{N}])" + working + "(?<p>na|no|nas|nos|em|pra|pro|para a|para o|numa|num)\\s+"),
    build: ({ p, v }) => {
      const place = clean(v);
      return place && !/^(?:casa|home|equipe|time|turno|grupo)/i.test(place)
        ? { kind: "profile", topic: "trabalho", text: `O usuário trabalha ${p?.toLowerCase()} ${place}.` } : undefined;
    } },
  { pattern: rule("(?<![\\p{L}\\p{N}])" + working + "(?<p>com|como)\\s+"),
    build: ({ p, v }) => { const area = clean(v); return area ? { kind: "profile", topic: "ocupacao", text: `O usuário trabalha ${p?.toLowerCase()} ${area}.` } : undefined; } },
  { pattern: new RegExp("(?<![\\p{L}\\p{N}])(?:eu\\s+)?sou\\s+(?:um\\s+|uma\\s+)?(?<v>" + professions + "[\\p{L}]*(?:\\s+(?:de|da|do|em)\\s+[\\p{L}-]+(?:\\s+[\\p{L}-]+)?)?)", "iu"),
    build: ({ v }) => { const job = clean(v); return job ? { kind: "profile", topic: "profissao", text: `O usuário é ${job.toLowerCase()}.` } : undefined; } },
  { pattern: rule("(?<![\\p{L}\\p{N}])(?:eu\\s+)?(?:moro|t[ôo]\\s+morando|estou\\s+morando|vivo)\\s+(?<p>em|no|na|nos|nas)\\s+"),
    build: ({ p, v }) => { const place = clean(v); return place ? { kind: "profile", topic: "moradia", text: `O usuário mora ${p?.toLowerCase()} ${place}.` } : undefined; } },
  // Case-sensitive on purpose: the place must be capitalized, or "sou de boa" would become a home town.
  { pattern: /(?<![\p{L}\p{N}])(?:[Ee]u\s+)?[Ss]ou\s+(?:natural\s+)?(?<p>de|do|da)\s+(?<v>\p{Lu}[\p{L}'’-]*(?:\s+(?:d[eoa]s?\s+)?\p{Lu}[\p{L}'’-]*){0,3})/u,
    build: ({ p, v }) => { const place = clean(v); return place ? { kind: "profile", topic: "origem", text: `O usuário é ${p} ${place}.` } : undefined; } },
  { pattern: rule("(?<![\\p{L}\\p{N}])(?:eu\\s+)?prefiro\\s+"),
    build: ({ v }) => { const what = clean(v); return what ? { kind: "fact", topic: "prefere:" + slug(what), text: `O usuário prefere ${what}.` } : undefined; } },
  { pattern: rule("(?<![\\p{L}\\p{N}])(?:eu\\s+)?(?:n[ãa]o\\s+gosto|odeio|detesto|n[ãa]o\\s+suporto)\\s+(?:muito\\s+)?(?:de\\s+|d[oa]s?\\s+|[oa]s?\\s+)?"), allowsNegation: true,
    build: ({ v }) => { const what = clean(v); return what ? { kind: "fact", topic: "naogosta:" + slug(what), text: `O usuário não gosta de ${what}.` } : undefined; } },
  { pattern: rule("(?<![\\p{L}\\p{N}])(?:eu\\s+)?(?:gosto|adoro|amo)\\s+(?:muito\\s+|bastante\\s+|demais\\s+)?(?:de\\s+|d[oa]s?\\s+|[oa]s?\\s+)?"),
    build: ({ v }) => { const what = clean(v); return what ? { kind: "fact", topic: "gosta:" + slug(what), text: `O usuário gosta de ${what}.` } : undefined; } },
  // "uso" is also a noun ("o uso de memória"), so it only counts at the start of a clause or after "eu".
  { pattern: rule("(?:^|[,.;:!?]\\s*|(?<![\\p{L}\\p{N}])(?:eu|e|mas|sempre|só|já)\\s+)(?:uso|utilizo)\\s+"),
    build: ({ v }) => { const what = clean(v); return what ? { kind: "fact", topic: "usa:" + slug(what), text: `O usuário usa ${what}.` } : undefined; } },
  { pattern: new RegExp("(?<![\\p{L}\\p{N}])(?<poss>minha|meu)\\s+(?<rel>" + relatives + ")\\s+(?:se chama|chama|é a|é o|eh a|eh o)\\s+(?<v>[\\p{L}'’-]+(?:\\s+\\p{Lu}[\\p{L}'’-]+)?)", "iu"),
    build: ({ poss, rel, v }) => {
      const name = v?.trim();
      if (!name || !rel || vague.test(name)) return undefined;
      const relation = rel.toLowerCase();
      return { kind: "fact", topic: "pessoa:" + slug(relation),
        text: `${poss?.toLowerCase() === "minha" ? "A" : "O"} ${relation} do usuário se chama ${titleCase(name)}.` };
    } },
  { pattern: rule("(?<![\\p{L}\\p{N}])(?:meu|nosso)\\s+projeto\\s+(?:se chama|chama|é o|é a)\\s+"),
    build: ({ v }) => { const name = clean(v); return name ? { kind: "fact", topic: "projeto:" + slug(name), text: `O usuário tem um projeto chamado ${name}.` } : undefined; } },
  { pattern: rule("(?<![\\p{L}\\p{N}])(?:eu\\s+)?(?:t[ôo]|estou)\\s+(?:criando|desenvolvendo|construindo|montando)\\s+"),
    build: ({ v }) => { const what = clean(v); return what ? { kind: "fact", topic: "projeto:" + slug(what), text: `O usuário está desenvolvendo ${what}.` } : undefined; } },
];

// "lembra que X", "anota aí: X", "não esquece que X". The request itself is the user's instruction to remember.
const request = /(?<![\p{L}\p{N}])(?:lembr[ae](?:-se)?|n[ãa]o\s+esque[çc]a|n[ãa]o\s+esquece|anot[ae]|guard[ae]|memoriz[ae]|salv[ae])\s+(?:a[íi]\s+)?(?:que\s+|disso\s*:?\s*|isso\s*:?\s*|:\s*)(?<v>.+)$/iu;
// "esquece que eu trabalho na Florarte" is a request to forget, the opposite of a statement to keep.
const forgetting = /(?<![\p{L}\p{N}])(?:esque[çc][ae]|apag[ae]|remov[ae]|delet[ae]|tir[ae] da mem[óo]ria|desconsider[ae])(?![\p{L}\p{N}])/iu;
const interrogative = /^(?:\s*(?:void|ei|oi|ol[áa])[,\s]+)?(?:onde|qual|quais|quem|como|quando|quanto|por ?qu[eê]|ser[áa] que|o que|voc[êe] sabe|sabe|lembra (?:onde|qual|quem|como|quando|o que|se|d[eoa]))(?![\p{L}\p{N}])/iu;

function matchRules(sentence: string): Draft[] {
  const found: Draft[] = [];
  for (const { pattern, allowsNegation, build } of rules) {
    const match = pattern.exec(sentence);
    if (!match?.groups) continue;
    if (!allowsNegation && hedge.test(sentence.slice(0, match.index))) continue;
    const draft = build(match.groups);
    if (draft && draft.topic && !draft.topic.endsWith(":")) found.push(draft);
  }
  return found;
}

export const maxExtractedPerTurn = 3;
export const extractionWindow = 600;

/** Durable facts stated in the message, at most three, one per topic. Never throws. */
export function extractMemories(message: string): ExtractedMemory[] {
  const found = new Map<string, ExtractedMemory>();
  const keep = (drafts: readonly Draft[], origin: ExtractedMemory["origin"]) => {
    for (const draft of drafts) if (!found.has(draft.topic) && draft.text.length <= 300) found.set(draft.topic, { ...draft, origin });
  };
  // Only the opening of the message counts: a long paste (an email, a document) is rarely the user talking about themselves.
  for (const raw of message.slice(0, extractionWindow).split(/(?<=[.!?;])\s+|\n+/)) {
    const sentence = raw.trim();
    if (!sentence || sentence.endsWith("?") || interrogative.test(sentence)) continue;
    const asked = request.exec(sentence)?.groups?.v?.trim();
    if (asked) {
      const drafts = matchRules(asked);
      if (drafts.length) keep(drafts, "explicit");
      else {
        // No rule knows this shape, but the user asked: keep their words, quoted, so nothing is invented.
        const said = asked.replace(/\s+/g, " ").replace(/[\s.!]+$/, "").slice(0, 200);
        const key = slug(said);
        if (said.length >= 3 && key && !vague.test(said)) {
          keep([{ kind: "fact", topic: "lembrete:" + key, text: `O usuário pediu para lembrar: "${said.replace(/"/g, "'")}".` }], "explicit");
        }
      }
      continue;
    }
    if (forgetting.test(sentence)) continue;
    keep(matchRules(sentence), "extracted");
  }
  return [...found.values()].slice(0, maxExtractedPerTurn);
}

/** Topics that hold one value at a time: a new statement replaces the old one even when the words differ. */
export const exclusiveTopic = (topic: string) => !topic.includes(":") || topic.startsWith("pessoa:");
const stems = (text: string) => new Set(searchTerms(text).filter((term) => term !== "usuario").map((term) => term.slice(0, 4)));

/** True when every word of `next` is already in `stored`: the stored sentence says at least as much. */
export function covers(stored: string, next: string): boolean {
  const have = stems(stored);
  const want = stems(next);
  return want.size > 0 && [...want].every((term) => have.has(term));
}

/** How much two sentences say the same thing: the smaller of the two shared-word ratios. */
export function overlap(a: string, b: string): number {
  const left = stems(a), right = stems(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((term) => right.has(term)).length;
  return Math.min(shared / left.size, shared / right.size);
}

const sentencesOf = (message: string) => message.split(/(?<=[.!?;])\s+|\n+/).map((sentence) => sentence.trim());

/** The user asked to keep something: "lembra que...", "anota aí...", "não esquece que...". */
export const asksToRemember = (message: string) => sentencesOf(message).some((sentence) => request.test(sentence));
/** The user asked to drop something: "esquece...", "apaga da memória...". */
export const asksToForget = (message: string) =>
  sentencesOf(message).some((sentence) => forgetting.test(sentence) && !request.test(sentence));

/**
 * Stages what the fixed rules found, through the same path the memory tools and the memory agent use. Returns how
 * many items the stage refused (a secret, for one).
 */
export function stageExtracted(items: readonly ExtractedMemory[], turn: MemoryTurn): number {
  let refused = 0;
  for (const item of items) {
    try { turn.stage.add({ text: item.text, kind: item.kind, origin: item.origin, topic: item.topic }); }
    catch (error) {
      if (!(error instanceof Error && error.name === "ToolInputError")) throw error;
      refused++;
    }
  }
  return refused;
}

/** True when a reply tells the user something was saved. Used to contradict it when nothing was. */
export const claimsSaved = (reply: string) =>
  /(?<![\p{L}\p{N}])(?:anotei|anotad[oa]|salvei|salv[oa] na mem[óo]ria|guardei|guardad[oa]|memorizei|registrei|registrad[oa]|vou (?:me )?lembrar|vou guardar|ficou (?:anotado|salvo|guardado|registrado))(?![\p{L}\p{N}])/iu.test(reply);
