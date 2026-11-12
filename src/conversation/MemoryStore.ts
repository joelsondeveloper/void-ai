import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openLocalDatabase } from "../governance/CheckpointStore.js";
import { detectSecret, secretRefusal } from "./secrets.js";

export const memoryKinds = ["profile", "fact", "summary"] as const;
export type MemoryKind = typeof memoryKinds[number];

/** Something VOID keeps about the host's user across sessions. It belongs to the user, not to a session. */
export const memoryOrigins = ["explicit", "extracted", "summary"] as const;
/** explicit: the user asked to remember it. extracted: the host inferred it from what the user said. summary: a session summary. */
export type MemoryOrigin = typeof memoryOrigins[number];

export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly origin: MemoryOrigin;
  /** Normalized theme ("trabalho", "moradia", "gosta:cafe"). One record per topic: a new statement replaces the old one. */
  readonly topic?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Conversation turn that produced the record, when there was one. */
  readonly sourceTurnId?: string;
  /** Session where it was recorded. Informational only: every session sees every record. */
  readonly sessionId?: string;
}

export interface MemoryInput {
  readonly kind: MemoryKind;
  readonly text: string;
  /** Defaults to "summary" for summaries and "explicit" otherwise. */
  readonly origin?: MemoryOrigin;
  readonly sourceTurnId?: string;
  readonly sessionId?: string;
}

export interface MemoryWrite {
  readonly record: MemoryRecord;
  /** False when the same normalized text was already stored; the existing record is returned and touched. */
  readonly created: boolean;
  /** Older summaries removed by the rotation that keeps only the latest few. Always empty for other kinds. */
  readonly removed: readonly string[];
}

export const memoryLimits = Object.freeze({ textChars: 300, summaryChars: 1_200, records: 500, summaries: 3, queryChars: 500 });

export type MemoryErrorCode = "invalid" | "too_long" | "full" | "secret" | "not_found";

/** Safe to show to the model or the user: messages never repeat the rejected text. */
export class MemoryError extends Error {
  override readonly name = "MemoryError";
  constructor(readonly code: MemoryErrorCode, message: string) { super(message); }
}

/** What remember() did with a statement about a topic. */
export interface TopicWrite {
  readonly record: MemoryRecord;
  /** created: no record had this topic. updated: the record of this topic got the new text. unchanged: same text as before. */
  readonly outcome: "created" | "updated" | "unchanged";
}

export interface MemorySearch {
  /** At most this many results. Defaults to 5, capped at 50. */
  readonly limit?: number;
  readonly kinds?: readonly MemoryKind[];
}

