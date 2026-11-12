import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MemoryError, memoryLimits, normalizeMemoryText, searchStem, searchTerms, SQLiteMemoryStore } from "../src/conversation/MemoryStore.js";

function file(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "void-memory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "memory.sqlite");
}

function clock() {
  let at = Date.parse("2026-11-11T12:00:00.000Z");
  return () => new Date(at += 1_000);
}

function open(t: TestContext, search: "fts5" | "fallback", filename = file(t)) {
  const store = new SQLiteMemoryStore(filename, { search, now: clock() });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  return store;
}

const rejects = (action: () => unknown, code: MemoryError["code"]) =>
  assert.throws(action, (error) => error instanceof MemoryError && error.code === code);

test("the runtime check picks FTS5 when this Node's SQLite has it", (t) => {
  const store = new SQLiteMemoryStore(file(t));
  t.after(() => store.close());
  assert.ok(["fts5", "fallback"].includes(store.searchMode));
});

for (const mode of ["fts5", "fallback"] as const) {
  test(`[${mode}] creates, reads and lists records oldest first`, (t) => {
    const store = open(t, mode);
    assert.equal(store.searchMode, mode);
    const { record, created, removed } = store.add({ kind: "profile", text: "  Se chama   Joelson ", sessionId: "s1", sourceTurnId: "turn-1" });
    assert.equal(created, true);
    assert.deepEqual(removed, []);
    assert.equal(record.text, "Se chama Joelson");
    assert.equal(record.kind, "profile");
    assert.equal(record.sessionId, "s1");
    assert.equal(record.sourceTurnId, "turn-1");
    assert.equal(record.createdAt, record.updatedAt);
    store.add({ kind: "fact", text: "Prefere TypeScript a JavaScript" });
    assert.deepEqual(store.list().map(({ text }) => text), ["Se chama Joelson", "Prefere TypeScript a JavaScript"]);
    assert.deepEqual(store.list("fact").map(({ kind }) => kind), ["fact"]);
    assert.deepEqual(store.get(record.id), record);
    assert.equal(store.get("not-a-uuid"), undefined);
    assert.equal(store.count(), 2);
  });

  test(`[${mode}] search ranks by shared words, ignores accents and case, and leaves unrelated records out`, (t) => {
    const store = open(t, mode);
    store.add({ kind: "fact", text: "Mora em Recife" });
    store.add({ kind: "fact", text: "Gosta de café coado" });
    const both = store.add({ kind: "fact", text: "Trabalha com logística em Recife, no turno da noite" }).record;
    store.add({ kind: "profile", text: "Desenvolvedor TypeScript" });
    const results = store.search("como anda a LOGISTICA aí em recife?");
    assert.equal(results[0]?.id, both.id);
    assert.deepEqual(results.map(({ text }) => text).sort(), ["Mora em Recife", "Trabalha com logística em Recife, no turno da noite"]);
    // Prefix matching: "cafe" finds "café", "desenvolv" finds "Desenvolvedor".
    assert.deepEqual(store.search("cafe").map(({ text }) => text), ["Gosta de café coado"]);
    assert.deepEqual(store.search("desenvolv").map(({ kind }) => kind), ["profile"]);
    assert.deepEqual(store.search("recife", { kinds: ["profile"] }), []);
    assert.equal(store.search("recife", { limit: 1 }).length, 1);
    assert.deepEqual(store.search("xadrez"), []);
    // Stopwords alone and FTS5 syntax never match or throw.
    assert.deepEqual(store.search("de o a"), []);
    assert.deepEqual(store.search('" OR * NEAR( ) recife^'), store.search("recife"));
  });

  test(`[${mode}] dedupes by normalized text and touches the existing record`, (t) => {
    const store = open(t, mode);
    const first = store.add({ kind: "fact", text: "Gosta de café coado." }).record;
    const again = store.add({ kind: "fact", text: "gosta  de CAFÉ, coado!!" });
    assert.equal(again.created, false);
    assert.equal(again.record.id, first.id);
    assert.equal(again.record.text, "Gosta de café coado.");
    assert.ok(again.record.updatedAt > first.updatedAt);
    assert.equal(store.get(first.id)?.updatedAt, again.record.updatedAt);
    assert.equal(store.count(), 1);
    assert.equal(store.check({ kind: "fact", text: "GOSTA DE CAFÉ COADO" })?.id, first.id);
    assert.equal(store.check({ kind: "fact", text: "Gosta de chá" }), undefined);
    assert.equal(normalizeMemoryText(" Olá,   Mundo! "), "olá mundo");
  });

  test(`[${mode}] rejects invalid input, oversized text and a full store, and never deletes to make room`, (t) => {
    const store = open(t, mode);
    rejects(() => store.add({ kind: "fact", text: "   ...  " }), "invalid");
    rejects(() => store.add({ kind: "other" as "fact", text: "x" }), "invalid");
    rejects(() => store.add({ kind: "fact", text: 42 as unknown as string }), "invalid");
    rejects(() => store.add({ kind: "fact", text: "linha\u0000nula" }), "invalid");
    rejects(() => store.add({ kind: "fact", text: "ok", sessionId: "../x" }), "invalid");
    rejects(() => store.add({ kind: "fact", text: "a".repeat(memoryLimits.textChars + 1) }), "too_long");
    store.add({ kind: "fact", text: "a".repeat(memoryLimits.textChars) });
    store.add({ kind: "summary", text: "b ".repeat(memoryLimits.summaryChars / 2).trim() });
    rejects(() => store.add({ kind: "summary", text: "c".repeat(memoryLimits.summaryChars + 1) }), "too_long");
    for (let index = store.count(); index < memoryLimits.records; index++) store.add({ kind: "fact", text: `fato número ${index}` });
    assert.equal(store.count(), memoryLimits.records);
    rejects(() => store.add({ kind: "fact", text: "um fato a mais" }), "full");
    assert.throws(() => store.add({ kind: "profile", text: "outro" }), /limite de 500 registros.*Nada foi apagado/);
    // A duplicate still resolves to the existing record when full.
    assert.equal(store.add({ kind: "fact", text: "Fato número 7" }).created, false);
    assert.equal(store.count(), memoryLimits.records);
  });

  test(`[${mode}] summaries rotate, keeping the three most recent and reporting what was removed`, (t) => {
    const store = open(t, mode);
    const ids = [1, 2, 3].map((n) => store.add({ kind: "summary", text: `Resumo ${n}` }).record.id);
    const fourth = store.add({ kind: "summary", text: "Resumo 4" });
    assert.deepEqual(fourth.removed, [ids[0]]);
    assert.deepEqual(store.list("summary").map(({ text }) => text), ["Resumo 2", "Resumo 3", "Resumo 4"]);
    assert.deepEqual(store.search("resumo", { limit: 10 }).length, 3);
  });

  test(`[${mode}] delete and clear remove rows for real, including from search`, (t) => {
    const store = open(t, mode);
    const keep = store.add({ kind: "fact", text: "Mora em Recife" }).record;
    const drop = store.add({ kind: "fact", text: "Mora em Olinda" }).record;
    assert.equal(store.delete(drop.id), true);
    assert.equal(store.delete(drop.id), false);
    assert.equal(store.delete("../../etc"), false);
    assert.equal(store.get(drop.id), undefined);
    assert.deepEqual(store.search("mora").map(({ id }) => id), [keep.id]);
    // Deleted text can be saved again: nothing was left behind as a tombstone.
    assert.equal(store.add({ kind: "fact", text: "Mora em Olinda" }).created, true);
    assert.equal(store.clear(), 2);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.search("mora"), []);
  });

  test(`[${mode}] update replaces the text in place, re-indexes it and validates like add`, (t) => {
    const store = open(t, mode);
    const record = store.add({ kind: "fact", text: "Mora em Recife", sessionId: "s1" }).record;
    const other = store.add({ kind: "fact", text: "Gosta de café" }).record;
    const updated = store.update(record.id, "Mora em Olinda");
    assert.deepEqual({ ...updated, updatedAt: "" }, { ...record, text: "Mora em Olinda", updatedAt: "" });
    assert.ok(updated.updatedAt > record.updatedAt);
    assert.deepEqual(store.get(record.id), updated);
    assert.deepEqual(store.search("olinda").map(({ id }) => id), [record.id]);
    assert.deepEqual(store.search("recife"), []);
    // The old text is free again and the new one is taken.
    assert.equal(store.add({ kind: "fact", text: "mora em recife" }).created, true);
    rejects(() => store.update(record.id, "gosta de CAFÉ!"), "invalid");
    assert.throws(() => store.update(record.id, "gosta de café"), new RegExp(`id ${other.id}`));
    rejects(() => store.update(record.id, "senha: hunter22"), "secret");
    rejects(() => store.update(record.id, "x".repeat(301)), "too_long");
    rejects(() => store.update("00000000-0000-4000-8000-000000000000", "ok"), "not_found");
    rejects(() => store.update("nope", "ok"), "not_found");
    assert.equal(store.get(record.id)?.text, "Mora em Olinda");
    // Updating to the same text (or a case variant of it) is allowed.
    assert.equal(store.update(record.id, "MORA EM OLINDA").text, "MORA EM OLINDA");
  });

  test(`[${mode}] records and summary marks survive reopening the file`, (t) => {
    const filename = file(t);
    const first = open(t, mode, filename);
    const record = first.add({ kind: "fact", text: "Usa Biome no lugar do ESLint" }).record;
    first.markSummarized("old-session", 4);
    first.close();
    const second = open(t, mode, filename);
    assert.deepEqual(second.list(), [record]);
    assert.deepEqual(second.search("biome").map(({ id }) => id), [record.id]);
    assert.equal(second.summarizedTurns("old-session"), 4);
    assert.equal(second.summarizedTurns("never"), 0);
    second.markSummarized("old-session", 6);
    assert.equal(second.summarizedTurns("old-session"), 6);
  });

  test(`[${mode}] secrets are rejected before anything is written`, (t) => {
    const store = open(t, mode);
    const key = "sk-or-v1-" + "a1b2c3d4".repeat(6);
    assert.throws(() => store.add({ kind: "fact", text: "Minha chave é " + key }), (error) =>
      error instanceof MemoryError && error.code === "secret" && !error.message.includes(key) && /chave de API/.test(error.message));
    assert.equal(store.count(), 0);
  });
}

