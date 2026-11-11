import { isMemoryId, type MemoryStore } from "./MemoryStore.js";

const labels = { profile: "perfil", fact: "fato", summary: "resumo" } as const;

/** Terminal commands: /memory lists, /forget ID deletes one record, /forget all deletes everything. */
export function memoryCommand(store: MemoryStore, command: "/memory" | "/forget", args: readonly string[]): string {
  if (command === "/memory") {
    if (args.length) return "Use /memory sem argumentos.";
    const records = store.list();
    if (!records.length) return "Memória vazia.";
    return [`${records.length} registro(s), guardados em texto puro no arquivo SQLite deste computador:`,
      ...records.map(({ id, kind, text, updatedAt }) => `${id} · ${labels[kind]} · ${updatedAt.slice(0, 10)} · ${text.replace(/\s+/g, " ")}`),
    ].join("\n");
  }
  const [target, ...rest] = args;
  if (!target || rest.length) return "Use /forget ID ou /forget all.";
  if (target === "all") {
    const removed = store.clear();
    return removed ? `${removed} registro(s) apagado(s). A memória está vazia.` : "A memória já estava vazia.";
  }
  if (!isMemoryId(target)) return "ID inválido. Copie o ID completo mostrado por /memory.";
  return store.delete(target) ? "Registro apagado." : "Registro não encontrado.";
}