export interface MemoryStore {
  /** "fts5" when SQLite has full-text search, otherwise word-overlap scoring. Both keep the same contract. */
  readonly searchMode: "fts5" | "fallback";
  /** Validates without writing and returns the duplicate already stored, if any. Throws MemoryError. */
  check(input: MemoryInput): MemoryRecord | undefined;
  /** Throws MemoryError when the text is empty, too long, looks like a secret or the store is full. */
  add(input: MemoryInput): MemoryWrite;
  /**
   * Replaces the text of a record, keeping its id, kind and creation date. Same validation as add. Throws
   * MemoryError not_found for an unknown id and invalid when another record already holds the same text.
   */
  update(id: string, text: string): MemoryRecord;
  /**
   * Stores a statement under a topic, replacing the text of the record that already holds the topic instead of
   * adding a second one. A record without topic that has the same text takes the topic. Same validation as add.
   */
  remember(input: MemoryInput & { readonly topic: string }): TopicWrite;
  /** Gives a topic to a record that has none. Returns false when the id is unknown or the topic is already taken. */
  adoptTopic(id: string, topic: string): boolean;
  byTopic(topic: string): MemoryRecord | undefined;
  get(id: string): MemoryRecord | undefined;
  /** Oldest first. */
  list(kind?: MemoryKind): MemoryRecord[];
  count(): number;
  /** Records sharing words with the query, most relevant first. Records with nothing in common are left out. */
  search(query: string, options?: MemorySearch): MemoryRecord[];
  /** Removes the row for real. Returns false when the id does not exist. */
  delete(id: string): boolean;
  /** Removes every record and returns how many were removed. */
  clear(): number;
  /** Turns of a conversation session already covered by a summary (0 when none). */
  summarizedTurns(sessionId: string): number;
  markSummarized(sessionId: string, turns: number): void;
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const isMemoryId = (value: unknown): value is string => typeof value === "string" && uuidPattern.test(value);

/** Lowercase, punctuation and symbols removed, repeated whitespace collapsed. Two texts with the same key are duplicates. */
export function normalizeMemoryText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

// Folded the same way as the terms (no accents), otherwise "não" or "você" would never match.
const stopwords = new Set(fold("a o e é as os um uma uns umas de do da dos das no na nos nas num numa em ao aos à às por pra pro para com sem " +
  "que se eu tu ele ela nós vós eles elas me te lhe mim meu minha meus minhas seu sua seus suas isso isto aquilo esse essa este esta " +
  "não sim mais muito já também como quando onde qual quais quem ou mas foi ser ter tem está estou sou vai vou " +
  "você vc vcs diga diz dizer fala falar conta contar sabe saber sei lembra lembre lembrar lembrou memória alguma algum alguém " +
  "coisa coisas sobre aqui aí lá então porque pq tudo nada até agora ainda só pode posso favor por favor oi olá " +
  "the an and or of to in on at for is are was be it this that my your i you me we with what where who do does tell know").split(" "));

/** Accent-insensitive search terms, the same way the FTS5 tokenizer (unicode61, remove_diacritics 2) splits text. */
export function searchTerms(text: string): string[] {
  const words = fold(text).split(/[^\p{L}\p{N}]+/u);
  return [...new Set(words.filter((word) => word.length >= 2 && !stopwords.has(word)))].slice(0, 16);
}

/**
 * A light Portuguese stem: the first five letters, so "trabalho", "trabalha" and "trabalhar" meet on "traba".
 * Shorter terms are kept whole. Search matches any word that starts with the stem, in both search paths.
 */
export const searchStem = (term: string) => term.length > 5 ? term.slice(0, 5) : term;

function fts5Available(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.void_fts5_probe USING fts5(x); DROP TABLE temp.void_fts5_probe;");
    return true;
  } catch { return false; }
}

function cleanText(kind: MemoryKind, raw: unknown): string {
  if (typeof raw !== "string") throw new MemoryError("invalid", "O texto da memória precisa ser uma string.");
  // Facts and profile lines are one line each; summaries may keep paragraphs.
  const text = kind === "summary" ? raw.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : raw.replace(/\s+/g, " ").trim();
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new MemoryError("invalid", "O texto tem caracteres de controle.");
  if (!normalizeMemoryText(text)) throw new MemoryError("invalid", "O texto da memória está vazio.");
  const limit = kind === "summary" ? memoryLimits.summaryChars : memoryLimits.textChars;
  if (text.length > limit) throw new MemoryError("too_long", `O texto passa de ${limit} caracteres. Resuma em uma frase curta.`);
  const secret = detectSecret(text);
  if (secret) throw new MemoryError("secret", secretRefusal(secret));
  return text;
}

const topicPattern = /^[a-z0-9]+(?:[:-][a-z0-9]+)*$/;
function cleanTopic(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !topicPattern.test(value)) throw new MemoryError("invalid", "Tema de memória inválido.");
  return value;
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new MemoryError("invalid", `${label} inválido.`);
  return value;
}

