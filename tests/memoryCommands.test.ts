import assert from "node:assert/strict";
import test from "node:test";
import { memoryCommand } from "../src/conversation/memoryCommands.js";
import { SQLiteMemoryStore } from "../src/conversation/MemoryStore.js";

test("terminal /memory lists, /forget ID deletes one, /forget all deletes everything", (t) => {
  const store = new SQLiteMemoryStore(":memory:");
  t.after(() => store.close());
  assert.equal(memoryCommand(store, "/memory", []), "Memória vazia.");
  const a = store.add({ kind: "profile", text: "Se chama Joelson" }).record;
  store.add({ kind: "fact", text: "Prefere TypeScript" });
  const listing = memoryCommand(store, "/memory", []).split("\n");
  assert.match(listing[0] ?? "", /^2 registro\(s\), guardados em texto puro/);
  assert.match(listing[1] ?? "", new RegExp(`^${a.id} · perfil · \\d{4}-\\d{2}-\\d{2} · Se chama Joelson$`));
  assert.equal(memoryCommand(store, "/forget", [a.id]), "Registro apagado.");
  assert.equal(memoryCommand(store, "/forget", [a.id]), "Registro não encontrado.");
  assert.equal(memoryCommand(store, "/forget", ["abc"]), "ID inválido. Copie o ID completo mostrado por /memory.");
  assert.equal(memoryCommand(store, "/forget", []), "Use /forget ID ou /forget all.");
  assert.equal(memoryCommand(store, "/forget", ["all", "now"]), "Use /forget ID ou /forget all.");
  assert.equal(memoryCommand(store, "/forget", ["all"]), "1 registro(s) apagado(s). A memória está vazia.");
  assert.equal(memoryCommand(store, "/forget", ["all"]), "A memória já estava vazia.");
  assert.equal(store.count(), 0);
});
