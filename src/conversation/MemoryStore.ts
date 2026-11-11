import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openLocalDatabase } from "../governance/CheckpointStore.js";
import { detectSecret, secretRefusal } from "./secrets.js";

export const memoryKinds = ["profile", "fact", "summary"] as const;
export type MemoryKind = typeof memoryKinds[number];

/** Something VOID keeps about the host's user across sessions. It belongs to the user, not to a session. */
export interface MemoryRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
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

const stopwords = new Set(("a o e é as os um uma uns umas de do da dos das no na nos nas em ao aos à às por pra pro para com sem " +
  "que se eu tu ele ela nós vós eles elas me te lhe mim meu minha meus minhas seu sua seus suas isso isto aquilo esse essa este esta " +
  "não sim mais muito já também como quando onde qual quais ou mas foi ser ter tem está estou sou vai vou " +
  "the an and or of to in on at for is are was be it this that my your i you me we with").split(" "));

/** Accent-insensitive search terms, the same way the FTS5 tokenizer (unicode61, remove_diacritics 2) splits text. */
export function searchTerms(text: string): string[] {
  const words = text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return [...new Set(words.filter((word) => word.length >= 2 && !stopwords.has(word)))].slice(0, 16);
}

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
      const { kind, text, normalized, existing, sourceTurnId, sessionId } = this.validate(input);
      const at = this.now().toISOString();
      if (existing) {
        this.db.prepare("UPDATE memory_records SET updated_at = ? WHERE id = ?").run(at, existing.id);
        return { record: { ...existing, updatedAt: at }, created: false, removed: [] };
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO memory_records (id, kind, text, normalized, created_at, updated_at, source_turn_id, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, text, normalized, at, at, sourceTurnId ?? null, sessionId ?? null);
      if (this.searchMode === "fts5") this.db.prepare("INSERT INTO memory_fts(id, body) VALUES (?, ?)").run(id, text);
      const removed = kind !== "summary" ? [] : this.db.prepare(`
        SELECT id FROM memory_records WHERE kind = 'summary' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      `).all(memoryLimits.summaries).flatMap(({ id: old }) => typeof old === "string" ? [old] : []);
      for (const old of removed) this.remove(old);
      const record: MemoryRecord = { id, kind, text, createdAt: at, updatedAt: at,
        ...(sourceTurnId ? { sourceTurnId } : {}), ...(sessionId ? { sessionId } : {}) };
      return { record, created: true, removed };
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
      const match = terms.map((term) => `"${term}"*`).join(" OR ");
      return this.db.prepare(`
        SELECT r.* FROM memory_fts f JOIN memory_records r ON r.id = f.id
        WHERE memory_fts MATCH ? AND r.kind IN (${placeholders})
        ORDER BY bm25(memory_fts), r.updated_at DESC, r.rowid DESC LIMIT ?
      `).all(match, ...kinds, limit).map((row) => this.read(row));
    }
    const scored = this.db.prepare(`SELECT *, rowid AS position FROM memory_records WHERE kind IN (${placeholders})`).all(...kinds)
      .map((row) => {
        const words = searchTerms(String(row.text));
        const score = terms.filter((term) => words.some((word) => word.startsWith(term))).length;
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
    return { kind: input.kind, text, normalized, existing, sourceTurnId, sessionId };
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
    return { id, kind: kind as MemoryKind, text, createdAt, updatedAt,
      ...(typeof sourceTurnId === "string" ? { sourceTurnId } : {}), ...(typeof sessionId === "string" ? { sessionId } : {}) };
  }
}
