import type { Snapshot, Turn } from "./contracts.js";

export function speakableText(text: string): string {
  return text.replace(/\r\n?/g, "\n")
    .replace(/^ {0,3}(~{3,}|\x60{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S]))/gm, "\n")
    .replace(/^(?: {4}|\t).+$/gm, "")
    .replace(/^.*\|.*\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*(?:\n.*\|.*)*/gm, "")
    .replace(/(\x60+)[^\n]*?\1/g, "")
    .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*.+$/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)/g, "$1")
    .replace(/!?\[([^\]\n]+)\]\[[^\]\n]*\]/g, "$1")
    .replace(/<?(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s<>]+>?/gi, (url) => url.match(/[.!?,;:]+$/)?.[0] ?? "")
    .replace(/<\/?[a-z][^>\n]*>/gi, "")
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$|^[ \t]*={2,}$/gm, "")
    .replace(/^[ \t]*(?:>+[ \t]*|#{1,6}[ \t]+|[-+*][ \t]+|\d+[.)][ \t]+)/gm, "")
    .replace(/[*_~#]+/g, "")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .split(/\n+/).map((line) => line.trim()).filter((line) => /[\p{L}\p{N}]/u.test(line))
    .join("\n").replace(/[ \t]+/g, " ");
}

export function finalReply(snapshot: Snapshot, turn: Turn): string | undefined {
  if (!turn.response || turn.failure || snapshot.active?.turnId === turn.id) return;
  if (!turn.executionId) return turn.response;
  if (!turn.response.startsWith("Execução concluída.\n\n")) return;
  if (snapshot.executions.find(({ id }) => id === turn.executionId)?.status !== "completed") return;
  // The existing persisted format puts the synthesis or the fallback in the second block.
  const body = turn.response.split("\n\n", 2)[1];
  if (!body || /^(?:## Resultados dos especialistas$|Nenhuma etapa concluída\.$|Não consegui concluir a síntese automática\.|Os resultados disponíveis estão abaixo\.|O orçamento da execução não permitiu gerar a síntese\.|Os resultados excederam o tamanho aceito pela síntese\.)/u.test(body)) return;
  return turn.response;
}
