import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { decodeCheckpoint, encodeCheckpoint, type ExecutionCheckpoint } from "./checkpoint.js";

export interface CheckpointLease {
  checkpoint: ExecutionCheckpoint;
  save(checkpoint: ExecutionCheckpoint): void;
  release(): void;
}

export interface CheckpointStore {
  claim(id: string, initial?: ExecutionCheckpoint): CheckpointLease;
  load(id: string): ExecutionCheckpoint | undefined;
}

const digest = (json: string): string => createHash("sha256").update(json).digest("hex");

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

export function openLocalDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") {
    try { closeSync(openSync(filename, "wx", 0o600)); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout = 3000; PRAGMA synchronous = FULL;");
  return db;
}

export class SQLiteCheckpointStore implements CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = openLocalDatabase(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, json TEXT NOT NULL, hash TEXT NOT NULL,
        owner TEXT, pid INTEGER
      ) STRICT;
    `);
  }

  close(): void { this.db.close(); }

  load(id: string): ExecutionCheckpoint | undefined {
    const row = this.db.prepare("SELECT json, hash FROM executions WHERE id = ?").get(id);
    return row ? this.read(id, row) : undefined;
  }

  claim(id: string, initial?: ExecutionCheckpoint): CheckpointLease {
    const owner = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    let checkpoint: ExecutionCheckpoint;
    try {
      const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(id);
      if (row) {
        if (initial) throw new Error("Execution ID already exists.");
        if (row.owner != null && (typeof row.pid !== "number" || processAlive(row.pid))) {
          throw new Error("Execution is already owned by another active run.");
        }
        checkpoint = this.read(id, row);
        this.db.prepare("UPDATE executions SET owner = ?, pid = ? WHERE id = ?").run(owner, process.pid, id);
      } else {
        if (!initial || initial.id !== id) throw new Error("Execution checkpoint not found.");
        const json = encodeCheckpoint(initial);
        checkpoint = decodeCheckpoint(json);
        this.db.prepare("INSERT INTO executions VALUES (?, ?, ?, ?, ?)").run(id, json, digest(json), owner, process.pid);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      checkpoint,
      save: (updated) => {
        if (updated.id !== id) throw new Error("Checkpoint ID mismatch.");
        const json = encodeCheckpoint(updated);
        const result = this.db.prepare("UPDATE executions SET json = ?, hash = ? WHERE id = ? AND owner = ?")
          .run(json, digest(json), id, owner);
        if (result.changes !== 1) throw new Error("Checkpoint ownership was lost.");
      },
      release: () => {
        this.db.prepare("UPDATE executions SET owner = NULL, pid = NULL WHERE id = ? AND owner = ?").run(id, owner);
      },
    };
  }

  private read(id: string, row: Record<string, unknown>): ExecutionCheckpoint {
    if (typeof row.json !== "string" || row.hash !== digest(row.json)) throw new Error("Execution checkpoint integrity check failed.");
    const checkpoint = decodeCheckpoint(row.json);
    if (checkpoint.id !== id) throw new Error("Checkpoint ID mismatch.");
    return checkpoint;
  }
}