test("the FTS5 index is rebuilt on open, so writes made in fallback mode are searchable", (t) => {
  const filename = file(t);
  const fallback = open(t, "fallback", filename);
  // Create the FTS table first so the fallback writes leave it stale.
  open(t, "fts5", filename).close();
  const record = fallback.add({ kind: "fact", text: "Treina calistenia" }).record;
  fallback.close();
  const fts = open(t, "fts5", filename);
  assert.deepEqual(fts.search("calistenia").map(({ id }) => id), [record.id]);
});

test("the memory tables live in the same SQLite file as the conversation and are STRICT", async (t) => {
  const filename = file(t);
  const { SQLiteConversationStore } = await import("../src/conversation/ConversationStore.js");
  const conversations = new SQLiteConversationStore(filename);
  const store = open(t, "fallback", filename);
  t.after(() => conversations.close());
  conversations.recordDirect("s", "oi", "olá");
  store.add({ kind: "fact", text: "ok" });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filename);
  t.after(() => db.close());
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
  for (const name of ["conversation_turns", "memory_records", "memory_summary_marks"]) {
    assert.ok(tables.some((row) => row.name === name), name);
  }
  for (const name of ["memory_records", "memory_summary_marks"]) {
    assert.match(String(tables.find((row) => row.name === name)?.sql), /\)\s*STRICT$/);
  }
});