export class SQLiteMemoryStore implements MemoryStore {
  readonly searchMode: "fts5" | "fallback";
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(filename: string, options: { search?: "auto" | "fts5" | "fallback"; now?: () => Date } = {}) {
    this.db = openLocalDatabase(filename);
    this.now = options.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('profile', 'fact', 'summary')),
        text TEXT NOT NULL,
        normalized TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_turn_id TEXT,
        session_id TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_records_kind ON memory_records(kind, updated_at);
      CREATE TABLE IF NOT EXISTS memory_summary_marks (
        session_id TEXT PRIMARY KEY,
        turns INTEGER NOT NULL CHECK (turns >= 0),
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
    // Columns added after the first release. Existing rows keep working: origin is derived from the kind.
    const columns = this.db.prepare("PRAGMA table_info(memory_records)").all().map(({ name }) => name);
    if (!columns.includes("origin")) {
      this.db.exec("ALTER TABLE memory_records ADD COLUMN origin TEXT NOT NULL DEFAULT 'explicit'");
      this.db.exec("UPDATE memory_records SET origin = 'summary' WHERE kind = 'summary'");
    }
    if (!columns.includes("topic")) this.db.exec("ALTER TABLE memory_records ADD COLUMN topic TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS memory_records_topic ON memory_records(topic) WHERE topic IS NOT NULL");
    const requested = options.search ?? "auto";
    const available = requested !== "fallback" && fts5Available(this.db);
    if (requested === "fts5" && !available) {
      this.db.close();
      throw new Error("O SQLite deste Node não tem FTS5.");
    }
    this.searchMode = available ? "fts5" : "fallback";
    if (available) {
      // The index is derived data. Rebuilding it on open also repairs writes made by a fallback-mode process.
      this.transaction(() => {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');
          DELETE FROM memory_fts; INSERT INTO memory_fts(id, body) SELECT id, text FROM memory_records;`);
      });
    }
  }

  close(): void { this.db.close(); }

  check(input: MemoryInput): MemoryRecord | undefined {
    return this.validate(input).existing;
  }

  add(input: MemoryInput): MemoryWrite {
    return this.transaction(() => {
      const { kind, text, normalized, existing, sourceTurnId, sessionId, origin } = this.validate(input);
      const at = this.now().toISOString();
      if (existing) {
        this.db.prepare("UPDATE memory_records SET updated_at = ? WHERE id = ?").run(at, existing.id);
        return { record: { ...existing, updatedAt: at }, created: false, removed: [] };
      }
      const id = this.insert({ kind, text, normalized, at, sourceTurnId, sessionId, origin });
      const removed = kind !== "summary" ? [] : this.db.prepare(`
        SELECT id FROM memory_records WHERE kind = 'summary' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      `).all(memoryLimits.summaries).flatMap(({ id: old }) => typeof old === "string" ? [old] : []);
      for (const old of removed) this.remove(old);
      const record: MemoryRecord = { id, kind, text, origin, createdAt: at, updatedAt: at,
        ...(sourceTurnId ? { sourceTurnId } : {}), ...(sessionId ? { sessionId } : {}) };
      return { record, created: true, removed };
    });
  }

  remember(input: MemoryInput & { readonly topic: string }): TopicWrite {
    return this.transaction((): TopicWrite => {
      const topic = cleanTopic(input.topic);
      if (input.kind === "summary") throw new MemoryError("invalid", "Resumos não têm tema.");
      const text = cleanText(input.kind, input.text);
      const normalized = normalizeMemoryText(text);
      const at = this.now().toISOString();
      const held = this.byTopic(topic);
      const same = this.db.prepare("SELECT * FROM memory_records WHERE normalized = ?").get(normalized);
      const twin = same ? this.read(same) : undefined;
      if (held && twin?.id === held.id) {
        this.db.prepare("UPDATE memory_records SET updated_at = ? WHERE id = ?").run(at, held.id);
        return { record: { ...held, updatedAt: at }, outcome: "unchanged" };
      }
      if (twin) {
        // The same sentence is already stored elsewhere. It becomes the record of this topic; a stale one goes away.
        const takes = twin.topic === undefined || held !== undefined;
        if (held) this.remove(held.id);
        if (takes) this.db.prepare("UPDATE memory_records SET topic = ?, updated_at = ? WHERE id = ?").run(topic, at, twin.id);
        return { record: { ...twin, updatedAt: at, ...(takes ? { topic } : {}) }, outcome: held ? "updated" : "unchanged" };
      }
      if (held) {
        this.db.prepare("UPDATE memory_records SET text = ?, normalized = ?, updated_at = ? WHERE id = ?").run(text, normalized, at, held.id);
        if (this.searchMode === "fts5") this.db.prepare("UPDATE memory_fts SET body = ? WHERE id = ?").run(text, held.id);
        return { record: { ...held, text, updatedAt: at }, outcome: "updated" };
      }
      const { sourceTurnId, sessionId, origin, kind } = this.validate(input);
      const id = this.insert({ kind, text, normalized, at, sourceTurnId, sessionId, origin, topic });
      return { record: { id, kind, text, origin, topic, createdAt: at, updatedAt: at,
        ...(sourceTurnId ? { sourceTurnId } : {}), ...(sessionId ? { sessionId } : {}) }, outcome: "created" };
    });
  }

  adoptTopic(id: string, topic: string): boolean {
    if (!isMemoryId(id) || this.byTopic(cleanTopic(topic))) return false;
    return this.db.prepare("UPDATE memory_records SET topic = ? WHERE id = ? AND topic IS NULL AND kind <> 'summary'").run(topic, id).changes === 1;
  }

  byTopic(topic: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory_records WHERE topic = ?").get(topic);
    return row ? this.read(row) : undefined;
  }

  update(id: string, text: string): MemoryRecord {
    return this.transaction(() => {
      const current = this.get(id);
      if (!current) throw new MemoryError("not_found", "Não existe registro com esse id.");
      const clean = cleanText(current.kind, text);
      const normalized = normalizeMemoryText(clean);
      const other = this.db.prepare("SELECT id FROM memory_records WHERE normalized = ? AND id <> ?").get(normalized, id);
      if (other) throw new MemoryError("invalid", `Já existe outro registro com esse texto (id ${String(other.id)}). Apague um dos dois com forget.`);
      const at = this.now().toISOString();
      this.db.prepare("UPDATE memory_records SET text = ?, normalized = ?, updated_at = ? WHERE id = ?").run(clean, normalized, at, id);
      if (this.searchMode === "fts5") this.db.prepare("UPDATE memory_fts SET body = ? WHERE id = ?").run(clean, id);
      return { ...current, text: clean, updatedAt: at };
    });
  }

  get(id: string): MemoryRecord | undefined {
    if (!isMemoryId(id)) return undefined;
    const row = this.db.prepare("SELECT * FROM memory_records WHERE id = ?").get(id);
    return row ? this.read(row) : undefined;
  }

  list(kind?: MemoryKind): MemoryRecord[] {
    const rows = kind === undefined
      ? this.db.prepare("SELECT * FROM memory_records ORDER BY created_at, rowid").all()
      : this.db.prepare("SELECT * FROM memory_records WHERE kind = ? ORDER BY created_at, rowid").all(kind);
    return rows.map((row) => this.read(row));
  }

  count(): number {
    const row = this.db.prepare("SELECT count(*) AS total FROM memory_records").get();
    return typeof row?.total === "number" ? row.total : 0;
  }

  search(query: string, options: MemorySearch = {}): MemoryRecord[] {
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 5)));
    const kinds = options.kinds?.length ? options.kinds.filter((kind) => memoryKinds.includes(kind)) : [...memoryKinds];
    const terms = searchTerms(query.slice(0, memoryLimits.queryChars));
    if (!terms.length || !kinds.length) return [];
    const placeholders = kinds.map(() => "?").join(", ");
    if (this.searchMode === "fts5") {
      // Terms only hold letters and digits, so quoting them is enough to keep FTS5 syntax out of the query.
      const match = [...new Set(terms.map(searchStem))].map((stem) => `"${stem}"*`).join(" OR ");
      return this.db.prepare(`
        SELECT r.* FROM memory_fts f JOIN memory_records r ON r.id = f.id
        WHERE memory_fts MATCH ? AND r.kind IN (${placeholders})
        ORDER BY bm25(memory_fts), r.updated_at DESC, r.rowid DESC LIMIT ?
      `).all(match, ...kinds, limit).map((row) => this.read(row));
    }
    const scored = this.db.prepare(`SELECT *, rowid AS position FROM memory_records WHERE kind IN (${placeholders})`).all(...kinds)
      .map((row) => {
        const words = searchTerms(String(row.text));
        const score = [...new Set(terms.map(searchStem))].filter((stem) => words.some((word) => word.startsWith(stem))).length;
        return { row, score, position: Number(row.position) };
      })
      .filter(({ score }) => score > 0);
    scored.sort((a, b) => b.score - a.score || String(b.row.updated_at).localeCompare(String(a.row.updated_at)) ||
      b.position - a.position);
    return scored.slice(0, limit).map(({ row }) => this.read(row));
  }

  delete(id: string): boolean {
    if (!isMemoryId(id)) return false;
    return this.transaction(() => this.remove(id));
  }

  clear(): number {
    return this.transaction(() => {
      const { changes } = this.db.prepare("DELETE FROM memory_records").run();
      if (this.searchMode === "fts5") this.db.exec("DELETE FROM memory_fts");
      return Number(changes);
    });
  }

  summarizedTurns(sessionId: string): number {
    const row = this.db.prepare("SELECT turns FROM memory_summary_marks WHERE session_id = ?").get(sessionId);
    return typeof row?.turns === "number" ? row.turns : 0;
  }

  markSummarized(sessionId: string, turns: number): void {
    if (!optionalId(sessionId, "Sessão") || !Number.isSafeInteger(turns) || turns < 0) throw new MemoryError("invalid", "Marca de resumo inválida.");
    this.db.prepare(`INSERT INTO memory_summary_marks VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET turns = excluded.turns, updated_at = excluded.updated_at`)
      .run(sessionId, turns, this.now().toISOString());
  }

  private validate(input: MemoryInput) {
    if (!memoryKinds.includes(input.kind)) throw new MemoryError("invalid", "Tipo de memória inválido.");
    const text = cleanText(input.kind, input.text);
    const sourceTurnId = optionalId(input.sourceTurnId, "Turno de origem");
    const sessionId = optionalId(input.sessionId, "Sessão");
    const normalized = normalizeMemoryText(text);
    const row = this.db.prepare("SELECT * FROM memory_records WHERE normalized = ?").get(normalized);
    const existing = row ? this.read(row) : undefined;
    if (!existing) {
      // A summary replaces the oldest one once the rotation is full, so it does not grow the store.
      const rotates = input.kind === "summary" && this.list("summary").length >= memoryLimits.summaries;
      if (!rotates && this.count() >= memoryLimits.records) {
        throw new MemoryError("full", `A memória chegou ao limite de ${memoryLimits.records} registros. ` +
          "Peça ao usuário para apagar registros antigos antes de gravar novos. Nada foi apagado automaticamente.");
      }
    }
    const origin = input.origin ?? (input.kind === "summary" ? "summary" : "explicit");
    if (!memoryOrigins.includes(origin) || (origin === "summary") !== (input.kind === "summary")) {
      throw new MemoryError("invalid", "Origem de memória inválida.");
    }
    return { kind: input.kind, text, normalized, existing, sourceTurnId, sessionId, origin };
  }

  private insert(row: { kind: MemoryKind; text: string; normalized: string; at: string; origin: MemoryOrigin;
    sourceTurnId: string | undefined; sessionId: string | undefined; topic?: string }): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO memory_records (id, kind, text, normalized, created_at, updated_at, source_turn_id, session_id, origin, topic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, row.kind, row.text, row.normalized, row.at, row.at,
      row.sourceTurnId ?? null, row.sessionId ?? null, row.origin, row.topic ?? null);
    if (this.searchMode === "fts5") this.db.prepare("INSERT INTO memory_fts(id, body) VALUES (?, ?)").run(id, row.text);
    return id;
  }

  private remove(id: string): boolean {
    const { changes } = this.db.prepare("DELETE FROM memory_records WHERE id = ?").run(id);
    if (this.searchMode === "fts5") this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(id);
    return changes === 1;
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private read(row: Record<string, unknown>): MemoryRecord {
    const { id, kind, text, created_at: createdAt, updated_at: updatedAt, source_turn_id: sourceTurnId, session_id: sessionId } = row;
    if (typeof id !== "string" || !memoryKinds.some((value) => value === kind) || typeof text !== "string" ||
        typeof createdAt !== "string" || typeof updatedAt !== "string") throw new Error("Invalid memory record.");
    const origin = memoryOrigins.find((value) => value === row.origin) ?? (kind === "summary" ? "summary" : "explicit");
    return { id, kind: kind as MemoryKind, text, origin, createdAt, updatedAt,
      ...(typeof row.topic === "string" ? { topic: row.topic } : {}),
      ...(typeof sourceTurnId === "string" ? { sourceTurnId } : {}), ...(typeof sessionId === "string" ? { sessionId } : {}) };
  }
}
