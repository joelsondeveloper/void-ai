import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openLocalDatabase } from "../governance/CheckpointStore.js";
import type { ModelMessage, ServedModel } from "../types/model.js";

export interface ConversationTurn {
  request: string;
  response: string | null;
}

export interface ConversationStore {
  history(sessionId: string, turns: number): ModelMessage[];
  recordDirect(sessionId: string, request: string, response: string, turnId?: string, model?: ServedModel, ui?: boolean): void;
  bind(sessionId: string, executionId: string, request: string, turnId?: string, introduction?: string): void;
  find(sessionId: string, executionId: string): ConversationTurn | undefined;
  complete(sessionId: string, executionId: string, response: string): void;
  pending(sessionId: string): string[];
}

export class SQLiteConversationStore implements ConversationStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = openLocalDatabase(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        execution_id TEXT UNIQUE,
        request TEXT NOT NULL,
        response TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversation_session ON conversation_turns(session_id);
      CREATE TABLE IF NOT EXISTS conversation_sessions (id TEXT PRIMARY KEY) STRICT;
    `);
    const columns = this.db.prepare("PRAGMA table_info(conversation_turns)").all();
    if (!columns.some(({ name }) => name === "failure")) {
      this.db.exec("ALTER TABLE conversation_turns ADD COLUMN failure TEXT");
    }
    if (!columns.some(({ name }) => name === "model")) {
      this.db.exec("ALTER TABLE conversation_turns ADD COLUMN model TEXT");
    }
    if (!columns.some(({ name }) => name === "ui")) {
      this.db.exec("ALTER TABLE conversation_turns ADD COLUMN ui INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some(({ name }) => name === "introduction")) {
      this.db.exec("ALTER TABLE conversation_turns ADD COLUMN introduction TEXT");
    }
  }

  close(): void { this.db.close(); }

  createSession(id: string): void {
    this.db.prepare("INSERT INTO conversation_sessions VALUES (?)").run(id);
  }

  sessions() {
    return this.db.prepare(`
      SELECT id, (SELECT request FROM conversation_turns WHERE session_id = conversation_sessions.id AND ui = 0 ORDER BY rowid LIMIT 1) AS title
      FROM conversation_sessions
      UNION ALL
      SELECT session_id, request FROM conversation_turns
      WHERE rowid IN (SELECT min(rowid) FROM conversation_turns GROUP BY session_id)
        AND session_id NOT IN (SELECT id FROM conversation_sessions)
    `).all().reverse();
  }

  hasSession(id: string): boolean {
    return !!this.db.prepare(`
      SELECT id FROM conversation_sessions WHERE id = ?
      UNION ALL SELECT session_id FROM conversation_turns WHERE session_id = ? LIMIT 1
    `).get(id, id);
  }

  turns(sessionId: string) {
    return this.db.prepare(`
      SELECT id, request, response, execution_id, failure, model, introduction, ui FROM conversation_turns
      WHERE session_id = ? ORDER BY rowid
    `).all(sessionId);
  }

  beginTurn(sessionId: string, id: string, request: string): boolean {
    const { changes } = this.db.prepare(`
      INSERT OR IGNORE INTO conversation_turns(id, session_id, request) VALUES (?, ?, ?)
    `).run(id, sessionId, request);
    return changes === 1;
  }

  failTurn(sessionId: string, id: string, failure: string): void {
    this.db.prepare(`
      UPDATE conversation_turns SET failure = ? WHERE session_id = ? AND id = ? AND response IS NULL
    `).run(failure, sessionId, id);
  }

  history(sessionId: string, turns: number): ModelMessage[] {
    if (!Number.isSafeInteger(turns) || turns < 0 || turns > 12) throw new Error("Invalid history limit.");
    const rows = this.db.prepare(`
      SELECT request, response FROM conversation_turns
      WHERE session_id = ? AND response <> '' AND ui = 0 ORDER BY rowid DESC LIMIT ?
    `).all(sessionId, turns).reverse();
    return rows.flatMap(({ request, response }): ModelMessage[] =>
      typeof request === "string" && typeof response === "string"
        ? [{ role: "user", content: request }, { role: "assistant", content: response }] : []);
  }

  recordDirect(sessionId: string, request: string, response: string, turnId?: string, model?: ServedModel, ui = false): void {
    if (turnId !== undefined) {
      const { changes } = this.db.prepare(`
        UPDATE conversation_turns SET response = ?, model = ?, ui = ?
        WHERE session_id = ? AND id = ? AND request = ? AND execution_id IS NULL AND response IS NULL
      `).run(response, model?.returned ?? null, Number(ui), sessionId, turnId, request);
      if (changes !== 1) throw new Error("Missing conversation turn.");
      return;
    }
    this.db.prepare("INSERT INTO conversation_turns (id, session_id, request, response, ui) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), sessionId, request, response, Number(ui));
  }

  bind(sessionId: string, executionId: string, request: string, turnId?: string, introduction?: string): void {
    if (turnId !== undefined) {
      const { changes } = this.db.prepare(`
        UPDATE conversation_turns SET execution_id = ?, introduction = ?
        WHERE session_id = ? AND id = ? AND request = ? AND execution_id IS NULL AND response IS NULL
      `).run(executionId, introduction ?? null, sessionId, turnId, request);
      if (changes !== 1) throw new Error("Missing conversation turn.");
      return;
    }
    this.db.prepare("INSERT INTO conversation_turns (id, session_id, execution_id, request, introduction) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), sessionId, executionId, request, introduction ?? null);
  }

  find(sessionId: string, executionId: string): ConversationTurn | undefined {
    const row = this.db.prepare("SELECT request, response FROM conversation_turns WHERE session_id = ? AND execution_id = ?")
      .get(sessionId, executionId);
    if (!row) return undefined;
    const { request, response } = row;
    if (typeof request !== "string" || (response !== null && typeof response !== "string")) {
      throw new Error("Invalid conversation record.");
    }
    return { request, response };
  }

  complete(sessionId: string, executionId: string, response: string): void {
    this.db.prepare(`
      UPDATE conversation_turns SET response = ?, failure = NULL
      WHERE session_id = ? AND execution_id = ? AND response IS NULL
    `).run(response, sessionId, executionId);
  }

  pending(sessionId: string): string[] {
    return this.db.prepare(`
      SELECT execution_id FROM conversation_turns
      WHERE session_id = ? AND execution_id IS NOT NULL AND response IS NULL ORDER BY rowid DESC
    `).all(sessionId).flatMap(({ execution_id }) => typeof execution_id === "string" ? [execution_id] : []);
  }
}