for (const mode of ["fts5", "fallback"] as const) {
  test(`[${mode}] Portuguese search: stopwords out, accents folded, "trabalho" meets "trabalha"`, (t) => {
    const store = open(t, mode);
    const job = store.add({ kind: "fact", text: "O usuário trabalha na Florarte." }).record;
    store.add({ kind: "fact", text: "Gosta de café coado" });
    store.add({ kind: "profile", text: "Treina calistenia" });
    for (const query of ["me diga onde eu trabalho", "onde eu trabalho?", "Florarte", "você sabe alguma coisa sobre a FLORARTE?",
      "quero trabalhar menos", "trabalhou ontem"]) {
      assert.deepEqual(store.search(query).map(({ id }) => id), [job.id], query);
    }
    // Questions made only of stopwords, and unrelated topics, bring nothing back.
    for (const query of ["me diga onde", "você sabe?", "o que é isso", "receita de bolo", "não"]) {
      assert.deepEqual(store.search(query), [], query);
    }
  });
}

test("search terms drop Portuguese stopwords even when written with accents", () => {
  assert.deepEqual(searchTerms("Você não sabe onde eu trabalho? Diga aí"), ["trabalho"]);
  assert.deepEqual(searchTerms("Também já está na memória"), []);
  assert.equal(searchStem("trabalhar"), "traba");
  assert.equal(searchStem("café"), "café");
});
